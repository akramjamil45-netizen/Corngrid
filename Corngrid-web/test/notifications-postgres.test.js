'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs/promises'), path = require('node:path');
const { Client } = require('pg'), createDatabase = require('../db-postgres');
const { dbGet, dbRun, withTransaction } = require('../db-async');
const { createNotificationCenter } = require('../notification-center');
const url = process.env.TEST_POSTGRES_URL;
test('PostgreSQL notification migration, cross-pool deduplication, preferences and transaction rollback', { skip: !url, timeout: 30000 }, async () => {
  const control = new Client({ connectionString: url }), schema = 'notifications_test_' + crypto.randomBytes(8).toString('hex'), pools = [];
  await control.connect();
  try {
    await control.query('CREATE SCHEMA ' + schema); await control.query('SET search_path TO ' + schema);
    const folder = path.join(__dirname, '../migrations/postgres');
    for (const name of (await fs.readdir(folder)).filter(name => name.endsWith('.sql')).sort()) await control.query(await fs.readFile(path.join(folder, name), 'utf8'));
    await control.query(await fs.readFile(path.join(folder, '0020_notification_center.sql'), 'utf8'));
    const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
    const a = createDatabase(scoped.toString()), b = createDatabase(scoped.toString()); pools.push(a, b);
    const time = Date.now(), sa = createNotificationCenter({ db: a, now: () => time }), sb = createNotificationCenter({ db: b, now: () => time }); await Promise.all([sa.ready(), sb.ready()]);
    const user = await dbRun(a, "INSERT INTO users(username,email,password) VALUES('notification-fixture','notification@example.test','fixture-password')");
    await dbRun(a, "INSERT INTO mt5_accounts(user_id,account_number,broker_server,currency,linked_at,last_heartbeat) VALUES(?,'fixture1234','Fixture-Demo','USD',?,?)", [user.lastID, time - 999999, time - 999999]);
    await Promise.all([sa.scanUser(user.lastID), sb.scanUser(user.lastID), sb.scanUser(user.lastID)]);
    assert.equal(Number((await dbGet(a, 'SELECT COUNT(*) AS n FROM user_notifications')).n), 1);
    const payment = await dbRun(a, "INSERT INTO subscription_payments(user_id,amount,currency,payment_method,status,created_at,updated_at) VALUES(?,5,'MYR','stripe','approved',?,?)", [user.lastID, time, time]);
    await Promise.all([sa.observePayment(user.lastID, payment.lastID, true), sb.observePayment(user.lastID, payment.lastID, true)]);
    assert.equal(Number((await dbGet(a, 'SELECT COUNT(*) AS n FROM user_notifications')).n), 2);
    await sa.savePreferences(user.lastID, { payment_status: false }); assert.equal((await sb.preferences(user.lastID)).payment_status, false);
    await sb.notify(user.lastID, 'payment_rejected', 'Private payment', 'Declined'); assert.equal(Number((await dbGet(a, 'SELECT COUNT(*) AS n FROM user_notifications')).n), 2);
    await assert.rejects(withTransaction(a, async () => { await sa.notify(user.lastID, 'subscription_suspended', 'Fixture status', 'Status'); throw Error('fixture rollback'); }));
    assert.equal(Number((await dbGet(a, 'SELECT COUNT(*) AS n FROM user_notifications')).n), 2);
    assert.equal(Number((await dbGet(a, 'SELECT COUNT(*) AS n FROM user_notification_details')).n), 2);
  } finally {
    for (const db of pools) await new Promise(resolve => db.close(resolve));
    try { await control.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await control.end(); }
  }
});
