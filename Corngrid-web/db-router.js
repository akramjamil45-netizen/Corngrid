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

  return {
    get(...args) { return pickReader().get(...args); },
    all(...args) { return pickReader().all(...args); },
    // Writes (and the write queue's BEGIN/COMMIT/ROLLBACK) always use the primary.
    run(...args) { return primary.run(...args); },
    exec(...args) { return primary.exec(...args); },
    serialize(...args) { return primary.serialize(...args); },
    enableReads,
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
