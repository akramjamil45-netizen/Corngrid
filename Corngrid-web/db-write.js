'use strict';

// The whole application shares ONE SQLite connection. node-sqlite3 keeps a
// single statement queue per connection, so an explicit transaction opened by
// one module can otherwise swallow (or roll back) another module's writes, and
// two modules opening a transaction at the same time fail with
// "cannot start a transaction within a transaction".
//
// Every write block therefore runs through this per-connection queue, so the
// modules take turns instead of interleaving on the shared connection.
const { AsyncLocalStorage } = require('async_hooks');

const queues = new WeakMap();
const holders = new AsyncLocalStorage();

function queueFor(db) {
  let queue = queues.get(db);
  if (!queue) {
    queue = Promise.resolve();
    queues.set(db, queue);
  }
  return queue;
}

// Runs `task` with exclusive use of the connection's write path. The returned
// promise rejects with the task's error, and the queue stays usable afterwards.
// A task that is already inside an exclusive block runs immediately, so a
// nested call can never deadlock on the queue it already holds.
function exclusive(db, task) {
  if (holders.getStore()) return Promise.resolve().then(task);
  const result = queueFor(db).then(() => holders.run(true, task));
  // Swallow the failure on the chain itself so one error does not poison the
  // queue for every later writer.
  queues.set(db, result.then(() => undefined, () => undefined));
  return result;
}

// True while the current async context holds the write queue (i.e. inside an
// exclusive block). The read router uses this to send reads back through the
// primary connection so a caller can read its own uncommitted writes.
function inWriteTransaction() {
  return Boolean(holders.getStore());
}

module.exports = { exclusive, inWriteTransaction };
