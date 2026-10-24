'use strict';
// PostgreSQL adapter that implements the subset of the node-sqlite3 Database
// API the application uses (get, all, run, exec, serialize, close), so every
// module keeps working unchanged while queries execute on a pg.Pool.
//
// Dialect translation is deliberately narrow and driven by what the codebase
// actually sends:
//   * `?` placeholders -> `$1`, `$2`, ... (string/comment aware)
//   * `PRAGMA ...` and SQLite DDL (CREATE/DROP/ALTER) -> no-op (`SELECT 1`),
//     because schema lives in migrations/postgres/ and is applied at startup
//   * `INSERT OR IGNORE INTO` -> `INSERT INTO ... ON CONFLICT DO NOTHING`
//   * `x = ? COLLATE NOCASE` -> `LOWER(x) = LOWER(?)`
//   * `x LIKE ? COLLATE NOCASE` -> `x ILIKE ?`
//   * `json_each(?)` -> `json_array_elements_text(?::json)`
//   * run() INSERTs gain `RETURNING *` so `lastID` matches sqlite semantics
//   * BEGIN/COMMIT/ROLLBACK pin a dedicated pool client for the duration of
//     the transaction, so its statements stay on one connection
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// Converts SQLite `?` placeholders into PostgreSQL `$1`, `$2`, ... without
// touching question marks inside single-quoted strings, double-quoted
// identifiers, -- line comments, or /* */ block comments.
function convertPlaceholders(sql) {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let idx = 0; idx < sql.length; idx++) {
    const ch = sql[idx];
    const next = idx + 1 < sql.length ? sql[idx + 1] : '';
    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') { out += next; idx += 1; inBlockComment = false; }
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') { inLineComment = true; out += ch; continue; }
    if (!inSingle && !inDouble && ch === '/' && next === '*') { inBlockComment = true; out += ch; continue; }
    if (ch === "'" && !inDouble) {
      // '' is an escaped quote inside a string literal; it does not toggle state.
      if (inSingle && next === "'") { out += ch + next; idx += 1; continue; }
      inSingle = !inSingle; out += ch; continue;
    }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; out += ch; continue; }
    if (!inSingle && !inDouble && ch === '?') { i += 1; out += '$' + i; continue; }
    out += ch;
  }
  return out;
}

// Rewrites the small set of SQLite-only constructs the application actually
// uses into their PostgreSQL equivalents. Keeps `?` placeholders intact; run
// convertPlaceholders afterwards.
function convertDialect(sql) {
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(sql)) {
    throw new Error('INSERT OR REPLACE has no safe automatic PostgreSQL equivalent; use an explicit ON CONFLICT clause.');
  }
  let s = sql;
  // `column = ? COLLATE NOCASE` -> case-insensitive equality.
  s = s.replace(/([A-Za-z_][\w.]*)\s*=\s*\?\s*COLLATE\s+NOCASE/gi, 'LOWER($1) = LOWER(?)');
  // `column LIKE ? COLLATE NOCASE` -> case-insensitive pattern match.
  s = s.replace(/LIKE\s*\?\s*COLLATE\s+NOCASE/gi, 'ILIKE ?');
  // Any leftover NOCASE collation would be a PostgreSQL error; strip it.
  s = s.replace(/\s*COLLATE\s+NOCASE/gi, '');
  // SQLite json_each(?) table function -> json_array_elements_text(?::json).
  // Both expose a `value` column, so `SELECT value FROM json_each(?)` maps 1:1.
  s = s.replace(/json_each\s*\(\s*\?\s*\)/gi, 'json_array_elements_text(?::json)');
  return s;
}


const NUMERIC_TYPE_IDS = new Set([
  20, 21, 23, 26, 700, 701, 1700
]);

// node-pg returns BIGINT/NUMERIC/DOUBLE as strings; sqlite returned numbers.
// Normalize so response shapes and `changes`/`count` comparisons stay intact.
// Values beyond Number.MAX_SAFE_INTEGER would lose precision, but every
// numeric column in this schema is a ms timestamp, a count, or a double.
function normalizeRows(rows, fields) {
  const numericByName = new Map();
  if (Array.isArray(fields)) {
    for (const field of fields) {
      numericByName.set(field.name, NUMERIC_TYPE_IDS.has(field.dataTypeID));
    }
  }
  return (rows || []).map((row) => {
    const next = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === 'string' && numericByName.get(key) && /^-?\d+(\.\d+)?$/.test(value)) {
        next[key] = Number(value);
      } else {
        next[key] = value;
      }
    }
    return next;
  });
}

