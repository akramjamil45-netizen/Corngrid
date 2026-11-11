const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const createDatabaseRouter = require('../db-router');
const { exclusive } = require('../db-write');

const run = (db, sql, params = []) => new Promise((resolve, reject) =>
  db.run(sql, params, function (error) { return error ? reject(error) : resolve(this); }));
const get = (db, sql, params = []) => new Promise((resolve, reject) =>
  db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('router returns every row and supports callback-free startup writes', async () => {
  const primary = new sqlite3.Database(':memory:');
  const db = createDatabaseRouter({ primary, dbPath: ':memory:', readSize: 0 });
  try {
    db.exec('CREATE TABLE startup_test (id INTEGER PRIMARY KEY, value TEXT)');
    await new Promise((resolve,reject)=>db.get('SELECT 1 FROM startup_test',[],e=>e?reject(e):resolve()));
    db.run('INSERT INTO startup_test VALUES(1,?)',['first']);
    await run(db,'INSERT INTO startup_test VALUES(2,?)',['second']);
    const rows = await new Promise((resolve,reject)=>db.all('SELECT * FROM startup_test ORDER BY id',[],(e,r)=>e?reject(e):resolve(r)));
    assert.deepEqual(rows.map(r=>r.value), ['first','second']);
    const columns = await new Promise((resolve,reject)=>db.all('PRAGMA table_info(startup_test)',[],(e,r)=>e?reject(e):resolve(r)));
    assert.deepEqual(columns.map(r=>r.name), ['id','value']);
  } finally { await new Promise(resolve=>db.close(resolve)); }
});

test('read router uses read-only connections but keeps read-your-writes consistency', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-router-'));
  const dbPath = path.join(root, 'database.sqlite');
  const primary = new sqlite3.Database(dbPath);
  const db = createDatabaseRouter({ primary, dbPath, readSize: 3 });

  await run(db, 'PRAGMA journal_mode = WAL');
  await run(db, 'CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');

  db.enableReads();
  await wait(50);
  assert.equal(db.readerCount(), 3, 'the read pool opened its connections');

  await run(db, 'INSERT INTO items (name) VALUES (?)', ['alpha']);
  const committed = await get(db, 'SELECT name FROM items WHERE id = 1');
  assert.equal(committed.name, 'alpha', 'committed writes are visible to read connections');

  await exclusive(db, async () => {
    await run(db, 'BEGIN IMMEDIATE');
    await run(db, 'INSERT INTO items (name) VALUES (?)', ['beta']);
    const pending = await get(db, 'SELECT COUNT(*) AS count FROM items');
    assert.equal(pending.count, 2, 'reads inside a write block see uncommitted writes');
    await run(db, 'COMMIT');
  });

  const afterCommit = await get(db, 'SELECT COUNT(*) AS count FROM items');
  assert.equal(afterCommit.count, 2);

  await new Promise(resolve => db.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('read router with size 0 keeps every read on the primary connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-router-'));
  const dbPath = path.join(root, 'database.sqlite');
  const primary = new sqlite3.Database(dbPath);
  const db = createDatabaseRouter({ primary, dbPath, readSize: 0 });

  await run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.enableReads();
  assert.equal(db.readerCount(), 0);
  await run(db, 'INSERT INTO t (v) VALUES (?)', ['only']);
  assert.equal((await get(db, 'SELECT v FROM t WHERE id = 1')).v, 'only');

  await new Promise(resolve => db.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
