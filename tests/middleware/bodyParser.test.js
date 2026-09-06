import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { bodyParser } from '../../src/middleware/bodyParser.js';

function fakeReq(headers, chunks) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => {
    for (const c of chunks) req.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.status = function (c) { this.statusCode = c; return this; };
  res.json = function (body) { this._json = body; this.headersSent = true; this.emit('finish'); };
  return res;
}

test('parses application/json bodies', async () => {
  const mw = bodyParser();
  const req = fakeReq({ 'content-type': 'application/json' }, ['{"a":1,"b":"x"}']);
  const res = fakeRes();
  await new Promise((resolve) => mw(req, res, resolve));
  assert.deepEqual(req.body, { a: 1, b: 'x' });
});

test('parses application/x-www-form-urlencoded bodies', async () => {
  const mw = bodyParser();
  const req = fakeReq({ 'content-type': 'application/x-www-form-urlencoded' }, ['a=1&b=hello+world']);
  const res = fakeRes();
  await new Promise((resolve) => mw(req, res, resolve));
  assert.deepEqual(req.body, { a: '1', b: 'hello world' });
});

test('parses multipart/form-data fields and streams the file to a temp file on disk', async () => {
  const boundary = '----testboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="name"\r\n\r\n` +
    `ali\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `hello file\r\n` +
    `--${boundary}--\r\n`;

  const mw = bodyParser();
  const req = fakeReq({ 'content-type': `multipart/form-data; boundary=${boundary}` }, [body]);
  const res = fakeRes();
  await new Promise((resolve) => mw(req, res, resolve));

  assert.equal(req.body.name, 'ali');
  assert.equal(req.files.file.filename, 'a.txt');
  assert.equal(req.files.file.size, 'hello file'.length);
  assert.ok(fs.existsSync(req.files.file.path), 'temp file should exist on disk');
  assert.equal(fs.readFileSync(req.files.file.path, 'utf8'), 'hello file');

  fs.unlinkSync(req.files.file.path);
});

test('multipart upload exceeding maxFileSize is rejected with 413 (no next(), no crash)', async () => {
  const boundary = '----bigboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    'x'.repeat(1000) +
    `\r\n--${boundary}--\r\n`;

  const mw = bodyParser({ multipart: { maxFileSize: 100 } });
  const req = fakeReq({ 'content-type': `multipart/form-data; boundary=${boundary}` }, [body]);
  const res = fakeRes();
  let nextCalled = false;
  await new Promise((resolve) => {
    mw(req, res, () => { nextCalled = true; resolve(); });
    res.on('finish', resolve);
  });

  assert.equal(res.statusCode, 413);
  assert.equal(nextCalled, false);
});

test('multipart temp file is deleted automatically once the response finishes', async () => {
  const boundary = '----cleanupboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="c.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `cleanup me\r\n` +
    `--${boundary}--\r\n`;

  const mw = bodyParser();
  const req = fakeReq({ 'content-type': `multipart/form-data; boundary=${boundary}` }, [body]);
  const res = fakeRes();
  await new Promise((resolve) => mw(req, res, resolve));

  const uploadedPath = req.files.file.path;
  assert.ok(fs.existsSync(uploadedPath));

  res.emit('finish');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(uploadedPath), false);
});

test('multipart temp file survives if the handler moved it before the response finished', async () => {
  const boundary = '----moveboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="m.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `keep me\r\n` +
    `--${boundary}--\r\n`;

  const mw = bodyParser();
  const req = fakeReq({ 'content-type': `multipart/form-data; boundary=${boundary}` }, [body]);
  const res = fakeRes();
  await new Promise((resolve) => mw(req, res, resolve));

  const originalPath = req.files.file.path;
  const movedPath = `${originalPath}.kept`;
  fs.renameSync(originalPath, movedPath);

  res.emit('finish');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(fs.existsSync(originalPath), false);
  assert.equal(fs.existsSync(movedPath), true);
  assert.equal(fs.readFileSync(movedPath, 'utf8'), 'keep me');

  fs.unlinkSync(movedPath);
});

test('rejects payloads over the configured maxSize with 413', async () => {
  const mw = bodyParser({ maxSize: 5 });
  const req = fakeReq({ 'content-type': 'application/json' }, ['{"way":"too big for five bytes"}']);
  const res = fakeRes();
  let nextCalled = false;
  await new Promise((resolve) => {
    req.on('data', () => {});
    mw(req, res, () => { nextCalled = true; resolve(); });
    setTimeout(resolve, 50);
  });
  assert.equal(res.statusCode, 413);
  assert.equal(nextCalled, false);
});
