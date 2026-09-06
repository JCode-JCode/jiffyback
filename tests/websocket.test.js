import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WSConnection } from '../src/websocket.js';

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this.ended = false;
  }
  write(buf) { this.written.push(buf); return true; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

function buildFrame({ fin = true, opcode, payload = Buffer.alloc(0) }) {
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
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  header[1] |= 0x80;

  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i] ^ maskKey[i % 4];
  }

  return Buffer.concat([header, maskKey, maskedPayload]);
}

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

test('WSConnection reassembles a fragmented text message across continuation frames (regression test)', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {});
  const messages = [];
  ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));

  socket.emit('data', buildFrame({ fin: false, opcode: OPCODE.TEXT, payload: Buffer.from('Hello, ') }));
  socket.emit('data', buildFrame({ fin: false, opcode: OPCODE.CONTINUATION, payload: Buffer.from('WebSocket ') }));
  socket.emit('data', buildFrame({ fin: true, opcode: OPCODE.CONTINUATION, payload: Buffer.from('world!') }));

  assert.deepEqual(messages, [{ data: 'Hello, WebSocket world!', isBinary: false }]);
});

test('WSConnection still handles a normal, non-fragmented message', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {});
  const messages = [];
  ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));

  socket.emit('data', buildFrame({ fin: true, opcode: OPCODE.TEXT, payload: Buffer.from('hi') }));

  assert.deepEqual(messages, [{ data: 'hi', isBinary: false }]);
});

test('WSConnection handles a control frame (PING) arriving in the middle of a fragmented message', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {});
  const messages = [];
  ws.on('message', (data) => messages.push(data));

  socket.emit('data', buildFrame({ fin: false, opcode: OPCODE.TEXT, payload: Buffer.from('part1-') }));
  socket.emit('data', buildFrame({ fin: true, opcode: OPCODE.PING, payload: Buffer.alloc(0) }));
  socket.emit('data', buildFrame({ fin: true, opcode: OPCODE.CONTINUATION, payload: Buffer.from('part2') }));

  assert.deepEqual(messages, ['part1-part2']);
  assert.equal(socket.written.length, 1);
});

test('WSConnection rejects a single frame whose declared length exceeds maxPayload (regression test: memory DoS)', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {}, { maxPayload: 100 });
  let errored = false;
  let closed = false;
  ws.on('error', () => { errored = true; });
  ws.on('close', () => { closed = true; });

  const header = Buffer.alloc(10);
  header[0] = 0x80 | OPCODE.BINARY;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(1_000_000), 2);
  socket.emit('data', header);

  assert.equal(errored, true);
  assert.equal(closed, true);
});

test('WSConnection rejects a fragmented message whose total size exceeds maxPayload', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {}, { maxPayload: 10 });
  let errored = false;
  ws.on('error', () => { errored = true; });

  socket.emit('data', buildFrame({ fin: false, opcode: OPCODE.TEXT, payload: Buffer.from('12345678') }));
  socket.emit('data', buildFrame({ fin: true, opcode: OPCODE.CONTINUATION, payload: Buffer.from('12345678') }));

  assert.equal(errored, true);
});

test('WSConnection still supports a normal binary message', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {});
  const messages = [];
  ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));

  const payload = Buffer.from([1, 2, 3, 4]);
  socket.emit('data', buildFrame({ fin: true, opcode: OPCODE.BINARY, payload }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].isBinary, true);
  assert.deepEqual(messages[0].data, payload);
});

test('WSConnection rejects an unmasked frame from a client (RFC 6455 5.1)', () => {
  const socket = new MockSocket();
  const ws = new WSConnection(socket, {});
  let errored = false;
  let closed = false;
  ws.on('error', () => { errored = true; });
  ws.on('close', () => { closed = true; });

  const payload = Buffer.from('hi');
  const header = Buffer.alloc(2);
  header[0] = 0x80 | OPCODE.TEXT;
  header[1] = payload.length;
  socket.emit('data', Buffer.concat([header, payload]));

  assert.equal(errored, true);
  assert.equal(closed, true);
});

class StalledSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this.ended = false;
  }
  write(buf, cb) {
    this.written.push({ buf, cb });
    return false;
  }
  drainAll() {
    const pending = this.written.splice(0, this.written.length);
    for (const { cb } of pending) cb && cb();
  }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

test('WSConnection.send() tracks bufferedAmount and drains it once the socket flushes (regression test)', () => {
  const socket = new StalledSocket();
  const ws = new WSConnection(socket, {}, { maxOutgoingBuffer: 10_000 });

  ws.send('hello');
  assert.equal(ws.bufferedAmount, 7);
  ws.send('!!');
  assert.equal(ws.bufferedAmount, 11);

  socket.drainAll();
  assert.equal(ws.bufferedAmount, 0);
});

test('WSConnection.send() aborts the connection once maxOutgoingBuffer is exceeded by a stalled peer (regression test: outgoing memory DoS)', () => {
  const socket = new StalledSocket();
  const ws = new WSConnection(socket, {}, { maxOutgoingBuffer: 100 });
  let errored = false;
  let closed = false;
  ws.on('error', () => { errored = true; });
  ws.on('close', () => { closed = true; });

  for (let i = 0; i < 30; i++) {
    ws.send('x'.repeat(20));
  }

  assert.equal(errored, true);
  assert.equal(closed, true);
  assert.equal(socket.destroyed, true);
  assert.doesNotThrow(() => ws.send('after close'));
});

test('WSConnection.send() against a healthy, promptly-draining peer never trips maxOutgoingBuffer', () => {
  const socket = new StalledSocket();
  const ws = new WSConnection(socket, {}, { maxOutgoingBuffer: 100 });
  let errored = false;
  ws.on('error', () => { errored = true; });

  for (let i = 0; i < 30; i++) {
    ws.send('x'.repeat(20));
    socket.drainAll();
  }

  assert.equal(errored, false);
  assert.equal(ws.bufferedAmount, 0);
});
