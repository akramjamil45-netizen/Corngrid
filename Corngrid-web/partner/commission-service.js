'use strict';

// Partner commission engine.
//
// When a subscription payment is approved, the engine finds the subscribing
// user's active sandbox strategy; if that strategy was published from a
// partner submission, a commission row is written to the immutable
// partner_transactions ledger.
//
// Duplicate prevention: the idempotency key `payment:<id>:partner:<id>` is
// UNIQUE, so replayed approvals or retried hooks can never double-pay.
// Amounts are never updated after insert — only the status field transitions
// (pending -> approved -> paid / rejected), and every transition is audited.

const crypto = require('crypto');

function createCommissionService({ db, events, now = () => Date.now() } = {}) {
  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
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

  // The commission rule in effect for a partner/strategy at a point in time.
  // Strategy-specific rules win over partner-wide defaults (strategy_id NULL).
  async function resolveCommissionRule(partnerId, strategyId, at) {
    const rules = await all(
      `SELECT * FROM partner_commissions
       WHERE partner_id = ? AND is_active = TRUE
         AND (strategy_id = ? OR strategy_id IS NULL)
         AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY (CASE WHEN strategy_id IS NULL THEN 1 ELSE 0 END) ASC, id DESC`,
      [partnerId, strategyId, at, at]
    );
    return rules[0] || null;
  }

  function computeCommission(rule, grossAmount) {
    if (rule.model === 'fixed') {
      return Math.min(grossAmount, Number(rule.fixed_amount) || 0);
    }
    const percent = Number(rule.percent) || 0;
    return Math.round((grossAmount * percent / 100) * 100) / 100;
  }

  // Called by the subscription module after a payment is approved.
  async function handlePaymentApproved(payment) {
    if (!payment || !payment.user_id) return;

    // Which strategy is the subscriber running? Only partner-published
    // strategies generate commission.
    const instance = await get(
      `SELECT i.strategy_id, s.submission_id, sub.partner_id
       FROM sandbox_instances i
       JOIN trading_strategies s ON s.id = i.strategy_id
       JOIN ea_submissions sub ON sub.id = s.submission_id
       WHERE i.user_id = ? AND i.deleted_at IS NULL
       ORDER BY i.id DESC LIMIT 1`,
      [payment.user_id]
    );
    if (!instance || !instance.partner_id) return; // official CornGrid EA: no partner

    const timestamp = now();
    const rule = await resolveCommissionRule(instance.partner_id, instance.strategy_id, timestamp);
    if (!rule) return;

    // Distinguish first subscription from renewal: a renewal has an earlier
    // approved payment on a different subscription period for the same user.
    const priorPayments = await get(
      `SELECT COUNT(*) AS count FROM subscription_payments
       WHERE user_id = ? AND status = 'approved' AND id <> ?`,
      [payment.user_id, payment.id]
    );
    const isRenewal = (Number(priorPayments.count) || 0) > 0;
    if (rule.applies_to === 'subscription' && isRenewal) return;
    if (rule.applies_to === 'renewal' && !isRenewal) return;

    const gross = Number(payment.amount) || 0;
    const commission = computeCommission(rule, gross);
    if (commission <= 0) return;

    const reference = `COM-${timestamp.toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const idempotencyKey = `payment:${payment.id}:partner:${instance.partner_id}`;

    try {
      await run(
        `INSERT INTO partner_transactions
           (reference, idempotency_key, partner_id, strategy_id, subscription_payment_id, subscription_id,
            gross_amount, commission_amount, currency, status, notes, created_at, status_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [reference, idempotencyKey, instance.partner_id, instance.strategy_id, payment.id, payment.subscription_id,
          gross, commission, payment.currency || rule.currency || 'MYR',
          isRenewal ? 'Renewal commission' : 'Subscription commission', timestamp, timestamp]
      );
      await events.emit('COMMISSION_GENERATED', {
        actorType: 'system',
        payload: { reference, partnerId: instance.partner_id, strategyId: instance.strategy_id, gross, commission, paymentId: payment.id }
      });
    } catch (error) {
      if (/UNIQUE constraint failed|duplicate key/i.test(error.message || '')) {
        return; // idempotent replay — commission already recorded
      }
      throw error;
    }
  }

  // Partner's available balance: approved commissions not yet settled by a payout.
  async function availableBalance(partnerId) {
    const row = await get(
      `SELECT COALESCE(SUM(commission_amount), 0) AS balance
       FROM partner_transactions
       WHERE partner_id = ? AND status = 'approved'`,
      [partnerId]
    );
    return Number(row.balance) || 0;
  }

  return { handlePaymentApproved, resolveCommissionRule, computeCommission, availableBalance };
}

module.exports = { createCommissionService };
