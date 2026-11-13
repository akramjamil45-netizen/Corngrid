-- Also applied by the subscription schema on SQLite startup.
CREATE TABLE IF NOT EXISTS subscription_payment_archives (
  payment_id INTEGER PRIMARY KEY REFERENCES subscription_payments(id),
  archived_at BIGINT NOT NULL,
  archived_by INTEGER
);
