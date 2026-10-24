'use strict';
// Compares row counts between the SQLite file and the configured PostgreSQL
// database for every known table. Read-only; used to verify data migration.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');

const TABLES = [
  'users', 'password_reset_tokens', 'user_preferences', 'user_auth_versions',
  'user_account_access', 'public_portfolios', 'mt5_pairing_codes', 'mt5_accounts',
  'public_portfolio_accounts', 'mt5_installations', 'mt5_snapshots', 'mt5_positions',
  'mt5_deals', 'user_avatars', 'direct_messages', 'support_messages', 'feed_posts',
  'feed_comments', 'feed_likes', 'feed_reports', 'market_drawings', 'market_candles',
  'economic_calendar_cache'
];

const sqlitePath = path.join(__dirname, '..', 'database.sqlite');
const sqlite = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
const liteCount = table => new Promise(resolve => {
  sqlite.get(`SELECT COUNT(*) AS c FROM ${table}`, (error, row) => resolve(error ? 'n/a' : row.c));
});

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  let mismatches = 0;
  console.log('table                         sqlite   postgres');
  for (const table of TABLES) {
    const lite = await liteCount(table);
    let pgCount = 'n/a';
    try {
      const result = await pg.query(`SELECT COUNT(*)::bigint AS c FROM ${table}`);
      pgCount = Number(result.rows[0].c);
    } catch { /* table missing */ }
    const flag = (lite !== 'n/a' && pgCount !== 'n/a' && Number(pgCount) < Number(lite)) ? '  <-- PG BEHIND' : '';
    if (flag) mismatches += 1;
    console.log(`${table.padEnd(28)} ${String(lite).padStart(8)} ${String(pgCount).padStart(10)}${flag}`);
  }
  await pg.end();
  sqlite.close();
  console.log(mismatches ? `\n${mismatches} table(s) behind in PostgreSQL` : '\nPostgreSQL is at parity or ahead for every table.');
})().catch(error => { console.error(error.message); process.exit(1); });
