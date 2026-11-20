CREATE TABLE IF NOT EXISTS subscription_plan_promotions (
  plan_id INTEGER PRIMARY KEY REFERENCES subscription_plans(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_promotion_claims (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES subscription_plans(id) ON DELETE SET NULL,
  subscription_id INTEGER REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  plan_name TEXT NOT NULL,
  duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 3650),
  max_activations INTEGER NOT NULL CHECK(max_activations BETWEEN 1 AND 100),
  starts_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL CHECK(expires_at > starts_at),
  claimed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_claims_plan ON subscription_promotion_claims(plan_id);
