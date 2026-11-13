CREATE TABLE IF NOT EXISTS stripe_reconciliation (
  order_id TEXT PRIMARY KEY REFERENCES stripe_orders(id),
  next_check_at BIGINT NOT NULL DEFAULT 0,
  lease_until BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_checked_at BIGINT,
  last_error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_stripe_reconciliation_due ON stripe_reconciliation(next_check_at,lease_until);
CREATE INDEX IF NOT EXISTS idx_stripe_orders_recovery ON stripe_orders(status,created_at) WHERE activated_at IS NULL;
