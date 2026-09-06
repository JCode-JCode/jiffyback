import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.js';
import { cors } from '../../src/middleware/cors.js';

test('cors: sets Access-Control-Allow-Origin from the default "*"', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(cors());
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    await close();
  }
});

test('cors: does not set Access-Control-Max-Age unless configured', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(cors());
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-max-age'), null);
  } finally {
    await close();
  }
});

test('cors: sends Access-Control-Max-Age on the preflight (OPTIONS) response when configured', () => {
  const mw = cors({ maxAge: 86400 });
  const headers = {};
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end() { this._ended = true; },
  };
  mw({ method: 'OPTIONS', headers: {} }, res, () => {});
  assert.equal(headers['access-control-max-age'], '86400');
  assert.equal(res.statusCode, 204);
});

test('cors: does not send Access-Control-Max-Age on a non-OPTIONS response even when configured', () => {
  const mw = cors({ maxAge: 86400 });
  const headers = {};
  const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; } };
  let nextCalled = false;
  mw({ method: 'GET', headers: {} }, res, () => { nextCalled = true; });
  assert.equal(headers['access-control-max-age'], undefined);
  assert.equal(nextCalled, true);
});

test('cors: sends Vary: Origin when origin is a function, even when it disallows the request', () => {
  const mw = cors({ origin: (o) => (o === 'https://allowed.example' ? o : null) });
  const headers = {};
  const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; } };
  mw({ method: 'GET', headers: { origin: 'https://blocked.example' } }, res, () => {});
  assert.equal(headers['vary'], 'Origin');
  assert.equal(headers['access-control-allow-origin'], undefined);
});

test('cors: sends Vary: Origin when origin is an array, even when the request origin is not in the list', () => {
  const mw = cors({ origin: ['https://allowed.example'] });
  const headers = {};
  const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; } };
  mw({ method: 'GET', headers: { origin: 'https://blocked.example' } }, res, () => {});
  assert.equal(headers['vary'], 'Origin');
  assert.equal(headers['access-control-allow-origin'], undefined);
});
