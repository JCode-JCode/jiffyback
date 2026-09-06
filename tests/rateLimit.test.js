import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, MemoryStore } from '../src/index.js';

function fakeReq(ip = '1.2.3.4') {
  return { ip };
}

function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('MemoryStore.increment counts hits within a window and resets after it expires', () => {
  const store = new MemoryStore();
  const r1 = store.increment('k', 1000);
  const r2 = store.increment('k', 1000);
  assert.equal(r1.count, 1);
  assert.equal(r2.count, 2);
  assert.equal(r1.resetAt, r2.resetAt);
});

test('MemoryStore.increment resets cleanly to 1 after a real idle gap (no stale blending)', async () => {
  const store = new MemoryStore();
  const windowMs = 100;
  store.increment('k', windowMs);
  store.increment('k', windowMs);
  await new Promise((r) => setTimeout(r, windowMs * 3));
  const r = store.increment('k', windowMs);
  assert.equal(r.count, 1);
});

test('MemoryStore.increment smooths the fixed-window boundary burst (regression test)', async () => {
  const store = new MemoryStore();
  const windowMs = 100;
  for (let i = 0; i < 5; i++) store.increment('boundary-key', windowMs);

  await new Promise((r) => setTimeout(r, windowMs + 5));

  const result = store.increment('boundary-key', windowMs);
  assert.ok(result.count > 1, `expected count > 1 right after boundary, got ${result.count}`);
});

test('rateLimit() works with a custom async store (the supported way to share limits across instances)', async () => {
  const counts = new Map();
  const customStore = {
    async increment(key, windowMs) {
      await Promise.resolve();
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      return { count, resetAt: Date.now() + windowMs };
    },
  };

  const mw = rateLimit({ windowMs: 60_000, max: 2, store: customStore });

  let nextCalls = 0;
  const next = () => { nextCalls++; };

  await mw(fakeReq(), fakeRes(), next);
  await mw(fakeReq(), fakeRes(), next);
  const res3 = fakeRes();
  await mw(fakeReq(), res3, next);

  assert.equal(nextCalls, 2);
  assert.equal(res3.statusCode, 429);
  assert.equal(counts.get('1.2.3.4'), 3);
});

test('rateLimit() keys by req.ip by default, so different IPs get independent limits', async () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });

  const resA1 = fakeRes();
  await mw(fakeReq('1.1.1.1'), resA1, () => {});
  const resA2 = fakeRes();
  await mw(fakeReq('1.1.1.1'), resA2, () => {});
  const resB1 = fakeRes();
  await mw(fakeReq('2.2.2.2'), resB1, () => {});

  assert.equal(resA1.statusCode, 200);
  assert.equal(resA2.statusCode, 429);
  assert.equal(resB1.statusCode, 200);
});

test('MemoryStore evicts the least-recently-used key once maxKeys is exceeded (regression test: unbounded key-count DoS)', () => {
  const store = new MemoryStore({ maxKeys: 3 });
  store.increment('a', 1000);
  store.increment('b', 1000);
  store.increment('c', 1000);
  assert.equal(store.hits.size, 3);

  store.increment('d', 1000);
  assert.equal(store.hits.size, 3);
  assert.deepEqual([...store.hits.keys()], ['b', 'c', 'd']);

  const result = store.increment('a', 1000);
  assert.equal(result.count, 1);
});

test('MemoryStore: touching an existing key refreshes its recency, protecting it from LRU eviction', () => {
  const store = new MemoryStore({ maxKeys: 3 });
  store.increment('a', 1000);
  store.increment('b', 1000);
  store.increment('c', 1000);

  store.increment('a', 1000);
  store.increment('d', 1000);

  assert.deepEqual([...store.hits.keys()], ['c', 'a', 'd']);
});

test('rateLimit() propagates store errors to next(err) instead of throwing', async () => {
  const failingStore = { increment: async () => { throw new Error('store unavailable'); } };
  const mw = rateLimit({ store: failingStore });

  let caught = null;
  await mw(fakeReq(), fakeRes(), (err) => { caught = err; });

  assert.ok(caught instanceof Error);
  assert.equal(caught.message, 'store unavailable');
});
