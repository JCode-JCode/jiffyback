import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeJoin } from '../../src/utils/safePath.js';

const root = '/var/www/public';

test('allows a normal nested path', () => {
  const result = safeJoin(root, '/css/style.css');
  assert.equal(result, path.join(root, 'css', 'style.css'));
});

test('allows the root itself', () => {
  const result = safeJoin(root, '/');
  assert.equal(result, root);
});

test('blocks plain ../ traversal', () => {
  assert.equal(safeJoin(root, '/../../../../etc/passwd'), null);
});

test('blocks traversal buried in the middle of the path', () => {
  assert.equal(safeJoin(root, '/images/../../../../etc/passwd'), null);
});

test('blocks traversal that arrives already decoded (%2e%2e decoded upstream)', () => {
  assert.equal(safeJoin(root, '/../../etc/passwd'), null);
});

test('does not double-decode: a literal, still-encoded segment is NOT treated as traversal', () => {
  const result = safeJoin(root, '/%2e%2e/file.txt');
  assert.equal(result, path.join(root, '%2e%2e', 'file.txt'));
});

test('blocks null-byte injection attempts', () => {
  assert.equal(safeJoin(root, '/file.txt\0.jpg'), null);
});

test('treats a malformed percent-sequence as a literal, harmless path segment', () => {
  const result = safeJoin(root, '/%E0%A4%A');
  assert.equal(result, path.join(root, '%E0%A4%A'));
});
