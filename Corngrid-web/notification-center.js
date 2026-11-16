'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dbGet, dbAll, dbRun, withTransaction, isPostgres } = require('./db-async');
const { inWriteTransaction } = require('./db-write');

const CATEGORIES = ['sandbox_offline', 'ea_disconnected', 'subscription_expiry', 'payment_status'];
const DEFAULTS = Object.freeze({ sandbox_offline: true, ea_disconnected: true, subscription_expiry: true, payment_status: true, expiry_days: 7 });
const DAY = 86400000;
const categoryFor = kind => kind.startsWith('payment_') || kind === 'subscription_active' ? 'payment_status'
  : kind.startsWith('subscription_') ? 'subscription_expiry' : 'ea_disconnected';

function createNotificationCenter({ db, now = Date.now, nodeOfflineMs = 90000, eaOfflineMs = 180000, sandboxOfflineMs = 120000 } = {}) {
  let initialization, timer, running, cursor = 0, stopped = true;
  const startedAt = now();
  const atomic = task => inWriteTransaction() ? task() : withTransaction(db, task);
  // Serialize notification work without repeatedly updating operational user rows.
  // SQLite already owns its connection's BEGIN IMMEDIATE write transaction.
  const lockOwner = userId => isPostgres(db) ? dbGet(db, 'SELECT pg_advisory_xact_lock(20261116,?)', [userId]) : Promise.resolve();
  function ready() {
    if (!initialization) initialization = (async () => {
      if (isPostgres(db)) {
        await dbGet(db, 'SELECT user_id FROM notification_preferences LIMIT 1');
        await dbGet(db, 'SELECT source_key FROM notification_alert_state LIMIT 1');
        await dbGet(db, 'SELECT notification_id FROM user_notification_details LIMIT 1');
      } else await new Promise((resolve, reject) => db.exec(fs.readFileSync(path.join(__dirname, 'migrations/sqlite/0020_notification_center.sql'), 'utf8'), error => error ? reject(error) : resolve()));
    })();
    return initialization;
  }
  async function preferences(userId) {
    await ready();
    const row = await dbGet(db, 'SELECT * FROM notification_preferences WHERE user_id=?', [userId]);
    return { ...Object.fromEntries(CATEGORIES.map(key => [key, row ? Number(row[key]) === 1 : true])), expiry_days: row ? Number(row.expiry_days) : DEFAULTS.expiry_days };
  }
  async function savePreferences(userId, values) {
    if (!values || Array.isArray(values) || typeof values !== 'object' || !Object.keys(values).length || Object.keys(values).some(key => ![...CATEGORIES, 'expiry_days'].includes(key))
      || CATEGORIES.some(key => key in values && typeof values[key] !== 'boolean')
      || ('expiry_days' in values && (!Number.isInteger(values.expiry_days) || values.expiry_days < 1 || values.expiry_days > 30))) {
      throw Object.assign(Error('Invalid notification preferences.'), { status: 400 });
    }
    await ready();
    return atomic(async () => {
      await lockOwner(userId);
      const next = { ...await preferences(userId), ...values };
      await dbRun(db, `INSERT INTO notification_preferences(user_id,sandbox_offline,ea_disconnected,subscription_expiry,payment_status,expiry_days,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET sandbox_offline=excluded.sandbox_offline,ea_disconnected=excluded.ea_disconnected,
        subscription_expiry=excluded.subscription_expiry,payment_status=excluded.payment_status,expiry_days=excluded.expiry_days,updated_at=excluded.updated_at`,
      [userId, ...CATEGORIES.map(key => next[key] ? 1 : 0), next.expiry_days, now()]);
      return next;
    });
  }
  async function insert(userId, kind, title, body, category, target, payload = {}, prefs) {
    if (!(prefs || await preferences(userId))[category]) return false;
    const inserted = await dbRun(db, 'INSERT INTO user_notifications(user_id,kind,title,body,created_at) VALUES(?,?,?,?,?)', [userId, kind, title, body || null, now()]);
    await dbRun(db, 'INSERT INTO user_notification_details(notification_id,category,target,payload_json) VALUES(?,?,?,?)', [inserted.lastID, category, target, JSON.stringify(payload)]);
    return true;
  }
  async function transition(userId, key, value, message, prefs, emitInitial = true) {
    const previous = await dbGet(db, 'SELECT value FROM notification_alert_state WHERE user_id=? AND source_key=?', [userId, key]);
    if (previous?.value === value) return false;
    await dbRun(db, `INSERT INTO notification_alert_state(user_id,source_key,value,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,source_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [userId, key, value, now()]);
    if (message && (previous || emitInitial)) return insert(userId, message.kind, message.title, message.body, message.category, message.target, message.payload, prefs);
    return false;
  }
  function paymentMessage(payment) {
    return { kind: 'payment_status', category: 'payment_status', target: 'subscription', title: 'Payment status updated',
      body: `Payment #${payment.id}: ${payment.status.replace(/_/g, ' ')}. ${Number(payment.amount).toFixed(2)} ${payment.currency}.`,
      payload: { paymentId: payment.id, status: payment.status, provider: payment.payment_method === 'stripe' ? 'Stripe' : 'DuitNow', amount: Number(payment.amount), currency: payment.currency } };
  }
  async function observePayment(userId, paymentId, forceInitial = false) {
    await ready();
    return atomic(async () => {
      await lockOwner(userId);
      const payment = await dbGet(db, 'SELECT id,status,amount,currency,payment_method,updated_at FROM subscription_payments WHERE id=? AND user_id=?', [paymentId, userId]);
      if (!payment) return false;
      return transition(userId, 'payment:' + payment.id, payment.status + ':' + payment.payment_method, paymentMessage(payment), await preferences(userId), forceInitial || Number(payment.updated_at) >= startedAt);
    });
  }
  async function notify(userId, kind, title, body, context = {}) {
    await ready();
    if (context.paymentId) return observePayment(userId, context.paymentId, true);
    return atomic(async () => {
      await lockOwner(userId);
      return insert(userId, kind, title, body, categoryFor(kind), kind.startsWith('ea_') || kind === 'activation_revoked' ? 'monitoring' : 'subscription');
    });
  }
  async function stripeOutcome(userId, orderId, status) {
    if (!['failed', 'expired'].includes(status)) return false;
    await ready();
    return atomic(async () => {
      await lockOwner(userId);
      const row = await dbGet(db, `SELECT p.id,p.amount,p.currency,p.payment_method,p.status FROM stripe_orders o
        JOIN subscription_payments p ON p.id=o.payment_id WHERE o.id=? AND o.user_id=? AND p.user_id=? AND o.activated_at IS NULL`, [orderId, userId, userId]);
      if (!row || row.status === 'approved') return false;
      return transition(userId, 'stripe:' + orderId, status, paymentMessage({ ...row, status }), await preferences(userId));
    });
  }
  const fresh = (stamp, timeout, time) => Number(stamp) > 0 && Number(stamp) <= time + 60000 && Number(stamp) >= time - timeout;
  async function scanUser(userId) {
    await ready();
    return atomic(async () => {
      // A shared owner lock serializes observation and preference changes across
      // workers. All mutations are notifications only: no trading/payment state.
      await lockOwner(userId);
      const archived = await dbGet(db, 'SELECT user_id FROM account_archives WHERE user_id=? AND archived_at IS NOT NULL', [userId]);
      if (archived) return;
      const prefs = await preferences(userId), time = now();
      const instances = await dbAll(db, `SELECT s.id,s.status,s.last_heartbeat_at,s.started_at,s.updated_at,n.last_heartbeat_at AS node_heartbeat,n.status AS node_status
        FROM sandbox_instances s LEFT JOIN sandbox_nodes n ON n.id=s.node_id WHERE s.user_id=? AND s.deleted_at IS NULL ORDER BY s.id LIMIT 200`, [userId]);
      for (const instance of instances) {
        const expected = ['running', 'starting', 'failed'].includes(instance.status);
        const reference = Number(instance.last_heartbeat_at || instance.started_at || instance.updated_at);
        const gracePassed = reference > 0 && time - reference > sandboxOfflineMs;
        const offline = expected && (instance.status === 'failed' || gracePassed && (!fresh(instance.last_heartbeat_at, sandboxOfflineMs, time) || !fresh(instance.node_heartbeat, nodeOfflineMs, time) || instance.node_status !== 'active'));
        await transition(userId, 'sandbox:' + instance.id, offline ? 'offline' : expected ? 'online' : 'stopped', offline ? {
          kind: 'sandbox_offline', category: 'sandbox_offline', target: 'sandbox', title: 'Sandbox needs attention', body: `Sandbox #${instance.id} is not reporting normally. Open Sandbox to check its status.`, payload: { instanceId: instance.id }
        } : null, prefs);
      }
      const accounts = await dbAll(db, 'SELECT id,account_number,last_heartbeat,linked_at,auth_error_at FROM mt5_accounts WHERE user_id=? ORDER BY id LIMIT 200', [userId]);
      for (const account of accounts) {
        // Never-linked/no-data accounts are waiting for setup, not disconnected.
        const offline = account.last_heartbeat != null && !fresh(account.last_heartbeat, eaOfflineMs, time)
          || Number(account.auth_error_at) > Number(account.last_heartbeat || 0);
        const masked = '****' + String(account.account_number).slice(-4);
        await transition(userId, 'ea:' + account.id, offline ? 'offline' : account.last_heartbeat ? 'online' : 'waiting', offline ? {
          kind: 'ea_disconnected', category: 'ea_disconnected', target: 'monitoring', title: 'EA connection interrupted', body: `MT5 account ${masked} is no longer reporting. Check the terminal, EA and connection.`, payload: { account: masked }
        } : null, prefs);
      }
      const subscriptions = await dbAll(db, `SELECT s.id,s.expires_at FROM user_subscriptions s WHERE s.user_id=? AND s.status='active' AND s.deleted_at IS NULL
        AND s.starts_at IS NOT NULL AND s.starts_at<=? AND s.expires_at>?
        AND NOT EXISTS(SELECT 1 FROM user_subscriptions renewed WHERE renewed.user_id=s.user_id AND renewed.status='active' AND renewed.deleted_at IS NULL
          AND renewed.starts_at IS NOT NULL AND renewed.starts_at<=s.expires_at AND (renewed.expires_at IS NULL OR renewed.expires_at>s.expires_at))
        ORDER BY s.id LIMIT 200`, [userId, time, time]);
      for (const subscription of subscriptions) {
        const days = Math.max(1, Math.ceil((Number(subscription.expires_at) - time) / DAY));
        if (days > prefs.expiry_days) continue;
        const band = days <= 1 ? 1 : days <= 3 ? Math.min(3, prefs.expiry_days) : prefs.expiry_days;
        await transition(userId, 'expiry:' + subscription.id, subscription.expires_at + ':' + band, {
          kind: 'subscription_expiring', category: 'subscription_expiry', target: 'subscription', title: 'Subscription expiring soon',
          body: `Your subscription expires on ${new Date(Number(subscription.expires_at)).toISOString().slice(0, 10)}. Open Subscription to renew.`, payload: { expiresAt: Number(subscription.expires_at), days }
        }, prefs);
      }
      const payments = await dbAll(db, `SELECT id,status,amount,currency,payment_method,updated_at FROM subscription_payments WHERE user_id=?
        ORDER BY updated_at DESC,id DESC LIMIT 200`, [userId]);
      for (const payment of payments) await transition(userId, 'payment:' + payment.id, payment.status + ':' + payment.payment_method, paymentMessage(payment), prefs, Number(payment.updated_at) >= startedAt);
    });
  }
  async function sweep() {
    if (running) return running;
    running = (async () => {
      await ready();
      const users = await dbAll(db, 'SELECT id FROM users WHERE id>? ORDER BY id LIMIT 100', [cursor]);
      const deadline = Date.now() + 3000;
      for (const user of users) {
        await scanUser(user.id); cursor = user.id;
        if (Date.now() > deadline) return;
      }
      if (users.length < 100) cursor = 0;
    })().finally(() => { running = null; });
    return running;
  }
  function start() {
    if (!stopped) return; stopped = false;
    const tick = async () => {
      try { await sweep(); } catch { console.error('Notification observation unavailable; check schema and database health.'); }
      if (!stopped) { timer = setTimeout(tick, 30000); timer.unref?.(); }
    };
    void tick();
  }
  async function stop() { stopped = true; clearTimeout(timer); if (running) await running.catch(() => {}); }
  return { ready, preferences, savePreferences, notify, observePayment, stripeOutcome, scanUser, sweep, start, stop };
}

