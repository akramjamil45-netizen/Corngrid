CREATE TABLE IF NOT EXISTS stripe_orders (
 id TEXT PRIMARY KEY, payment_id INTEGER NOT NULL UNIQUE REFERENCES subscription_payments(id),
 user_id INTEGER NOT NULL REFERENCES users(id), amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
 session_id TEXT UNIQUE, checkout_url TEXT, payment_intent_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending', review_status TEXT, paid_at INTEGER, activated_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed_at INTEGER NOT NULL);
