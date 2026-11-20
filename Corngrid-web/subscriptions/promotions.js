'use strict';

// One promotion grant per account, across every promotional plan and revision.
// No payment is fabricated; the existing subscription/license checks govern use.
function createPromotions({ run, get, withTransaction, isPostgres, now = Date.now }) {
  async function claim(userId, planId, ip) {
    return withTransaction(async () => {
      // Same user lock as paid activation. PostgreSQL workers serialize here;
      // SQLite also holds the shared write queue and BEGIN IMMEDIATE.
      const user = await run('UPDATE users SET id=id WHERE id=?', [userId]);
      if (!user.changes) return { http: 401, body: { error: 'User account not found.' } };
      const archived = await get('SELECT user_id FROM account_archives WHERE user_id=?', [userId]);
      const blocked = await get('SELECT user_id FROM user_account_access WHERE user_id=? AND suspended_until>?', [userId,now()]);
      if (archived || blocked) return { http: 403, body: { error: 'This account cannot claim promotions. Contact support.' } };
      const previous = await get('SELECT user_id FROM subscription_promotion_claims WHERE user_id=?', [userId]);
      if (previous) return { http: 409, body: { error: 'You have already claimed your one-time promotion.', code: 'PROMOTION_ALREADY_CLAIMED' } };
      if (isPostgres) await get('SELECT id FROM subscription_plans WHERE id=? FOR SHARE', [planId]);
      const plan = await get(`SELECT p.* FROM subscription_plans p
        JOIN subscription_plan_promotions promo ON promo.plan_id=p.id WHERE p.id=? AND p.is_active=TRUE`, [planId]);
      if (!plan) return { http: 404, body: { error: 'This promotion is not available.' } };
      if (Number(plan.price) !== 0) return { http: 409, body: { error: 'This promotion is not configured as a free plan.' } };
      if (!Number.isSafeInteger(plan.duration_days) || plan.duration_days < 1 || plan.duration_days > 3650 ||
          !Number.isSafeInteger(plan.max_activations) || plan.max_activations < 1 || plan.max_activations > 100) {
        return { http: 409, body: { error: 'This promotion needs an administrator to review its terms.' } };
      }
      const suspended = await get("SELECT id FROM user_subscriptions WHERE user_id=? AND status='suspended' AND deleted_at IS NULL LIMIT 1", [userId]);
      if (suspended) return { http: 409, body: { error: 'Your subscription is suspended. Contact support before claiming a promotion.' } };
      const unlimited = await get("SELECT id FROM user_subscriptions WHERE user_id=? AND status='active' AND starts_at IS NOT NULL AND expires_at IS NULL AND deleted_at IS NULL LIMIT 1", [userId]);
      if (unlimited) return { http: 409, body: { error: 'Your subscription has no expiry date. Contact support to review this promotion.' } };
      const latest = await get("SELECT MAX(expires_at) AS expires_at FROM user_subscriptions WHERE user_id=? AND status='active' AND starts_at IS NOT NULL AND deleted_at IS NULL", [userId]);
      const timestamp = now();
      const startsAt = Math.max(timestamp, Number(latest?.expires_at) || 0);
      const expiresAt = startsAt + plan.duration_days * 86400000;
      const subscription = await run(`INSERT INTO user_subscriptions
        (user_id,plan_id,status,purchase_price,currency,duration_days,max_activations,starts_at,expires_at,approved_at,created_at,updated_at)
        VALUES (?,?,'active',0,?,?,?,?,?,?,?,?)`,
      [userId,plan.id,plan.currency,plan.duration_days,plan.max_activations,startsAt,expiresAt,timestamp,timestamp,timestamp]);
      await run(`INSERT INTO subscription_promotion_claims
        (user_id,plan_id,subscription_id,plan_name,duration_days,max_activations,starts_at,expires_at,claimed_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      [userId,plan.id,subscription.lastID,plan.name,plan.duration_days,plan.max_activations,startsAt,expiresAt,timestamp]);
      // Audit is part of the grant transaction: failure must not consume a claim
      // or leave an unaudited licence period behind.
      await run(`INSERT INTO subscription_audit_logs
        (actor_id,actor_role,action,affected_type,affected_id,metadata,reason,ip_address,created_at)
        VALUES (?,'user','promotion_claimed','subscription',?,?,NULL,?,?)`,
      [userId,subscription.lastID,JSON.stringify({planId:plan.id,planName:plan.name,durationDays:plan.duration_days,maxActivations:plan.max_activations,startsAt,expiresAt}),ip || null,timestamp]);
      const scheduled = startsAt > timestamp;
      return { http: 201, body: { subscriptionId: subscription.lastID, scheduled, startsAt, expiresAt,
        durationDays: plan.duration_days, maxActivations: plan.max_activations,
        message: scheduled ? 'Promotion claimed. Your free access starts after your existing subscription periods.' : 'Promotion claimed. Your free subscription is now active.' } };
    });
  }
  return { claim };
}

module.exports = { createPromotions };
