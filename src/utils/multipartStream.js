import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class MultipartError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'MultipartError';
    this.statusCode = statusCode;
  }
}

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_SIZE = 16 * 1024;

function parseQuotedParam(headerText, paramName) {
  const re = new RegExp(`${paramName}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i');
  const match = re.exec(headerText);
  if (!match) return undefined;
  return match[1].replace(/\\(.)/g, '$1');
}

function parseExtendedFilename(headerText) {
  const match = /filename\*\s*=\s*([^;]+)/i.exec(headerText);
  if (!match) return undefined;
  const raw = match[1].trim().replace(/^"|"$/g, '');
  const firstQuote = raw.indexOf("'");
  const secondQuote = raw.indexOf("'", firstQuote + 1);
  if (firstQuote === -1 || secondQuote === -1) return undefined;
  const encodedValue = raw.slice(secondQuote + 1);
  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return undefined;
  }
}

function parsePartHeaders(headerText) {
  const fieldName = parseQuotedParam(headerText, 'name');
  if (fieldName === undefined) return null;
  const extendedFilename = parseExtendedFilename(headerText);
  const filename = extendedFilename !== undefined ? extendedFilename : parseQuotedParam(headerText, 'filename');
  const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
  return {
    fieldName,
    filename,
    contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
  };
}

function createFileSink(filePath) {
  const stream = fs.createWriteStream(filePath);
  let streamError = null;
  stream.on('error', (err) => {
    streamError = streamError || err;
  });

  return {
    path: filePath,
    async write(buf) {
      if (streamError) throw streamError;
      if (buf.length === 0) return;
      const canContinue = stream.write(buf);
      if (!canContinue) {
        await new Promise((resolve) => stream.once('drain', resolve));
      }
      if (streamError) throw streamError;
    },
    async end() {
      if (streamError) throw streamError;
      await new Promise((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()));
      });
      if (streamError) throw streamError;
    },
    destroy() {
      return new Promise((resolve) => {
        if (stream.destroyed || stream.closed) {
          resolve();
          return;
        }
        stream.once('close', resolve);
        stream.destroy();
      });
    },
  };
}

async function unlinkQuiet(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch {
  }
}

class MultipartState {
  constructor(boundary, options) {
    this.delimiter = Buffer.concat([CRLF, Buffer.from(`--${boundary}`)]);
    this.firstDelimiter = Buffer.from(`--${boundary}`);
    this.options = options;

    this.pending = Buffer.alloc(0);
    this.phase = 'PREAMBLE';
    this.currentSink = null;

    this.fields = {};
    this.files = {};
    this.tempPaths = [];
    this.fileCount = 0;
    this.totalBytes = 0;
  }

  async _flushToCurrentSink(buf) {
    if (buf.length === 0 || !this.currentSink) return;
    this.currentSink.size += buf.length;

    if (this.currentSink.kind === 'file') {
      if (this.currentSink.size > this.options.maxFileSize) {
        throw new MultipartError(413, `File "${this.currentSink.fieldName}" exceeds the maximum allowed size`);
      }
      await this.currentSink.sink.write(buf);
    } else {
      if (this.currentSink.size > this.options.maxFieldSize) {
        throw new MultipartError(413, `Field "${this.currentSink.fieldName}" exceeds the maximum allowed size`);
      }
      this.currentSink.parts.push(buf);
    }
  }

  async _finalizeCurrentSink() {
    if (!this.currentSink) return;
    if (this.currentSink.kind === 'file') {
      await this.currentSink.sink.end();
      this.files[this.currentSink.fieldName] = {
        filename: this.currentSink.filename,
        contentType: this.currentSink.contentType,
        path: this.currentSink.sink.path,
        size: this.currentSink.size,
      };
    } else {
      this.fields[this.currentSink.fieldName] = Buffer.concat(this.currentSink.parts).toString('utf8');
    }
    this.currentSink = null;
  }

  _beginPart(headerText) {
    const parsed = parsePartHeaders(headerText);
    if (!parsed) throw new MultipartError(400, 'Malformed multipart part (missing name)');

    if (parsed.filename !== undefined) {
      this.fileCount++;
      if (this.fileCount > this.options.maxFiles) {
        throw new MultipartError(413, `Too many files in one request (max ${this.options.maxFiles})`);
      }
      const tempPath = path.join(this.options.uploadDir, `upload-${crypto.randomUUID()}.tmp`);
      this.tempPaths.push(tempPath);
      this.currentSink = {
        kind: 'file',
        sink: createFileSink(tempPath),
        fieldName: parsed.fieldName,
        filename: parsed.filename,
        contentType: parsed.contentType,
        size: 0,
      };
    } else {
      this.currentSink = { kind: 'field', fieldName: parsed.fieldName, parts: [], size: 0 };
    }
  }

  async processChunk(chunk) {
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.options.maxTotalSize) {
      throw new MultipartError(413, 'Payload Too Large');
    }

    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;

    let progressed = true;
    while (progressed) {
      progressed = false;

      if (this.phase === 'DONE') {
        break;
      }

      if (this.phase === 'PREAMBLE') {
        const idx = this.pending.indexOf(this.firstDelimiter);
        if (idx === -1) {
          const keep = this.firstDelimiter.length - 1;
          if (this.pending.length > keep) this.pending = this.pending.subarray(this.pending.length - keep);
          break;
        }
        this.pending = this.pending.subarray(idx + this.firstDelimiter.length);
        this.phase = 'AFTER_DELIMITER';
        progressed = true;
      } else if (this.phase === 'AFTER_DELIMITER') {
        if (this.pending.length < 2) break;
        if (this.pending[0] === 0x2d && this.pending[1] === 0x2d) {
          this.phase = 'DONE';
          break;
        }
        if (this.pending[0] !== 0x0d || this.pending[1] !== 0x0a) {
          throw new MultipartError(400, 'Malformed multipart body (expected CRLF after boundary)');
        }
        this.pending = this.pending.subarray(2);
        this.phase = 'HEADERS';
        progressed = true;
      } else if (this.phase === 'HEADERS') {
        const idx = this.pending.indexOf(HEADER_END);
        if (idx === -1) {
          if (this.pending.length > MAX_HEADER_SIZE) {
            throw new MultipartError(400, 'Multipart part headers too large');
          }
          break;
        }
        const headerText = this.pending.subarray(0, idx).toString('utf8');
        this.pending = this.pending.subarray(idx + HEADER_END.length);
        this._beginPart(headerText);
        this.phase = 'BODY';
        progressed = true;
      } else if (this.phase === 'BODY') {
        const idx = this.pending.indexOf(this.delimiter);
        if (idx === -1) {
          const safeLen = this.pending.length - (this.delimiter.length - 1);
          if (safeLen > 0) {
            await this._flushToCurrentSink(this.pending.subarray(0, safeLen));
            this.pending = this.pending.subarray(safeLen);
          }
          break;
        }
        await this._flushToCurrentSink(this.pending.subarray(0, idx));
        await this._finalizeCurrentSink();
        this.pending = this.pending.subarray(idx + this.delimiter.length);
        this.phase = 'AFTER_DELIMITER';
        progressed = true;
      }
    }
  }

  async finish() {
    if (this.phase !== 'DONE') {
      throw new MultipartError(400, 'Unexpected end of multipart body (missing closing boundary)');
    }
  }

  async cleanup() {
    if (this.currentSink && this.currentSink.kind === 'file') {
      try {
        await this.currentSink.sink.destroy();
      } catch {
      }
    }
    await Promise.all(this.tempPaths.map(unlinkQuiet));
  }
}

export function parseMultipartStream(req, boundary, options) {
  return new Promise((resolve, reject) => {
    const state = new MultipartState(boundary, options);
    const queue = [];
    let ended = false;
    let requestError = null;
    let waiter = null;

    const wake = () => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };

    const onData = (chunk) => {
      queue.push(chunk);
      if (typeof req.pause === 'function') req.pause();
      wake();
    };
    const onEnd = () => {
      ended = true;
      wake();
    };
    const onError = (err) => {
      requestError = requestError || err;
      ended = true;
      wake();
    };
    const onClose = () => {
      if (!ended) onError(new Error('Request connection closed before the body finished'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);

    const removeListeners = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };

    (async () => {
      try {
        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift();
            await state.processChunk(chunk);
            if (typeof req.resume === 'function') req.resume();
            continue;
          }
          if (ended) break;
          await new Promise((res) => {
            waiter = res;
          });
        }
        if (requestError) throw requestError;
        await state.finish();
        removeListeners();
        resolve({ fields: state.fields, files: state.files });
      } catch (err) {
        removeListeners();
        await state.cleanup();
        reject(err);
      }
    })();
  });
}
