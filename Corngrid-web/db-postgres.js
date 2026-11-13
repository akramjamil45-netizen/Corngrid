'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');

// PostgreSQL returns BIGINT (int8) and NUMERIC as strings to avoid precision
// loss. The application uses BIGINT for ids and epoch-millisecond timestamps,
// and COUNT()/SUM() results, so parse them as numbers here. Values outside the
// safe range are kept as strings.
types.setTypeParser(20, value => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});
types.setTypeParser(1700, value => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
});

function convertPlaceholders(sql) {
  let out = '';
  let i = 0;
  let inSingle = false;
  for (let idx = 0; idx < sql.length; idx++) {
    const ch = sql[idx];
    if (ch === "'") { inSingle = !inSingle; out += ch; continue; }
    if (!inSingle && ch === '?') { i += 1; out += '$' + i; continue; }
    out += ch;
  }
  return out;
}

function normalizeError(error) {
  // SQLite reports a duplicate key as "UNIQUE constraint failed: ..."; the
  // application checks that message. Give PostgreSQL's 23505 the same shape.
  if (error && error.code === '23505') {
    const detail = error.constraint || error.detail || 'unique constraint';
    const normalized = new Error(`UNIQUE constraint failed: ${detail}`);
    normalized.code = error.code;
    normalized.constraint = error.constraint;
    return normalized;
  }
  return error;
}

function createPostgresDatabase(databaseUrl, { timeouts = {} } = {}) {
  function milliseconds(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    // A disconnected database or blocked row must not hold the shared write
    // queue forever. Server timeouts cancel the SQL, rather than only abandoning
    // the HTTP response while a write continues in the background.
    connectionTimeoutMillis: milliseconds(timeouts.connection ?? process.env.PG_CONNECTION_TIMEOUT_MS, 5000),
    statement_timeout: milliseconds(timeouts.statement ?? process.env.PG_STATEMENT_TIMEOUT_MS, 15000),
    lock_timeout: milliseconds(timeouts.lock ?? process.env.PG_LOCK_TIMEOUT_MS, 5000),
    query_timeout: milliseconds(timeouts.query ?? process.env.PG_QUERY_TIMEOUT_MS, 20000),
    keepAlive: true
  });
  // pg emits errors for idle pooled clients when PostgreSQL/network restarts.
  // Without a listener EventEmitter terminates the entire website process.
  pool.on('error', error => {
    console.error('PostgreSQL idle connection lost:', error.code || 'CONNECTION_ERROR');
  });
  // A transaction pins one pooled connection for the duration of the task, so
  // every query made inside it must use that same client.
  const transactionContext = new AsyncLocalStorage();
  let closed = false;

  function transform(sql, forRun) {
    let original = String(sql || '');
    let s = original.trim();
    if (/^\s*PRAGMA\b/i.test(s)) return 'SELECT 1';
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return 'SELECT 1';
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
    // Convert SQLite COLLATE NOCASE to PostgreSQL-compatible syntax.
    // LIKE has a native case-insensitive form; equality needs LOWER() on both
    // sides because PostgreSQL collations are case-sensitive by default.
    s = s.replace(/\s+LIKE\s+(\S+)\s+COLLATE\s+NOCASE\b/gi, ' ILIKE $1');
    s = s.replace(/([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*\?\s+COLLATE\s+NOCASE\b/gi, 'LOWER($1) = LOWER(?)');
    s = s.replace(/\s+COLLATE\s+NOCASE\b/gi, '');
    // PostgreSQL's json_each() expects a JSON object, not an array.
    // SQLite's json_each() works with both objects and arrays, but callers
    // in this codebase pass JSON arrays (e.g. kept ticket lists).
    // Replace with json_array_elements_text() which handles JSON arrays and
    // returns each element as text, matching SQLite's behavior with arrays.
    // Also adjust "SELECT value FROM" since json_array_elements_text returns
    // an unnamed text column rather than a named "value" column.
    s = s.replace(/SELECT\s+value\s+FROM\s+json_each\(\s*\?\s*\)/gi,
                  'SELECT * FROM json_array_elements_text(CAST(? AS JSON))');
    s = s.replace(/json_each\(\s*\?\s*\)/g, 'json_array_elements_text(CAST(? AS JSON))');
    s = convertPlaceholders(s);
    return s;
  }

  async function query(sql, params, forRun) {
    const text = transform(sql, forRun);
    if (text === 'SELECT 1') return { rows: [], rowCount: 0 };
    if (process.env.DEBUG_SQL) console.error('[SQL]', text, JSON.stringify(params || []));
    const context = transactionContext.getStore();
    const executor = context ? context.client : pool;
    let result;
    try {
      result = await executor.query(text, params || []);
    } catch (error) {
      throw normalizeError(error);
    }
    return { rows: result.rows, rowCount: result.rowCount || 0 };
  }

  const db = {
    serialize(fn) { if (typeof fn === 'function') fn(); },
    async transaction(task) {
      // Nested calls already share the outer transaction.
      if (transactionContext.getStore()) return task();
      const client = await pool.connect();
      let discard;
      try {
        await client.query('BEGIN');
        const result = await transactionContext.run({ client }, task);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A client-side query timeout can leave a command in flight. Discard
        // that connection so it cannot leak a late write into another request.
        if (error.message === 'Query read timeout') discard = error;
        else {
          try { await client.query('ROLLBACK'); } catch (rollbackError) { discard = rollbackError; }
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    async run(sql, params, callback) {
      let cb = callback;
      let p = params;
      if (typeof params === 'function') { cb = params; p = []; }
      try {
        const result = await query(sql, p, true);
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
      try {
        const result = await query(sql, p, false);
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
      try {
        const result = await query(sql, p, false);
        if (typeof cb === 'function') cb(null, result.rows);
        return result.rows;
      } catch (error) {
        if (typeof cb === 'function') cb(error);
        else throw error;
      }
    },
    exec(sql, callback) {
      if (typeof callback === 'function') {
        setImmediate(() => callback(null));
      }
      return this;
    },
    close(callback) {
      if (closed) { if (typeof callback === 'function') callback(); return; }
      closed = true;
      pool.end().then(() => { if (typeof callback === 'function') callback(); }).catch((e) => { if (typeof callback === 'function') callback(e); });
    },
    enableReads() {}
  };
  return db;
}

module.exports = createPostgresDatabase;
