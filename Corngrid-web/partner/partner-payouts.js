'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dbAll, dbGet, dbRun, withTransaction, isPostgres } = require('../db-async');

function fail(status, message, field) {
  const error = new Error(message);
  Object.assign(error, { status, field });
  throw error;
}

function cents(value) {
  const amount = Number(value);
  const rounded = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(rounded) || rounded < 0) fail(400, 'Invalid amount.');
  return rounded;
}

function requestedCents(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') fail(400, 'Enter a payout amount.', 'amount');
  const result = cents(value);
  if (result < 1 || Math.abs(Number(value) * 100 - result) > 0.000001) fail(400, 'Enter a positive amount with at most two decimal places.', 'amount');
  return result;
}

function createPartnerPayouts({ db, crypto: bankCrypto, events, now = () => Date.now() }) {
  // SQLite self-applies the additive migration; PostgreSQL is migrated before deployment.
  let initialization;
  function ready() {
    if (!initialization) {
      initialization = isPostgres(db)
        ? dbAll(db, 'SELECT payout_id FROM partner_payout_allocations LIMIT 0')
        : new Promise((resolve, reject) => db.exec(fs.readFileSync(path.join(__dirname, '../migrations/sqlite/0011_partner_payout_requests.sql'), 'utf8'), error => error ? reject(error) : resolve()));
    }
    return initialization;
  }

  async function profile(partnerId, { lock = false, active = true } = {}) {
    const row = await dbGet(db, `SELECT * FROM partner_profiles WHERE user_id = ?${lock && isPostgres(db) ? ' FOR UPDATE' : ''}`, [partnerId]);
    if (!row) fail(403, 'Partner registration is required.');
    if (active && row.status !== 'active') fail(403, 'This partner account is suspended.');
    return row;
  }

  function decodeBank(cipher) {
    if (!cipher) return null;
    try {
      const bank = JSON.parse(bankCrypto.decrypt(cipher));
      if (typeof bank.bankName !== 'string' || typeof bank.accountHolder !== 'string' || typeof bank.accountNumber !== 'string' || !/^\d{6,34}$/.test(bank.accountNumber)) return null;
      return bank;
    } catch { return null; }
  }

  function maskedBank(bank) {
    return bank ? { bankName: bank.bankName, accountHolder: bank.accountHolder, accountLast4: bank.accountNumber.slice(-4) } : null;
  }

  async function audit(req, action, payoutId, metadata = null, reason = null, role = 'admin') {
    await dbRun(db, `INSERT INTO subscription_audit_logs
      (actor_id, actor_role, action, affected_type, affected_id, metadata, reason, ip_address, created_at)
      VALUES (?, ?, ?, 'partner_payout', ?, ?, ?, ?, ?)`,
    [role === 'user' ? req.user.id : req.admin?.id || null, role, action, payoutId,
      metadata ? JSON.stringify(metadata) : null, reason, req.ip || null, now()]);
  }

  async function availableRows(partnerId) {
    return dbAll(db, `SELECT t.*,
        COALESCE((SELECT SUM(a.amount_cents) FROM partner_payout_allocations a
          JOIN partner_payouts p ON p.id = a.payout_id
          WHERE a.transaction_id = t.id AND p.status IN ('pending','approved','paid')), 0) AS allocated_cents
      FROM partner_transactions t WHERE t.partner_id = ? AND t.status = 'approved' AND t.currency = 'MYR'
      AND NOT EXISTS (SELECT 1 FROM partner_payout_transactions legacy
        JOIN partner_payouts p ON p.id = legacy.payout_id
        WHERE legacy.transaction_id = t.id AND p.status IN ('pending','approved','paid')) ORDER BY t.id ASC`, [partnerId]);
  }

  async function summary(partnerId) {
    await ready();
    const rows = await availableRows(partnerId);
    const available = rows.reduce((sum, row) => sum + Math.max(0, cents(row.commission_amount) - Number(row.allocated_cents)), 0);
    const pending = await dbGet(db, `SELECT COALESCE(SUM(amount), 0) AS amount FROM partner_payouts
      WHERE partner_id = ? AND status IN ('pending','approved')`, [partnerId]);
    // Resolve each earning's current strategy rule before determining its threshold.
    const rules = await dbAll(db, `SELECT * FROM partner_commissions WHERE partner_id = ? AND is_active = TRUE
      AND currency = 'MYR' AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
      ORDER BY CASE WHEN strategy_id IS NULL THEN 1 ELSE 0 END, id DESC`, [partnerId, now(), now()]);
    let minimum = 0;
    for (const row of rows) {
      if (cents(row.commission_amount) <= Number(row.allocated_cents)) continue;
      const rule = rules.find(rule => rule.strategy_id == null || Number(rule.strategy_id) === Number(row.strategy_id));
      minimum = Math.max(minimum, rule ? cents(rule.min_payout_threshold) : 0);
    }
    return { currency: 'MYR', availableBalance: available / 100, reservedBalance: Number(pending.amount), minimumPayout: minimum / 100, hasOpenRequest: Number(pending.amount) > 0 };
  }

  async function allocate(partnerId, amountCents, payoutId) {
    let remaining = amountCents;
    for (const row of await availableRows(partnerId)) {
      const amount = Math.min(remaining, Math.max(0, cents(row.commission_amount) - Number(row.allocated_cents)));
      if (amount > 0) {
        await dbRun(db, 'INSERT INTO partner_payout_allocations(payout_id, transaction_id, amount_cents) VALUES (?, ?, ?)', [payoutId, row.id, amount]);
        remaining -= amount;
      }
      if (remaining === 0) break;
    }
    if (remaining !== 0) fail(409, 'The available balance changed. Refresh and try again.', 'amount');
  }

  async function settle(payoutId) {
    const allocations = await dbAll(db, 'SELECT transaction_id FROM partner_payout_allocations WHERE payout_id = ?', [payoutId]);
    // Legacy requests may already carry whole-commission settlement links.
    const legacy = await dbAll(db, 'SELECT transaction_id FROM partner_payout_transactions WHERE payout_id = ?', [payoutId]);
    for (const link of legacy) await dbRun(db, `UPDATE partner_transactions SET status = 'paid', status_updated_at = ? WHERE id = ? AND status = 'approved'`, [now(), link.transaction_id]);
    for (const link of allocations) {
      const row = await dbGet(db, `SELECT t.commission_amount,
        COALESCE(SUM(CASE WHEN p.status = 'paid' THEN a.amount_cents ELSE 0 END), 0) AS paid_cents
        FROM partner_transactions t LEFT JOIN partner_payout_allocations a ON a.transaction_id = t.id
        LEFT JOIN partner_payouts p ON p.id = a.payout_id WHERE t.id = ? GROUP BY t.id, t.commission_amount`, [link.transaction_id]);
      if (Number(row.paid_cents) >= cents(row.commission_amount)) await dbRun(db, `UPDATE partner_transactions SET status = 'paid', status_updated_at = ? WHERE id = ? AND status = 'approved'`, [now(), link.transaction_id]);
    }
    return allocations.length + legacy.length;
  }

  function publicPayout(row) {
    return { id: row.id, payoutUid: row.payout_uid, partnerId: row.partner_id,
      partnerName: row.partner_name, partnerEmail: row.partner_email,
      amount: Number(row.amount), currency: row.currency, status: row.status,
      method: row.method, reference: row.reference, reviewReason: row.review_reason,
      requestedAt: row.requested_at, approvedAt: row.approved_at, paidAt: row.paid_at,
      recipient: maskedBank(decodeBank(row.bank_snapshot_cipher)) };
  }

  function endpoint(handler) {
    return async (req, res) => {
      try { await ready(); await handler(req, res); }
      catch (error) {
        if (!error.status) console.error('Partner payout operation failed:', error.code || 'internal-error');
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to process the payout. Try again.', field: error.field });
      }
    };
  }

  function registerRoutes(app, verifyToken, verifyAdminToken, rateLimit) {
    const limiter = rateLimit({ limit: 30, windowMs: 60 * 60 * 1000 });
    app.get('/api/partner/payout-summary', verifyToken, endpoint(async (req, res) => {
      const partner = await profile(req.user.id);
      res.set('Cache-Control', 'no-store').json({ ...await summary(req.user.id), bankDetails: maskedBank(decodeBank(partner.payout_details_cipher)) });
    }));

    app.put('/api/partner/bank-details', verifyToken, limiter, endpoint(async (req, res) => {
      const result = await withTransaction(db, async () => {
        const partner = await profile(req.user.id, { lock: true });
        const body = req.body || {};
        const oldBank = decodeBank(partner.payout_details_cipher);
        const bankName = typeof body.bankName === 'string' ? body.bankName.trim() : '';
        const accountHolder = typeof body.accountHolder === 'string' ? body.accountHolder.trim() : '';
        const accountNumber = typeof body.accountNumber === 'string' && body.accountNumber.trim()
          ? body.accountNumber.replace(/[ -]/g, '') : oldBank?.accountNumber || '';
        if (bankName.length < 2 || bankName.length > 120) fail(400, 'Enter a bank name between 2 and 120 characters.', 'bankName');
        if (accountHolder.length < 2 || accountHolder.length > 120) fail(400, 'Enter the account holder name between 2 and 120 characters.', 'accountHolder');
        if (!/^\d{6,34}$/.test(accountNumber)) fail(400, 'Enter an account number containing 6 to 34 digits.', 'accountNumber');
        if (body.confirmOwnership !== true) fail(400, 'Confirm that these bank details are correct and belong to you.', 'confirmOwnership');
        const bank = { bankName, accountHolder, accountNumber };
        await dbRun(db, `UPDATE partner_profiles SET payout_method = 'bank_transfer', payout_details_cipher = ?, updated_at = ? WHERE user_id = ?`, [bankCrypto.encrypt(JSON.stringify(bank)), now(), req.user.id]);
        await audit(req, 'partner_bank_details_updated', null, null, null, 'user');
        return maskedBank(bank);
      });
      res.json({ message: 'Bank details saved.', bankDetails: result });
    }));

    app.get('/api/partner/payouts', verifyToken, endpoint(async (req, res) => {
      await profile(req.user.id);
      const rows = await dbAll(db, `SELECT p.*, d.bank_snapshot_cipher, d.review_reason FROM partner_payouts p
        LEFT JOIN partner_payout_details d ON d.payout_id = p.id WHERE p.partner_id = ? ORDER BY p.id DESC LIMIT 100`, [req.user.id]);
      res.set('Cache-Control', 'no-store').json({ payouts: rows.map(publicPayout) });
    }));

    app.post('/api/partner/payouts', verifyToken, limiter, endpoint(async (req, res) => {
      const body = req.body || {};
      const amountCents = requestedCents(body.amount);
      if (typeof body.requestKey !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(body.requestKey)) fail(400, 'A valid request key is required. Refresh and try again.');
      const key = `${req.user.id}:${body.requestKey}`;
      const result = await withTransaction(db, async () => {
        const partner = await profile(req.user.id, { lock: true });
        const existing = await dbGet(db, `SELECT p.* FROM partner_payout_details d JOIN partner_payouts p ON p.id = d.payout_id WHERE d.request_key = ?`, [key]);
        if (existing) {
          if (cents(existing.amount) !== amountCents) fail(409, 'This request key was already used for a different amount.');
          return { payoutUid: existing.payout_uid, alreadyRecorded: true };
        }
        const bank = decodeBank(partner.payout_details_cipher);
        if (!bank) fail(400, 'Save your bank details before requesting a payout.');
        const balance = await summary(req.user.id);
        if (balance.hasOpenRequest) fail(409, 'You already have a payout awaiting review.');
        if (amountCents > cents(balance.availableBalance)) fail(409, 'Amount exceeds your available approved balance.', 'amount');
        if (amountCents < cents(balance.minimumPayout)) fail(400, `The minimum payout is MYR ${balance.minimumPayout.toFixed(2)}.`, 'amount');
        const stamp = now();
        const uid = `pay_${crypto.randomBytes(9).toString('hex')}`;
        const inserted = await dbRun(db, `INSERT INTO partner_payouts
          (payout_uid, partner_id, amount, currency, status, method, requested_at, created_at, updated_at)
          VALUES (?, ?, ?, 'MYR', 'pending', 'bank_transfer', ?, ?, ?)`, [uid, req.user.id, amountCents / 100, stamp, stamp, stamp]);
        await dbRun(db, 'INSERT INTO partner_payout_details(payout_id, request_key, bank_snapshot_cipher) VALUES (?, ?, ?)', [inserted.lastID, key, bankCrypto.encrypt(JSON.stringify(bank))]);
        await allocate(req.user.id, amountCents, inserted.lastID);
        await audit(req, 'payout_requested', inserted.lastID, { amount: amountCents / 100, payoutUid: uid }, null, 'user');
        return { payoutUid: uid };
      });
      if (!result.alreadyRecorded) await events.emit('PAYOUT_REQUESTED', { actorType: 'user', actorId: req.user.id, payload: { payoutUid: result.payoutUid, amount: amountCents / 100 } });
      res.status(result.alreadyRecorded ? 200 : 201).json({ message: 'Payout request saved. Awaiting admin transfer and confirmation.', ...result });
    }));

    app.get('/api/admin/partners/:id/payout-summary', verifyAdminToken, endpoint(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid partner.');
      await profile(id, { active: false });
      res.json(await summary(id));
    }));

    app.get('/api/admin/payouts', verifyAdminToken, endpoint(async (_req, res) => {
      const rows = await dbAll(db, `SELECT p.*, pp.display_name AS partner_name, u.email AS partner_email,
        d.bank_snapshot_cipher, d.review_reason FROM partner_payouts p
        JOIN partner_profiles pp ON pp.user_id = p.partner_id JOIN users u ON u.id = p.partner_id
        LEFT JOIN partner_payout_details d ON d.payout_id = p.id
        ORDER BY CASE WHEN p.status IN ('pending','approved') THEN 0 ELSE 1 END, p.id DESC LIMIT 200`);
      res.set('Cache-Control', 'no-store').json({ payouts: rows.map(publicPayout) });
    }));

    app.get('/api/admin/payouts/:id/recipient', verifyAdminToken, endpoint(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid payout.');
      const row = await dbGet(db, `SELECT p.*, d.bank_snapshot_cipher FROM partner_payouts p LEFT JOIN partner_payout_details d ON d.payout_id = p.id WHERE p.id = ?`, [id]);
      if (!row) fail(404, 'Payout not found.');
      const recipient = decodeBank(row.bank_snapshot_cipher);
      await audit(req, 'payout_recipient_viewed', id, { payoutUid: row.payout_uid });
      res.set('Cache-Control', 'no-store').json({ recipient, payoutUid: row.payout_uid });
    }));

    // Retain manual recording for transfers made outside the request flow.
    app.post('/api/admin/payouts', verifyAdminToken, endpoint(async (req, res) => {
      const body = req.body || {};
      const partnerId = Number(body.partnerId);
      if (!Number.isSafeInteger(partnerId) || partnerId < 1) fail(400, 'A partner is required.');
      const amountCents = requestedCents(body.amount);
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      if (!reference || reference.length > 120) fail(400, 'Enter the bank transfer reference (maximum 120 characters).', 'reference');
      const result = await withTransaction(db, async () => {
        const partner = await profile(partnerId, { lock: true, active: false });
        const existing = await dbGet(db, `SELECT payout_uid, amount FROM partner_payouts WHERE partner_id = ? AND reference = ? AND status = 'paid'`, [partnerId, reference]);
        if (existing) {
          if (cents(existing.amount) !== amountCents) fail(409, 'This transfer reference is already recorded for a different amount.');
          return { payoutUid: existing.payout_uid, settledTransactions: 0, alreadyRecorded: true };
        }
        const balance = await summary(partnerId);
        if (balance.hasOpenRequest) fail(409, 'Review the existing payout request before recording another payout.');
        if (amountCents > cents(balance.availableBalance)) fail(409, 'Amount exceeds the available approved balance.');
        const stamp = now(), uid = `pay_${crypto.randomBytes(9).toString('hex')}`;
        const inserted = await dbRun(db, `INSERT INTO partner_payouts
          (payout_uid, partner_id, amount, currency, status, method, reference, requested_at, approved_at, paid_at, created_at, updated_at)
          VALUES (?, ?, ?, 'MYR', 'paid', ?, ?, ?, ?, ?, ?, ?)`,
        [uid, partnerId, amountCents / 100, typeof body.method === 'string' ? body.method.trim().slice(0, 60) : 'bank_transfer', reference, stamp, stamp, stamp, stamp, stamp]);
        await dbRun(db, 'INSERT INTO partner_payout_details(payout_id, bank_snapshot_cipher) VALUES (?, ?)', [inserted.lastID, partner.payout_details_cipher]);
        // Paid rows also reserve their allocated amounts immediately.
        await allocate(partnerId, amountCents, inserted.lastID);
        const settledTransactions = await settle(inserted.lastID);
        await audit(req, 'payout_recorded', inserted.lastID, { partnerId, payoutUid: uid, amount: amountCents / 100, reference });
        return { payoutUid: uid, settledTransactions };
      });
      if (!result.alreadyRecorded) await events.emit('PAYOUT_PAID', { actorType: 'admin', payload: { ...result, partnerId, amount: amountCents / 100 } });
      res.status(result.alreadyRecorded ? 200 : 201).json({ message: 'Payout recorded.', ...result });
    }));

    app.post('/api/admin/payouts/:id/status', verifyAdminToken, endpoint(async (req, res) => {
      const id = Number(req.params.id), body = req.body || {};
      if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid payout.');
      if (!['paid', 'rejected'].includes(body.status)) fail(400, 'Confirm the completed transfer or reject the request.');
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (body.status === 'paid' && (!reference || reference.length > 120)) fail(400, 'Enter the bank transfer reference (maximum 120 characters).', 'reference');
      if (body.status === 'paid' && body.confirmTransferred !== true) fail(400, 'Confirm that the bank transfer has completed.', 'confirmTransferred');
      if (body.status === 'rejected' && (!reason || reason.length > 500)) fail(400, 'Enter a rejection reason (maximum 500 characters).', 'reason');
      const result = await withTransaction(db, async () => {
        const initial = await dbGet(db, 'SELECT partner_id FROM partner_payouts WHERE id = ?', [id]);
        if (!initial) fail(404, 'Payout not found.');
        await profile(initial.partner_id, { lock: true, active: false });
        const payout = await dbGet(db, `SELECT p.*, d.request_key, d.bank_snapshot_cipher FROM partner_payouts p
          LEFT JOIN partner_payout_details d ON d.payout_id = p.id WHERE p.id = ?`, [id]);
        if (!['pending','approved'].includes(payout.status)) {
          if (payout.status === body.status && (body.status !== 'paid' || payout.reference === reference)) return { payoutUid: payout.payout_uid, alreadyRecorded: true };
          fail(409, `This payout is already ${payout.status}.`);
        }
        const links = await dbAll(db, `SELECT t.*, a.amount_cents FROM partner_payout_allocations a
          JOIN partner_transactions t ON t.id = a.transaction_id WHERE a.payout_id = ?`, [id]);
        if (body.status === 'paid' && links.some(row => Number(row.partner_id) !== Number(payout.partner_id) || row.currency !== 'MYR' || row.status !== 'approved')) fail(409, 'The linked commissions require review before payment can be recorded.');
        if (body.status === 'paid' && links.length && links.reduce((sum, row) => sum + Number(row.amount_cents), 0) !== cents(payout.amount)) fail(409, 'The payout allocation does not match the requested amount.');
        if (body.status === 'paid' && payout.request_key && !decodeBank(payout.bank_snapshot_cipher)) fail(409, 'The saved bank details could not be read. Review the request before confirming payment.');
        if (body.status === 'paid' && await dbGet(db, `SELECT id FROM partner_payouts WHERE partner_id = ? AND reference = ? AND status = 'paid' AND id <> ?`, [payout.partner_id, reference, id])) fail(409, 'This bank transfer reference has already been recorded for this partner.', 'reference');
        if (body.status === 'paid' && !links.length) {
          const legacy = await dbAll(db, 'SELECT transaction_id FROM partner_payout_transactions WHERE payout_id = ?', [id]);
          if (!legacy.length) fail(409, 'This payout has no linked commissions. Review it before recording payment.');
        }
        const stamp = now();
        await dbRun(db, `UPDATE partner_payouts SET status = ?, reference = ?, approved_by = ?,
          approved_at = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
        [body.status, body.status === 'paid' ? reference : payout.reference, req.admin?.id || null,
          body.status === 'paid' ? stamp : payout.approved_at, body.status === 'paid' ? stamp : null, stamp, id]);
        await dbRun(db, `INSERT INTO partner_payout_details(payout_id, review_reason) VALUES (?, ?)
          ON CONFLICT(payout_id) DO UPDATE SET review_reason = excluded.review_reason`, [id, body.status === 'rejected' ? reason : null]);
        if (body.status === 'paid') await settle(id);
        await audit(req, `payout_${body.status}`, id, { payoutUid: payout.payout_uid, partnerId: payout.partner_id, amount: payout.amount, reference: body.status === 'paid' ? reference : null }, reason || null);
        return { payoutUid: payout.payout_uid, partnerId: payout.partner_id, amount: Number(payout.amount) };
      });
      if (body.status === 'paid' && !result.alreadyRecorded) await events.emit('PAYOUT_PAID', { actorType: 'admin', payload: result });
      res.json({ message: body.status === 'paid' ? 'Payout approved. Payment and commission records saved automatically.' : 'Payout rejected. The reserved balance is available again.', ...result });
    }));
  }

  return { registerRoutes, summary, ready };
}

module.exports = { createPartnerPayouts };
