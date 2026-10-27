-- CornGrid EA - Subscription & License System
-- SQLite Schema
-- Version: 0003

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS subscription_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  duration_days INTEGER NOT NULL,
  max_activations INTEGER NOT NULL DEFAULT 5,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES subscription_plans(id),
  status TEXT NOT NULL CHECK(status IN ('pending_payment','pending_approval','active','expired','suspended','rejected','cancelled')),
  purchase_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  duration_days INTEGER,
  max_activations INTEGER NOT NULL DEFAULT 5,
  starts_at INTEGER,
  expires_at INTEGER,
  approved_by INTEGER,
  approved_at INTEGER,
  suspended_at INTEGER,
  suspension_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires ON user_subscriptions(expires_at);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES user_subscriptions(id),
  plan_id INTEGER REFERENCES subscription_plans(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  payment_method TEXT NOT NULL DEFAULT 'duitnow',
  payment_reference TEXT,
  payment_proof_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending_payment','pending_approval','approved','rejected','cancelled')),
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  admin_notes TEXT,
  rejection_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_user ON subscription_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription ON subscription_payments(subscription_id);

CREATE TABLE IF NOT EXISTS ea_license_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES user_subscriptions(id),
  account_id INTEGER REFERENCES mt5_accounts(id) ON DELETE SET NULL,
  mt5_account_number TEXT NOT NULL,
  broker_server TEXT NOT NULL,
  activation_identifier TEXT NOT NULL UNIQUE,
  license_status TEXT NOT NULL CHECK(license_status IN ('active','revoked','suspended')) DEFAULT 'active',
  activated_at INTEGER NOT NULL,
  last_verified_at INTEGER,
  revoked_at INTEGER,
  revocation_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, mt5_account_number, broker_server)
);

CREATE INDEX IF NOT EXISTS idx_ea_license_activations_user ON ea_license_activations(user_id);
CREATE INDEX IF NOT EXISTS idx_ea_license_activations_subscription ON ea_license_activations(subscription_id);
CREATE INDEX IF NOT EXISTS idx_ea_license_activations_status ON ea_license_activations(license_status);

CREATE TABLE IF NOT EXISTS subscription_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_role TEXT,
  action TEXT NOT NULL,
  affected_type TEXT,
  affected_id INTEGER,
  metadata TEXT,
  reason TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_audit_logs_actor ON subscription_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_subscription_audit_logs_action ON subscription_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_subscription_audit_logs_created ON subscription_audit_logs(created_at);

CREATE TABLE IF NOT EXISTS ea_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  release_notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
  released_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, read_at, created_at);

COMMIT;