function transactionCommand(sql) {
  const s = String(sql || '').trim().replace(/;$/, '');
  if (/^BEGIN\b/i.test(s)) return 'BEGIN';
  if (/^COMMIT\b/i.test(s)) return 'COMMIT';
  if (/^ROLLBACK\b/i.test(s)) return 'ROLLBACK';
  return null;
}

function createPostgresDatabase(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'corngrid-web',
    max: Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : 50,
    // Keep two connections warm so a traffic burst does not pay the
    // connection-setup cost on the critical path (seen as 500s at level
    // transitions during load testing with min=0).
    min: process.env.PG_POOL_MIN === undefined ? 2 : Math.max(0, Number(process.env.PG_POOL_MIN) || 0),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) > 0 ? Number(process.env.PG_IDLE_TIMEOUT_MS) : 30000,
    // Connection acquisition gets the same 10s budget as statements: 5s
    // proved too tight when a level burst spawns many connections while the
    // event loop is busy (surfaced as request 500s in load testing).
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS) > 0 ? Number(process.env.PG_CONNECTION_TIMEOUT_MS) : 10000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) > 0 ? Number(process.env.PG_STATEMENT_TIMEOUT_MS) : 10000,
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS) > 0 ? Number(process.env.PG_QUERY_TIMEOUT_MS) : 10000
  });

  pool.on('error', (error) => {
    // An idle client died (server restart, network drop). The pool replaces it
    // on next checkout; logging is all that is required here.
    console.error('PostgreSQL pool error:', error.message);
  });

  // A single open transaction per async context. AsyncLocalStorage stores a
  // Promise<Client>; it is populated synchronously inside run()/get()/all()
  // (plain functions, so enterWith applies to the CALLER's context), which
  // keeps every statement of a BEGIN...COMMIT section on one connection while
  // unrelated requests keep using the pool undisturbed.
  const transactionStorage = new AsyncLocalStorage();
  let closed = false;

  function currentClientPromise() {
    return transactionStorage.getStore() || null;
  }

  // Open transaction clients (as promises), tracked so close() can roll them
  // back instead of leaking them into pool.end(), which would hang shutdown.
  const openTransactions = new Set();

  // Handles BEGIN/COMMIT/ROLLBACK. MUST be called synchronously from the
  // prelude of run()/get()/all() so enterWith() applies to the caller's async
  // context. Returns null for non-transaction statements.
  function handleTransactionCommand(sql) {
    const cmd = transactionCommand(sql);
    if (!cmd) return null;
    if (cmd === 'BEGIN') {
      if (currentClientPromise()) {
        return Promise.reject(new Error('cannot start a transaction within a transaction'));
      }
      const clientPromise = (async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
        } catch (error) {
          client.release();
          throw error;
        }
        return client;
      })();
      // Guard against an unhandled rejection if the caller abandons the
      // transaction without awaiting anything inside it.
      clientPromise.catch(() => {});
      openTransactions.add(clientPromise);
      transactionStorage.enterWith(clientPromise);
      return clientPromise.then(() => ({ rows: [], rowCount: 0 }));
    }
    const clientPromise = currentClientPromise();
    if (!clientPromise) {
      return Promise.reject(new Error('there is no transaction in progress'));
    }
    // Clear synchronously so statements after COMMIT/ROLLBACK leave the
    // transaction context immediately, even while the command is in flight.
    transactionStorage.enterWith(null);
    openTransactions.delete(clientPromise);
    return clientPromise.then(async (client) => {
      try {
        await client.query(cmd);
      } finally {
        client.release();
      }
      return { rows: [], rowCount: 0 };
    });
  }

  function transform(sql, forRun) {
    const original = String(sql || '');
    let s = original.trim();
    // SQLite-only session/DDL statements are intentionally no-ops: the schema
    // is owned by migrations/postgres/ and applied before the server listens.
    if (/^\s*PRAGMA\b/i.test(s)) return 'SELECT 1';
    if (/^\s*(CREATE|DROP|ALTER)\b/i.test(s)) return 'SELECT 1';
    const hadOrIgnore = /INSERT\s+OR\s+IGNORE/i.test(original);
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    if (hadOrIgnore) {
      if (s.endsWith(';')) s = s.slice(0, -1) + ' ON CONFLICT DO NOTHING;';
      else s = s + ' ON CONFLICT DO NOTHING';
    }
    if (forRun && /^\s*INSERT\b/i.test(s) && !/RETURNING\b/i.test(s)) {
      if (s.endsWith(';')) s = s.slice(0, -1) + ' RETURNING *;';
      else s = s + ' RETURNING *';
    }
    if (/^\s*BEGIN\s+IMMEDIATE\b/i.test(s)) s = s.replace(/^\s*BEGIN\s+IMMEDIATE\b/i, 'BEGIN');
    s = convertDialect(s);
    s = convertPlaceholders(s);
    return s;
  }

  async function execute(text, params) {
    const clientPromise = currentClientPromise();
    if (clientPromise) {
      const client = await clientPromise;
      const result = await client.query(text, params || []);
      return { rows: normalizeRows(result.rows, result.fields), rowCount: result.rowCount || 0, fields: result.fields };
    }
    const result = await pool.query(text, params || []);
    return { rows: normalizeRows(result.rows, result.fields), rowCount: result.rowCount || 0, fields: result.fields };
  }

  function query(sql, params, forRun) {
    const text = transform(sql, forRun);
    if (text === 'SELECT 1') return Promise.resolve({ rows: [], rowCount: 0 });
    return execute(text, params);
  }

  const db = {
    dialect: 'postgres',
    serialize(fn) { if (typeof fn === 'function') fn(); },
    async run(sql, params, callback) {
      let cb = callback;
      let p = params;
      if (typeof params === 'function') { cb = params; p = []; }
      // Synchronous prelude: enterWith() must run in the caller's context.
      const txResult = handleTransactionCommand(sql);
      try {
        const result = txResult ? await txResult : await query(sql, p, true);
        const ctx = { changes: result.rowCount, lastID: (result.rows[0] && result.rows[0].id) };
        if (typeof cb === 'function') cb.call(ctx, null);
        return ctx;
      } catch (error) {
        if (typeof cb === 'function') cb.call({ changes: 0, lastID: undefined }, error);
        else throw error;
      }
    },
    async get(sql, params, callback) {
      let cb = callback;
      let p = params;
      if (typeof params === 'function') { cb = params; p = []; }
      const txResult = handleTransactionCommand(sql);
      try {
        const result = txResult ? await txResult : await query(sql, p, false);
        if (typeof cb === 'function') cb(null, result.rows[0]);
        return result.rows[0];
      } catch (error) {
        if (typeof cb === 'function') cb(error);
        else throw error;
      }
    },
    async all(sql, params, callback) {
      let cb = callback;
      let p = params;
      if (typeof params === 'function') { cb = params; p = []; }
      const txResult = handleTransactionCommand(sql);
      try {
        const result = txResult ? await txResult : await query(sql, p, false);
        if (typeof cb === 'function') cb(null, result.rows);
        return result.rows;
      } catch (error) {
        if (typeof cb === 'function') cb(error);
        else throw error;
      }
    },
    // exec() is only ever called with SQLite DDL batches by this codebase; in
    // PostgreSQL mode the schema already exists (see migrations/postgres/), so
    // succeeding immediately preserves the sqlite call sites unchanged.
    exec(sql, callback) {
      if (typeof callback === 'function') {
        setImmediate(() => callback(null));
      }
      return this;
    },
    close(callback) {
      if (closed) { if (typeof callback === 'function') callback(); return; }
      closed = true;
      // Roll back any still-open transactions so their clients are released;
      // otherwise pool.end() would wait forever and shutdown would hang.
      const cleanup = [...openTransactions].map(clientPromise =>
        clientPromise
          .then(client => client.query('ROLLBACK').catch(() => {}).finally(() => client.release()))
          .catch(() => {}));
      openTransactions.clear();
      Promise.all(cleanup)
        .then(() => pool.end())
        .then(() => { if (typeof callback === 'function') callback(); })
        .catch((e) => { if (typeof callback === 'function') callback(e); });
    },
    enableReads() {},
    // Pool telemetry for the readiness endpoint and load-test diagnostics.
    poolStats() {
      return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: pool.options.max
      };
    }
  };
  return db;
}

module.exports = createPostgresDatabase;

