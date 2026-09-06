import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, bodyParser, cors, compression, rateLimit, Router } from '../src/index.js';
import { startTestServer } from './helpers/testServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'fixtures', 'public');

test('GET route responds with JSON', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.get('/hello', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/hello`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

test('POST body is parsed as JSON', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(bodyParser());
    app.post('/echo', (req, res) => res.json(req.body));
  });
  try {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 'x' }),
    });
    assert.deepEqual(await res.json(), { a: 1, b: 'x' });
  } finally {
    await close();
  }
});

test('bodyParser rejects oversized payloads with 413', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(bodyParser({ maxSize: 10 }));
    app.post('/echo', (req, res) => res.json(req.body));
  });
  try {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 'this is definitely more than ten bytes' }),
    });
    assert.equal(res.status, 413);
  } finally {
    await close();
  }
});

test('sub-router mounted with app.use(path, router) actually works', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    const users = new Router();
    users.get('/:id', (req, res) => res.send(`user:${req.params.id}`));
    app.use('/users', users);
  });
  try {
    const res = await fetch(`${baseUrl}/users/99`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'user:99');
  } finally {
    await close();
  }
});

test('REGRESSION: a request that misses serveStatic must not hang, and later routes must still run', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
    app.get('/api/late-route', (req, res) => res.json({ reached: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/api/late-route`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reached: true });
  } finally {
    await close();
  }
});

test('serveStatic serves an existing file', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/index.html`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /It works!/);
  } finally {
    await close();
  }
});

test('serveStatic resolves a directory request to its index file (regression test: async existence check)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /It works!/);
  } finally {
    await close();
  }
});

test('serveStatic returns 404 (not a hang) for a missing file with no routes after it', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/does-not-exist.txt`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('serveStatic blocks path traversal end-to-end', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/..%2f..%2f..%2f..%2fetc%2fpasswd`, { signal: AbortSignal.timeout(2000) });
    assert.notEqual(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /root:.*:0:0:/);
  } finally {
    await close();
  }
});

test('serveStatic blocks a plain (single-encoded) request for a dotfile', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/.env`, { signal: AbortSignal.timeout(2000) });
    assert.notEqual(res.status, 200);
  } finally {
    await close();
  }
});

test('serveStatic blocks a double-URL-encoded dotfile request (regression: decode-once fix)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/%252eenv`, { signal: AbortSignal.timeout(2000) });
    assert.notEqual(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /SECRET=/);
  } finally {
    await close();
  }
});

test('serveStatic serves SVG inline by default (no Content-Disposition)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/avatar.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('content-disposition'), null);
  } finally {
    await close();
  }
});

test('serveStatic({ attachmentExtensions }) forces a download for matching extensions (regression test: uploaded-SVG stored-XSS hardening)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir, { attachmentExtensions: ['.svg'] }));
  });
  try {
    const res = await fetch(`${baseUrl}/avatar.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /^attachment/);

    const htmlRes = await fetch(`${baseUrl}/index.html`);
    assert.equal(htmlRes.headers.get('content-disposition'), null);
  } finally {
    await close();
  }
});

test('serveStatic({ attachmentExtensions }) matches case-insensitively', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir, { attachmentExtensions: ['.SVG'] }));
  });
  try {
    const res = await fetch(`${baseUrl}/avatar.svg`);
    assert.match(res.headers.get('content-disposition') || '', /^attachment/);
  } finally {
    await close();
  }
});

test('an uncaught throw in a handler returns 500 and does not crash the server', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.get('/boom', () => { throw new Error('kaboom'); });
    app.get('/still-alive', (req, res) => res.json({ ok: true }));
  });
  try {
    const boomRes = await fetch(`${baseUrl}/boom`);
    assert.equal(boomRes.status, 500);

    const aliveRes = await fetch(`${baseUrl}/still-alive`);
    assert.equal(aliveRes.status, 200);
    assert.deepEqual(await aliveRes.json(), { ok: true });
  } finally {
    await close();
  }
});

test('cors middleware sets headers and handles preflight', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(cors());
    app.get('/hello', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/hello`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    await close();
  }
});

