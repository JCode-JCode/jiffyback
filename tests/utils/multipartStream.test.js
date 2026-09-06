import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseMultipartStream, MultipartError } from '../../src/utils/multipartStream.js';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiffyback-test-'));

function defaultOptions(overrides = {}) {
  return {
    maxFileSize: 10 * 1024 * 1024,
    maxFieldSize: 1024 * 1024,
    maxFiles: 20,
    maxTotalSize: 50 * 1024 * 1024,
    uploadDir,
    ...overrides,
  };
}

function streamed(chunks) {
  const req = new EventEmitter();
  process.nextTick(() => {
    for (const c of chunks) req.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c));
    req.emit('end');
  });
  return req;
}

test('parses one field and one file, streaming the file to disk', async () => {
  const boundary = 'B1';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="title"\r\n\r\n` +
    `hello\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="photo"; filename="pic.jpg"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n` +
    `\x01\x02\x03binarydata` +
    `\r\n--${boundary}--\r\n`;

  const { fields, files } = await parseMultipartStream(streamed([body]), boundary, defaultOptions());

  assert.equal(fields.title, 'hello');
  assert.equal(files.photo.filename, 'pic.jpg');
  assert.equal(files.photo.contentType, 'image/jpeg');
  assert.equal(fs.readFileSync(files.photo.path).toString('latin1'), '\x01\x02\x03binarydata');
  fs.unlinkSync(files.photo.path);
});

test('reassembles a file correctly when every chunk is a single byte, including through the boundary itself', async () => {
  const boundary = 'SPLIT';
  const payload = '0123456789ABCDEF'.repeat(50);
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
  const chunks = Array.from(body, (ch) => ch);

  const { files } = await parseMultipartStream(streamed(chunks), boundary, defaultOptions());
  assert.equal(files.f.size, 800);
  assert.equal(fs.readFileSync(files.f.path, 'utf8'), payload);
  fs.unlinkSync(files.f.path);
});

test('handles two files and a field arriving as awkwardly-sized chunks that split fields, headers, and boundaries', async () => {
  const boundary = 'MULTI';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nsecond upload\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="a"; filename="a.bin"\r\n\r\n` +
    'A'.repeat(300) +
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="b"; filename="b.bin"\r\n\r\n` +
    'B'.repeat(300) +
    `\r\n--${boundary}--\r\n`;

  const chunks = [];
  for (let i = 0; i < body.length; i += 37) chunks.push(body.slice(i, i + 37));

  const { fields, files } = await parseMultipartStream(streamed(chunks), boundary, defaultOptions());
  assert.equal(fields.note, 'second upload');
  assert.equal(fs.readFileSync(files.a.path, 'utf8'), 'A'.repeat(300));
  assert.equal(fs.readFileSync(files.b.path, 'utf8'), 'B'.repeat(300));
  fs.unlinkSync(files.a.path);
  fs.unlinkSync(files.b.path);
});

test('rejects a file exceeding maxFileSize with a 413 MultipartError and deletes the partial temp file', async () => {
  const boundary = 'BIG';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n` +
    'x'.repeat(5000) +
    `\r\n--${boundary}--\r\n`;

  const before = new Set(fs.readdirSync(uploadDir));

  await assert.rejects(
    () => parseMultipartStream(streamed([body]), boundary, defaultOptions({ maxFileSize: 100 })),
    (err) => {
      assert.ok(err instanceof MultipartError);
      assert.equal(err.statusCode, 413);
      return true;
    },
  );

  const after = new Set(fs.readdirSync(uploadDir));
  assert.deepEqual([...after].filter((f) => !before.has(f)), []);
});

test('rejects a field exceeding maxFieldSize with a 413 MultipartError', async () => {
  const boundary = 'FIELDBIG';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="bio"\r\n\r\n${'y'.repeat(2000)}\r\n--${boundary}--\r\n`;

  await assert.rejects(
    () => parseMultipartStream(streamed([body]), boundary, defaultOptions({ maxFieldSize: 50 })),
    (err) => err instanceof MultipartError && err.statusCode === 413,
  );
});

test('rejects more files than maxFiles, cleaning up every temp file created so far', async () => {
  const boundary = 'MANY';
  let body = '';
  for (let i = 0; i < 5; i++) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="f${i}"; filename="f${i}.bin"\r\n\r\ndata${i}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  const before = new Set(fs.readdirSync(uploadDir));

  await assert.rejects(
    () => parseMultipartStream(streamed([body]), boundary, defaultOptions({ maxFiles: 2 })),
    (err) => err instanceof MultipartError && err.statusCode === 413,
  );

  const after = new Set(fs.readdirSync(uploadDir));
  assert.deepEqual([...after].filter((f) => !before.has(f)), []);
});

test('rejects a total payload exceeding maxTotalSize', async () => {
  const boundary = 'TOTAL';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="f.bin"\r\n\r\n` +
    'z'.repeat(2000) +
    `\r\n--${boundary}--\r\n`;

  await assert.rejects(
    () => parseMultipartStream(streamed([body]), boundary, defaultOptions({ maxTotalSize: 500 })),
    (err) => err instanceof MultipartError && err.statusCode === 413,
  );
});

