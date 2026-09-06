import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceRequest } from '../src/request.js';

function fakeReq(url, headers = {}) {
  return { method: 'GET', url, headers, socket: {} };
}

test('parses pathname and query string', () => {
  const req = enhanceRequest(fakeReq('/search?q=hello+world&page=2'));
  assert.equal(req.pathname, '/search');
  assert.deepEqual(req.query, { q: 'hello world', page: '2' });
});

test('parses cookies from the Cookie header', () => {
  const req = enhanceRequest(fakeReq('/', { cookie: 'a=1; b=hello%20there' }));
  assert.deepEqual(req.cookies, { a: '1', b: 'hello there' });
});

test('req.get() reads headers case-insensitively', () => {
  const req = enhanceRequest(fakeReq('/', { 'content-type': 'application/json' }));
  assert.equal(req.get('Content-Type'), 'application/json');
});

test('req.is() checks the content type', () => {
  const req = enhanceRequest(fakeReq('/', { 'content-type': 'application/json; charset=utf-8' }));
  assert.equal(req.is('application/json'), true);
  assert.equal(req.is('text/html'), false);
});

test('collapses duplicate slashes and strips trailing slash', () => {
  const req = enhanceRequest(fakeReq('//a///b/'));
  assert.equal(req.pathname, '/a/b');
});

test('req.ip falls back to socket.remoteAddress when trustProxy is not set (default)', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '10.0.0.5' },
  });
  assert.equal(req.ip, '10.0.0.5');
});

test('req.ip with trustProxy: true blindly trusts the left-most X-Forwarded-For entry (legacy mode)', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    socket: { remoteAddress: '10.0.0.1' },
    app: { trustProxy: true },
  });
  assert.equal(req.ip, '203.0.113.7');
});

test('req.ip with numeric trustProxy: 1 trusts only the right-most (nearest-proxy-added) entry', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 198.51.100.1' },
    socket: { remoteAddress: '10.0.0.1' },
    app: { trustProxy: 1 },
  });
  assert.equal(req.ip, '198.51.100.1');
});

test('req.ip with numeric trustProxy: 2 trusts the two right-most entries and returns the one before them', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.2' },
    socket: { remoteAddress: '10.0.0.1' },
    app: { trustProxy: 2 },
  });
  assert.equal(req.ip, '203.0.113.7');
});

test('req.ip with an allow-listed trustProxy array walks past trusted proxies to find the real client', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.2, 10.0.0.1' },
    socket: { remoteAddress: '10.0.0.1' },
    app: { trustProxy: ['10.0.0.1', '10.0.0.2'] },
  });
  assert.equal(req.ip, '203.0.113.7');
});

test('req.ip with an allow-listed trustProxy array ignores X-Forwarded-For entirely if the direct peer is untrusted', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '198.51.100.9' },
    app: { trustProxy: ['10.0.0.1'] },
  });
  assert.equal(req.ip, '198.51.100.9');
});

test('req.ip with a trustProxy array still matches when the peer address is IPv4-mapped IPv6 (regression test)', () => {
  const req = enhanceRequest({
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    socket: { remoteAddress: '::ffff:10.0.0.1' },
    app: { trustProxy: ['10.0.0.1'] },
  });
  assert.equal(req.ip, '203.0.113.7');
});

test('req.query returns a plain string for a key that appears once', () => {
  const req = enhanceRequest(fakeReq('/search?tag=blue'));
  assert.deepEqual(req.query, { tag: 'blue' });
});

test('req.query collects a repeated key into an array instead of keeping only the last value (regression test)', () => {
  const req = enhanceRequest(fakeReq('/search?tag=blue&tag=red&tag=green'));
  assert.deepEqual(req.query, { tag: ['blue', 'red', 'green'] });
});

test('req.query handles a mix of single and repeated keys', () => {
  const req = enhanceRequest(fakeReq('/search?q=shoes&tag=blue&tag=red&page=2'));
  assert.deepEqual(req.query, { q: 'shoes', tag: ['blue', 'red'], page: '2' });
});

test('req.query treats a repeated "__proto__" key as an ordinary key, not a prototype write (regression test)', () => {
  const req = enhanceRequest(fakeReq('/search?__proto__=a&__proto__=b&normal=1'));

  assert.equal(Object.getPrototypeOf(req.query), Object.prototype, 'req.query must keep the normal Object.prototype');
  assert.deepEqual(Object.keys(req.query).sort(), ['__proto__', 'normal']);
  assert.deepEqual(req.query.__proto__, ['a', 'b']);
  assert.equal(req.query.normal, '1');
});

test('req.query treats a single "constructor"/"toString" key as an ordinary key too', () => {
  const req = enhanceRequest(fakeReq('/search?constructor=evil&toString=also-evil'));
  assert.equal(Object.getPrototypeOf(req.query), Object.prototype);
  assert.equal(req.query.constructor, 'evil');
  assert.equal(req.query.toString, 'also-evil');
});
