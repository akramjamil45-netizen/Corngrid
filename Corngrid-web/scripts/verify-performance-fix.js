'use strict';
// Verifies the two queries that previously failed with
// "function max(integer, integer) does not exist" against the live database.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const createPostgresDatabase = require('../db-postgres');

const db = createPostgresDatabase(process.env.DATABASE_URL);
const all = (sql, params = []) => new Promise((resolve, reject) =>
  db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
const get = (sql, params = []) => new Promise((resolve, reject) =>
  db.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));

(async () => {
  const account = await get('SELECT id, user_id FROM mt5_accounts ORDER BY id LIMIT 1');
  if (!account) { console.log('No mt5_accounts rows; nothing to verify.'); process.exit(0); }
  console.log(`Verifying with account id=${account.id}, user_id=${account.user_id}`);

  // Query 1: /api/portfolio/performance snapshot downsampling (was line 1111).
  const since = 0;
  const until = Date.now() + 1;
  const rows1 = await all(`
    WITH ordered_snapshots AS (
      SELECT s.captured_at, s.balance, s.equity,
             ROW_NUMBER() OVER (ORDER BY s.captured_at ASC) AS row_number,
             COUNT(*) OVER () AS row_count
      FROM mt5_snapshots s
      JOIN mt5_accounts a ON a.id = s.account_id
      WHERE a.user_id = ? AND s.captured_at >= ? AND s.captured_at < ?
    )
    SELECT captured_at, balance, equity
    FROM ordered_snapshots
    WHERE row_number = 1 OR row_number = row_count
      OR row_number % COALESCE(NULLIF(CAST((row_count + 499) / 500 AS INTEGER), 0), 1) = 0
    ORDER BY captured_at ASC
  `, [account.user_id, since, until]);
  console.log(`performance snapshot query: OK (${rows1.length} rows)`);

  // Query 2: public portfolio equity curve (was line 1394).
  const rows2 = await all(`
    WITH ordered_snapshots AS (
      SELECT captured_at, balance, equity,
             ROW_NUMBER() OVER (ORDER BY captured_at ASC) AS row_number,
             COUNT(*) OVER () AS row_count
      FROM mt5_snapshots WHERE account_id = ?
    )
    SELECT captured_at, balance, equity FROM ordered_snapshots
    WHERE row_number = 1 OR row_number = row_count
      OR row_number % COALESCE(NULLIF(CAST((row_count + 499) / 500 AS INTEGER), 0), 1) = 0
    ORDER BY captured_at ASC
  `, [account.id]);
  console.log(`equity curve query: OK (${rows2.length} rows)`);

  db.close(() => process.exit(0));
})().catch(error => {
  console.error('VERIFY FAILED:', error.message);
  process.exit(1);
});
