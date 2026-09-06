import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { session, MemorySessionStore } from '../src/middleware/session.js';
import { enhanceResponse } from '../src/response.js';
import { sign, unsign } from '../src/middleware/cookieParser.js';

const SECRET = 'test-secret';

function fakeReq(cookies = {}) {
  return { cookies: { ...cookies } };
}

function fakeRes() {
  const res = new EventEmitter();
  const headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => { headers[k] = v; };
  res.getHeader = (k) => headers[k];
  res.headers = headers;
  res.end = () => { res.emit('finish'); };
  return enhanceResponse(res);
}

function getSessionIdFromRes(res, cookieName = 'jsid') {
  const setCookie = res.getHeader('Set-Cookie');
  const cookieStr = Array.isArray(setCookie) ? setCookie.find((c) => c.startsWith(`${cookieName}=`)) : setCookie;
  assert.ok(cookieStr, 'expected a Set-Cookie header for the session');
  const raw = decodeURIComponent(cookieStr.split(';')[0].split('=').slice(1).join('='));
  const unsigned = unsign(raw, SECRET);
  assert.notEqual(unsigned, false, 'session-id cookie must be validly signed');
  return unsigned;
}

function run(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('session(): throws synchronously at setup if secret is missing', () => {
  assert.throws(() => session({}), TypeError);
});

test('session(): a fresh request gets a new session and a signed cookie', async () => {
  const middleware = session({ secret: SECRET });
  const req = fakeReq();
  const res = fakeRes();
  await run(middleware, req, res);
  assert.deepEqual(req.session.name, undefined);
  req.session.userId = 42;
  res.end();
  await flush();

  const id = getSessionIdFromRes(res);
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 20);
});

test('session(): data set in one request is available in the next request with the same cookie', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store });

  const req1 = fakeReq();
  const res1 = fakeRes();
  await run(middleware, req1, res1);
  req1.session.userId = 42;
  res1.end();
  await flush();
  const setCookieHeader = res1.getHeader('Set-Cookie');

  const cookieValue = decodeURIComponent(setCookieHeader.split(';')[0].split('=').slice(1).join('='));
  const req2 = fakeReq({ jsid: cookieValue });
  const res2 = fakeRes();
  await run(middleware, req2, res2);

  assert.equal(req2.session.userId, 42);
});

test('session(): a tampered cookie is rejected and treated as a brand-new session', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store });

  const req1 = fakeReq();
  const res1 = fakeRes();
  await run(middleware, req1, res1);
  req1.session.userId = 42;
  res1.end();
  await flush();
  const originalId = getSessionIdFromRes(res1);

  const forged = sign(originalId, 'wrong-secret');
  const req2 = fakeReq({ jsid: forged });
  const res2 = fakeRes();
  await run(middleware, req2, res2);

  assert.equal(req2.session.userId, undefined, 'tampered cookie must not grant access to the original session data');
});

test('session(): a cookie pointing at an unknown/expired store entry gets a fresh session, not a crash', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store });
  const validSignedButUnknownId = sign('this-id-was-never-issued', SECRET);
  const req = fakeReq({ jsid: validSignedButUnknownId });
  const res = fakeRes();
  await run(middleware, req, res);
  assert.deepEqual({ ...req.session }, {});
});

test('session(): regenerate() rotates the session id, keeps the data, and invalidates the old id', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store });

  const req1 = fakeReq();
  const res1 = fakeRes();
  await run(middleware, req1, res1);
  req1.session.userId = 42;
  req1.session.regenerate();
  res1.end();
  await flush();

  const newId = getSessionIdFromRes(res1);

  const req2 = fakeReq({ jsid: sign(newId, SECRET) });
  const res2 = fakeRes();
  await run(middleware, req2, res2);
  assert.equal(req2.session.userId, 42, 'data survives regenerate()');

  const oldEntries = [...store.sessions.values()].filter((e) => e.data.userId === 42);
  assert.equal(oldEntries.length, 1, 'only the new id should have a live store entry with this data');
});

