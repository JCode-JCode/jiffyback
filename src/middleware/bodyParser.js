import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseMultipartStream, MultipartError } from '../utils/multipartStream.js';

const DEFAULT_MULTIPART = {
  maxFileSize: 100 * 1024 * 1024,
  maxFieldSize: 1 * 1024 * 1024,
  maxFiles: 20,
  maxTotalSize: 500 * 1024 * 1024,
  uploadDir: path.join(os.tmpdir(), 'jiffyback-uploads'),
};

export function bodyParser(options = {}) {
  const maxSize = options.maxSize || 5 * 1024 * 1024;
  const multipartOptions = { ...DEFAULT_MULTIPART, ...(options.multipart || {}) };

  fs.mkdirSync(multipartOptions.uploadDir, { recursive: true });

  return async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    const boundaryMatch = contentType.includes('multipart/form-data')
      ? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
      : null;
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : null;

    if (boundary) {
      return handleMultipart(req, res, next, boundary, multipartOptions, contentLength);
    }

    if (contentLength && contentLength > maxSize) {
      res.status(413).json({ error: 'Payload Too Large' });
      return;
    }

    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxSize) {
        aborted = true;
        req.destroy();
        if (!res.headersSent) res.status(413).json({ error: 'Payload Too Large' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);

      try {
        if (contentType.includes('application/json')) {
          req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          req.body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        } else if (contentType.startsWith('text/')) {
          req.body = raw.toString('utf8');
        } else {
          req.body = raw;
        }
      } catch (err) {
        return next(new Error(`Invalid request body: ${err.message}`));
      }

      next();
    });

    req.on('error', (err) => next(err));
  };
}

async function handleMultipart(req, res, next, boundary, multipartOptions, contentLength) {
  if (contentLength && contentLength > multipartOptions.maxTotalSize) {
    res.status(413).json({ error: 'Payload Too Large' });
    return;
  }

  try {
    const { fields, files } = await parseMultipartStream(req, boundary, multipartOptions);
    req.body = fields;
    req.files = files;

    const tempPaths = Object.values(files).map((f) => f.path);
    if (tempPaths.length) {
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        for (const p of tempPaths) {
          fs.unlink(p, () => {});
        }
      };
      res.on('finish', cleanup);
      res.on('close', cleanup);
    }

    next();
  } catch (err) {
    req.destroy();
    if (err instanceof MultipartError) {
      if (!res.headersSent) res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}
