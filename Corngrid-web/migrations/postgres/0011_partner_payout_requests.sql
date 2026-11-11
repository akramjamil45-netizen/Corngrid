-- Keep the original payout ledger and legacy settlement links intact.
CREATE TABLE IF NOT EXISTS partner_payout_details (
  payout_id BIGINT PRIMARY KEY REFERENCES partner_payouts(id) ON DELETE CASCADE,
  request_key TEXT UNIQUE,
  bank_snapshot_cipher TEXT,
  review_reason TEXT
);
CREATE TABLE IF NOT EXISTS partner_payout_allocations (
  payout_id BIGINT NOT NULL REFERENCES partner_payouts(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES partner_transactions(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL CHECK(amount_cents > 0),
  PRIMARY KEY(payout_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_payout_allocations_transaction ON partner_payout_allocations(transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_one_open_payout
  ON partner_payouts(partner_id) WHERE status IN ('pending','approved');