test('session(): destroy() clears the store entry and the cookie', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store });

  const req1 = fakeReq();
  const res1 = fakeRes();
  await run(middleware, req1, res1);
  req1.session.userId = 42;
  res1.end();
  await flush();
  const id = getSessionIdFromRes(res1);
  assert.notEqual(store.get(id), undefined);

  const req2 = fakeReq({ jsid: sign(id, SECRET) });
  const res2 = fakeRes();
  await run(middleware, req2, res2);
  req2.session.destroy();
  res2.end();
  await flush();

  assert.equal(store.get(id), undefined, 'store entry must be gone after destroy()');
  const clearCookie = res2.getHeader('Set-Cookie');
  assert.match(clearCookie, /Max-Age=0/);
});

test('session(): the session-id cookie is always httpOnly, even if a caller tries to override it', async () => {
  const middleware = session({ secret: SECRET, cookie: { httpOnly: false } });
  const req = fakeReq();
  const res = fakeRes();
  await run(middleware, req, res);
  res.end();
  await flush();
  const setCookie = res.getHeader('Set-Cookie');
  assert.match(setCookie, /HttpOnly/);
});

test('session(): rolling (default) resends the cookie on every request that has a session', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store });

  const req1 = fakeReq();
  const res1 = fakeRes();
  await run(middleware, req1, res1);
  res1.end();
  await flush();
  const id = getSessionIdFromRes(res1);

  const req2 = fakeReq({ jsid: sign(id, SECRET) });
  const res2 = fakeRes();
  await run(middleware, req2, res2);
  res2.end();
  await flush();
  assert.ok(res2.getHeader('Set-Cookie'), 'rolling sessions resend the cookie even without a data change');
});

test('session(): touch() forces a save even without a top-level reassignment (e.g. after mutating a nested array)', async () => {
  const store = new MemorySessionStore();
  const middleware = session({ secret: SECRET, store, rolling: false });

  const req1 = fakeReq();
  const res1 = fakeRes();
  await run(middleware, req1, res1);
  req1.session.cart = [];
  res1.end();
  await flush();
  const id = getSessionIdFromRes(res1);

  const req2 = fakeReq({ jsid: sign(id, SECRET) });
  const res2 = fakeRes();
  await run(middleware, req2, res2);
  req2.session.cart.push('item-1');
  req2.session.touch();
  res2.end();
  await flush();

  const req3 = fakeReq({ jsid: sign(id, SECRET) });
  const res3 = fakeRes();
  await run(middleware, req3, res3);
  assert.deepEqual(req3.session.cart, ['item-1']);
});

test('MemorySessionStore: expired entries are not returned', async () => {
  const store = new MemorySessionStore();
  store.set('a', { x: 1 }, 10);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.get('a'), undefined);
});

test('MemorySessionStore evicts the least-recently-used session once maxSessions is exceeded (regression test: unbounded session-count DoS)', () => {
  const store = new MemorySessionStore({ maxSessions: 3 });
  store.set('a', { x: 1 }, 60_000);
  store.set('b', { x: 2 }, 60_000);
  store.set('c', { x: 3 }, 60_000);
  assert.equal(store.sessions.size, 3);

  store.set('d', { x: 4 }, 60_000);
  assert.equal(store.sessions.size, 3);
  assert.equal(store.get('a'), undefined, "'a' should have been evicted");
  assert.deepEqual(store.get('d'), { x: 4 });
});

test('MemorySessionStore: reading a session (get) refreshes its recency, protecting it from LRU eviction', () => {
  const store = new MemorySessionStore({ maxSessions: 3 });
  store.set('a', { x: 1 }, 60_000);
  store.set('b', { x: 2 }, 60_000);
  store.set('c', { x: 3 }, 60_000);

  store.get('a');
  store.set('d', { x: 4 }, 60_000);

  assert.deepEqual(store.get('a'), { x: 1 }, "'a' should have survived (it was read, not stale)");
  assert.equal(store.get('b'), undefined, "'b' should have been evicted");
});
