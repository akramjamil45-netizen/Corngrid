CREATE TABLE IF NOT EXISTS auth_factors (
 subject TEXT PRIMARY KEY,
 secret_cipher TEXT,
 pending_cipher TEXT,
 pending_until BIGINT NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 version INTEGER NOT NULL DEFAULT 0,
 last_step BIGINT NOT NULL DEFAULT -1,
 failures INTEGER NOT NULL DEFAULT 0,
 blocked_until BIGINT NOT NULL DEFAULT 0,
 recovery_json TEXT NOT NULL DEFAULT '[]',
 updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_factor_events (
 id SERIAL PRIMARY KEY,
 subject TEXT NOT NULL,
 action TEXT NOT NULL,
 created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_factor_events_subject ON auth_factor_events(subject,created_at);
