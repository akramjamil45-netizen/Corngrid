CREATE TABLE IF NOT EXISTS user_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id,read_at,created_at);
CREATE TABLE IF NOT EXISTS notification_preferences (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 sandbox_offline INTEGER NOT NULL DEFAULT 1 CHECK(sandbox_offline IN (0,1)),
 ea_disconnected INTEGER NOT NULL DEFAULT 1 CHECK(ea_disconnected IN (0,1)),
 subscription_expiry INTEGER NOT NULL DEFAULT 1 CHECK(subscription_expiry IN (0,1)),
 payment_status INTEGER NOT NULL DEFAULT 1 CHECK(payment_status IN (0,1)),
 expiry_days INTEGER NOT NULL DEFAULT 7 CHECK(expiry_days BETWEEN 1 AND 30),
 updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_alert_state (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, value TEXT NOT NULL, updated_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,source_key)
);
CREATE TABLE IF NOT EXISTS user_notification_details (
 notification_id INTEGER PRIMARY KEY REFERENCES user_notifications(id) ON DELETE CASCADE,
 category TEXT NOT NULL CHECK(category IN ('sandbox_offline','ea_disconnected','subscription_expiry','payment_status')),
 target TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_notification_state_updated ON notification_alert_state(updated_at);
