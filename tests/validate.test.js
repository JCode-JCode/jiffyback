import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v, validate, ValidationError } from '../src/validate.js';

test('string(): required by default, rejects missing/wrong-type values', () => {
  const schema = v.string();
  assert.deepEqual(schema.safeParse('hi'), { success: true, data: 'hi' });
  assert.equal(schema.safeParse(undefined).success, false);
  assert.equal(schema.safeParse(42).success, false);
});

test('string(): min/max/length/pattern', () => {
  assert.equal(v.string().min(3).safeParse('ab').success, false);
  assert.equal(v.string().max(3).safeParse('abcd').success, false);
  assert.equal(v.string().length(4).safeParse('abcd').success, true);
  assert.equal(v.string().length(4).safeParse('abc').success, false);
  assert.equal(v.string().pattern(/^[a-z]+$/).safeParse('abc123').success, false);
});

test('string(): email()', () => {
  assert.equal(v.string().email().safeParse('a@b.com').success, true);
  assert.equal(v.string().email().safeParse('not-an-email').success, false);
});

test('string(): trim() trims before length checks', () => {
  const result = v.string().trim().min(1).safeParse('  hi  ');
  assert.deepEqual(result, { success: true, data: 'hi' });
});

test('string(): optional()/nullable()/default()', () => {
  assert.deepEqual(v.string().optional().safeParse(undefined), { success: true, data: undefined });
  assert.deepEqual(v.string().nullable().safeParse(null), { success: true, data: null });
  assert.deepEqual(v.string().default('x').safeParse(undefined), { success: true, data: 'x' });
});

test('number(): type checking, min/max/integer', () => {
  assert.equal(v.number().safeParse('42').success, false);
  assert.equal(v.number().safeParse(42).success, true);
  assert.equal(v.number().safeParse(NaN).success, false);
  assert.equal(v.number().min(0).safeParse(-1).success, false);
  assert.equal(v.number().max(10).safeParse(11).success, false);
  assert.equal(v.number().integer().safeParse(1.5).success, false);
  assert.equal(v.number().positive().safeParse(0).success, false);
  assert.equal(v.number().positive().safeParse(1).success, true);
});

test('number(): coerce() accepts numeric strings (form/query input)', () => {
  assert.deepEqual(v.number().coerce().safeParse('42'), { success: true, data: 42 });
  assert.equal(v.number().coerce().safeParse('not-a-number').success, false);
});

test('boolean(): strict by default, coerce() accepts form/query shapes', () => {
  assert.equal(v.boolean().safeParse('true').success, false);
  assert.equal(v.boolean().safeParse(true).success, true);
  assert.deepEqual(v.boolean().coerce().safeParse('true'), { success: true, data: true });
  assert.deepEqual(v.boolean().coerce().safeParse('0'), { success: true, data: false });
});

test('object(): validates each declared key and drops unknown keys by default', () => {
  const schema = v.object({ name: v.string(), age: v.number().optional() });
  const result = schema.safeParse({ name: 'Ali', age: 20, extra: 'ignored' });
  assert.deepEqual(result, { success: true, data: { name: 'Ali', age: 20 } });
});

test('object(): strict() rejects unknown keys', () => {
  const schema = v.object({ name: v.string() }).strict();
  const result = schema.safeParse({ name: 'Ali', extra: 'nope' });
  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'extra'));
});

test('object(): nested object errors carry a dotted path', () => {
  const schema = v.object({ user: v.object({ email: v.string().email() }) });
  const result = schema.safeParse({ user: { email: 'nope' } });
  assert.equal(result.success, false);
  assert.deepEqual(result.errors, [{ path: 'user.email', message: 'Invalid email address' }]);
});

test('array(): validates length and each item, with indexed error paths', () => {
  const schema = v.array(v.number());
  assert.equal(schema.safeParse('not an array').success, false);
  assert.equal(schema.min(2).safeParse([1]).success, false);
  assert.equal(schema.max(1).safeParse([1, 2]).success, false);

  const result = schema.safeParse([1, 'two', 3]);
  assert.equal(result.success, false);
  assert.deepEqual(result.errors, [{ path: '[1]', message: 'Must be a number' }]);
});

test('array() of object(): error paths combine index and key (e.g. "[0].price")', () => {
  const schema = v.array(v.object({ price: v.number() }));
  const result = schema.safeParse([{ price: 'free' }]);
  assert.equal(result.success, false);
  assert.deepEqual(result.errors, [{ path: '[0].price', message: 'Must be a number' }]);
});

test('refine(): custom validation with a message', () => {
  const schema = v.number().refine((n) => n % 2 === 0, 'Must be even');
  assert.equal(schema.safeParse(3).success, false);
  assert.equal(schema.safeParse(4).success, true);
});

test('schemas are immutable: chaining returns a new schema, never mutates the original', () => {
  const base = v.string();
  const withMin = base.min(5);
  assert.equal(base.safeParse('ab').success, true);
  assert.equal(withMin.safeParse('ab').success, false);
});

test('parse() throws ValidationError with a readable message; safeParse() never throws', () => {
  assert.throws(() => v.string().parse(42), ValidationError);
  assert.doesNotThrow(() => v.string().safeParse(42));
});

test('validate() middleware: replaces req.body with parsed data on success', () => {
  const schema = v.object({ name: v.string() });
  const middleware = validate(schema);
  const req = { body: { name: 'Ali', junk: 'x' } };
  let nextCalled = false;
  const res = { status() { throw new Error('should not be called'); } };
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.body, { name: 'Ali' });
});

test('validate() middleware: responds 400 with issues on failure and does not call next()', () => {
  const schema = v.object({ name: v.string() });
  const middleware = validate(schema);
  const req = { body: {} };
  let statusCode, jsonBody;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; },
  };
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 400);
  assert.equal(jsonBody.error, 'Validation failed');
  assert.deepEqual(jsonBody.errors, [{ path: 'name', message: 'Required' }]);
});

test('validate() middleware: supports source: "query"', () => {
  const schema = v.object({ page: v.number().coerce() });
  const middleware = validate(schema, { source: 'query' });
  const req = { query: { page: '2' } };
  const res = {};
  middleware(req, res, () => {});
  assert.deepEqual(req.query, { page: 2 });
});