test('rejects a body missing the closing boundary (truncated upload) with a 400', async () => {
  const boundary = 'TRUNC';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="f"\r\n\r\nunfinished`;

  await assert.rejects(
    () => parseMultipartStream(streamed([body]), boundary, defaultOptions()),
    (err) => err instanceof MultipartError && err.statusCode === 400,
  );
});

test('rejects a part with no name= (malformed Content-Disposition) with a 400', async () => {
  const boundary = 'NONAME';
  const body = `--${boundary}\r\nContent-Disposition: form-data\r\n\r\nvalue\r\n--${boundary}--\r\n`;

  await assert.rejects(
    () => parseMultipartStream(streamed([body]), boundary, defaultOptions()),
    (err) => err instanceof MultipartError && err.statusCode === 400,
  );
});

test('an empty file part (0 bytes) is handled without error', async () => {
  const boundary = 'EMPTY';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="empty.txt"\r\n\r\n\r\n--${boundary}--\r\n`;

  const { files } = await parseMultipartStream(streamed([body]), boundary, defaultOptions());
  assert.equal(files.f.size, 0);
  assert.equal(fs.readFileSync(files.f.path, 'utf8'), '');
  fs.unlinkSync(files.f.path);
});

test('unescapes a backslash-escaped quote inside a quoted filename param', async () => {
  const boundary = 'ESCAPED';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="f"; filename="quote: \\".jpg"\r\n\r\n` +
    `data\r\n--${boundary}--\r\n`;

  const { files } = await parseMultipartStream(streamed([body]), boundary, defaultOptions());
  assert.equal(files.f.filename, 'quote: ".jpg');
  fs.unlinkSync(files.f.path);
});

test('unescapes a backslash-escaped backslash inside a quoted name param', async () => {
  const boundary = 'ESCAPED2';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="back\\\\slash"\r\n\r\n` +
    `value\r\n--${boundary}--\r\n`;

  const { fields } = await parseMultipartStream(streamed([body]), boundary, defaultOptions());
  assert.equal(fields['back\\slash'], 'value');
});

test('prefers the RFC 5987 filename* parameter over plain filename, and percent/UTF-8-decodes it', async () => {
  const boundary = 'EXT';
  const encoded = 'r%C3%A9sum%C3%A9.pdf';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="f"; filename="fallback.pdf"; filename*=UTF-8''${encoded}\r\n\r\n` +
    `data\r\n--${boundary}--\r\n`;

  const { files } = await parseMultipartStream(streamed([body]), boundary, defaultOptions());
  assert.equal(files.f.filename, 'résumé.pdf');
  fs.unlinkSync(files.f.path);
});

test('falls back to the plain filename param when filename* is malformed', async () => {
  const boundary = 'EXTBAD';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="f"; filename="fallback.pdf"; filename*=not-a-valid-value\r\n\r\n` +
    `data\r\n--${boundary}--\r\n`;

  const { files } = await parseMultipartStream(streamed([body]), boundary, defaultOptions());
  assert.equal(files.f.filename, 'fallback.pdf');
  fs.unlinkSync(files.f.path);
});

test('propagates a request stream error and cleans up any partially-written temp file', async () => {
  const boundary = 'ERR';
  const req = new EventEmitter();
  const before = new Set(fs.readdirSync(uploadDir));

  const promise = parseMultipartStream(req, boundary, defaultOptions());
  process.nextTick(() => {
    req.emit('data', Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="f.bin"\r\n\r\nsome data`));
    req.emit('error', new Error('socket reset'));
  });

  await assert.rejects(promise, /socket reset/);
  const after = new Set(fs.readdirSync(uploadDir));
  assert.deepEqual([...after].filter((f) => !before.has(f)), []);
});
