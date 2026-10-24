'use strict';
// One-off reconciliation: mt5_snapshots diverged while both databases were
// written (same id space, different rows). Copies SQLite snapshots whose
// (account_id, captured_at) content is missing in PostgreSQL, letting the
// sequence assign fresh ids. Additive only; never overwrites.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');

const sqlitePath = path.join(__dirname, '..', 'database.sqlite');
const sqlite = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
const liteAll = (sql, params = []) => new Promise((resolve, reject) =>
  sqlite.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const rows = await liteAll('SELECT account_id, captured_at, balance, equity, floating_profit FROM mt5_snapshots ORDER BY captured_at');
  let inserted = 0;
  let skipped = 0;
  await pg.query('BEGIN');
  try {
    for (const row of rows) {
      const result = await pg.query(
        `INSERT INTO mt5_snapshots (account_id, captured_at, balance, equity, floating_profit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, captured_at) DO NOTHING`,
        [row.account_id, row.captured_at, row.balance, row.equity, row.floating_profit]
      );
      inserted += result.rowCount;
      if (!result.rowCount) skipped += 1;
    }
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
  const count = await pg.query('SELECT COUNT(*)::bigint AS c FROM mt5_snapshots');
  console.log(`sqlite rows: ${rows.length}, inserted: ${inserted}, already present: ${skipped}, postgres total now: ${count.rows[0].c}`);
  await pg.end();
  sqlite.close();
})().catch(error => { console.error(error.message); process.exit(1); });
