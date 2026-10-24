'use strict';

// Applies migrations/postgres/*.sql to the configured PostgreSQL database.
// Runs at server startup (before the HTTP listener accepts traffic) and is
// safe to run repeatedly: applied versions are recorded in schema_migrations
// and every migration file uses IF NOT EXISTS guards, so re-runs are no-ops.
//
// A session-level advisory lock prevents two concurrently starting instances
// from applying the same migration at the same time.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations', 'postgres');
// Arbitrary but fixed key: serializes migrations across instances.
const ADVISORY_LOCK_KEY = 727301;

function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => /^\d+_.*\.sql$/i.test(name))
    .sort();
}

async function applyPostgresMigrations(databaseUrl, options = {}) {
  const logger = options.logger || console;
  const files = listMigrationFiles();
  if (!files.length) {
    logger.warn?.('No PostgreSQL migration files found in', MIGRATIONS_DIR);
    return { applied: [], skipped: [] };
  }

  const client = new Client({ connectionString: databaseUrl, application_name: 'corngrid-migrate' });
  await client.connect();
  const applied = [];
  const skipped = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(existing.rows.map(row => row.name));
    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.log?.(`Applying PostgreSQL migration ${file} ...`);
      // Migration files contain their own BEGIN/COMMIT; the schema_migrations
      // row is written after the file's statements succeed, so a half-applied
      // file is rolled back with its transaction and retried on next start.
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
      applied.push(file);
    }
    return { applied, skipped };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]); } catch { /* connection already closed */ }
    await client.end().catch(() => {});
  }
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  if (error.message) return error.message;
  // Node 20+ connect failures surface as an AggregateError with an empty
  // message; the useful messages are on the inner errors.
  if (Array.isArray(error.errors) && error.errors.length) {
    return error.errors.map(inner => inner.message || String(inner)).join('; ');
  }
  return String(error);
}

// Retries connection until PostgreSQL accepts the migration session. Handles
// the classic "database starts slower than Node" race on a VPS reboot.
async function applyPostgresMigrationsWithRetry(databaseUrl, { attempts = 10, delayMs = 2000, logger = console } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await applyPostgresMigrations(databaseUrl, { logger });
    } catch (error) {
      lastError = error;
      logger.warn?.(`PostgreSQL migration attempt ${attempt}/${attempts} failed: ${errorMessage(error)}`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(errorMessage(lastError));
}

module.exports = { applyPostgresMigrations, applyPostgresMigrationsWithRetry, listMigrationFiles };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  applyPostgresMigrationsWithRetry(databaseUrl)
    .then(result => {
      console.log(`Migrations applied: ${result.applied.length ? result.applied.join(', ') : '(none)'}`);
      console.log(`Migrations already present: ${result.skipped.length ? result.skipped.join(', ') : '(none)'}`);
    })
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}
