CREATE TABLE IF NOT EXISTS partner_agreements (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, terms_version TEXT NOT NULL,
 terms_hash TEXT NOT NULL, language TEXT NOT NULL, signer_name TEXT NOT NULL,
 accepted_at INTEGER NOT NULL, receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partner_agreements_user ON partner_agreements(user_id,accepted_at);
-- The runtime checks PRAGMA table_info before adding agreement_id, making retries safe.
