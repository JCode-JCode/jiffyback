import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachWebSocket } from '../src/websocket.js';

class FakeHttpServer extends EventEmitter {}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
  }
  write(data) { this.written.push(data.toString()); }
  destroy() { this.destroyed = true; }
  unshift() {}
}

function fakeUpgradeReq({ origin, host = 'example.com' } = {}) {
  const headers = {
    upgrade: 'websocket',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    host,
  };
  if (origin !== undefined) headers.origin = origin;
  return { headers, url: '/chat' };
}

function attach(options = {}) {
  const server = new FakeHttpServer();
  const handlers = new Map([['/chat', () => {}]]);
  attachWebSocket(server, handlers, options);
  return server;
}

test('attachWebSocket (default allowedOrigins): accepts a same-origin request', () => {
  const server = attach();
  const socket = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://example.com', host: 'example.com' }), socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, false);
  assert.match(socket.written[0], /101 Switching Protocols/);
});

test('attachWebSocket (default allowedOrigins): rejects a cross-site request (Cross-Site WebSocket Hijacking protection)', () => {
  const server = attach();
  const socket = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://evil.example', host: 'example.com' }), socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, true);
  assert.match(socket.written[0], /403 Forbidden/);
});

test('attachWebSocket (default allowedOrigins): accepts a request with no Origin header (non-browser client)', () => {
  const server = attach();
  const socket = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ host: 'example.com' }), socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, false);
  assert.match(socket.written[0], /101 Switching Protocols/);
});

test('attachWebSocket: allowedOrigins array only accepts listed origins', () => {
  const server = attach({ allowedOrigins: ['https://trusted.example'] });

  const ok = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://trusted.example', host: 'example.com' }), ok, Buffer.alloc(0));
  assert.equal(ok.destroyed, false);

  const blocked = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://example.com', host: 'example.com' }), blocked, Buffer.alloc(0));
  assert.equal(blocked.destroyed, true);
});

test('attachWebSocket: allowedOrigins function gets full custom control', () => {
  const server = attach({ allowedOrigins: (origin) => origin === 'https://only-this-one.example' });

  const ok = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://only-this-one.example' }), ok, Buffer.alloc(0));
  assert.equal(ok.destroyed, false);

  const blocked = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://example.com' }), blocked, Buffer.alloc(0));
  assert.equal(blocked.destroyed, true);
});

test('attachWebSocket: allowedOrigins: true explicitly disables the origin check', () => {
  const server = attach({ allowedOrigins: true });
  const socket = new FakeSocket();
  server.emit('upgrade', fakeUpgradeReq({ origin: 'https://anywhere.example' }), socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, false);
});

test('attachWebSocket (default allowedOrigins): rejects a malformed Origin header rather than throwing', () => {
  const server = attach();
  const socket = new FakeSocket();
  assert.doesNotThrow(() => {
    server.emit('upgrade', fakeUpgradeReq({ origin: 'not-a-valid-url', host: 'example.com' }), socket, Buffer.alloc(0));
  });
  assert.equal(socket.destroyed, true);
});
