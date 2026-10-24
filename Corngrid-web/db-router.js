'use strict';

// Read/write connection router.
//
// The application used ONE sqlite connection for everything, so every dashboard
// read and market-chart query queued behind every EA write. SQLite in WAL mode
// supports many concurrent readers alongside a single writer, so this router
// keeps the shared connection for writes (the write queue in db-write.js keys on
// it) and sends SELECTs to a small pool of read-only connections.
//
// Consistency rules:
//   * Reads issued inside an exclusive write block go to the PRIMARY connection,
//     so a handler always sees its own uncommitted writes.
//   * Everywhere else a write has already autocommitted before its callback
//     runs, and WAL makes committed data visible to the read connections, so a
//     read issued after an awaited write sees it.
//
// The returned object implements the subset of the sqlite3 Database API the app
// uses: get, all, run, exec, serialize, close. Tests keep using a raw Database,
// so the router only has to be behaviourally identical for those methods.

const sqlite3 = require('sqlite3').verbose();
const { inWriteTransaction } = require('./db-write');

// 8 second per-query ceiling on read paths; 15s on the primary write path.
const DB_QUERY_TIMEOUT_MS = 8000;
const DB_WRITE_TIMEOUT_MS = 15000;

function createDatabaseRouter({ primary, dbPath, readSize = 0 }) {
  if (!primary) throw new Error('createDatabaseRouter requires a primary connection.');

  const readers = [];
  let roundRobin = 0;
  let enabled = false;

  function openReader() {
    const connection = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, error => {
      if (error) {
        console.error(`Read connection could not be opened (${dbPath}): ${error.message}`);
        const index = readers.indexOf(connection);
        if (index >= 0) readers.splice(index, 1);
      }
    });
    connection.serialize(() => {
      connection.run('PRAGMA busy_timeout = 5000;');
      // query_only is a belt-and-braces guard: a read connection must never write.
      connection.run('PRAGMA query_only = ON;');
    });
    return connection;
  }

  // Called once the primary connection is open (so the database file exists and
  // WAL is active). Until then every read falls back to the primary.
  function enableReads() {
    if (enabled || readSize <= 0) return;
    enabled = true;
    for (let index = 0; index < readSize; index += 1) readers.push(openReader());
  }

  function pickReader() {
    if (!readers.length || inWriteTransaction()) return primary;
    roundRobin = (roundRobin + 1) % readers.length;
    return readers[roundRobin];
  }

  function withTimeout(db, sql, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Database query timed out after ${timeoutMs}ms: ${sql.slice(0, 80)}`);
        error.code = 'ETIMEOUT';
        reject(error);
      }, timeoutMs);
      db.get(sql, params, (error, row) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  // Promise-based wrapper for async/await usage
  function withPromise(db, sql, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Database query timed out after ${timeoutMs}ms: ${sql.slice(0, 80)}`);
        error.code = 'ETIMEOUT';
        reject(error);
      }, timeoutMs);

      db.get(sql, params, (error, row) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  // Callback-based wrapper for existing Node-style callback code
  function withCallback(db, sql, params, timeoutMs, callback) {
    const timer = setTimeout(() => {
      const error = new Error(`Database query timed out after ${timeoutMs}ms: ${sql.slice(0, 80)}`);
      error.code = 'ETIMEOUT';
      if (typeof callback === 'function') { callback(error); }
      else reject(error);
    }, timeoutMs);

    db.get(sql, params, (error, row) => {
      clearTimeout(timer);
      if (typeof callback === 'function') {
        if (error) callback(error);
        else callback(null, row);
      } else if (error) {
        reject(error);
      } else {
        resolve(row);
      }
    });
  }

  return {
    // Promise-based API for async/await code
    async get(...args) {
      const [sql, params = []] = args;
      if (inWriteTransaction()) {
        return withPromise(primary, sql, params, DB_WRITE_TIMEOUT_MS);
      }
      return withPromise(pickReader(), sql, params, DB_QUERY_TIMEOUT_MS);
    },
    async all(...args) {
      const [sql, params = []] = args;
      if (inWriteTransaction()) {
        return withPromise(primary, sql, params, DB_WRITE_TIMEOUT_MS);
      }
      return withPromise(pickReader(), sql, params, DB_QUERY_TIMEOUT_MS);
    },
    async run(...args) {
      const [sql, params = []] = args;
      return withPromise(primary, sql, params, DB_WRITE_TIMEOUT_MS);
    },
    async exec(...args) {
      const [sql] = args;
      return withPromise(primary, sql, [], DB_WRITE_TIMEOUT_MS);
    },
    // Node callback-compatible API for existing code
    get(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      if (inWriteTransaction()) { withCallback(primary, sql, params, DB_WRITE_TIMEOUT_MS, callback); }
      else { withCallback(pickReader(), sql, params, DB_QUERY_TIMEOUT_MS, callback); }
    },
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      if (inWriteTransaction()) { withCallback(primary, sql, params, DB_WRITE_TIMEOUT_MS, callback); }
      else { withCallback(pickReader(), sql, params, DB_QUERY_TIMEOUT_MS, callback); }
    },
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      const timer = setTimeout(() => callback(new Error('Database query timed out')), DB_WRITE_TIMEOUT_MS);
      this.runWithPromise(sql, params, timer).then(
        result => { clearTimeout(timer); if (typeof callback === 'function') callback.call(result, null, result); else throw null; },
        error => { clearTimeout(timer); if (typeof callback === 'function') callback(error); else throw error; }
      );
    },
    exec(sql, callback) {
      if (typeof callback !== 'function') callback = null;
      const timer = setTimeout(() => { if (callback) callback(new Error('Database exec timed out')); else throw new Error('Database exec timed out'); }, DB_WRITE_TIMEOUT_MS);
      this.execWithPromise(sql, timer).then(
        result => { clearTimeout(timer); if (callback) callback(null, result); else throw null; },
        error => { clearTimeout(timer); if (callback) callback(error); else throw error; }
      );
    },
    // Promise-based helpers for the callback-compatible methods above.
    runWithPromise(sql, params, timer) {
      return new Promise((resolve, reject) => {
        primary.run(sql, params, function (error) {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve({ lastID: this && this.lastID, changes: this && this.changes });
        });
      });
    },
    execWithPromise(sql, timer) {
      return new Promise((resolve, reject) => {
        primary.exec(sql, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve({});
        });
      });
    },
    // Called once the primary connection is open (so the database file exists and
    // WAL is active). Until then every read falls back to the primary.
    enableReads,
    serialize(...args) { return primary.serialize(...args); },
    readerCount: () => readers.length,
    close(callback) {
      const pending = readers.splice(0, readers.length);
      let remaining = pending.length;
      const finish = () => {
        if (remaining > 0) return;
        primary.close(callback);
      };
      if (!remaining) return finish();
      for (const connection of pending) {
        connection.close(() => {
          remaining -= 1;
          finish();
        });
      }
      return undefined;
    }
  };
}

module.exports = createDatabaseRouter;
