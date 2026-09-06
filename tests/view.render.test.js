import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers/testServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.join(__dirname, 'fixtures', 'views');

test('res.render() sends rendered HTML with the right Content-Type', async () => {
  const { baseUrl, close } = await startTestServer(
    (app) => {
      app.get('/hello', (req, res) => res.render('hello', { name: 'Ali' }));
    },
    { views: { dir: viewsDir } }
  );
  try {
    const res = await fetch(`${baseUrl}/hello`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(await res.text(), '<p>Hello, Ali!</p>');
  } finally {
    await close();
  }
});

test('res.render() works when awaited inside an async handler', async () => {
  const { baseUrl, close } = await startTestServer(
    (app) => {
      app.get('/hello', async (req, res) => {
        await res.render('hello', { name: 'Sara' });
      });
    },
    { views: { dir: viewsDir } }
  );
  try {
    const res = await fetch(`${baseUrl}/hello`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<p>Hello, Sara!</p>');
  } finally {
    await close();
  }
});

test('res.render() works from a 3-arg (req, res, next) handler without awaiting (matches res.sendFile\'s existing convention)', async () => {
  const { baseUrl, close } = await startTestServer(
    (app) => {
      app.get('/hello', (req, res, next) => {
        res.render('hello', { name: 'Reza' });
      });
    },
    { views: { dir: viewsDir } }
  );
  try {
    const res = await fetch(`${baseUrl}/hello`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<p>Hello, Reza!</p>');
  } finally {
    await close();
  }
});

test('a template error is routed through the normal error-handling chain (custom onError), not a bespoke format', async () => {
  const { baseUrl, close } = await startTestServer(
    (app) => {
      app.get('/broken', (req, res) => res.render('does-not-exist'));
      app.onError((err, req, res) => {
        res.status(502).json({ customError: true, message: err.message });
      });
    },
    { views: { dir: viewsDir } }
  );
  try {
    const res = await fetch(`${baseUrl}/broken`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.customError, true);
    assert.match(body.message, /view not found/i);
  } finally {
    await close();
  }
});

test('res.render() with no views configured routes a clear error through the error chain', async () => {
  const { baseUrl, close } = await startTestServer((app) => {
    app.get('/x', (req, res) => res.render('hello'));
    app.onError((err, req, res) => res.status(500).json({ message: err.message }));
  });
  try {
    const res = await fetch(`${baseUrl}/x`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.message, /no view engine configured/);
  } finally {
    await close();
  }
});

test('res.render() with a layout renders the full composed page', async () => {
  const { baseUrl, close } = await startTestServer(
    (app) => {
      app.get('/page', (req, res) => res.render('child', { title: 'Composed' }, { layout: 'layout' }));
    },
    { views: { dir: viewsDir } }
  );
  try {
    const res = await fetch(`${baseUrl}/page`);
    assert.equal(await res.text(), '<html><body><main>Composed</main></body></html>');
  } finally {
    await close();
  }
});

test('user input rendered via res.render() is HTML-escaped end-to-end (XSS protection)', async () => {
  const { baseUrl, close } = await startTestServer(
    (app) => {
      app.get('/hello', (req, res) => res.render('hello', { name: req.query.name }));
    },
    { views: { dir: viewsDir } }
  );
  try {
    const res = await fetch(`${baseUrl}/hello?${new URLSearchParams({ name: '<script>alert(1)</script>' })}`);
    const text = await res.text();
    assert.ok(!text.includes('<script>'), 'raw <script> must never reach the response');
    assert.match(text, /&lt;script&gt;/);
  } finally {
    await close();
  }
});

test(
  'res.render() works from a bare 2-arg handler with no await/return/next (regression test: router auto-advance race)',
  async () => {
    const { baseUrl, close } = await startTestServer(
      (app) => {
        app.get('/hello', (req, res) => {
          res.render('hello', { name: 'Sara' });
        });
      },
      { views: { dir: viewsDir } }
    );
    try {
      const res = await fetch(`${baseUrl}/hello`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<p>Hello, Sara!</p>');
    } finally {
      await close();
    }
  }
);
