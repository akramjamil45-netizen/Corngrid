'use strict';

// Scheduled SQLite backups.
//
// The whole site runs from a single SQLite file, so a corrupt page, a bad deploy,
// or an accidental delete is a total data loss without a copy. This keeps a
// rolling set of timestamped copies.
//
// The backup reads through its OWN short-lived read-only connection, never the
// shared write connection, so a backup can never stall an EA market post or a
// heartbeat. `VACUUM INTO` is used rather than copying the file: it writes a
// compacted, transactionally-consistent copy that is safe while WAL writers are
// active (a plain file copy can miss or tear a concurrent write).

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const BACKUP_PREFIX = 'database-';
const BACKUP_SUFFIX = '.sqlite';

function backupFileName(stamp) {
  return `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
}

// Keeps the newest `keep` backups, deletes older ones. Never throws: a failed
// prune must not abort the caller after a successful backup.
function pruneBackups(dir, keep) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  // The filename carries an ISO timestamp, so a name sort is chronological and
  // does not depend on filesystem mtimes (which can tie for rapid backups).
  const backups = entries
    .filter(name => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const name of backups.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch (error) {
      console.error(`Failed to prune old backup ${name}: ${error.message}`);
    }
  }
  return removed;
}

function createBackupScheduler({ dbPath, dir, intervalMs, keep, now = Date.now }) {
  if (!dbPath) throw new Error('createBackupScheduler requires a dbPath.');
  if (!dir) throw new Error('createBackupScheduler requires a backup directory.');

  let timer = null;
  let running = null;

  function uniqueDestination() {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    let candidate = path.join(dir, backupFileName(stamp));
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, backupFileName(`${stamp}-${suffix}`));
      suffix += 1;
    }
    return candidate;
  }

  function runBackup() {
    // Collapse overlapping triggers (interval tick plus a manual call) into one.
    if (running) return running;
    running = (async () => {
      if (!fs.existsSync(dbPath)) return { destination: null, pruned: 0, skipped: 'missing-database' };
      fs.mkdirSync(dir, { recursive: true });
      // Clear any .tmp left behind by a previous crash, then write the new backup
      // to .tmp and rename only on success. A VACUUM that dies midway therefore
      // never leaves a partial file that pruneBackups would keep as a backup.
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(BACKUP_PREFIX) && name.endsWith(`${BACKUP_SUFFIX}.tmp`)) {
          try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
        }
      }
      const destination = uniqueDestination();
      const temporary = `${destination}.tmp`;

      const source = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      try {
        await new Promise((resolve, reject) => {
          source.run('VACUUM INTO ?', [temporary], error => (error ? reject(error) : resolve()));
        });
        fs.renameSync(temporary, destination);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
        throw error;
      } finally {
        await new Promise(resolve => source.close(() => resolve()));
      }
      const pruned = pruneBackups(dir, keep);
      return { destination, pruned };
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer || !(intervalMs > 0)) return;
    timer = setInterval(() => {
      runBackup().catch(error => console.error(`Scheduled database backup failed: ${error.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { runBackup, start, stop, pruneBackups: () => pruneBackups(dir, keep) };
}

module.exports = createBackupScheduler;
module.exports.pruneBackups = pruneBackups;
module.exports.backupFileName = backupFileName;
