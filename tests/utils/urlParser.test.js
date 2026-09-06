import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseURL } from '../../src/utils/urlParser.js';

test('parses pathname and query string', () => {
  const { pathname, queryString } = parseURL('/search?q=hello&page=2');
  assert.equal(pathname, '/search');
  assert.equal(queryString, 'q=hello&page=2');
});

test('decodes a normally-encoded pathname exactly once', () => {
  const { pathname } = parseURL('/caf%C3%A9');
  assert.equal(pathname, '/café');
});

test('does not throw on malformed percent-encoding, leaves it raw instead', () => {
  const { pathname } = parseURL('/%E0%A4%A');
  assert.equal(pathname, '/%E0%A4%A');
});

test('collapses duplicate slashes and strips trailing slash', () => {
  const { pathname } = parseURL('//a///b/');
  assert.equal(pathname, '/a/b');
});