test('cors middleware never combines wildcard origin with credentials (regression test)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(cors({ credentials: true }));
    app.get('/hello', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/hello`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await close();
  }
});

test('compression middleware gzips large json responses when requested', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression({ threshold: 100 }));
    app.get('/big', (req, res) => res.json({ data: 'x'.repeat(5000) }));
  });
  try {
    const res = await fetch(`${baseUrl}/big`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
  } finally {
    await close();
  }
});

test('rateLimit blocks requests past the configured max', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(rateLimit({ windowMs: 60_000, max: 2 }));
    app.get('/limited', (req, res) => res.send('ok'));
  });
  try {
    const r1 = await fetch(`${baseUrl}/limited`);
    const r2 = await fetch(`${baseUrl}/limited`);
    const r3 = await fetch(`${baseUrl}/limited`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
  } finally {
    await close();
  }
});

test('range requests on static files return 206 with correct byte range', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const res = await fetch(`${baseUrl}/index.html`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range')?.startsWith('bytes 0-4/'), true);
    const text = await res.text();
    assert.equal(text.length, 5);
  } finally {
    await close();
  }
});

test('suffix range requests ("bytes=-N") return the last N bytes (regression test)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(serveStatic(publicDir));
  });
  try {
    const full = await (await fetch(`${baseUrl}/index.html`)).text();
    const res = await fetch(`${baseUrl}/index.html`, { headers: { Range: 'bytes=-5' } });
    assert.equal(res.status, 206);
    const expectedStart = full.length - 5;
    assert.equal(res.headers.get('content-range'), `bytes ${expectedStart}-${full.length - 1}/${full.length}`);
    const text = await res.text();
    assert.equal(text, full.slice(-5));
  } finally {
    await close();
  }
});

test('logger middleware stays silent unless explicitly enabled (regression test)', async () => {
  const originalLog = console.log;
  let called = false;
  console.log = () => { called = true; };
  try {
    const { logger } = await import('../src/middleware/logger.js');
    const { baseUrl, close } = await startTestServer((app) => {
      app.use(logger());
      app.get('/hello', (req, res) => res.send('hi'));
    });
    try {
      await fetch(`${baseUrl}/hello`);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(called, false);
    } finally {
      await close();
    }
  } finally {
    console.log = originalLog;
  }
});

test('bodyParser handles a real (multi-megabyte) multipart file upload correctly over an actual HTTP connection', async () => {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');

  let capturedSize = null;
  let capturedHash = null;
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(bodyParser());
    app.post('/upload', (req, res) => {
      capturedSize = req.files.file.size;
      capturedHash = crypto.createHash('sha256').update(fs.readFileSync(req.files.file.path)).digest('hex');
      res.json({ ok: true, size: req.files.file.size });
    });
  });

  try {
    const fileBytes = crypto.randomBytes(15 * 1024 * 1024);
    const expectedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
    const form = new FormData();
    form.append('caption', 'a big video, presumably');
    form.append('file', new Blob([fileBytes]), 'video.bin');

    const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.size, fileBytes.length);
    assert.equal(capturedSize, fileBytes.length);
    assert.equal(capturedHash, expectedHash);
  } finally {
    await close();
  }
});

test('HEAD request to a GET-only route gets the same headers and status but no body (regression test)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.get('/hello', (req, res) => res.json({ ok: true, message: 'hi there' }));
  });
  try {
    const getRes = await fetch(`${baseUrl}/hello`);
    const getBody = await getRes.text();

    const headRes = await fetch(`${baseUrl}/hello`, { method: 'HEAD' });
    const headBody = await headRes.text();

    assert.equal(headRes.status, 200);
    assert.equal(headBody, '');
    assert.equal(headRes.headers.get('content-type'), getRes.headers.get('content-type'));
    assert.equal(headRes.headers.get('content-length'), String(Buffer.byteLength(getBody)));
  } finally {
    await close();
  }
});

test('an explicit router.head() route still takes precedence when registered before the matching get() (regression test)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.head('/custom', (req, res) => {
      res.setHeader('X-Custom-Head', 'yes');
      res.status(200).end();
    });
    app.get('/custom', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/custom`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-custom-head'), 'yes');
  } finally {
    await close();
  }
});

test('POST/PUT routes are unaffected by the HEAD->GET fallback (regression test)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.post('/only-post', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetch(`${baseUrl}/only-post`, { method: 'HEAD' });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('compression() does not hang the connection when a handler calls res.write() before res.end() (regression test)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression({ threshold: 0 }));
    app.get('/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.write('a'.repeat(2000));
      res.end('b'.repeat(2000));
    });
  });
  try {
    const res = await fetch(`${baseUrl}/stream`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), null);
    const text = await res.text();
    assert.equal(text.length, 4000);
  } finally {
    await close();
  }
});

test('compression() still compresses a normal single-shot res.json response (no regression)', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression({ threshold: 0 }));
    app.get('/big', (req, res) => res.json({ text: 'x'.repeat(5000) }));
  });
  try {
    const res = await fetch(`${baseUrl}/big`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    const json = await res.json();
    assert.equal(json.text.length, 5000);
  } finally {
    await close();
  }
});

test(
  'res.sendFile() works from a bare 2-arg route handler with no await/return/next (regression test: router auto-advance race)',
  async () => {
    const filePath = path.join(publicDir, 'index.html');
    const { baseUrl, close } = await startTestServer((app) => {
      app.get('/file', (req, res) => {
        res.sendFile(filePath);
      });
    });
    try {
      const res = await fetch(`${baseUrl}/file`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/html/);
    } finally {
      await close();
    }
  }
);
