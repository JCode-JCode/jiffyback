import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router.js';
import { enhanceRequest } from '../src/request.js';
import { enhanceResponse } from '../src/response.js';

function mockReqRes(method, url, headers = {}) {
  const req = { method, url, headers };
  const res = {
    _headers: {},
    _ended: false,
    _body: '',
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    getHeader(k) { return this._headers[k.toLowerCase()]; },
    removeHeader(k) { delete this._headers[k.toLowerCase()]; },
    end(chunk) {
      if (chunk) this._body += chunk;
      this._ended = true;
      this.writableEnded = true;
      this.headersSent = true;
      this.emit && this.emit('finish');
    },
    on() {},
  };
  enhanceRequest(req);
  enhanceResponse(res);
  return { req, res };
}

test('router matches a simple GET route', () => {
  const router = new Router();
  let hit = false;
  router.get('/hello', (req, res) => { hit = true; res.end('ok'); });

  const { req, res } = mockReqRes('GET', '/hello');
  router.handle(req, res, () => {});
  assert.equal(hit, true);
  assert.equal(res._body, 'ok');
});

test('router extracts named params', () => {
  const router = new Router();
  let captured = null;
  router.get('/user/:id', (req, res) => { captured = req.params; res.end(); });

  const { req, res } = mockReqRes('GET', '/user/42');
  router.handle(req, res, () => {});
  assert.deepEqual(captured, { id: '42' });
});

test('router returns 400 (does not throw) on malformed percent-encoding in a param (regression test: crash DoS)', () => {
  const router = new Router();
  let hit = false;
  router.get('/user/:id', (req, res) => { hit = true; res.end('should not reach here'); });

  const { req, res } = mockReqRes('GET', '/user/%zz');
  assert.doesNotThrow(() => router.handle(req, res, () => {}));
  assert.equal(hit, false);
  assert.equal(res.statusCode, 400);
});

test('router returns 400 on malformed percent-encoding in a wildcard param', () => {
  const router = new Router();
  let hit = false;
  router.get('/files/*', (req, res) => { hit = true; res.end(); });

  const { req, res } = mockReqRes('GET', '/files/%E0%A4%A');
  assert.doesNotThrow(() => router.handle(req, res, () => {}));
  assert.equal(hit, false);
  assert.equal(res.statusCode, 400);
});

test('router handles optional params', () => {
  const router = new Router();
  const seen = [];
  router.get('/posts/:id?', (req, res) => { seen.push(req.params.id); res.end(); });

  router.handle(...Object.values(mockReqRes('GET', '/posts')), () => {});
  router.handle(...Object.values(mockReqRes('GET', '/posts/7')), () => {});
  assert.deepEqual(seen, [undefined, '7']);
});

test('router calls doneCallback (404 path) when nothing matches', () => {
  const router = new Router();
  router.get('/only', (req, res) => res.end());

  let doneCalled = false;
  const { req, res } = mockReqRes('GET', '/nope');
  router.handle(req, res, (err) => { doneCalled = true; assert.equal(err, undefined); });
  assert.equal(doneCalled, true);
});

test('middleware chain runs in order via next()', () => {
  const router = new Router();
  const order = [];
  router.use((req, res, next) => { order.push('a'); next(); });
  router.use((req, res, next) => { order.push('b'); next(); });
  router.get('/x', (req, res) => { order.push('c'); res.end(); });

  const { req, res } = mockReqRes('GET', '/x');
  router.handle(req, res, () => {});
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a synchronous throw inside a route is routed to the error handler', () => {
  const router = new Router();
  router.get('/boom', () => { throw new Error('kaboom'); });

  let caught = null;
  const { req, res } = mockReqRes('GET', '/boom');
  router.handle(req, res, (err) => { caught = err; });
  assert.equal(caught?.message, 'kaboom');
});

