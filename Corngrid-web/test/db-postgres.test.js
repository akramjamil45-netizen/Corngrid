'use strict';

// Integration tests for the PostgreSQL adapter (db-postgres.js) and the
// migration runner. These run against a dedicated local test database
// (corngrid_test by default) and never touch the production database.
// When PostgreSQL is unreachable the whole file is skipped with a notice.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!process.env.DATABASE_URL) return null;
  try {
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/corngrid_test';
    return url.toString();
  } catch {
    return null;
  }
}

const TEST_URL = testDatabaseUrl();
if (TEST_URL) {
  const dbName = new URL(TEST_URL).pathname.replace(/^\//, '');
  assert.ok(/(_test|_loadtest)$/i.test(dbName),
    `TEST database must be a dedicated *_test database, got "${dbName}". Refusing to run against it.`);
}

async function pgAvailable(url) {
  if (!url) return false;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const available = await pgAvailable(TEST_URL);
  if (!available) {
    test.skip('PostgreSQL test database unavailable; set TEST_DATABASE_URL to a local *_test database', () => {});
    return;
  }
  const { applyPostgresMigrations } = require('../db-migrate');
  const createPostgresDatabase = require('../db-postgres');

  // Small pool on purpose: the concurrency test must exercise queueing.
  process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '10';

  const run = (db, sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function (error) { return error ? reject(error) : resolve({ changes: this.changes, lastID: this.lastID }); }));
  const get = (db, sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  const all = (db, sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

  // Fresh schema for the whole file.
  const admin = new Client({ connectionString: TEST_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await applyPostgresMigrations(TEST_URL, { logger: { log() {}, warn() {} } });

  // Scratch table for destructive probes (created via raw pg, not the adapter,
  // because the adapter intentionally no-ops DDL).
  const setup = new Client({ connectionString: TEST_URL });
  await setup.connect();
  await setup.query('CREATE TABLE adapter_probe (id SERIAL PRIMARY KEY, name TEXT UNIQUE, n BIGINT, x DOUBLE PRECISION)');
  await setup.end();

  const db = createPostgresDatabase(TEST_URL);

  test.after(() => new Promise(resolve => db.close(resolve)));

  test('connection and health check', async () => {
    const row = await get(db, 'SELECT 1 AS ok');
    assert.equal(row.ok, 1);
    assert.equal(db.dialect, 'postgres');
  });

  test('migrations are idempotent and tracked', async () => {
    const again = await applyPostgresMigrations(TEST_URL, { logger: { log() {}, warn() {} } });
    assert.equal(again.applied.length, 0, 'second run applies nothing');
    assert.ok(again.skipped.includes('0001_initial.sql'));
    const tracked = await get(db, 'SELECT COUNT(*) AS count FROM schema_migrations');
    assert.ok(tracked.count >= 1);
  });

  test('INSERT returns lastID and changes; numeric types come back as numbers', async () => {
    const inserted = await run(db, 'INSERT INTO adapter_probe (name, n, x) VALUES (?, ?, ?)', ['alpha', 900719925474000, 1.5]);
    assert.equal(inserted.changes, 1);
    assert.equal(typeof inserted.lastID, 'number');
    const row = await get(db, 'SELECT * FROM adapter_probe WHERE id = ?', [inserted.lastID]);
    assert.equal(row.name, 'alpha');
    assert.equal(typeof row.n, 'number');
    assert.equal(row.n, 900719925474000);
    assert.equal(row.x, 1.5);
  });

  test('UPDATE and DELETE report affected-row counts', async () => {
    const updated = await run(db, 'UPDATE adapter_probe SET x = ? WHERE name = ?', [2.5, 'alpha']);
    assert.equal(updated.changes, 1);
    const noop = await run(db, 'UPDATE adapter_probe SET x = ? WHERE name = ?', [9, 'nobody']);
    assert.equal(noop.changes, 0);
    const deleted = await run(db, 'DELETE FROM adapter_probe WHERE name = ?', ['alpha']);
    assert.equal(deleted.changes, 1);
  });

  test('placeholders inside strings, quoted identifiers and comments are untouched', async () => {
    const inserted = await run(db,
      "INSERT INTO adapter_probe (name, n) VALUES (?, ?) -- trailing ? comment\n/* block ? comment */",
      ['what? really', 1]);
    const row = await get(db, 'SELECT name FROM adapter_probe WHERE id = ?', [inserted.lastID]);
    assert.equal(row.name, 'what? really');
    const literal = await get(db, "SELECT 'a?b' AS v, CAST(? AS INTEGER) AS p", [7]);
    assert.equal(literal.v, 'a?b');
    assert.equal(literal.p, 7);
  });

  test('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING', async () => {
    const first = await run(db, 'INSERT OR IGNORE INTO adapter_probe (name, n) VALUES (?, ?)', ['dupe', 1]);
    assert.equal(first.changes, 1);
    const second = await run(db, 'INSERT OR IGNORE INTO adapter_probe (name, n) VALUES (?, ?)', ['dupe', 2]);
    assert.equal(second.changes, 0);
    const count = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['dupe']);
    assert.equal(count.count, 1);
  });

  test('ON CONFLICT DO UPDATE upsert keeps working', async () => {
    const user = await run(db, 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      ['upsert-probe', 'upsert-probe@example.test', 'x']);
    const userId = user.lastID;
    await run(db, `INSERT INTO user_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at`,
      [userId, '{"a":1}', 1000]);
    const again = await run(db, `INSERT INTO user_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at`,
      [userId, '{"a":2}', 2000]);
    assert.equal(again.changes, 1);
    const row = await get(db, 'SELECT preferences_json, updated_at FROM user_preferences WHERE user_id = ?', [userId]);
    assert.equal(row.preferences_json, '{"a":2}');
    assert.equal(row.updated_at, 2000);
    await run(db, 'DELETE FROM users WHERE id = ?', [userId]);
  });

  test('transactions commit and roll back on a pinned connection', async () => {
    await run(db, 'BEGIN IMMEDIATE');
    await run(db, 'INSERT INTO adapter_probe (name, n) VALUES (?, ?)', ['tx-commit', 1]);
    const insideTx = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['tx-commit']);
    assert.equal(insideTx.count, 1, 'read inside the transaction sees the write');
    await run(db, 'COMMIT');
    const afterCommit = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['tx-commit']);
    assert.equal(afterCommit.count, 1);

    await run(db, 'BEGIN');
    await run(db, 'INSERT INTO adapter_probe (name, n) VALUES (?, ?)', ['tx-rollback', 1]);
    await run(db, 'ROLLBACK');
    const afterRollback = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['tx-rollback']);
    assert.equal(afterRollback.count, 0);
  });

  test('a nested BEGIN is rejected and the transaction can still roll back', async () => {
    await run(db, 'BEGIN');
    await assert.rejects(() => run(db, 'BEGIN'), /within a transaction/);
    await run(db, 'ROLLBACK');
    const ok = await get(db, 'SELECT 1 AS ok');
    assert.equal(ok.ok, 1, 'pool is healthy after the aborted transaction');
  });


  test('COLLATE NOCASE equality is rewritten to case-insensitive match', async () => {
    await run(db, 'INSERT INTO adapter_probe (name, n) VALUES (?, ?)', ['MixedCase@Test.com', 5]);
    const row = await get(db, 'SELECT id, name FROM adapter_probe WHERE name = ? COLLATE NOCASE', ['mixedcase@test.com']);
    assert.ok(row, 'case-insensitive match found');
    assert.equal(row.name, 'MixedCase@Test.com');
    const hits = await all(db, 'SELECT id FROM adapter_probe WHERE name LIKE ? COLLATE NOCASE', ['mixedcase%']);
    assert.equal(hits.length, 1, 'LIKE ... COLLATE NOCASE became ILIKE');
  });

  test('json_each(?) is rewritten for position cleanup style queries', async () => {
    const rows = await all(db, 'SELECT value FROM json_each(?) ORDER BY value', ['["a","b","c"]']);
    assert.deepEqual(rows.map(row => row.value), ['a', 'b', 'c']);
  });

  test('parameters are always bound (SQL injection resistance)', async () => {
    const payload = "x'; DROP TABLE adapter_probe; --";
    await run(db, 'INSERT INTO adapter_probe (name, n) VALUES (?, ?)', [payload, 1]);
    const row = await get(db, 'SELECT name FROM adapter_probe WHERE name = ?', [payload]);
    assert.equal(row.name, payload);
    const stillThere = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe');
    assert.ok(stillThere.count > 0, 'table survived the injection attempt');
  });

  test('100 concurrent mixed operations resolve without pool exhaustion', async () => {
    const jobs = [];
    for (let i = 0; i < 100; i += 1) {
      if (i % 2 === 0) jobs.push(run(db, 'INSERT INTO adapter_probe (name, n) VALUES (?, ?)', [`bulk-${i}`, i]));
      else jobs.push(get(db, 'SELECT COUNT(*) AS count FROM adapter_probe'));
    }
    const results = await Promise.all(jobs);
    assert.equal(results.length, 100);
    for (let i = 0; i < 100; i += 2) assert.equal(results[i].changes, 1);
    const stats = db.poolStats();
    assert.ok(stats.total <= stats.max, `pool size ${stats.total} stays within max ${stats.max}`);
    const count = await get(db, "SELECT COUNT(*) AS count FROM adapter_probe WHERE name LIKE 'bulk-%'");
    assert.equal(count.count, 50);
  });

  test('a failed statement returns an error and the pool recovers', async () => {
    await assert.rejects(() => run(db, 'UPDATE missing_table SET x = 1'), /missing_table/);
    const ok = await get(db, 'SELECT 1 AS ok');
    assert.equal(ok.ok, 1);
  });

  test('callback style (node-sqlite3 signature) still works', async () => {
    const row = await new Promise((resolve, reject) =>
      db.get('SELECT COUNT(*) AS count FROM adapter_probe', [], (error, result) => error ? reject(error) : resolve(result)));
    assert.ok(row.count > 0);
  });

  test('INSERT OR REPLACE fails loudly instead of silently misbehaving', async () => {
    await assert.rejects(
      () => run(db, 'INSERT OR REPLACE INTO adapter_probe (name, n) VALUES (?, ?)', ['x', 1]),
      /INSERT OR REPLACE/);
  });

  test('an open transaction never leaks into a concurrent request context', async () => {
    // Context B is created from the test root (like an independent HTTP
    // request) BEFORE the transaction opens, so it must not observe the
    // uncommitted row even while context A's transaction is in flight.
    let releaseGate;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const contextB = (async () => {
      await gate;
      await new Promise(resolve => setImmediate(resolve));
      const outside = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['tx-isolation']);
      return outside.count;
    })();

    await run(db, 'BEGIN');
    await run(db, 'INSERT INTO adapter_probe (name, n) VALUES (?, ?)', ['tx-isolation', 1]);
    const inside = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['tx-isolation']);
    assert.equal(inside.count, 1, 'transaction context sees its own uncommitted write');
    releaseGate();
    const outside = await contextB;
    assert.equal(outside, 0, 'concurrent context does not see the uncommitted write');
    await run(db, 'COMMIT');

    const after = await get(db, 'SELECT COUNT(*) AS count FROM adapter_probe WHERE name = ?', ['tx-isolation']);
    assert.equal(after.count, 1, 'committed row is visible afterwards');
    assert.ok(db.poolStats().total <= db.poolStats().max);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

