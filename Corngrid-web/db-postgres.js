'use strict';
const { Pool } = require('pg');

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

function normalizeRows(rows) {
  return (rows || []).map((row) => {
    const next = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === 'string' && /^-?\d+$/.test(value)) next[key] = Number(value);
      else next[key] = value;
    }
    return next;
  });
}

function createPostgresDatabase(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
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
    s = s.replace(/\s+LIKE\s+(\S+)\s+COLLATE\s+NOCASE\b/gi, ' ILIKE $1');
    s = s.replace(/\s+COLLATE\s+NOCASE\b/gi, '');
    s = convertPlaceholders(s);
    return s;
  }

  async function query(sql, params, forRun) {
    const text = transform(sql, forRun);
    if (text === 'SELECT 1') return { rows: [], rowCount: 0 };
    const result = await pool.query(text, params || []);
    return { rows: normalizeRows(result.rows), rowCount: result.rowCount || 0 };
  }

  const db = {
    serialize(fn) { if (typeof fn === 'function') fn(); },
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
