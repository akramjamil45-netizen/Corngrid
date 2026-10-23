const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const createBackupScheduler = require('../db-backup');

const open = dbPath => new sqlite3.Database(dbPath);
const run = (db, sql, params = []) => new Promise((resolve, reject) =>
  db.run(sql, params, function (error) { return error ? reject(error) : resolve(this); }));
const get = (db, sql, params = []) => new Promise((resolve, reject) =>
  db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const close = db => new Promise(resolve => db.close(() => resolve()));

test('scheduled backups capture a consistent copy and prune the oldest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-backup-'));
  const dbPath = path.join(root, 'database.sqlite');
  const backupDir = path.join(root, 'backups');

  const db = open(dbPath);
  await run(db, 'CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
  await run(db, 'INSERT INTO items (name) VALUES (?)', ['alpha']);
  await close(db);

  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const scheduler = createBackupScheduler({
    dbPath,
    dir: backupDir,
    intervalMs: 0,
    keep: 2,
    now: () => (clock += 1000)
  });

  const first = await scheduler.runBackup();
  assert.ok(fs.existsSync(first.destination), 'a backup file is written');

  const copy = open(first.destination);
  const row = await get(copy, 'SELECT name FROM items WHERE id = 1');
  assert.equal(row.name, 'alpha', 'the backup contains the committed data');
  await close(copy);

  await scheduler.runBackup();
  const third = await scheduler.runBackup();

  const remaining = fs.readdirSync(backupDir).filter(name => name.endsWith('.sqlite'));
  assert.equal(remaining.length, 2, 'only the newest two backups are retained');
  assert.ok(remaining.includes(path.basename(third.destination)), 'the newest backup is kept');

  fs.rmSync(root, { recursive: true, force: true });
});

test('pruning is a no-op when there are fewer backups than the keep limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-backup-'));
  fs.writeFileSync(path.join(root, 'database-2026-01-01T00-00-00-000Z.sqlite'), 'x');
  assert.equal(require('../db-backup').pruneBackups(root, 7), 0);
  assert.equal(fs.readdirSync(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
