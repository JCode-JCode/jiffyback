import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.js';
import { csrf } from '../../src/middleware/csrf.js';
import { bodyParser } from '../../src/middleware/bodyParser.js';

function extractCookie(res, name) {
  const raw = res.headers.get('set-cookie') || '';
  const match = new RegExp(`${name}=([^;]+)`).exec(raw);
  return match ? match[1] : null;
}

test('csrf: not applied unless explicitly mounted', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.post('/action', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/action`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('csrf: issues a token cookie on a safe (GET) request and exposes req.csrfToken()', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(csrf());
    app.get('/form', (req, res) => res.json({ token: req.csrfToken() }));
  });
  try {
    const res = await fetch(`${baseUrl}/form`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    const cookieToken = extractCookie(res, '_csrf');
    assert.ok(cookieToken, 'expected a _csrf cookie to be set');
    assert.equal(decodeURIComponent(cookieToken), body.token);
  } finally {
    await close();
  }
});

test('csrf: blocks a state-changing request with no token (403)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(csrf());
    app.post('/action', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/action`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('csrf: blocks a state-changing request with a mismatched token (403)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(csrf());
    app.get('/form', (req, res) => res.json({ token: req.csrfToken() }));
    app.post('/action', (req, res) => res.json({ ok: true }));
  });
  try {
    const formRes = await fetch(`${baseUrl}/form`, { signal: AbortSignal.timeout(2000) });
    const cookie = formRes.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': 'totally-wrong-token' },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('csrf: allows a state-changing request whose header token matches the cookie', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(csrf());
    app.get('/form', (req, res) => res.json({ token: req.csrfToken() }));
    app.post('/action', (req, res) => res.json({ ok: true }));
  });
  try {
    const formRes = await fetch(`${baseUrl}/form`, { signal: AbortSignal.timeout(2000) });
    const { token } = await formRes.json();
    const cookie = formRes.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': token },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('csrf: falls back to a body field (e.g. a hidden form input) when no header is sent', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(bodyParser());
    app.use(csrf());
    app.get('/form', (req, res) => res.json({ token: req.csrfToken() }));
    app.post('/action', (req, res) => res.json({ ok: true }));
  });
  try {
    const formRes = await fetch(`${baseUrl}/form`, { signal: AbortSignal.timeout(2000) });
    const { token } = await formRes.json();
    const cookie = formRes.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${baseUrl}/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ _csrf: token }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('csrf: GET/HEAD/OPTIONS are never blocked (safe methods)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(csrf());
    app.get('/x', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/x`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});
