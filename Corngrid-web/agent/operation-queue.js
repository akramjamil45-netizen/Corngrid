'use strict';

// One account at a time may use the node's shared MT5 broker probe. The same
// primitive also prevents Start/recovery from racing an unfinished deployment.
function createOperationQueue() {
  const pending = new Map();
  return function enqueue(key, operation) {
    const previous = pending.get(key) || Promise.resolve();
    const result = previous.then(operation);
    const tail = result.catch(() => {}).finally(() => {
      if (pending.get(key) === tail) pending.delete(key);
    });
    pending.set(key, tail);
    return result;
  };
}

module.exports = { createOperationQueue };
