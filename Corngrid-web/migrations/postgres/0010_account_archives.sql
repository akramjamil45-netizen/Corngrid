CREATE TABLE IF NOT EXISTS account_archives (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 archived_at BIGINT NOT NULL, archived_by TEXT NOT NULL, reason TEXT
);
CREATE TABLE IF NOT EXISTS account_archive_events (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, username TEXT NOT NULL,
 action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_archive_events_user ON account_archive_events(user_id,created_at);
