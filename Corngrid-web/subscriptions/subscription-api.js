'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exclusive } = require('../db-write');

const DEFAULT_MAX_ACTIVATIONS = 5;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_EA_BYTES = 50 * 1024 * 1024;
const PROOF_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS subscription_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    duration_days INTEGER NOT NULL,
    max_activations INTEGER NOT NULL DEFAULT 5,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id INTEGER,
    status TEXT NOT NULL,
    purchase_price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    duration_days INTEGER,
    max_activations INTEGER NOT NULL DEFAULT 5,
    starts_at INTEGER,
    expires_at INTEGER,
    approved_by INTEGER,
    approved_at INTEGER,
    suspended_at INTEGER,
    suspension_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_subs_status ON user_subscriptions(status);
  CREATE INDEX IF NOT EXISTS idx_user_subs_expires ON user_subscriptions(expires_at);
  CREATE TABLE IF NOT EXISTS subscription_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subscription_id INTEGER,
    plan_id INTEGER,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    payment_method TEXT NOT NULL DEFAULT 'duitnow',
    payment_reference TEXT,
    payment_proof_path TEXT,
    status TEXT NOT NULL,
    reviewed_by INTEGER,
    reviewed_at INTEGER,
    admin_notes TEXT,
    rejection_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sub_pay_user ON subscription_payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_sub_pay_status ON subscription_payments(status);
  CREATE INDEX IF NOT EXISTS idx_sub_pay_sub ON subscription_payments(subscription_id);
  CREATE TABLE IF NOT EXISTS ea_license_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subscription_id INTEGER,
    account_id INTEGER,
    mt5_account_number TEXT NOT NULL,
    broker_server TEXT NOT NULL,
    activation_identifier TEXT NOT NULL UNIQUE,
    license_status TEXT NOT NULL DEFAULT 'active',
    activated_at INTEGER NOT NULL,
    last_verified_at INTEGER,
    revoked_at INTEGER,
    revocation_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, mt5_account_number, broker_server)
  );
  CREATE INDEX IF NOT EXISTS idx_ea_act_user ON ea_license_activations(user_id);
  CREATE INDEX IF NOT EXISTS idx_ea_act_sub ON ea_license_activations(subscription_id);
  CREATE INDEX IF NOT EXISTS idx_ea_act_status ON ea_license_activations(license_status);
  CREATE TABLE IF NOT EXISTS subscription_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_role TEXT,
    action TEXT NOT NULL,
    affected_type TEXT,
    affected_id INTEGER,
    metadata TEXT,
    reason TEXT,
    ip_address TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sub_audit_actor ON subscription_audit_logs(actor_id);
  CREATE INDEX IF NOT EXISTS idx_sub_audit_action ON subscription_audit_logs(action);
  CREATE INDEX IF NOT EXISTS idx_sub_audit_created ON subscription_audit_logs(created_at);
  CREATE TABLE IF NOT EXISTS ea_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    release_notes TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    released_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, read_at, created_at);
