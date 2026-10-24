'use strict';
// Diagnostic: verify PostgreSQL connectivity and list schema state.
// Usage: node scripts/pg-check.js [--database-url postgres://...]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const urlArg = process.argv.find(a => a.startsWith('--database-url='));
const url = urlArg ? urlArg.slice('--database-url='.length) : process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

(async () => {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const version = await client.query('SHOW server_version');
    console.log('CONNECTED. PostgreSQL server_version:', version.rows[0].server_version);
    const db = await client.query('SELECT current_database() AS db, current_user AS usr');
    console.log('database:', db.rows[0].db, '| user:', db.rows[0].usr);
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log(`TABLES(${tables.rows.length}):`, tables.rows.map(r => r.table_name).join(', ') || '(none)');
    for (const t of ['users', 'mt5_accounts', 'market_candles', 'feed_posts', 'schema_migrations']) {
      try {
        const c = await client.query(`SELECT COUNT(*)::bigint AS c FROM ${t}`);
        console.log(`  ${t}: ${c.rows[0].c} rows`);
      } catch (e) {
        console.log(`  ${t}: ${e.message}`);
      }
    }
  } catch (error) {
    console.error('CONNECT FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
