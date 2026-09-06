import crypto from 'crypto';
import { EventEmitter } from 'events';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024;
const DEFAULT_MAX_OUTGOING_BUFFER = 16 * 1024 * 1024;

export class WSConnection extends EventEmitter {
  constructor(socket, req, options = {}) {
    super();
    this.socket = socket;
    this.req = req;
    this._maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    this._maxOutgoingBuffer = options.maxOutgoingBuffer ?? DEFAULT_MAX_OUTGOING_BUFFER;
    this._bufferedAmount = 0;

    this._buf = Buffer.alloc(0);
    this._start = 0;
    this._end = 0;
    this._closed = false;

    this._fragments = null;
    this._fragmentOpcode = null;
    this._fragmentLength = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('error', (err) => this.emit('error', err));
  }

  _onData(chunk) {
    if (this._closed) return;
    this._append(chunk);
    let frame;
    try {
      while ((frame = this._tryParseFrame())) {
        this._handleFrame(frame);
        if (this._closed) return;
      }
    } catch (err) {
      this._protocolError(err);
    }
  }

  _append(chunk) {
    if (chunk.length === 0) return;

    const unconsumedLen = this._end - this._start;
    const tailSpace = this._buf.length - this._end;

    if (tailSpace < chunk.length) {
      if (this._start > 0 && this._buf.length - unconsumedLen >= chunk.length) {
        this._buf.copy(this._buf, 0, this._start, this._end);
        this._start = 0;
        this._end = unconsumedLen;
      } else {
        let newCapacity = Math.max(this._buf.length * 2, 64);
        while (newCapacity < unconsumedLen + chunk.length) newCapacity *= 2;
        const grown = Buffer.alloc(newCapacity);
        this._buf.copy(grown, 0, this._start, this._end);
        this._buf = grown;
        this._start = 0;
        this._end = unconsumedLen;
      }
    }

    chunk.copy(this._buf, this._end);
    this._end += chunk.length;
  }

  _protocolError(err) {
    this.emit('error', err);
    const code = err.wsCloseCode || 1009;
    this.close(code, code === 1002 ? 'Protocol Error' : 'Message Too Big');
  }

  _tryParseFrame() {
    const buf = this._buf.subarray(this._start, this._end);
    if (buf.length < 2) return null;

    const firstByte = buf[0];
    const secondByte = buf[1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (!masked) {
      const err = new Error('Received an unmasked frame from a client; the connection must be closed');
      err.wsCloseCode = 1002;
      throw err;
    }

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      payloadLen = Number(big);
      offset += 8;
    }

    if (payloadLen > this._maxPayload) {
      throw new Error(`Frame size (${payloadLen} bytes) exceeds the allowed cap (${this._maxPayload} bytes)`);
    }
    if (opcode === OPCODE.CONTINUATION || opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (this._fragmentLength + payloadLen > this._maxPayload) {
        throw new Error('Total length of the fragmented message exceeded the allowed cap');
      }
    }

    if (buf.length < offset + 4) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + payloadLen) return null;

    const rawPayload = buf.subarray(offset, offset + payloadLen);
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = rawPayload[i] ^ maskKey[i % 4];
    }

    this._start += offset + payloadLen;
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        this._beginOrEmitData(frame);
        break;
      case OPCODE.CONTINUATION:
        this._continueData(frame);
        break;
      case OPCODE.PING:
        this._sendFrame(OPCODE.PONG, frame.payload);
        break;
      case OPCODE.PONG:
        this.emit('pong');
        break;
      case OPCODE.CLOSE:
        this.close();
        break;
    }
  }

  _beginOrEmitData(frame) {
    if (frame.fin) {
      this._emitMessage(frame.opcode, frame.payload);
      return;
    }
    this._fragments = [frame.payload];
    this._fragmentOpcode = frame.opcode;
    this._fragmentLength = frame.payload.length;
  }

  _continueData(frame) {
    if (!this._fragments) {
      throw new Error('Received a CONTINUATION frame with no preceding start frame');
    }
    this._fragments.push(frame.payload);
    this._fragmentLength += frame.payload.length;

    if (frame.fin) {
      const full = Buffer.concat(this._fragments, this._fragmentLength);
      const opcode = this._fragmentOpcode;
      this._fragments = null;
      this._fragmentOpcode = null;
      this._fragmentLength = 0;
      this._emitMessage(opcode, full);
    }
  }

  _emitMessage(opcode, payload) {
    if (opcode === OPCODE.BINARY) {
      this.emit('message', payload, true);
    } else {
      this.emit('message', payload.toString('utf8'), false);
    }
  }

  get bufferedAmount() {
    return this._bufferedAmount;
  }

  _sendFrame(opcode, data) {
    if (this._closed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;

    const frame = Buffer.concat([header, payload]);

    if (this._bufferedAmount + frame.length > this._maxOutgoingBuffer) {
      this._abortOutgoingOverflow(
        new Error(
          `WebSocket outgoing buffer exceeded maxOutgoingBuffer (${this._maxOutgoingBuffer} bytes) - ` +
            'the client is not reading data fast enough; closing the connection to bound server memory use.'
        )
      );
      return;
    }

    this._bufferedAmount += frame.length;
    try {
      this.socket.write(frame, () => {
        this._bufferedAmount -= frame.length;
      });
    } catch {
      this._bufferedAmount -= frame.length;
    }
  }

  _abortOutgoingOverflow(err) {
    if (this._closed) return;
    this.emit('error', err);
    try {
      this.socket.destroy();
    } catch {
    }
    this._handleClose();
  }

  send(data) {
    const isBinary = Buffer.isBuffer(data);
    this._sendFrame(isBinary ? OPCODE.BINARY : OPCODE.TEXT, isBinary ? data : String(data));
  }

  ping() {
    this._sendFrame(OPCODE.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this._closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(OPCODE.CLOSE, payload);
    if (this._closed) return;
    this.socket.end();
    this._handleClose();
  }

  _handleClose() {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }
}

function isSameOriginAsHost(origin, hostHeader) {
  if (!hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

export function attachWebSocket(httpServer, routeHandlers, options = {}) {
  const allowedOrigins = options.allowedOrigins;

  const isOriginAllowed = (origin, hostHeader) => {
    if (allowedOrigins === true || allowedOrigins === '*') return true;
    if (typeof allowedOrigins === 'function') return Boolean(allowedOrigins(origin));
    if (Array.isArray(allowedOrigins)) return origin != null && allowedOrigins.includes(origin);

    if (allowedOrigins == null) {
      if (!origin) return true;
      return isSameOriginAsHost(origin, hostHeader);
    }

    return false;
  };

  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const upgradeHeader = (req.headers.upgrade || '').toLowerCase();

    if (upgradeHeader !== 'websocket' || !key) {
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const handler = routeHandlers.get(url.pathname);
    if (!handler) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + WS_MAGIC)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    if (head && head.length) socket.unshift(head);

    const ws = new WSConnection(socket, req, options);
    handler(ws, req);
  });
}
