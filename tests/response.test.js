import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceResponse } from '../src/response.js';

function fakeRes() {
  const res = {
    _headers: {},
    _body: undefined,
    statusCode: 200,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    getHeader(k) { return this._headers[k.toLowerCase()]; },
    end(chunk) { this._body = chunk; },
  };
  return enhanceResponse(res);
}

test('res.json sets Content-Type and serializes the body', () => {
  const res = fakeRes();
  res.json({ a: 1 });
  assert.equal(res.getHeader('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res._body, '{"a":1}');
});

test('res.status is chainable', () => {
  const res = fakeRes();
  res.status(201).json({ created: true });
  assert.equal(res.statusCode, 201);
});

test('res.send infers JSON for plain objects', () => {
  const res = fakeRes();
  res.send({ x: 1 });
  assert.equal(res._body, '{"x":1}');
});

test('res.cookie sets a Set-Cookie header with HttpOnly by default', () => {
  const res = fakeRes();
  res.cookie('session', 'abc123');
  const cookie = res.getHeader('Set-Cookie');
  assert.match(cookie, /^session=abc123/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('res.cookie rejects a name with CR/LF or other header-breaking characters (regression test)', () => {
  const res = fakeRes();
  assert.throws(() => res.cookie('session\r\nSet-Cookie: evil=1', 'abc123'), TypeError);
});

test('res.redirect sets status and Location header', () => {
  const res = fakeRes();
  res.redirect('/login');
  assert.equal(res.statusCode, 302);
  assert.equal(res.getHeader('Location'), '/login');
});

test('res.redirect accepts a custom status code', () => {
  const res = fakeRes();
  res.redirect('/new-place', 301);
  assert.equal(res.statusCode, 301);
  assert.equal(res.getHeader('Location'), '/new-place');
});

test('res.redirect rejects a url with CR/LF (header/response-splitting injection, regression test)', () => {
  const res = fakeRes();
  assert.throws(() => res.redirect('/x\r\nSet-Cookie: evil=1'), TypeError);
  assert.throws(() => res.redirect('/x\nLocation: https://evil.example'), TypeError);
  assert.equal(res._body, undefined);
});