`;

function createSubscriptionApi(app, db, verifyToken, adminAuth, authenticateInstallation) {
  const PROOF_DIR = process.env.PAYMENT_PROOF_DIR
    ? path.resolve(process.env.PAYMENT_PROOF_DIR)
    : path.join(__dirname, '..', 'storage', 'payment-proofs');
  const EA_DOWNLOAD_DIR = process.env.EA_DOWNLOAD_DIR
    ? path.resolve(process.env.EA_DOWNLOAD_DIR)
    : path.join(__dirname, '..', 'storage', 'ea-downloads');
  const DUITNOW_QR_PATH = process.env.DUITNOW_QR_PATH
    ? path.resolve(process.env.DUITNOW_QR_PATH)
    : (() => {
      const dir = path.join(__dirname, '..', 'public', 'assets', 'payments');
      const candidates = ['duitnow-qr.png', 'duitnow-qr.jpg', 'duitnow-qr.jpeg', 'duitnow-qr.webp']
        .map((name) => path.join(dir, name));
      return candidates.find((candidate) => {
        try { return fs.statSync(candidate).isFile(); } catch { return false; }
      }) || candidates[0];
    })();

  fs.mkdirSync(PROOF_DIR, { recursive: true });
  fs.mkdirSync(EA_DOWNLOAD_DIR, { recursive: true });

  const now = () => Date.now();
  const isPostgres = typeof db.transaction === 'function';

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }
  function get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
    });
  }
  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
    });
  }

  async function withTransaction(task) {
    if (isPostgres) return db.transaction(task);
    return exclusive(db, async () => {
      await run('BEGIN IMMEDIATE');
      try {
        const result = await task();
        await run('COMMIT');
        return result;
      } catch (error) {
        await run('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async function logAudit(actorId, actorRole, action, affectedType, affectedId, metadata, reason, ip) {
    try {
      await run(
        `INSERT INTO subscription_audit_logs
           (actor_id, actor_role, action, affected_type, affected_id, metadata, reason, ip_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actorId || null, actorRole || null, action, affectedType || null, affectedId || null,
         metadata ? JSON.stringify(metadata) : null, reason || null, ip || null, now()]
      );
    } catch (error) {
      console.error('Failed to write subscription audit log:', error.message);
    }
  }

  async function notify(userId, kind, title, body) {
    try {
      await run(
        `INSERT INTO user_notifications (user_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
        [userId, kind, title, body || null, now()]
      );
    } catch (error) {
      console.error('Failed to create subscription notification:', error.message);
    }
  }

  function publicPlan(plan) {
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description || '',
      price: Number(plan.price),
      currency: plan.currency,
      durationDays: plan.duration_days,
      maxActivations: plan.max_activations
    };
  }

  db.exec(SCHEMA, error => {
    if (error) console.error('Failed to initialize subscription tables:', error.message);
  });

  // Startup barrier: SQLite schema creation is applied here; PostgreSQL tables
  // come from migrations/0003_subscriptions.sql. Expose a ready() promise so
  // server startup can wait and warn clearly when the migration is missing.
  async function ready() {
    if (!isPostgres) {
      await new Promise((resolve, reject) => {
        db.exec(SCHEMA, error => (error ? reject(error) : resolve()));
      });
      return;
    }
    try {
      const table = await get("SELECT to_regclass('public.subscription_plans') AS table_name");
      if (!table || !table.table_name) {
        console.error('Subscription tables are missing. Apply migrations/postgres/0003_subscriptions.sql before using subscriptions.');
      }
    } catch (error) {
      console.error('Unable to verify subscription tables:', error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Subscription status helpers
  // ---------------------------------------------------------------------------

  function effectiveStatus(subscription) {
    if (!subscription) return null;
    if (subscription.status === 'active' && subscription.expires_at && subscription.expires_at <= now()) {
      return 'expired';
    }
    return subscription.status;
  }

  async function latestSubscription(userId) {
    return get(`
      SELECT s.*, p.name AS plan_name, p.description AS plan_description
      FROM user_subscriptions s
      LEFT JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.deleted_at IS NULL
      ORDER BY s.id DESC
      LIMIT 1
    `, [userId]);
  }

  // The subscription covering the present moment (started already). A future
  // renewal must not hide a suspended or expired current license.
  async function currentSubscription(userId) {
    return get(`
      SELECT s.*, p.name AS plan_name, p.max_activations AS plan_max_activations
      FROM user_subscriptions s
      LEFT JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.deleted_at IS NULL
        AND s.starts_at IS NOT NULL AND s.starts_at <= ?
      ORDER BY s.starts_at DESC, s.id DESC
      LIMIT 1
    `, [userId, now()]);
  }

  async function eligibleSubscription(userId) {
    const row = await get(`
      SELECT s.*, p.name AS plan_name, p.max_activations AS plan_max_activations
      FROM user_subscriptions s
      LEFT JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.deleted_at IS NULL AND s.status = 'active'
        AND s.starts_at IS NOT NULL AND s.starts_at <= ?
        AND (s.expires_at IS NULL OR s.expires_at > ?)
      ORDER BY s.expires_at DESC, s.id DESC
      LIMIT 1
    `, [userId, now(), now()]);
    return row || null;
  }

  async function activeActivationCount(userId) {
    const row = await get(
      `SELECT COUNT(*) AS count FROM ea_license_activations WHERE user_id = ? AND license_status = 'active'`,
      [userId]
    );
    return row ? Number(row.count) : 0;
  }

  function maxActivationsFor(subscription) {
    return subscription.max_activations || subscription.plan_max_activations || DEFAULT_MAX_ACTIVATIONS;
  }

  // ---------------------------------------------------------------------------
  // User API
  // ---------------------------------------------------------------------------

  app.get('/api/subscription/plans', verifyToken, async (_req, res) => {
    try {
      const plans = await all('SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price ASC, id ASC');
      res.json({ plans: plans.map(publicPlan), duitnowConfigured: fs.existsSync(DUITNOW_QR_PATH) });
    } catch (error) {
      console.error('Failed to load subscription plans:', error.message);
      res.status(500).json({ error: 'Unable to load subscription plans.' });
    }
  });

  app.get('/api/subscription/overview', verifyToken, async (req, res) => {
    try {
      const userId = req.user.id;
      // An active license stays visible while a renewal purchase is pending:
      // prefer the subscription that is actually in effect, then fall back to
      // the most recent purchase (pending/rejected/expired) for reporting.
      const latest = await latestSubscription(userId);
      const current = await currentSubscription(userId);
      const subscription = current || latest;
      const status = effectiveStatus(subscription);
      const payments = await all(
        `SELECT pay.id, pay.amount, pay.currency, pay.status, pay.payment_reference,
                pay.created_at, pay.reviewed_at, pay.rejection_reason, p.name AS plan_name
         FROM subscription_payments pay
         LEFT JOIN subscription_plans p ON p.id = pay.plan_id
         WHERE pay.user_id = ?
         ORDER BY pay.id DESC LIMIT 10`,
        [userId]
      );
      const activations = await all(
        `SELECT id, mt5_account_number, broker_server, license_status, activated_at, last_verified_at
         FROM ea_license_activations WHERE user_id = ? ORDER BY id DESC`,
        [userId]
      );
      const activeCount = activations.filter(row => row.license_status === 'active').length;

      res.json({
        subscription: subscription ? {
          id: subscription.id,
          status,
          planId: subscription.plan_id,
          planName: subscription.plan_name || null,
          price: Number(subscription.purchase_price),
          currency: subscription.currency,
          startsAt: subscription.starts_at,
          expiresAt: subscription.expires_at,
          suspendedReason: subscription.suspension_reason,
          maxActivations: maxActivationsFor(subscription)
        } : null,
        latestPayment: payments[0] || null,
        payments,
        activations: activations.map(row => ({
          id: row.id,
          maskedAccount: maskAccount(row.mt5_account_number),
          brokerServer: row.broker_server,
          status: row.license_status,
          activatedAt: row.activated_at,
          lastVerifiedAt: row.last_verified_at
        })),
        activationCount: activeCount,
        maxActivations: subscription ? maxActivationsFor(subscription) : DEFAULT_MAX_ACTIVATIONS,
        daysRemaining: subscription && subscription.expires_at
          ? Math.max(0, Math.ceil((subscription.expires_at - now()) / 86400000))
          : null,
        duitnowConfigured: fs.existsSync(DUITNOW_QR_PATH)
      });
    } catch (error) {
      console.error('Failed to load subscription overview:', error.message);
      res.status(500).json({ error: 'Unable to load subscription overview.' });
    }
  });

  app.post('/api/subscription/subscribe', verifyToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const planId = Number.parseInt(req.body?.planId, 10);
      if (!Number.isSafeInteger(planId) || planId < 1) {
        return res.status(400).json({ error: 'A valid subscription plan is required.' });
      }

      const plan = await get('SELECT * FROM subscription_plans WHERE id = ? AND is_active = TRUE', [planId]);
      if (!plan) return res.status(404).json({ error: 'This subscription plan is not available.' });

      return await withTransaction(async () => {
        const openPurchase = await get(
          `SELECT id FROM user_subscriptions
           WHERE user_id = ? AND status IN ('pending_payment','pending_approval') AND deleted_at IS NULL
           LIMIT 1`,
          [userId]
        );
        if (openPurchase) {
          return res.status(409).json({ error: 'You already have a pending subscription purchase.' });
        }

        const current = await get(
          `SELECT id, status FROM user_subscriptions
           WHERE user_id = ? AND deleted_at IS NULL AND status IN ('active','suspended')
           ORDER BY id DESC LIMIT 1`,
          [userId]
        );
        if (current && current.status === 'suspended') {
          return res.status(409).json({ error: 'Your subscription is suspended. Contact support to reinstate it before renewing.' });
        }

        const timestamp = now();
        const created = await run(
          `INSERT INTO user_subscriptions
             (user_id, plan_id, status, purchase_price, currency, duration_days, max_activations, created_at, updated_at)
           VALUES (?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?)`,
          [userId, plan.id, Number(plan.price), plan.currency, plan.duration_days, plan.max_activations, timestamp, timestamp]
        );
        const payment = await run(
          `INSERT INTO subscription_payments
             (user_id, subscription_id, plan_id, amount, currency, payment_method, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'duitnow', 'pending_payment', ?, ?)`,
          [userId, created.lastID, plan.id, Number(plan.price), plan.currency, timestamp, timestamp]
        );

        await logAudit(userId, 'user', 'subscription_created', 'subscription', created.lastID,
          { planId: plan.id, amount: Number(plan.price), currency: plan.currency }, null, req.ip);

        return res.status(201).json({
          subscriptionId: created.lastID,
          paymentId: payment.lastID,
          plan: publicPlan(plan),
          amount: Number(plan.price),
          currency: plan.currency,
          duitnowConfigured: fs.existsSync(DUITNOW_QR_PATH)
        });
      });
    } catch (error) {
      console.error('Failed to create subscription purchase:', error.message);
      res.status(500).json({ error: 'Unable to create the subscription purchase.' });
    }
  });

  // Cancels an unpaid purchase. Once payment proof is submitted the request is
  // already with an administrator, so it must be resolved through support.
  app.post('/api/subscription/cancel', verifyToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const paymentId = Number.parseInt(req.body?.paymentId, 10);
      if (!Number.isSafeInteger(paymentId) || paymentId < 1) {
        return res.status(400).json({ error: 'A valid payment is required.' });
      }

      const outcome = await withTransaction(async () => {
        const payment = await get(
          'SELECT * FROM subscription_payments WHERE id = ? AND user_id = ?',
          [paymentId, userId]
        );
        if (!payment) return { http: 404, body: { error: 'Payment not found.' } };
        if (payment.status === 'pending_approval') {
          return { http: 409, body: { error: 'Your payment is already under review. Contact support to cancel it.' } };
        }
        if (payment.status !== 'pending_payment') {
          return { http: 409, body: { error: 'This purchase can no longer be cancelled.' } };
        }

        const timestamp = now();
        await run(
          `UPDATE subscription_payments SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'pending_payment'`,
          [timestamp, paymentId, userId]
        );
        if (payment.subscription_id) {
          await run(
            `UPDATE user_subscriptions SET status = 'cancelled', deleted_at = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND status = 'pending_payment' AND deleted_at IS NULL`,
            [timestamp, timestamp, payment.subscription_id, userId]
          );
        }

        await logAudit(userId, 'user', 'subscription_cancelled', 'subscription',
          payment.subscription_id, { paymentId }, null, req.ip);
        return { http: 200, body: { message: 'Pending subscription cancelled.' } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to cancel subscription purchase:', error.message);
      res.status(500).json({ error: 'Unable to cancel this purchase.' });
    }
  });

  app.post('/api/subscription/payment-proof', verifyToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const paymentId = Number.parseInt(req.body?.paymentId, 10);
      const paymentReference = typeof req.body?.paymentReference === 'string'
        ? req.body.paymentReference.trim().slice(0, 120) : null;

      if (!Number.isSafeInteger(paymentId) || paymentId < 1) {
        return res.status(400).json({ error: 'A valid payment is required.' });
      }
      const payment = await get('SELECT * FROM subscription_payments WHERE id = ? AND user_id = ?', [paymentId, userId]);
      if (!payment) return res.status(404).json({ error: 'Payment not found.' });
      if (!['pending_payment', 'pending_approval'].includes(payment.status)) {
        return res.status(409).json({ error: 'This payment can no longer be updated.' });
      }

      let proofPath = payment.payment_proof_path;
      if (req.body?.proofData && req.body?.proofName) {
        const extension = path.extname(String(req.body.proofName)).toLowerCase();
        if (!PROOF_EXTENSIONS.has(extension)) {
          return res.status(400).json({ error: 'Payment proof must be an image or PDF file.' });
        }
        const base64 = String(req.body.proofData).replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        if (!buffer.length || buffer.length > MAX_PROOF_BYTES) {
          return res.status(400).json({ error: 'Payment proof must be smaller than 5 MB.' });
        }
        const filename = `proof_${userId}_${paymentId}_${crypto.randomBytes(12).toString('hex')}${extension}`;
        fs.writeFileSync(path.join(PROOF_DIR, filename), buffer);
        proofPath = filename;
      }

      if (!proofPath && !paymentReference) {
        return res.status(400).json({ error: 'Attach a payment proof or enter a transaction reference.' });
      }

      const timestamp = now();
      await withTransaction(async () => {
        await run(
          `UPDATE subscription_payments
           SET payment_reference = COALESCE(?, payment_reference), payment_proof_path = ?,
               status = 'pending_approval', updated_at = ?
           WHERE id = ? AND user_id = ? AND status IN ('pending_payment','pending_approval')`,
          [paymentReference, proofPath, timestamp, paymentId, userId]
        );
        await run(
          `UPDATE user_subscriptions SET status = 'pending_approval', updated_at = ?
           WHERE id = ? AND status = 'pending_payment'`,
          [timestamp, payment.subscription_id]
        );
      });

      await logAudit(userId, 'user', 'payment_proof_submitted', 'payment', paymentId,
        { hasProof: Boolean(proofPath) }, null, req.ip);
      await notify(userId, 'payment_submitted', 'Payment submitted',
        'Your DuitNow payment is awaiting administrator approval.');

      res.json({ message: 'Payment evidence submitted. Your subscription activates after approval.' });
    } catch (error) {
      console.error('Failed to submit payment proof:', error.message);
      res.status(500).json({ error: 'Unable to submit payment evidence.' });
    }
  });

  app.get('/api/subscription/duitnow-qr', verifyToken, (_req, res) => {
    if (!fs.existsSync(DUITNOW_QR_PATH)) {
      return res.status(404).json({ error: 'DuitNow QR has not been configured yet.' });
    }
    res.sendFile(DUITNOW_QR_PATH);
  });

  // ---------------------------------------------------------------------------
  // Protected EA downloads
  // ---------------------------------------------------------------------------

  app.get('/api/subscription/downloads', verifyToken, async (req, res) => {
    try {
      const subscription = await eligibleSubscription(req.user.id);
      if (!subscription) {
        return res.status(403).json({ error: 'An active subscription is required to download the EA.' });
      }
      const versions = await all(
        'SELECT id, version, filename, release_notes, created_at FROM ea_downloads WHERE is_active = TRUE ORDER BY id DESC LIMIT 20'
      );
      res.json({
        subscriptionStatus: 'active',
        versions: versions.map(row => ({
          id: row.id,
          version: row.version,
          filename: row.filename,
          releaseNotes: row.release_notes || '',
          releasedAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('Failed to list EA downloads:', error.message);
      res.status(500).json({ error: 'Unable to load EA downloads.' });
    }
  });

  app.get('/api/subscription/download/:id', verifyToken, async (req, res) => {
    try {
      const downloadId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(downloadId) || downloadId < 1) {
        return res.status(400).json({ error: 'Invalid download identifier.' });
      }
      const subscription = await eligibleSubscription(req.user.id);
      if (!subscription) {
        return res.status(403).json({ error: 'An active subscription is required to download the EA.' });
      }
      const record = await get('SELECT * FROM ea_downloads WHERE id = ? AND is_active = TRUE', [downloadId]);
      if (!record) return res.status(404).json({ error: 'This EA version is not available.' });

      const absolute = path.isAbsolute(record.file_path)
        ? record.file_path
        : path.resolve(EA_DOWNLOAD_DIR, record.file_path);
      if (!absolute.startsWith(path.resolve(EA_DOWNLOAD_DIR)) || !fs.existsSync(absolute)) {
        return res.status(404).json({ error: 'The EA file is temporarily unavailable.' });
      }

      await logAudit(req.user.id, 'user', 'ea_downloaded', 'download', downloadId,
        { version: record.version }, null, req.ip);
      res.download(absolute, record.filename);
    } catch (error) {
      console.error('EA download failed:', error.message);
      res.status(500).json({ error: 'Unable to download the EA file.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
      const rows = await all(
        'SELECT id, kind, title, body, read_at, created_at FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        [req.user.id]
      );
      res.json({ notifications: rows, unread: rows.filter(row => !row.read_at).length });
    } catch (error) {
      console.error('Failed to load notifications:', error.message);
      res.status(500).json({ error: 'Unable to load notifications.' });
    }
  });

  app.post('/api/notifications/read', verifyToken, async (req, res) => {
    try {
      await run('UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
        [now(), req.user.id]);
      res.json({ message: 'Notifications marked as read.' });
    } catch (error) {
      res.status(500).json({ error: 'Unable to update notifications.' });
    }
  });

  app.delete('/api/notifications', verifyToken, async (req, res) => {
    try {
      const result = await run('DELETE FROM user_notifications WHERE user_id = ?', [req.user.id]);
      res.json({ message: 'Notifications cleared.', deleted: result.changes });
    } catch (error) {
      console.error('Failed to clear notifications:', error.message);
      res.status(500).json({ error: 'Unable to clear notifications.' });
    }
  });

  app.delete('/api/notifications/:id', verifyToken, async (req, res) => {
    try {
      const notificationId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(notificationId) || notificationId < 1) {
        return res.status(400).json({ error: 'Invalid notification.' });
      }
      const result = await run(
        'DELETE FROM user_notifications WHERE id = ? AND user_id = ?',
        [notificationId, req.user.id]
      );
      if (!result.changes) return res.status(404).json({ error: 'Notification not found.' });
      res.json({ message: 'Notification deleted.' });
    } catch (error) {
      console.error('Failed to delete notification:', error.message);
      res.status(500).json({ error: 'Unable to delete this notification.' });
    }
  });

  // ---------------------------------------------------------------------------
  // License API (authenticated by the EA installation credential)
  // ---------------------------------------------------------------------------

  async function installationContext(req) {
    const installation = req.installation;
    if (!installation) return null;
    const account = await get(
      'SELECT id, user_id, account_number, broker_server FROM mt5_accounts WHERE id = ? AND user_id = ?',
      [installation.account_id, installation.user_id]
    );
    return account || null;
  }

  function licensePayload(subscription, activationCount, extra = {}) {
    return Object.assign({
      success: true,
      license_status: 'active',
      subscription_status: 'active',
      expires_at: subscription.expires_at,
      activation_count: activationCount,
      maximum_activations: maxActivationsFor(subscription),
      message: 'License active.'
    }, extra);
  }

  async function verifyLicense(req, res) {
    const account = await installationContext(req);
    if (!account) return res.status(403).json({ success: false, license_status: 'account_not_authorized', message: 'MT5 account is not authorized.' });

    const subscription = await eligibleSubscription(account.user_id);
    if (!subscription) {
      const fallback = (await currentSubscription(account.user_id))
        || (await latestSubscription(account.user_id));
      const status = fallback ? effectiveStatus(fallback) : null;
      if (status === 'suspended') {
        return res.json({ success: false, license_status: 'suspended', subscription_status: 'suspended', message: 'Subscription is suspended.' });
      }
      if (status === 'expired') {
        return res.json({ success: false, license_status: 'expired', subscription_status: 'expired', message: 'Subscription has expired.' });
      }
      return res.json({ success: false, license_status: 'no_subscription', subscription_status: status || 'none', message: 'An active subscription is required.' });
    }

    const activation = await get(
      `SELECT * FROM ea_license_activations
       WHERE user_id = ? AND mt5_account_number = ? AND broker_server = ?`,
      [account.user_id, account.account_number, account.broker_server]
    );

    if (!activation) {
      return res.json({
        success: false,
        license_status: 'not_activated',
        subscription_status: 'active',
        expires_at: subscription.expires_at,
        activation_count: await activeActivationCount(account.user_id),
        maximum_activations: maxActivationsFor(subscription),
        message: 'Activation required.'
      });
    }

    if (activation.license_status !== 'active') {
      return res.json({ success: false, license_status: activation.license_status, subscription_status: 'active', message: 'Activation is not active.' });
    }
    if (activation.subscription_id !== subscription.id) {
      // Activation bound to a different (older) subscription: re-bind it to the
      // current eligible subscription so renewals keep working for the account.
      await run('UPDATE ea_license_activations SET subscription_id = ?, updated_at = ? WHERE id = ?',
        [subscription.id, now(), activation.id]);
    }

    await run('UPDATE ea_license_activations SET last_verified_at = ?, updated_at = ? WHERE id = ?',
      [now(), now(), activation.id]);

    return res.json(licensePayload(subscription, await activeActivationCount(account.user_id), {
      mt5_account_number: account.account_number
    }));
  }

  app.post('/api/license/verify', authenticateInstallation, async (req, res) => {
    try {
      return await verifyLicense(req, res);
    } catch (error) {
      console.error('License verification failed:', error.message);
      res.status(500).json({ success: false, license_status: 'error', message: 'License server error.' });
    }
  });

  app.post('/api/license/activate', authenticateInstallation, async (req, res) => {
    try {
      const account = await installationContext(req);
      if (!account) return res.status(403).json({ success: false, license_status: 'account_not_authorized', message: 'MT5 account is not authorized.' });

      const result = await withTransaction(async () => {
        const subscription = await eligibleSubscription(account.user_id);
        if (!subscription) {
          const fallback = (await currentSubscription(account.user_id))
            || (await latestSubscription(account.user_id));
          const status = fallback ? effectiveStatus(fallback) : null;
          const licenseStatus = status === 'suspended' ? 'suspended' : status === 'expired' ? 'expired' : 'no_subscription';
          return { http: 200, body: { success: false, license_status: licenseStatus, message: 'An eligible subscription is required.' } };
        }

        if (isPostgres) {
          await get('SELECT id FROM user_subscriptions WHERE id = ? FOR UPDATE', [subscription.id]);
        }

        const existing = await get(
          `SELECT * FROM ea_license_activations
           WHERE user_id = ? AND mt5_account_number = ? AND broker_server = ?`,
          [account.user_id, account.account_number, account.broker_server]
        );

        if (existing && existing.license_status === 'active') {
          await run('UPDATE ea_license_activations SET last_verified_at = ?, subscription_id = ?, updated_at = ? WHERE id = ?',
            [now(), subscription.id, now(), existing.id]);
          const count = await activeActivationCount(account.user_id);
          return { http: 200, body: licensePayload(subscription, count, { mt5_account_number: account.account_number }) };
        }

        const activeCount = await activeActivationCount(account.user_id);
        const limit = maxActivationsFor(subscription);
        if (activeCount >= limit) {
          return {
            http: 200,
            body: {
              success: false,
              license_status: 'limit_reached',
              message: 'Activation limit reached.',
              activation_count: activeCount,
              maximum_activations: limit
            }
          };
        }

        const timestamp = now();
        const identifier = crypto.randomBytes(24).toString('hex');
        if (existing) {
          await run(
            `UPDATE ea_license_activations
             SET subscription_id = ?, activation_identifier = ?, license_status = 'active',
                 activated_at = ?, last_verified_at = ?, revoked_at = NULL, revocation_reason = NULL, updated_at = ?
             WHERE id = ?`,
            [subscription.id, identifier, timestamp, timestamp, timestamp, existing.id]
          );
        } else {
          await run(
            `INSERT INTO ea_license_activations
               (user_id, subscription_id, account_id, mt5_account_number, broker_server,
                activation_identifier, license_status, activated_at, last_verified_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
            [account.user_id, subscription.id, account.id, account.account_number,
             account.broker_server, identifier, timestamp, timestamp, timestamp, timestamp]
          );
        }

        await logAudit(account.user_id, 'user', 'ea_activation_created', 'activation', null,
          { account: maskAccount(account.account_number), brokerServer: account.broker_server }, null, req.ip);
        await notify(account.user_id, 'ea_activated', 'EA activation created',
          `An EA activation was created for account ${maskAccount(account.account_number)}.`);

        return {
          http: 201,
          body: licensePayload(subscription, activeCount + 1, { mt5_account_number: account.account_number })
        };
      });

      return res.status(result.http).json(result.body);
    } catch (error) {
      console.error('License activation failed:', error.message);
      res.status(500).json({ success: false, license_status: 'error', message: 'License server error.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Administrator API
  // ---------------------------------------------------------------------------

  app.get('/api/admin/subscriptions/overview', adminAuth.verifyToken, async (_req, res) => {
    try {
      const total = await get('SELECT COUNT(*) AS count FROM user_subscriptions WHERE deleted_at IS NULL');
      const active = await get(`SELECT COUNT(*) AS count FROM user_subscriptions WHERE status = 'active' AND deleted_at IS NULL`);
      const pending = await get(`SELECT COUNT(*) AS count FROM user_subscriptions WHERE status IN ('pending_payment','pending_approval') AND deleted_at IS NULL`);
      const expired = await get(`SELECT COUNT(*) AS count FROM user_subscriptions WHERE status = 'expired' AND deleted_at IS NULL`);
      const suspended = await get(`SELECT COUNT(*) AS count FROM user_subscriptions WHERE status = 'suspended' AND deleted_at IS NULL`);
      const rejected = await get(`SELECT COUNT(*) AS count FROM subscription_payments WHERE status = 'rejected'`);
      const revenue = await get(`SELECT COALESCE(SUM(amount), 0) AS total FROM subscription_payments WHERE status = 'approved'`);
      const recent = await all(`
        SELECT action, actor_role, affected_type, affected_id, reason, created_at
        FROM subscription_audit_logs ORDER BY id DESC LIMIT 15
      `);
      res.json({
        total: Number(total.count),
        active: Number(active.count),
        pending: Number(pending.count),
        expired: Number(expired.count),
        suspended: Number(suspended.count),
        rejected: Number(rejected.count),
        revenue: Number(revenue.total),
        recent
      });
    } catch (error) {
      console.error('Failed to load admin subscription overview:', error.message);
      res.status(500).json({ error: 'Unable to load subscription overview.' });
    }
  });

  app.get('/api/admin/subscriptions', adminAuth.verifyToken, async (req, res) => {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const clauses = ['s.deleted_at IS NULL'];
      const params = [];
      if (typeof req.query.status === 'string' && req.query.status) {
        clauses.push('s.status = ?');
        params.push(req.query.status);
      }
      if (typeof req.query.search === 'string' && req.query.search.trim()) {
        clauses.push('(u.username LIKE ? OR u.email LIKE ?)');
        const like = `%${req.query.search.trim().slice(0, 80)}%`;
        params.push(like, like);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;

      const rows = await all(`
        SELECT s.*, u.username, u.email, p.name AS plan_name,
               (SELECT COUNT(*) FROM ea_license_activations a
                WHERE a.user_id = s.user_id AND a.license_status = 'active') AS activation_count
        FROM user_subscriptions s
        LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN subscription_plans p ON p.id = s.plan_id
        ${where}
        ORDER BY s.id DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, (page - 1) * limit]);
      const total = await get(`
        SELECT COUNT(*) AS count FROM user_subscriptions s
        LEFT JOIN users u ON u.id = s.user_id ${where}
      `, params);

      res.json({ subscriptions: rows, page, limit, total: Number(total.count) });
    } catch (error) {
      console.error('Failed to list admin subscriptions:', error.message);
      res.status(500).json({ error: 'Unable to load subscriptions.' });
    }
  });

  app.get('/api/admin/subscription-payments', adminAuth.verifyToken, async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const params = [];
      let where = '';
      if (status) { where = 'WHERE pay.status = ?'; params.push(status); }
      const payments = await all(`
        SELECT pay.id, pay.user_id, pay.subscription_id, pay.plan_id, pay.amount, pay.currency,
               pay.payment_method, pay.payment_reference, pay.payment_proof_path, pay.status,
               pay.admin_notes, pay.rejection_reason, pay.reviewed_at, pay.created_at,
               u.username, u.email, p.name AS plan_name, s.status AS subscription_status
        FROM subscription_payments pay
        LEFT JOIN users u ON u.id = pay.user_id
        LEFT JOIN subscription_plans p ON p.id = pay.plan_id
        LEFT JOIN user_subscriptions s ON s.id = pay.subscription_id
        ${where}
        ORDER BY pay.id DESC
        LIMIT 200
      `, params);
      res.json({
        payments: payments.map(row => ({
          ...row,
          hasProof: Boolean(row.payment_proof_path)
        }))
      });
    } catch (error) {
      console.error('Failed to list admin payments:', error.message);
      res.status(500).json({ error: 'Unable to load payment requests.' });
    }
  });

  // Server-side payment proof streaming (never exposed as a static URL).
  app.get('/api/admin/subscription-payments/:id/proof', adminAuth.verifyToken, async (req, res) => {
    try {
      const paymentId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(paymentId) || paymentId < 1) return res.status(400).json({ error: 'Invalid payment.' });
      const payment = await get('SELECT payment_proof_path FROM subscription_payments WHERE id = ?', [paymentId]);
      if (!payment || !payment.payment_proof_path) return res.status(404).json({ error: 'No payment proof was uploaded.' });

      const filename = path.basename(payment.payment_proof_path);
      const absolute = path.join(PROOF_DIR, filename);
      if (!absolute.startsWith(PROOF_DIR) || !fs.existsSync(absolute)) {
        return res.status(404).json({ error: 'Payment proof file is missing.' });
      }
      return res.sendFile(absolute);
    } catch (error) {
      console.error('Failed to serve payment proof:', error.message);
      res.status(500).json({ error: 'Unable to load payment proof.' });
    }
  });

  app.post('/api/admin/subscription-payments/:id/approve', adminAuth.verifyToken, async (req, res) => {
    try {
      const paymentId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(paymentId) || paymentId < 1) return res.status(400).json({ error: 'Invalid payment.' });
      const adminId = req.admin?.id || null;
      const note = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 1000) : null;

      const outcome = await withTransaction(async () => {
        const payment = await get('SELECT * FROM subscription_payments WHERE id = ?', [paymentId]);
        if (!payment) return { http: 404, body: { error: 'Payment not found.' } };
        if (payment.status === 'approved') return { http: 409, body: { error: 'This payment has already been approved.' } };
        if (payment.status !== 'pending_approval') {
          return { http: 409, body: { error: 'This payment is not awaiting approval.' } };
        }

        const subscription = await get('SELECT * FROM user_subscriptions WHERE id = ?', [payment.subscription_id]);
        if (!subscription) return { http: 404, body: { error: 'Subscription for this payment was not found.' } };
        if (subscription.deleted_at) return { http: 409, body: { error: 'Subscription has been removed.' } };
        if (subscription.status === 'suspended') {
          return { http: 409, body: { error: 'Subscription is suspended. Reinstate it before approving renewal payments.' } };
        }
        if (!['pending_payment', 'pending_approval'].includes(subscription.status)) {
          return { http: 409, body: { error: 'Subscription is not in a pending state.' } };
        }

        const plan = payment.plan_id
          ? await get('SELECT * FROM subscription_plans WHERE id = ?', [payment.plan_id])
          : null;
        const durationDays = subscription.duration_days || plan?.duration_days || 30;
        const approvedAt = now();

        // Renewal rules: extend an active subscription from its current expiry;
        // start a new period now when the previous period has lapsed.
        const previous = await get(`
          SELECT id, status, expires_at FROM user_subscriptions
          WHERE user_id = ? AND id <> ? AND deleted_at IS NULL
            AND status IN ('active','expired')
          ORDER BY id DESC LIMIT 1
        `, [payment.user_id, subscription.id]);

        let startsAt = approvedAt;
        if (previous && previous.status === 'active' && previous.expires_at && previous.expires_at > approvedAt) {
          startsAt = previous.expires_at;
        }
        const expiresAt = startsAt + durationDays * 86400000;

        await run(
          `UPDATE subscription_payments
           SET status = 'approved', reviewed_by = ?, reviewed_at = ?, admin_notes = ?, updated_at = ?
           WHERE id = ? AND status = 'pending_approval'`,
          [adminId, approvedAt, note, approvedAt, paymentId]
        );
        await run(
          `UPDATE user_subscriptions
           SET status = 'active', starts_at = ?, expires_at = ?, approved_by = ?, approved_at = ?,
               suspended_at = NULL, suspension_reason = NULL, updated_at = ?
           WHERE id = ?`,
          [startsAt, expiresAt, adminId, approvedAt, approvedAt, subscription.id]
        );

        await logAudit(adminId, 'admin', 'payment_approved', 'payment', paymentId,
          { amount: Number(payment.amount), currency: payment.currency, subscriptionId: subscription.id, expiresAt },
          note, req.ip);
        await notify(payment.user_id, 'payment_approved', 'Subscription active',
          `Your payment was approved. Your subscription is active until ${new Date(expiresAt).toISOString().slice(0, 10)}.`);
        await notify(payment.user_id, 'subscription_active', 'Subscription activated',
          'Your CornGrid EA subscription is now active.');

        return { http: 200, body: { message: 'Payment approved and subscription activated.', startsAt, expiresAt } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to approve payment:', error.message);
      res.status(500).json({ error: 'Unable to approve this payment.' });
    }
  });

  app.post('/api/admin/subscription-payments/:id/reject', adminAuth.verifyToken, async (req, res) => {
    try {
      const paymentId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(paymentId) || paymentId < 1) return res.status(400).json({ error: 'Invalid payment.' });
      const adminId = req.admin?.id || null;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
      if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });

      const outcome = await withTransaction(async () => {
        const payment = await get('SELECT * FROM subscription_payments WHERE id = ?', [paymentId]);
        if (!payment) return { http: 404, body: { error: 'Payment not found.' } };
        if (payment.status === 'approved') return { http: 409, body: { error: 'An approved payment cannot be rejected.' } };
        if (payment.status === 'rejected') return { http: 409, body: { error: 'This payment has already been rejected.' } };

        const timestamp = now();
        await run(
          `UPDATE subscription_payments SET status = 'rejected', reviewed_by = ?, reviewed_at = ?,
             rejection_reason = ?, updated_at = ? WHERE id = ?`,
          [adminId, timestamp, reason, timestamp, paymentId]
        );
        await run(
          `UPDATE user_subscriptions SET status = 'rejected', updated_at = ?
           WHERE id = ? AND status IN ('pending_payment','pending_approval')`,
          [timestamp, payment.subscription_id]
        );

        await logAudit(adminId, 'admin', 'payment_rejected', 'payment', paymentId, null, reason, req.ip);
        await notify(payment.user_id, 'payment_rejected', 'Payment rejected',
          `Your payment was rejected: ${reason}`);
        return { http: 200, body: { message: 'Payment rejected.' } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to reject payment:', error.message);
      res.status(500).json({ error: 'Unable to reject this payment.' });
    }
  });

  app.post('/api/admin/subscriptions/:id/suspend', adminAuth.verifyToken, async (req, res) => {
    try {
      const subscriptionId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 1) return res.status(400).json({ error: 'Invalid subscription.' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
      if (!reason) return res.status(400).json({ error: 'A suspension reason is required.' });
      const adminId = req.admin?.id || null;

      const outcome = await withTransaction(async () => {
        const subscription = await get('SELECT * FROM user_subscriptions WHERE id = ? AND deleted_at IS NULL', [subscriptionId]);
        if (!subscription) return { http: 404, body: { error: 'Subscription not found.' } };
        if (subscription.status !== 'active') return { http: 409, body: { error: 'Only active subscriptions can be suspended.' } };

        const timestamp = now();
        await run(
          `UPDATE user_subscriptions SET status = 'suspended', suspended_at = ?, suspension_reason = ?, updated_at = ?
           WHERE id = ?`,
          [timestamp, reason, timestamp, subscriptionId]
        );
        await run(
          `UPDATE ea_license_activations SET license_status = 'suspended', updated_at = ?
           WHERE subscription_id = ? AND license_status = 'active'`,
          [timestamp, subscriptionId]
        );

        await logAudit(adminId, 'admin', 'subscription_suspended', 'subscription', subscriptionId, null, reason, req.ip);
        await notify(subscription.user_id, 'subscription_suspended', 'Subscription suspended',
          `Your subscription was suspended: ${reason}`);
        return { http: 200, body: { message: 'Subscription suspended.' } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to suspend subscription:', error.message);
      res.status(500).json({ error: 'Unable to suspend this subscription.' });
    }
  });

  app.post('/api/admin/subscriptions/:id/reinstate', adminAuth.verifyToken, async (req, res) => {
    try {
      const subscriptionId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 1) return res.status(400).json({ error: 'Invalid subscription.' });
      const adminId = req.admin?.id || null;

      const outcome = await withTransaction(async () => {
        const subscription = await get('SELECT * FROM user_subscriptions WHERE id = ? AND deleted_at IS NULL', [subscriptionId]);
        if (!subscription) return { http: 404, body: { error: 'Subscription not found.' } };
        if (subscription.status !== 'suspended') return { http: 409, body: { error: 'Only suspended subscriptions can be reinstated.' } };
        if (!subscription.expires_at || subscription.expires_at <= now()) {
          return { http: 409, body: { error: 'This subscription has expired. A renewal is required instead of reinstatement.' } };
        }

        const timestamp = now();
        await run(
          `UPDATE user_subscriptions SET status = 'active', suspended_at = NULL, suspension_reason = NULL, updated_at = ?
           WHERE id = ?`,
          [timestamp, subscriptionId]
        );
        await run(
          `UPDATE ea_license_activations SET license_status = 'active', updated_at = ?
           WHERE subscription_id = ? AND license_status = 'suspended'`,
          [timestamp, subscriptionId]
        );

        await logAudit(adminId, 'admin', 'subscription_reinstated', 'subscription', subscriptionId, null, null, req.ip);
        await notify(subscription.user_id, 'subscription_reinstated', 'Subscription reinstated',
          'Your CornGrid EA subscription has been reinstated.');
        return { http: 200, body: { message: 'Subscription reinstated.' } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to reinstate subscription:', error.message);
      res.status(500).json({ error: 'Unable to reinstate this subscription.' });
    }
  });

  app.post('/api/admin/subscriptions/:id/revoke', adminAuth.verifyToken, async (req, res) => {
    try {
      const subscriptionId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 1) return res.status(400).json({ error: 'Invalid subscription.' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
      if (!reason) return res.status(400).json({ error: 'A revocation reason is required.' });
      const adminId = req.admin?.id || null;

      const outcome = await withTransaction(async () => {
        const subscription = await get('SELECT * FROM user_subscriptions WHERE id = ? AND deleted_at IS NULL', [subscriptionId]);
        if (!subscription) return { http: 404, body: { error: 'Subscription not found.' } };

        const timestamp = now();
        await run(
          `UPDATE user_subscriptions SET status = 'cancelled', deleted_at = ?, updated_at = ? WHERE id = ?`,
          [timestamp, timestamp, subscriptionId]
        );
        await run(
          `UPDATE ea_license_activations SET license_status = 'revoked', revoked_at = ?,
             revocation_reason = ?, updated_at = ? WHERE subscription_id = ?`,
          [timestamp, reason, timestamp, subscriptionId]
        );

        await logAudit(adminId, 'admin', 'subscription_revoked', 'subscription', subscriptionId, null, reason, req.ip);
        await notify(subscription.user_id, 'subscription_revoked', 'Subscription revoked',
          `Your subscription was revoked: ${reason}`);
        return { http: 200, body: { message: 'Subscription revoked and activations deactivated.' } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to revoke subscription:', error.message);
      res.status(500).json({ error: 'Unable to revoke this subscription.' });
    }
  });

  // Removes an inactive subscription record. Active/suspended licenses must go
  // through suspend + revoke so their audit trail and license state stay intact.
  app.delete('/api/admin/subscriptions/:id', adminAuth.verifyToken, async (req, res) => {
    try {
      const subscriptionId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 1) {
        return res.status(400).json({ error: 'Invalid subscription.' });
      }
      const adminId = req.admin?.id || null;

      const outcome = await withTransaction(async () => {
        const subscription = await get(
          'SELECT * FROM user_subscriptions WHERE id = ? AND deleted_at IS NULL',
          [subscriptionId]
        );
        if (!subscription) return { http: 404, body: { error: 'Subscription not found.' } };
        if (['active', 'suspended'].includes(subscription.status)) {
          return { http: 409, body: { error: 'Active or suspended subscriptions must be revoked instead of deleted.' } };
        }

        const timestamp = now();
        await run(
          `UPDATE user_subscriptions SET status = 'cancelled', deleted_at = ?, updated_at = ?
           WHERE id = ?`,
          [timestamp, timestamp, subscriptionId]
        );
        await run(
          `UPDATE subscription_payments SET status = 'cancelled', updated_at = ?
           WHERE subscription_id = ? AND status IN ('pending_payment','pending_approval')`,
          [timestamp, subscriptionId]
        );
        await run(
          `UPDATE ea_license_activations SET license_status = 'revoked', revoked_at = ?,
             revocation_reason = 'Subscription record deleted by administrator.', updated_at = ?
           WHERE subscription_id = ? AND license_status <> 'revoked'`,
          [timestamp, timestamp, subscriptionId]
        );

        await logAudit(adminId, 'admin', 'subscription_deleted', 'subscription', subscriptionId,
          { previousStatus: subscription.status }, null, req.ip);
        return { http: 200, body: { message: 'Subscription deleted.' } };
      });

      return res.status(outcome.http).json(outcome.body);
    } catch (error) {
      console.error('Failed to delete subscription:', error.message);
      res.status(500).json({ error: 'Unable to delete this subscription.' });
    }
  });

  app.delete('/api/admin/subscriptions/:id/activations/:activationId', adminAuth.verifyToken, async (req, res) => {
    try {
      const subscriptionId = Number.parseInt(req.params.id, 10);
      const activationId = Number.parseInt(req.params.activationId, 10);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : 'Revoked by administrator.';
      if (!Number.isSafeInteger(subscriptionId) || !Number.isSafeInteger(activationId)) {
        return res.status(400).json({ error: 'Invalid activation.' });
      }
      const adminId = req.admin?.id || null;
      const activation = await get(
        'SELECT * FROM ea_license_activations WHERE id = ? AND subscription_id = ?',
        [activationId, subscriptionId]
      );
      if (!activation) return res.status(404).json({ error: 'Activation not found.' });

      const timestamp = now();
      await run(
        `UPDATE ea_license_activations SET license_status = 'revoked', revoked_at = ?,
           revocation_reason = ?, updated_at = ? WHERE id = ?`,
        [timestamp, reason, timestamp, activationId]
      );
      await logAudit(adminId, 'admin', 'activation_revoked', 'activation', activationId, null, reason, req.ip);
      await notify(activation.user_id, 'activation_revoked', 'EA activation revoked',
        `An EA activation for account ${maskAccount(activation.mt5_account_number)} was revoked.`);
      res.json({ message: 'Activation revoked.' });
    } catch (error) {
      console.error('Failed to revoke activation:', error.message);
      res.status(500).json({ error: 'Unable to revoke this activation.' });
    }
  });

  app.get('/api/admin/subscription-plans', adminAuth.verifyToken, async (_req, res) => {
    try {
      const plans = await all(`
        SELECT p.*,
          (SELECT COUNT(*) FROM user_subscriptions s WHERE s.plan_id = p.id AND s.deleted_at IS NULL) AS usage_count
        FROM subscription_plans p ORDER BY p.id ASC
      `);
      res.json({ plans });
    } catch (error) {
      res.status(500).json({ error: 'Unable to load plans.' });
    }
  });

  app.post('/api/admin/subscription-plans', adminAuth.verifyToken, async (req, res) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : null;
      const price = Number(body.price);
      const durationDays = Number.parseInt(body.duration_days, 10);
      const maxActivations = Number.parseInt(body.max_activations, 10) || DEFAULT_MAX_ACTIVATIONS;
      const currency = typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency.toUpperCase())
        ? body.currency.toUpperCase() : 'MYR';

      if (!name) return res.status(400).json({ error: 'Plan name is required.' });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Price must be a non-negative number.' });
      if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
        return res.status(400).json({ error: 'Duration must be between 1 and 3650 days.' });
      }
      if (!Number.isSafeInteger(maxActivations) || maxActivations < 1 || maxActivations > 100) {
        return res.status(400).json({ error: 'Maximum activations must be between 1 and 100.' });
      }

      const timestamp = now();
      const created = await run(
        `INSERT INTO subscription_plans
           (name, description, price, currency, duration_days, max_activations, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, price, currency, durationDays, maxActivations,
         body.is_active !== false, timestamp, timestamp]
      );
      await logAudit(req.admin?.id || null, 'admin', 'plan_created', 'plan', created.lastID,
        { name, price, durationDays, maxActivations }, null, req.ip);
      res.status(201).json({ id: created.lastID, message: 'Plan created.' });
    } catch (error) {
      console.error('Failed to create plan:', error.message);
      res.status(500).json({ error: 'Unable to create plan.' });
    }
  });

  app.put('/api/admin/subscription-plans/:id', adminAuth.verifyToken, async (req, res) => {
    try {
      const planId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(planId) || planId < 1) return res.status(400).json({ error: 'Invalid plan.' });
      const plan = await get('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });

      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : plan.name;
      const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : plan.description;
      const price = body.price === undefined ? Number(plan.price) : Number(body.price);
      const durationDays = body.duration_days === undefined ? plan.duration_days : Number.parseInt(body.duration_days, 10);
      const maxActivations = body.max_activations === undefined ? plan.max_activations : Number.parseInt(body.max_activations, 10);
      const currency = typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency.toUpperCase())
        ? body.currency.toUpperCase() : plan.currency;
      const isActive = body.is_active === undefined ? Boolean(plan.is_active) : Boolean(body.is_active);

      if (!name) return res.status(400).json({ error: 'Plan name is required.' });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Price must be a non-negative number.' });
      if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
        return res.status(400).json({ error: 'Duration must be between 1 and 3650 days.' });
      }
      if (!Number.isSafeInteger(maxActivations) || maxActivations < 1 || maxActivations > 100) {
        return res.status(400).json({ error: 'Maximum activations must be between 1 and 100.' });
      }

      await run(
        `UPDATE subscription_plans SET name = ?, description = ?, price = ?, currency = ?,
           duration_days = ?, max_activations = ?, is_active = ?, updated_at = ? WHERE id = ?`,
        [name, description, price, currency, durationDays, maxActivations, isActive, now(), planId]
      );
      await logAudit(req.admin?.id || null, 'admin', 'plan_updated', 'plan', planId,
        { name, price, durationDays, maxActivations, isActive }, null, req.ip);
      res.json({ message: 'Plan updated. Existing paid subscriptions keep their agreed terms.' });
    } catch (error) {
      console.error('Failed to update plan:', error.message);
      res.status(500).json({ error: 'Unable to update plan.' });
    }
  });

  // EA version publishing (admin)
  app.get('/api/admin/ea-downloads', adminAuth.verifyToken, async (_req, res) => {
    try {
      const rows = await all('SELECT * FROM ea_downloads ORDER BY id DESC LIMIT 100');
      res.json({ versions: rows });
    } catch (error) {
      res.status(500).json({ error: 'Unable to load EA versions.' });
    }
  });

  // Binary upload route. Global express.json only parses JSON, so the raw EA
  // bytes pass through this route untouched.
  app.post('/api/admin/ea-downloads/upload', adminAuth.verifyToken,
    express.raw({ type: 'application/octet-stream', limit: '50mb' }),
    async (req, res) => {
      try {
        const version = typeof req.query.version === 'string' ? req.query.version.trim().slice(0, 40) : '';
        const filename = typeof req.query.filename === 'string' ? path.basename(req.query.filename) : '';
        const releaseNotes = typeof req.query.release_notes === 'string' ? req.query.release_notes.trim().slice(0, 4000) : null;
        if (!version) return res.status(400).json({ error: 'Version is required.' });
        if (!filename || path.extname(filename).toLowerCase() !== '.ex5') {
          return res.status(400).json({ error: 'A valid .ex5 filename is required.' });
        }
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          return res.status(400).json({ error: 'The EA file is required.' });
        }
        if (req.body.length > MAX_EA_BYTES) {
          return res.status(400).json({ error: 'EA build must be smaller than 50 MB.' });
        }
        fs.writeFileSync(path.join(EA_DOWNLOAD_DIR, filename), req.body);
        const timestamp = now();
        const created = await run(
          `INSERT INTO ea_downloads (version, filename, file_path, release_notes, is_active, released_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, FALSE, ?, ?, ?)`,
          [version, filename, filename, releaseNotes, req.admin?.id || null, timestamp, timestamp]
        );
        await logAudit(req.admin?.id || null, 'admin', 'ea_version_uploaded', 'download', created.lastID,
          { version, filename }, null, req.ip);
        res.status(201).json({ id: created.lastID, message: 'EA build uploaded and registered (inactive).' });
      } catch (error) {
        console.error('Failed to upload EA build:', error.message);
        res.status(500).json({ error: 'Unable to upload the EA build.' });
      }
    });

  app.post('/api/admin/ea-downloads', adminAuth.verifyToken, async (req, res) => {
    try {
      const body = req.body || {};
      const version = typeof body.version === 'string' ? body.version.trim().slice(0, 40) : '';
      const filename = typeof body.filename === 'string' ? path.basename(body.filename) : '';
      const releaseNotes = typeof body.release_notes === 'string' ? body.release_notes.trim().slice(0, 4000) : null;
      if (!version) return res.status(400).json({ error: 'Version is required.' });
      if (!filename) return res.status(400).json({ error: 'Filename is required.' });
      if (path.extname(filename).toLowerCase() !== '.ex5') {
        return res.status(400).json({ error: 'The compiled EA must be an .ex5 file.' });
      }

      if (body.fileData) {
        const base64 = String(body.fileData).replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        if (!buffer.length || buffer.length > MAX_EA_BYTES) {
          return res.status(400).json({ error: 'EA build must be smaller than 50 MB.' });
        }
        fs.writeFileSync(path.join(EA_DOWNLOAD_DIR, filename), buffer);
      } else if (!fs.existsSync(path.join(EA_DOWNLOAD_DIR, filename))) {
        return res.status(400).json({ error: `Upload the .ex5 file or place it in storage/ea-downloads/${filename} first.` });
      }
      const timestamp = now();
      const created = await run(
        `INSERT INTO ea_downloads (version, filename, file_path, release_notes, is_active, released_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, FALSE, ?, ?, ?)`,
        [version, filename, filename, releaseNotes, req.admin?.id || null, timestamp, timestamp]
      );
      await logAudit(req.admin?.id || null, 'admin', 'ea_version_published', 'download', created.lastID,
        { version, filename }, null, req.ip);
      res.status(201).json({ id: created.lastID, message: 'EA version registered (inactive).' });
    } catch (error) {
      console.error('Failed to register EA version:', error.message);
      res.status(500).json({ error: 'Unable to register EA version.' });
    }
  });

  app.post('/api/admin/ea-downloads/:id/activate', adminAuth.verifyToken, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid version.' });
      const record = await get('SELECT * FROM ea_downloads WHERE id = ?', [id]);
      if (!record) return res.status(404).json({ error: 'Version not found.' });
      if (!fs.existsSync(path.resolve(EA_DOWNLOAD_DIR, record.file_path))) {
        return res.status(409).json({ error: 'The compiled file is missing from storage.' });
      }
      await withTransaction(async () => {
        await run('UPDATE ea_downloads SET is_active = FALSE, updated_at = ? WHERE is_active = TRUE', [now()]);
        await run('UPDATE ea_downloads SET is_active = TRUE, updated_at = ? WHERE id = ?', [now(), id]);
      });
      await logAudit(req.admin?.id || null, 'admin', 'ea_version_activated', 'download', id,
        { version: record.version }, null, req.ip);
      res.json({ message: 'EA version published.' });
    } catch (error) {
      console.error('Failed to publish EA version:', error.message);
      res.status(500).json({ error: 'Unable to publish EA version.' });
    }
  });

  return { ready };
}

function maskAccount(accountNumber) {
  const value = String(accountNumber || '');
  if (value.length <= 4) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(value.length - 4, 8))}${value.slice(-4)}`;
}

module.exports = createSubscriptionApi;
