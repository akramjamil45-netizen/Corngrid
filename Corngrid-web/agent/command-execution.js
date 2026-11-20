'use strict';

// WebSocket delivery can overlap the HTTPS fallback. Retain outcomes so an
// acknowledgement retry never deploys a second terminal for the same command.
function createCommandExecution(limit = 256) {
  const commands = new Map();
  return function execute(uid, command, operation) {
    if (typeof uid !== 'string' || !uid || uid.length > 128) return Promise.reject(new Error('Invalid command identity.'));
    const existing = commands.get(uid);
    if (existing) {
      if (existing.command !== command) return Promise.reject(new Error('Command identity mismatch.'));
      return existing.result;
    }
    for (const [key, value] of commands) {
      if (commands.size < limit) break;
      if (value.settled) commands.delete(key);
    }
    if (commands.size >= limit) return Promise.reject(new Error('Node command queue is full; retry later.'));
    const entry = { command, settled: false };
    entry.result = Promise.resolve().then(operation).finally(() => { entry.settled = true; });
    commands.set(uid, entry);
    return entry.result;
  };
}

module.exports = { createCommandExecution };
