'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./helpers/notification-fixture');
const { withTransaction } = require('../db-async');
const DAY = 86400000;
async function fixture(t) { const f = await createFixture(); t.after(() => f.close()); return f; }
const count = f => f.get('SELECT COUNT(*) AS n FROM user_notifications');
async function online(f) {
  await f.run("INSERT INTO sandbox_nodes VALUES(1,'active',?)", [f.time()]);
  await f.run("INSERT INTO sandbox_instances VALUES(1,1,1,'running',?,?,?,NULL),(2,1,1,'stopped',1,1,1,NULL)", [f.time(), f.time(), f.time()]);
  await f.run("INSERT INTO mt5_accounts VALUES(1,1,'123456789',?,?,NULL),(2,1,'unpaired',NULL,?,NULL)", [f.time(), f.time(), f.time()]);
}
test('offline episodes notify once, skip intentional stops/no-data accounts, recover and survive clearing history', async t => {
  const f = await fixture(t); await online(f); await f.service.scanUser(1); assert.equal((await count(f)).n, 0);
  f.setTime(f.time() + 240000); await Promise.all([f.service.scanUser(1), f.service.scanUser(1)]); assert.equal((await count(f)).n, 2);
  const text = JSON.stringify(await f.all('SELECT * FROM user_notifications')); assert(!text.includes('123456789')); assert(text.includes('****6789'));
  const cleared = await fetch(f.base + '/api/notifications', { method: 'DELETE', headers: { Authorization: 'Bearer ' + f.token(1) } }); assert.equal(cleared.status, 200);
  await f.service.scanUser(1); assert.equal((await count(f)).n, 0, 'cleared warnings stay cleared during the same outage');
  await f.run('UPDATE sandbox_nodes SET last_heartbeat_at=?', [f.time()]); await f.run('UPDATE sandbox_instances SET last_heartbeat_at=? WHERE id=1', [f.time()]); await f.run('UPDATE mt5_accounts SET last_heartbeat=? WHERE id=1', [f.time()]); await f.service.scanUser(1);
  f.setTime(f.time() + 240000); await f.service.scanUser(1); assert.equal((await count(f)).n, 2, 'a later outage is a new episode');
});
test('per-user preferences suppress future alerts and survive recreation; archive excludes observations', async t => {
  const f = await fixture(t); await online(f);
  await f.service.savePreferences(1, { sandbox_offline: false, ea_disconnected: false, payment_status: false }); f.setTime(f.time() + 240000);
  await f.service.scanUser(1); await f.service.notify(1, 'payment_approved', 'Private payment', 'Approved'); assert.equal((await count(f)).n, 0);
  await f.service.notify(2, 'payment_approved', 'Other owner', 'Approved'); assert.equal((await count(f)).n, 1);
  const recreated = require('../notification-center').createNotificationCenter({ db: f.db }); assert.equal((await recreated.preferences(1)).payment_status, false);
  await f.run("INSERT INTO account_archives(user_id,archived_at,archived_by,reason) VALUES(1,?,'fixture-admin','fixture archive')", [f.time()]); await f.service.savePreferences(1, { sandbox_offline: true }); await f.service.scanUser(1); assert.equal((await count(f)).n, 1);
});
test('expiry reminders use configured lead, urgency bands and renewed expiry; expired/suspended subscriptions are skipped', async t => {
  const f = await fixture(t), start = f.time();
  await f.run("INSERT INTO user_subscriptions VALUES(1,1,'active',?,?,NULL),(2,1,'suspended',1,?,NULL),(3,1,'expired',1,1,NULL)", [start - DAY, start + 6 * DAY, start + DAY]);
  await f.service.scanUser(1); await f.service.scanUser(1); assert.equal((await count(f)).n, 1);
  f.setTime(start + 3 * DAY); await f.service.scanUser(1); assert.equal((await count(f)).n, 2);
  f.setTime(start + 5 * DAY); await f.service.scanUser(1); assert.equal((await count(f)).n, 3);
  await f.run('UPDATE user_subscriptions SET expires_at=? WHERE id=1', [f.time() + 20 * DAY]); await f.service.scanUser(1); assert.equal((await count(f)).n, 3);
  await f.service.savePreferences(1, { expiry_days: 30 }); await f.service.scanUser(1); assert.equal((await count(f)).n, 4);
  await f.service.savePreferences(1, { subscription_expiry: false }); f.setTime(f.time() + 19 * DAY); await f.service.scanUser(1); assert.equal((await count(f)).n, 4);
});
test('payment changes are observed for both providers without historical backfill, repeat activation or duplicate polling alerts', async t => {
  const f = await fixture(t);
  await f.run("INSERT INTO subscription_payments VALUES(1,1,'approved',50,'MYR','stripe',?),(2,1,'pending_payment',250,'MYR','duitnow',?)", [f.time() - DAY, f.time() - DAY]);
  await f.service.scanUser(1); assert.equal((await count(f)).n, 0);
  await f.run("UPDATE subscription_payments SET status='pending_approval',updated_at=? WHERE id=2", [f.time()]); await f.service.notify(1, 'payment_submitted', 'Payment', 'Pending', { paymentId: 2 });
  await f.service.scanUser(1); assert.equal((await count(f)).n, 1);
  await f.run("UPDATE subscription_payments SET status='approved',updated_at=? WHERE id=2", [f.time()]); await withTransaction(f.db, () => f.service.observePayment(1, 2, true)); await f.service.scanUser(1); assert.equal((await count(f)).n, 2);
  await f.run("UPDATE subscription_payments SET status='cancelled',updated_at=? WHERE id=1", [f.time()]); await f.service.scanUser(1); assert.equal((await count(f)).n, 3);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM user_subscriptions')).n, 0, 'notification observation never activates a subscription');
});
test('an already-paid future renewal suppresses reminders for the covered old term', async t => {
  const f = await fixture(t), start = f.time();
  await f.run("INSERT INTO user_subscriptions VALUES(1,1,'active',?,?,NULL),(2,1,'active',?,?,NULL)", [start - DAY, start + 6 * DAY, start + 6 * DAY, start + 36 * DAY]);
  await f.service.scanUser(1); assert.equal((await count(f)).n, 0);
  f.setTime(start + 30 * DAY); await f.service.scanUser(1); assert.equal((await count(f)).n, 1);
});
test('Stripe failed/expired checkout notifications are idempotent and respect payment preferences', async t => {
  const f = await fixture(t); await f.run("INSERT INTO subscription_payments VALUES(1,1,'pending_payment',5,'MYR','stripe',?)", [f.time()]); await f.run("INSERT INTO stripe_orders VALUES('fixture-order',1,1,NULL)");
  await Promise.all([f.service.stripeOutcome(1, 'fixture-order', 'failed'), f.service.stripeOutcome(1, 'fixture-order', 'failed')]); assert.equal((await count(f)).n, 1);
  await f.service.stripeOutcome(2, 'fixture-order', 'failed'); assert.equal((await count(f)).n, 1);
  await f.service.savePreferences(1, { payment_status: false }); await f.service.stripeOutcome(1, 'fixture-order', 'expired'); assert.equal((await count(f)).n, 1);
  await f.run('UPDATE stripe_orders SET activated_at=?', [f.time()]); await f.service.stripeOutcome(1, 'fixture-order', 'failed'); assert.equal((await count(f)).n, 1);
});
test('notification APIs enforce auth, CSRF, ownership, strict preferences, pagination, category filters and global unread counts', async t => {
  const f = await fixture(t), auth = { Authorization: 'Bearer ' + f.token(1) }, other = { Authorization: 'Bearer ' + f.token(2) };
  assert.equal((await fetch(f.base + '/api/notifications')).status, 401);
  for (let i = 0; i < 42; i++) await f.run("INSERT INTO user_notifications(user_id,kind,title,created_at) VALUES(1,'payment_approved','Legacy payment',?)", [f.time()]);
  const first = await (await fetch(f.base + '/api/notifications?limit=20&category=payment_status', { headers: auth })).json(); assert.equal(first.notifications.length, 20); assert.equal(first.unread, 42); assert(first.nextBefore);
  const second = await (await fetch(f.base + '/api/notifications?limit=20&before=' + first.nextBefore, { headers: auth })).json(); assert.equal(second.notifications.length, 20); assert.equal(second.notifications.some(n => n.id === first.notifications[0].id), false);
  const id = first.notifications[0].id; for (const [method, suffix] of [['DELETE', '/' + id], ['POST', '/' + id + '/read']]) assert.equal((await fetch(f.base + '/api/notifications' + suffix, { method, headers: other })).status, 404);
  assert.equal((await (await fetch(f.base + '/api/notifications', { headers: other })).json()).unread, 0);
  const cookie = 'corngrid_session=' + f.token(1);
  const csrf = await fetch(f.base + '/api/notifications/preferences', { method: 'PATCH', headers: { Cookie: cookie, Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_status: false }) }); assert.equal(csrf.status, 403);
  for (const body of [{ user_id: 2 }, { payment_status: 'false' }, { expiry_days: 0 }, { expiry_days: 31 }, {}]) assert.equal((await fetch(f.base + '/api/notifications/preferences', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  const update = await fetch(f.base + '/api/notifications/preferences', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_status: false, expiry_days: 14 }) }); assert.equal(update.status, 200); assert.equal((await update.json()).preferences.payment_status, false);
  assert.equal((await f.service.preferences(2)).payment_status, true);
  await fetch(f.base + '/api/notifications/' + id + '/read', { method: 'POST', headers: auth }); assert.equal((await (await fetch(f.base + '/api/notifications?limit=1', { headers: auth })).json()).unread, 41);
  for (const query of ['?limit=0', '?before=1abc', '?category=private', '?unread=false']) assert.equal((await fetch(f.base + '/api/notifications' + query, { headers: auth })).status, 400);
});