function registerNotificationRoutes(app, db, verifyToken, service, rateLimit) {
  const readLimit = rateLimit ? rateLimit({ limit: 90, windowMs: 60000 }) : (_q, _r, next) => next();
  const writeLimit = rateLimit ? rateLimit({ limit: 30, windowMs: 60000 }) : (_q, _r, next) => next();
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await service.ready(); await handler(req, res); }
    catch (error) { res.status(error.status || 503).json({ error: error.status === 400 ? error.message : 'Notifications are temporarily unavailable.' }); }
  };
  const validId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  app.get('/api/notifications/preferences', verifyToken, readLimit, route(async (req, res) => res.json({ preferences: await service.preferences(req.user.id), delivery: 'in_app' })));
  app.patch('/api/notifications/preferences', verifyToken, writeLimit, route(async (req, res) => res.json({ preferences: await service.savePreferences(req.user.id, req.body), delivery: 'in_app' })));
  app.get('/api/notifications', verifyToken, readLimit, route(async (req, res) => {
    const { before, category, unread } = req.query;
    const limit = req.query.limit == null ? 30 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || before != null && !validId(before) || category != null && !CATEGORIES.includes(category) || unread != null && unread !== '1') return res.status(400).json({ error: 'Invalid notification filter.' });
    const where = ['n.user_id=?'], params = [req.user.id];
    if (before != null) { where.push('n.id<?'); params.push(Number(before)); }
    if (category) { where.push("COALESCE(d.category,CASE WHEN n.kind LIKE 'payment_%' OR n.kind='subscription_active' THEN 'payment_status' WHEN n.kind LIKE 'subscription_%' THEN 'subscription_expiry' ELSE 'ea_disconnected' END)=?"); params.push(category); }
    if (unread) where.push('n.read_at IS NULL');
    const rows = await dbAll(db, `SELECT n.id,n.kind,n.title,n.body,n.read_at,n.created_at,d.category,d.target,d.payload_json
      FROM user_notifications n LEFT JOIN user_notification_details d ON d.notification_id=n.id WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ?`, [...params, limit + 1]);
    const count = await dbGet(db, 'SELECT COUNT(*) AS total FROM user_notifications WHERE user_id=? AND read_at IS NULL', [req.user.id]);
    const hasMore = rows.length > limit;
    const notifications = rows.slice(0, limit).map(({ payload_json, ...row }) => {
      let payload = {}; try { payload = JSON.parse(payload_json || '{}'); } catch {}
      return { ...row, category: row.category || categoryFor(row.kind), target: row.target || 'subscription', payload };
    });
    res.json({ notifications, unread: Number(count.total), nextBefore: hasMore ? notifications.at(-1).id : null });
  }));
  app.post('/api/notifications/read', verifyToken, writeLimit, route(async (req, res) => {
    await dbRun(db, 'UPDATE user_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [Date.now(), req.user.id]);
    res.json({ message: 'Notifications marked as read.' });
  }));
  app.post('/api/notifications/:id/read', verifyToken, writeLimit, route(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid notification.' });
    const row = await dbGet(db, 'SELECT id FROM user_notifications WHERE id=? AND user_id=?', [Number(req.params.id), req.user.id]);
    if (!row) return res.status(404).json({ error: 'Notification not found.' });
    await dbRun(db, 'UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?', [Date.now(), row.id, req.user.id]);
    res.json({ message: 'Notification marked as read.' });
  }));
  async function remove(req, res, single) {
    if (single && !validId(req.params.id)) return res.status(400).json({ error: 'Invalid notification.' });
    const where = 'user_id=?' + (single ? ' AND id=?' : ''), params = [req.user.id, ...(single ? [Number(req.params.id)] : [])];
    const result = await withTransaction(db, async () => {
      await dbRun(db, `DELETE FROM user_notification_details WHERE notification_id IN (SELECT id FROM user_notifications WHERE ${where})`, params);
      return dbRun(db, `DELETE FROM user_notifications WHERE ${where}`, params);
    });
    if (single && !result.changes) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ message: single ? 'Notification deleted.' : 'Notifications cleared.', deleted: result.changes });
  }
  app.delete('/api/notifications', verifyToken, writeLimit, route((req, res) => remove(req, res, false)));
  app.delete('/api/notifications/:id', verifyToken, writeLimit, route((req, res) => remove(req, res, true)));
}
module.exports = { createNotificationCenter, registerNotificationRoutes, CATEGORIES, DEFAULTS };