test('error middleware (4-arg) intercepts errors', () => {
  const router = new Router();
  router.get('/boom', () => { throw new Error('kaboom'); });
  let handledMessage = null;
  router.use((err, req, res, next) => { handledMessage = err.message; res.end(); });

  const { req, res } = mockReqRes('GET', '/boom');
  router.handle(req, res, () => {});
  assert.equal(handledMessage, 'kaboom');
});

test('mounting a sub-router with app.use(path, router) works (regression test)', () => {
  const app = new Router();
  const users = new Router();
  users.get('/:id', (req, res) => res.end(`user:${req.params.id}`));
  app.use('/users', users);

  const { req, res } = mockReqRes('GET', '/users/9');
  app.handle(req, res, () => {});
  assert.equal(res._body, 'user:9');
});

test('mount/middleware path matching respects segment boundaries (regression test)', () => {
  const app = new Router();
  app.use('/admin', (req, res) => res.end('blocked-by-admin-mw'));
  app.get('/admin-public/info', (req, res) => res.end('public-info'));
  app.get('/admin/dashboard', (req, res) => res.end('dashboard'));

  const unrelated = mockReqRes('GET', '/admin-public/info');
  app.handle(unrelated.req, unrelated.res, () => {});
  assert.equal(unrelated.res._body, 'public-info');

  const exact = mockReqRes('GET', '/admin');
  app.handle(exact.req, exact.res, () => {});
  assert.equal(exact.res._body, 'blocked-by-admin-mw');

  const nested = mockReqRes('GET', '/admin/dashboard');
  app.handle(nested.req, nested.res, () => {});
  assert.equal(nested.res._body, 'blocked-by-admin-mw');
});

test('async route handlers are awaited before advancing (no premature chain skip)', async () => {
  const router = new Router();
  const order = [];
  router.get(
    '/async',
    async (req, res, next) => {
      order.push('start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('end');
      next();
    },
    (req, res) => { order.push('final'); res.end(); }
  );

  const { req, res } = mockReqRes('GET', '/async');
  router.handle(req, res, () => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['start', 'end', 'final']);
});

test('a literal "*" inside a path segment is matched literally, not as a regex quantifier (regression test)', () => {
  const router = new Router();
  router.get('/files/foo*bar', (req, res) => res.end('matched'));

  const { req: reqLiteral, res: resLiteral } = mockReqRes('GET', '/files/foo*bar');
  router.handle(reqLiteral, resLiteral, () => {});
  assert.equal(resLiteral._body, 'matched');

  const { req: reqWrong, res: resWrong } = mockReqRes('GET', '/files/foobar');
  let fellThrough = false;
  router.handle(reqWrong, resWrong, () => { fellThrough = true; });
  assert.equal(fellThrough, true);
  assert.equal(resWrong._ended, false);
});

test('a route with two "*" wildcards captures both under distinct params keys (regression test)', () => {
  const router = new Router();
  let captured;
  router.get('/a/*/b/*', (req, res) => {
    captured = { ...req.params };
    res.end();
  });

  const { req, res } = mockReqRes('GET', '/a/foo/b/bar');
  router.handle(req, res, () => {});
  assert.deepEqual(captured, { wildcard: 'foo', wildcard2: 'bar' });
});

test('a route with three "*" wildcards names them wildcard, wildcard2, wildcard3', () => {
  const router = new Router();
  let captured;
  router.get('/*/*/*', (req, res) => {
    captured = { ...req.params };
    res.end();
  });

  const { req, res } = mockReqRes('GET', '/x/y/z');
  router.handle(req, res, () => {});
  assert.deepEqual(captured, { wildcard: 'x', wildcard2: 'y', wildcard3: 'z' });
});

test('a route with a single "*" still uses the plain, backwards-compatible "wildcard" key', () => {
  const router = new Router();
  let captured;
  router.get('/files/*', (req, res) => {
    captured = { ...req.params };
    res.end();
  });

  const { req, res } = mockReqRes('GET', '/files/a/b/c');
  router.handle(req, res, () => {});
  assert.deepEqual(captured, { wildcard: 'a/b/c' });
});
