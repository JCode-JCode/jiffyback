import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startTestServer } from '../helpers/testServer.js';
import { compression } from '../../src/middleware/compression.js';

function rawRequest(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const bigPayload = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'widget', tag: 'compressible-payload' })) };

test('compression: gzip-compresses a large JSON response when the client accepts gzip', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => res.json(bigPayload));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['vary'], 'Accept-Encoding');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')), bigPayload);
  } finally {
    await close();
  }
});

test('compression: brotli-compresses when the client sends "br" in Accept-Encoding, preferred over gzip', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => res.json(bigPayload));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(res.headers['content-encoding'], 'br');
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(res.body).toString('utf8')), bigPayload);
  } finally {
    await close();
  }
});

test('compression: deflate-compresses when only deflate is accepted', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => res.json(bigPayload));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'deflate' } });
    assert.equal(res.headers['content-encoding'], 'deflate');
    assert.deepEqual(JSON.parse(zlib.inflateSync(res.body).toString('utf8')), bigPayload);
  } finally {
    await close();
  }
});

test('compression: leaves the response uncompressed when the client sends no Accept-Encoding', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => res.json(bigPayload));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: {} });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), bigPayload);
  } finally {
    await close();
  }
});

test('compression: leaves a body smaller than threshold uncompressed', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression({ threshold: 1024 }));
    app.get('/', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), { ok: true });
  } finally {
    await close();
  }
});

test('compression: leaves a body larger than maxSize uncompressed', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression({ maxSize: 100 }));
    app.get('/', (req, res) => res.json(bigPayload));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), bigPayload);
  } finally {
    await close();
  }
});

test('compression: leaves a non-compressible content type (e.g. an image) uncompressed', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.send(Buffer.alloc(2000, 1));
    });
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.length, 2000);
  } finally {
    await close();
  }
});

test('compression: HEAD request completes correctly and sends no body', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => res.json(bigPayload));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 0);
  } finally {
    await close();
  }
});

test('compression: a synchronous handler with no `next` param still completes correctly through the router while compression is pending', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/', (req, res) => {
      res.json(bigPayload);
    });
    app.use((req, res) => res.status(404).json({ error: 'should never be reached' }));
  });
  try {
    const res = await rawRequest(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')), bigPayload);
  } finally {
    await close();
  }
});

test('compression: many concurrent compressible requests all resolve with correct, distinct bodies', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.use(compression());
    app.get('/:id', (req, res) => res.json({ ...bigPayload, id: req.params.id }));
  });
  try {
    const ids = Array.from({ length: 20 }, (_, i) => String(i));
    const responses = await Promise.all(
      ids.map((id) =>
        rawRequest(`${baseUrl}/${id}`, { headers: { 'Accept-Encoding': 'gzip' } }).then((res) =>
          JSON.parse(zlib.gunzipSync(res.body).toString('utf8')),
        ),
      ),
    );
    responses.forEach((body, i) => assert.equal(body.id, ids[i]));
  } finally {
    await close();
  }
});

test('compression: bails out to a plain uncompressed end() when headers were already sent (res.write before res.end)', () => {
  const mw = compression();
  const headers = {};
  let ended = null;
  const res = {
    headersSent: true,
    getHeader(k) { return headers[k.toLowerCase()]; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    removeHeader(k) { delete headers[k.toLowerCase()]; },
    end(chunk) { ended = chunk; },
  };
  mw({ headers: { 'accept-encoding': 'gzip' } }, res, () => {});
  res.end('late chunk');
  assert.equal(ended, 'late chunk');
  assert.equal(headers['content-encoding'], undefined);
});
