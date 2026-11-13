'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const createDatabase = require('../db-postgres');
const { dbGet, dbRun, withTransaction } = require('../db-async');

const databaseUrl = process.env.TEST_POSTGRES_URL;
test('PostgreSQL timeouts roll back blocked writes, release the queue and survive idle connection loss', { skip: !databaseUrl, timeout: 15000 }, async () => {
  const control = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  const schema = 'availability_test_' + crypto.randomBytes(8).toString('hex');
  let db;
  await control.connect();
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    await control.query(`CREATE TABLE ${schema}.capacity (id INTEGER PRIMARY KEY, slots INTEGER NOT NULL)`);
    await control.query(`INSERT INTO ${schema}.capacity VALUES (1,20)`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', '-c search_path=' + schema);
    db = createDatabase(url.toString(), { timeouts: { connection: 1000, statement: 500, lock: 150, query: 2000 } });
    assert.equal((await dbGet(db, 'SHOW statement_timeout')).statement_timeout, '500ms');
    assert.equal((await dbGet(db, 'SHOW lock_timeout')).lock_timeout, '150ms');
    await control.query('BEGIN');
    await control.query(`UPDATE ${schema}.capacity SET slots=30 WHERE id=1`);
    await assert.rejects(withTransaction(db, async () => {
      await dbGet(db, 'SELECT * FROM capacity WHERE id=1 FOR UPDATE');
      await dbRun(db, 'UPDATE capacity SET slots=10 WHERE id=1');
    }), { code: '55P03' });
    await control.query('ROLLBACK');
    assert.equal((await dbGet(db, 'SELECT slots FROM capacity WHERE id=1')).slots, 20, 'a timed-out edit never applies later');
    await assert.rejects(withTransaction(db, async () => {
      await dbRun(db, 'UPDATE capacity SET slots=99 WHERE id=1');
      await dbGet(db, 'SELECT pg_sleep(2)');
    }), { code: '57014' });
    assert.equal((await dbGet(db, 'SELECT slots FROM capacity WHERE id=1')).slots, 20, 'statement timeout rolls the whole transaction back');
    await withTransaction(db, () => dbRun(db, 'UPDATE capacity SET slots=10 WHERE id=1'));
    assert.equal((await dbGet(db, 'SELECT slots FROM capacity WHERE id=1')).slots, 10, 'the shared write queue recovers after both failures');
    const { pid } = await dbGet(db, 'SELECT pg_backend_pid() AS pid');
    await control.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await dbGet(db, 'SELECT slots FROM capacity WHERE id=1')).slots, 10, 'an idle connection failure does not crash the website');
  } finally {
    await control.query('ROLLBACK');
    if (db) await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    // Only a randomly named test schema is ever removed; customer tables are untouched.
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
});
