import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, sqliteAdapter } from '../src/db.js';

function freshDb() {
  const db = createDatabase(sqliteAdapter(':memory:'));
  return db;
}

async function withUsersTable() {
  const db = freshDb();
  await db.query(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      age INTEGER,
      active INTEGER DEFAULT 1
    )
  `);
  return db;
}

test('insert() returns the new row\'s id, and the row is readable back via table().first()', async () => {
  const db = await withUsersTable();
  const id = await db.table('users').insert({ name: 'Ali', age: 25 });
  assert.equal(typeof id, 'number');
  const row = await db.table('users').where('id', id).first();
  assert.equal(row.name, 'Ali');
  assert.equal(row.age, 25);
});

test('where() with a bare value defaults to equality', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 25 });
  await db.table('users').insert({ name: 'Sara', age: 30 });
  const rows = await db.table('users').where('name', 'Sara').get();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Sara');
});

test('where() with an explicit operator', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 15 });
  await db.table('users').insert({ name: 'Sara', age: 30 });
  const adults = await db.table('users').where('age', '>=', 18).get();
  assert.deepEqual(adults.map((r) => r.name), ['Sara']);
});

test('where() with an object applies multiple AND-ed equality conditions', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 25, active: 1 });
  await db.table('users').insert({ name: 'Sara', age: 25, active: 0 });
  const rows = await db.table('users').where({ age: 25, active: 1 }).get();
  assert.deepEqual(rows.map((r) => r.name), ['Ali']);
});

test('orWhere() ORs conditions together', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 15 });
  await db.table('users').insert({ name: 'Sara', age: 30 });
  await db.table('users').insert({ name: 'Reza', age: 40 });
  const rows = await db.table('users').where('age', 15).orWhere('age', 40).get();
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Ali', 'Reza']);
});

test('whereIn()', async () => {
  const db = await withUsersTable();
  const id1 = await db.table('users').insert({ name: 'Ali', age: 1 });
  await db.table('users').insert({ name: 'Sara', age: 2 });
  const id3 = await db.table('users').insert({ name: 'Reza', age: 3 });
  const rows = await db.table('users').whereIn('id', [id1, id3]).get();
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Ali', 'Reza']);
});

test('whereIn() with an empty array matches nothing (does not send malformed SQL)', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 1 });
  const rows = await db.table('users').whereIn('id', []).get();
  assert.deepEqual(rows, []);
});

test('whereNull() / whereNotNull()', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: null });
  await db.table('users').insert({ name: 'Sara', age: 30 });
  assert.deepEqual((await db.table('users').whereNull('age').get()).map((r) => r.name), ['Ali']);
  assert.deepEqual((await db.table('users').whereNotNull('age').get()).map((r) => r.name), ['Sara']);
});

test('orderBy()/limit()/offset()', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'A', age: 3 });
  await db.table('users').insert({ name: 'B', age: 1 });
  await db.table('users').insert({ name: 'C', age: 2 });
  const rows = await db.table('users').orderBy('age', 'asc').get();
  assert.deepEqual(rows.map((r) => r.name), ['B', 'C', 'A']);

  const page = await db.table('users').orderBy('age', 'asc').limit(1).offset(1).get();
  assert.deepEqual(page.map((r) => r.name), ['C']);
});

test('limit(0) is a valid, deliberate "no rows" limit', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'A', age: 1 });
  const rows = await db.table('users').limit(0).get();
  assert.deepEqual(rows, []);
});

test('limit()/offset() reject non-integer, negative, non-finite and blank values instead of building broken/misleading SQL (regression test)', async () => {
  const db = await withUsersTable();
  const table = () => db.table('users');
  const badValues = ['Infinity', '', '   ', 'x; DROP TABLE users', -1, 1.5, NaN, null, undefined, {}];
  for (const bad of badValues) {
    assert.throws(() => table().limit(bad), TypeError, `limit(${JSON.stringify(bad)}) should throw`);
    assert.throws(() => table().offset(bad), TypeError, `offset(${JSON.stringify(bad)}) should throw`);
  }
  const count = await db.table('users').count();
  assert.equal(count, 0);
});

test('limit()/offset() still accept numeric strings (the common HTML-form/query-string shape)', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'A', age: 3 });
  await db.table('users').insert({ name: 'B', age: 1 });
  await db.table('users').insert({ name: 'C', age: 2 });
  const page = await db.table('users').orderBy('age', 'asc').limit('1').offset('1').get();
  assert.deepEqual(page.map((r) => r.name), ['C']);
});

test('select() restricts returned columns', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 25 });
  const rows = await db.table('users').select('name').get();
  assert.deepEqual(Object.keys(rows[0]), ['name']);
});

test('count()', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 15 });
  await db.table('users').insert({ name: 'Sara', age: 30 });
  assert.equal(await db.table('users').count(), 2);
  assert.equal(await db.table('users').where('age', '>=', 18).count(), 1);
});

test('update() changes matching rows and returns the changed count', async () => {
  const db = await withUsersTable();
  const id = await db.table('users').insert({ name: 'Ali', age: 25 });
  const changed = await db.table('users').where('id', id).update({ age: 26 });
  assert.equal(changed, 1);
  const row = await db.table('users').where('id', id).first();
  assert.equal(row.age, 26);
});

test('update() without where() throws rather than silently updating every row', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 25 });
  await assert.rejects(() => db.table('users').update({ age: 99 }), /where\(\) clause/);
});

test('delete() removes matching rows and returns the deleted count', async () => {
  const db = await withUsersTable();
  const id = await db.table('users').insert({ name: 'Ali', age: 25 });
  await db.table('users').insert({ name: 'Sara', age: 30 });
  const deleted = await db.table('users').where('id', id).delete();
  assert.equal(deleted, 1);
  assert.equal(await db.table('users').count(), 1);
});

test('delete() without where() throws rather than silently deleting every row', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Ali', age: 25 });
  await assert.rejects(() => db.table('users').delete(), /where\(\) clause/);
});

test('first() returns null (not undefined, not a throw) when nothing matches', async () => {
  const db = await withUsersTable();
  const row = await db.table('users').where('id', 999).first();
  assert.equal(row, null);
});

test('a value containing SQL-special characters is treated as pure data, never executed (SQL injection check)', async () => {
  const db = await withUsersTable();
  const evil = "Robert'); DROP TABLE users; --";
  await db.table('users').insert({ name: evil, age: 1 });
  const row = await db.table('users').where('name', evil).first();
  assert.equal(row.name, evil);
  assert.equal(await db.table('users').count(), 1);
});

test('an invalid table/column identifier is rejected rather than interpolated into SQL', async () => {
  const db = await withUsersTable();
  assert.throws(() => db.table('users; DROP TABLE users; --'), TypeError);
  assert.throws(() => db.table('users').where('age; --', 1), TypeError);
  assert.throws(() => db.table('users').orderBy('age; --'), TypeError);
});

test('where() rejects an unsupported operator', async () => {
  const db = await withUsersTable();
  assert.throws(() => db.table('users').where('age', 'DROP TABLE users; --', 1), TypeError);
});

test('raw db.query() runs parameterized SQL directly', async () => {
  const db = await withUsersTable();
  await db.query('INSERT INTO users (name, age) VALUES (?, ?)', ['Ali', 25]);
  const result = await db.query('SELECT * FROM users WHERE age > ?', [18]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, 'Ali');
});

test('transaction(): commits on success', async () => {
  const db = await withUsersTable();
  await db.transaction(async (tx) => {
    await tx.table('users').insert({ name: 'Ali', age: 25 });
    await tx.table('users').insert({ name: 'Sara', age: 30 });
  });
  assert.equal(await db.table('users').count(), 2);
});

test('transaction(): rolls back every change if the callback throws', async () => {
  const db = await withUsersTable();
  await db.table('users').insert({ name: 'Existing', age: 1 });
  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        await tx.table('users').insert({ name: 'ShouldRollBack', age: 2 });
        throw new Error('boom');
      }),
    /boom/
  );
  const names = (await db.table('users').get()).map((r) => r.name);
  assert.deepEqual(names, ['Existing']);
});

test('close() does not throw', async () => {
  const db = await withUsersTable();
  await assert.doesNotReject(() => db.close());
});
