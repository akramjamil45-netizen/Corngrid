CREATE TABLE IF NOT EXISTS stripe_orders (
 id TEXT PRIMARY KEY, payment_id INTEGER NOT NULL UNIQUE REFERENCES subscription_payments(id),
 user_id INTEGER NOT NULL REFERENCES users(id), amount_minor BIGINT NOT NULL, currency TEXT NOT NULL,
 session_id TEXT UNIQUE, checkout_url TEXT, payment_intent_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending', review_status TEXT, paid_at BIGINT, activated_at BIGINT,
 created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed_at BIGINT NOT NULL);
