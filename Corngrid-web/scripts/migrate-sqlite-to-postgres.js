'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sqlitePath = args.sqlite || process.env.SQLITE_PATH || path.join(__dirname, '..', 'database.sqlite');
const databaseUrl = args['database-url'] || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL (or --database-url) is required.');
  process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found: ${sqlitePath}`);
  process.exit(1);
}

const TABLES = [
  'users', 'password_reset_tokens', 'user_preferences', 'user_auth_versions',
  'user_account_access', 'public_portfolios', 'mt5_pairing_codes', 'mt5_accounts',
  'public_portfolio_accounts', 'mt5_installations', 'mt5_snapshots', 'mt5_positions',
  'mt5_deals', 'user_avatars', 'direct_messages', 'support_messages', 'feed_posts',
  'feed_comments', 'feed_likes', 'feed_reports', 'market_drawings', 'market_candles',
  'economic_calendar_cache', 'email_verification_codes', 'email_verification_requests'
];
const CONFLICT_TARGETS = {
  users: 'id', password_reset_tokens: 'token_hash', user_preferences: 'user_id',
  user_auth_versions: 'user_id', user_account_access: 'user_id', public_portfolios: 'user_id',
  mt5_pairing_codes: 'code_hash', mt5_accounts: 'id', public_portfolio_accounts: 'account_id',
  mt5_installations: 'id', mt5_snapshots: 'id', mt5_positions: 'id', mt5_deals: 'id',
  user_avatars: 'user_id', direct_messages: 'id', support_messages: 'id', feed_posts: 'id',
  feed_comments: 'id', feed_likes: 'user_id, post_id', feed_reports: 'id', market_drawings: 'id',
  market_candles: 'feed, symbol, tf, t', economic_calendar_cache: 'id',
  email_verification_codes: 'user_id', email_verification_requests: 'id'
};

const BOOLEAN_COLUMNS = new Set(['users.email_verified']);

const SERIAL_TABLES = [
  'users', 'mt5_accounts', 'mt5_installations', 'mt5_snapshots', 'mt5_positions',
  'mt5_deals', 'direct_messages', 'support_messages', 'feed_posts', 'feed_comments',
  'feed_reports', 'market_drawings', 'email_verification_requests'
];

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function sqliteColumns(db, table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (error, rows) => {
      if (error) return reject(error);
      resolve((rows || []).map(row => row.name));
    });
  });
}

function sqliteTableExists(db, table) {
  return new Promise((resolve, reject) => {
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table], (error, row) => {
      if (error) return reject(error);
      resolve(Boolean(row));
    });
  });
}

function convertValue(table, column, value) {
  if (value === undefined) return null;
  if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) {
    return value === 1 || value === true || value === '1';
  }
  if (table === 'users' && column === 'created_at' && typeof value === 'string') {
    let text = value.trim();
    if (!text.includes('T')) text = text.replace(' ', 'T');
    if (!/[zZ]$/.test(text) && !/[+-]\d{2}:?\d{2}$/.test(text)) text += 'Z';
    return text;
  }
  return value;
}

async function main() {
  const sqlite = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();

  try {
    const schemaDir = path.join(__dirname, '..', 'migrations', 'postgres');
    const schemaFiles = fs.readdirSync(schemaDir)
      .filter(name => name.endsWith('.sql'))
      .sort();
    console.log('Applying PostgreSQL schema migrations...');
    for (const schemaFile of schemaFiles) {
      console.log(`  ${schemaFile}`);
      await pg.query(fs.readFileSync(path.join(schemaDir, schemaFile), 'utf8'));
    }

    await pg.query('BEGIN');
    for (const table of TABLES) {
      const exists = await sqliteTableExists(sqlite, table);
      if (!exists) {
        console.log(`Skipping missing SQLite table: ${table}`);
        continue;
      }
      const columns = await sqliteColumns(sqlite, table);
      if (!columns.length) continue;
      const rows = await sqliteAll(sqlite, `SELECT * FROM ${table}`);
      if (!rows.length) {
        console.log(`${table}: 0 rows`);
        continue;
      }
      const quotedColumns = columns.map(name => `"${name}"`).join(', ');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const conflict = CONFLICT_TARGETS[table]
        ? `ON CONFLICT (${CONFLICT_TARGETS[table]}) DO NOTHING`
        : '';
      const sql = `INSERT INTO ${table} (${quotedColumns}) VALUES (${placeholders}) ${conflict}`;
      let inserted = 0;
      for (const row of rows) {
        const values = columns.map(column => convertValue(table, column, row[column]));
        const result = await pg.query(sql, values);
        inserted += result.rowCount || 0;
      }
      console.log(`${table}: ${rows.length} source rows, ${inserted} inserted`);
    }
    await pg.query('COMMIT');

    for (const table of SERIAL_TABLES) {
      try {
        await pg.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
      } catch (error) {
      }
    }

    console.log('\nVerification (source -> target):');
    for (const table of TABLES) {
      const exists = await sqliteTableExists(sqlite, table);
      if (!exists) continue;
      const sourceCount = (await sqliteAll(sqlite, `SELECT COUNT(*) AS count FROM ${table}`))[0].count;
      const targetResult = await pg.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
      const targetCount = targetResult.rows[0].count;
      console.log(`  ${table}: ${sourceCount} -> ${targetCount}`);
    }

    console.log('\nMigration completed successfully.');
  } catch (error) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    console.error('Migration failed:', error.message);
    if (error.stack) console.error(error.stack);
    process.exitCode = 1;
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

