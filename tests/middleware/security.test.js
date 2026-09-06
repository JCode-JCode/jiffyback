import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.js';
import { securityHeaders } from '../../src/middleware/security.js';

test('securityHeaders: not applied unless explicitly mounted', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.headers.get('x-content-type-options'), null);
    assert.equal(res.headers.get('x-frame-options'), null);
  } finally {
    await close();
  }
});

test('securityHeaders: sets safe defaults when mounted', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(securityHeaders());
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-xss-protection'), '0');
    assert.equal(res.headers.get('x-dns-prefetch-control'), 'off');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('strict-transport-security'), null);
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(res.headers.get('permissions-policy'), null);
  } finally {
    await close();
  }
});

test('securityHeaders: every option is individually overridable/disableable', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(securityHeaders({
      frameOptions: 'SAMEORIGIN',
      referrerPolicy: null,
      contentSecurityPolicy: "default-src 'self'",
      permissionsPolicy: 'geolocation=()',
      crossOriginResourcePolicy: 'cross-origin',
    }));
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('referrer-policy'), null);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'");
    assert.equal(res.headers.get('permissions-policy'), 'geolocation=()');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  } finally {
    await close();
  }
});

test('securityHeaders: removes a pre-set X-Powered-By header by default', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use((req, res, next) => { res.setHeader('X-Powered-By', 'SomeStack'); next(); });
    app.use(securityHeaders());
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    await close();
  }
});

test('securityHeaders: hidePoweredBy: false leaves a pre-set X-Powered-By header alone', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use((req, res, next) => { res.setHeader('X-Powered-By', 'SomeStack'); next(); });
    app.use(securityHeaders({ hidePoweredBy: false }));
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.headers.get('x-powered-by'), 'SomeStack');
  } finally {
    await close();
  }
});

test('securityHeaders: HSTS is only sent when the request is secure (req.secure)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.trustProxy = true;
    app.use(securityHeaders({ hsts: { maxAge: 1000, includeSubDomains: true } }));
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const plain = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(plain.headers.get('strict-transport-security'), null);

    const secure = await fetch(`${baseUrl}/`, {
      headers: { 'x-forwarded-proto': 'https' },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(secure.headers.get('strict-transport-security'), 'max-age=1000; includeSubDomains');
  } finally {
    await close();
  }
});
