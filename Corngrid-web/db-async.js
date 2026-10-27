'use strict';

// Small promise wrappers around the three database shapes used by the app:
// raw node-sqlite3, the read/write router, and the PostgreSQL adapter. Each
// accepts both callback-style and promise-returning implementations, so callers
// never have to care which backend is active.
//
// All SQL in this project is parameterised. Do not interpolate user input into
// these helpers.

const { exclusive } = require('./db-write');

function isPostgres(db) {
  return Boolean(db && typeof db.transaction === 'function');
}

function normalizeResult(result, context) {
  const source = result || context || {};
  return {
    changes: Number.isFinite(source.changes) ? source.changes : 0,
    lastID: source.lastID !== undefined ? source.lastID : undefined
  };
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result, context) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(normalizeResult(result, context));
    };
    const callback = function onResult(error, result) {
      finish(error, result, this);
    };
    let maybe;
    try {
      maybe = db.run(sql, params, callback);
    } catch (error) {
      finish(error);
      return;
    }
    if (maybe && typeof maybe.then === 'function') {
      maybe.then(result => finish(null, result), error => finish(error));
    }
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, row) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(row);
    };
    let maybe;
    try {
      maybe = db.get(sql, params, (error, row) => finish(error, row));
    } catch (error) {
      finish(error);
      return;
    }
    if (maybe && typeof maybe.then === 'function') {
      maybe.then(row => finish(null, row), error => finish(error));
    }
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, rows) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(rows || []);
    };
    let maybe;
    try {
      maybe = db.all(sql, params, (error, rows) => finish(error, rows));
    } catch (error) {
      finish(error);
      return;
    }
    if (maybe && typeof maybe.then === 'function') {
      maybe.then(rows => finish(null, rows), error => finish(error));
    }
  });
}

// Runs `task` inside a real database transaction.
//   * PostgreSQL: db-write's exclusive() calls db.transaction(), which pins a
//     pooled client for the whole task.
//   * SQLite: the shared connection gets BEGIN IMMEDIATE, which takes the write
//     lock up front so two concurrent read-then-write blocks cannot interleave.
// The exclusive queue prevents another module's transaction from interleaving.
async function withTransaction(db, task) {
  return exclusive(db, async () => {
    if (isPostgres(db)) return task();
    await dbRun(db, 'BEGIN IMMEDIATE');
    try {
      const result = await task();
      await dbRun(db, 'COMMIT');
      return result;
    } catch (error) {
      try {
        await dbRun(db, 'ROLLBACK');
      } catch {
        // The connection may already have rolled back (for example after a
        // constraint error). The original error is the one worth reporting.
      }
      throw error;
    }
  });
}

module.exports = {
  dbAll,
  dbGet,
  dbRun,
  isPostgres,
  withTransaction
};
