import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createViewEngine } from '../src/view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, 'fixtures', 'views');

test('render() reads a view file and interpolates data', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR });
  const out = await engine.render('hello', { name: 'Ali' });
  assert.equal(out.trim(), '<p>Hello, Ali!</p>');
});

test('render() accepts a view name with or without the extension', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR });
  const a = await engine.render('hello', { name: 'X' });
  const b = await engine.render('hello.html', { name: 'X' });
  assert.equal(a, b);
});

test('{{include}} resolves and renders a partial from the same views dir, inheriting data by default', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR });
  const out = await engine.render('with-partial', { name: 'Sara' });
  assert.equal(out.trim(), '<div><span>partial says: Sara</span></div>');
});

test('render(name, data, {layout}) wraps the view output in the given layout at {{yield}}', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR });
  const out = await engine.render('child', { title: 'Hi' }, { layout: 'layout' });
  assert.equal(out.trim(), '<html><body><main>Hi</main></body></html>');
});

test('createViewEngine({ layout }) sets a default layout applied to every render() call', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR, layout: 'layout' });
  const out = await engine.render('child', { title: 'Default layout' });
  assert.equal(out.trim(), '<html><body><main>Default layout</main></body></html>');
});

test('a per-call {layout: false} (falsy) skips the default layout', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR, layout: 'layout' });
  const out = await engine.render('child', { title: 'No layout' }, { layout: false });
  assert.equal(out.trim(), '<main>No layout</main>');
});

test('rendering a nonexistent view throws a clear error instead of an fs stack trace', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR });
  await assert.rejects(() => engine.render('does-not-exist'), /view not found/i);
});

test('a view name attempting path traversal is rejected, not resolved outside the views dir', async () => {
  const engine = createViewEngine({ dir: VIEWS_DIR });
  await assert.rejects(() => engine.render('../../etc/passwd'), /invalid view name|view not found/i);
});

test('createViewEngine requires options.dir', () => {
  assert.throws(() => createViewEngine({}), TypeError);
});

test('compiled output is cached and reused across renders when the file has not changed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiffyback-views-'));
  const viewPath = path.join(tmpDir, 'cached.html');
  fs.writeFileSync(viewPath, '{{ msg }}');

  const engine = createViewEngine({ dir: tmpDir, cache: true });

  const reads = [];
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async (...args) => {
    reads.push(args[0]);
    return originalReadFile(...args);
  };
  let out1, out2;
  try {
    out1 = await engine.render('cached', { msg: 'first' });
    out2 = await engine.render('cached', { msg: 'second' });
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  assert.equal(out1, 'first');
  assert.equal(out2, 'second', 'a cached *compiled template* still re-runs with each call\'s own data');
  assert.equal(reads.filter((p) => p === viewPath).length, 1, 'the view file should only be read from disk once - the second render must reuse the cached compiled function');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cache invalidates automatically when a view file\'s mtime changes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiffyback-views-'));
  const viewPath = path.join(tmpDir, 'live.html');
  fs.writeFileSync(viewPath, 'version-1');

  const engine = createViewEngine({ dir: tmpDir, cache: true });
  assert.equal(await engine.render('live'), 'version-1');

  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(viewPath, 'version-2');

  assert.equal(await engine.render('live'), 'version-2');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cache: false always re-reads and re-compiles the file from disk', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiffyback-views-'));
  const viewPath = path.join(tmpDir, 'nocache.html');
  fs.writeFileSync(viewPath, 'A');

  const engine = createViewEngine({ dir: tmpDir, cache: false });
  assert.equal(await engine.render('nocache'), 'A');

  const statBefore = fs.statSync(viewPath);
  fs.writeFileSync(viewPath, 'B');
  fs.utimesSync(viewPath, statBefore.atime, statBefore.mtime);

  assert.equal(await engine.render('nocache'), 'B');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a self-including partial is stopped by the recursion-depth guard rather than a stack overflow', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiffyback-views-'));
  fs.writeFileSync(path.join(tmpDir, 'loop.html'), '{{include "loop"}}');
  const engine = createViewEngine({ dir: tmpDir });
  await assert.rejects(() => engine.render('loop'), /circular include|too deep/i);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
