-- Retain provider references and financial history when removing closed requests.
CREATE TABLE IF NOT EXISTS subscription_payment_archives (
  payment_id INTEGER PRIMARY KEY REFERENCES subscription_payments(id),
  archived_at BIGINT NOT NULL,
  archived_by INTEGER
);
