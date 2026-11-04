-- CornGrid EA - Sandbox, Partner Program & Commission System
-- PostgreSQL Schema
-- Version: 0005
-- Mirrors the SQLite schema embedded in sandbox/sandbox-schema.js.

BEGIN;

CREATE TABLE IF NOT EXISTS sandbox_nodes (
  id SERIAL PRIMARY KEY,
  node_uid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  auth_token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
  is_test_node BOOLEAN NOT NULL DEFAULT FALSE,
  max_instances INTEGER NOT NULL DEFAULT 10,
  agent_version TEXT,
  machine_name TEXT,
  os_version TEXT,
  cpu_count INTEGER,
  ram_mb INTEGER,
  disk_free_mb INTEGER,
  cpu_percent DOUBLE PRECISION,
  memory_used_mb DOUBLE PRECISION,
  running_instances INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at BIGINT,
  last_seen_ip TEXT,
  connected_at BIGINT,
  disconnected_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_status ON sandbox_nodes(status);
CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_heartbeat ON sandbox_nodes(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS trading_strategies (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT,
  ea_file_name TEXT,
  ea_file_path TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  submission_id INTEGER,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sandbox_instances (
  id SERIAL PRIMARY KEY,
  instance_uid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE SET NULL,
  strategy_id INTEGER REFERENCES trading_strategies(id),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','allocating','deploying','starting','running','stopping','stopped','failed','suspended')),
  broker_server TEXT,
  mt5_account_number TEXT,
  account_masked TEXT,
  sandbox_path TEXT,
  process_id INTEGER,
  trading_paused BOOLEAN NOT NULL DEFAULT FALSE,
  last_heartbeat_at BIGINT,
  last_error TEXT,
  started_at BIGINT,
  stopped_at BIGINT,
  cpu_percent DOUBLE PRECISION,
  memory_mb DOUBLE PRECISION,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_instances_active_user
  ON sandbox_instances(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sandbox_instances_node ON sandbox_instances(node_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_instances_status ON sandbox_instances(status);
CREATE INDEX IF NOT EXISTS idx_sandbox_instances_account ON sandbox_instances(mt5_account_number);

CREATE TABLE IF NOT EXISTS sandbox_credentials (
  id SERIAL PRIMARY KEY,
  instance_id INTEGER NOT NULL UNIQUE REFERENCES sandbox_instances(id) ON DELETE CASCADE,
  cipher TEXT NOT NULL,
  key_version TEXT NOT NULL DEFAULT 'v1',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sandbox_logs (
  id SERIAL PRIMARY KEY,
  instance_id INTEGER REFERENCES sandbox_instances(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
  source TEXT NOT NULL DEFAULT 'backend',
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_logs_instance ON sandbox_logs(instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sandbox_logs_node ON sandbox_logs(node_id, created_at);

CREATE TABLE IF NOT EXISTS sandbox_deployments (
  id SERIAL PRIMARY KEY,
  command_uid TEXT NOT NULL UNIQUE,
  instance_id INTEGER REFERENCES sandbox_instances(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','sent','acknowledged','completed','failed','expired')),
  payload_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_deployments_node ON sandbox_deployments(node_id, status);
CREATE INDEX IF NOT EXISTS idx_sandbox_deployments_instance ON sandbox_deployments(instance_id, created_at);

CREATE TABLE IF NOT EXISTS sandbox_metrics (
  id SERIAL PRIMARY KEY,
  node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE CASCADE,
  instance_id INTEGER REFERENCES sandbox_instances(id) ON DELETE CASCADE,
  cpu_percent DOUBLE PRECISION,
  memory_mb DOUBLE PRECISION,
  disk_free_mb DOUBLE PRECISION,
  recorded_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_metrics_node ON sandbox_metrics(node_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_sandbox_metrics_instance ON sandbox_metrics(instance_id, recorded_at);

CREATE TABLE IF NOT EXISTS sandbox_events (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_type TEXT,
  actor_id INTEGER,
  instance_id INTEGER,
  node_id INTEGER,
  payload_json TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_type ON sandbox_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_instance ON sandbox_events(instance_id, created_at);

CREATE TABLE IF NOT EXISTS partner_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  company TEXT,
  website TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  payout_method TEXT,
  payout_details_cipher TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ea_submissions (
  id SERIAL PRIMARY KEY,
  submission_uid TEXT NOT NULL UNIQUE,
  partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL,
  symbols TEXT,
  strategy_description TEXT,
  risk_description TEXT,
  documentation TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK(status IN ('pending_review','under_review','testing','testing_failed','testing_passed','approved','rejected','published')),
  review_notes TEXT,
  rejection_reason TEXT,
  reviewed_by INTEGER,
  reviewed_at BIGINT,
  published_at BIGINT,
  strategy_id INTEGER REFERENCES trading_strategies(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ea_submissions_partner ON ea_submissions(partner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ea_submissions_status ON ea_submissions(status);

CREATE TABLE IF NOT EXISTS ea_versions (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  status TEXT NOT NULL DEFAULT 'stored' CHECK(status IN ('stored','scan_failed','compiled','compile_failed')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ea_versions_submission ON ea_versions(submission_id, created_at);

CREATE TABLE IF NOT EXISTS ea_test_reports (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES ea_versions(id) ON DELETE SET NULL,
  node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'runtime' CHECK(kind IN ('compile','runtime')),
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','passed','failed')),
  compile_log TEXT,
  runtime_log TEXT,
  cpu_avg DOUBLE PRECISION,
  memory_peak_mb DOUBLE PRECISION,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ea_test_reports_submission ON ea_test_reports(submission_id, created_at);

CREATE TABLE IF NOT EXISTS partner_commissions (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id INTEGER REFERENCES trading_strategies(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT 'percent' CHECK(model IN ('percent','fixed')),
  percent DOUBLE PRECISION,
  fixed_amount DOUBLE PRECISION,
  currency TEXT NOT NULL DEFAULT 'MYR',
  applies_to TEXT NOT NULL DEFAULT 'both' CHECK(applies_to IN ('subscription','renewal','both')),
  min_payout_threshold DOUBLE PRECISION NOT NULL DEFAULT 100,
  effective_from BIGINT NOT NULL,
  effective_to BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partner_commissions_partner ON partner_commissions(partner_id, is_active);

CREATE TABLE IF NOT EXISTS partner_transactions (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id INTEGER REFERENCES trading_strategies(id),
  subscription_payment_id INTEGER,
  subscription_id INTEGER,
  gross_amount DOUBLE PRECISION NOT NULL,
  commission_amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected','cancelled')),
  notes TEXT,
  created_at BIGINT NOT NULL,
  status_updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partner_transactions_partner ON partner_transactions(partner_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_transactions_payment ON partner_transactions(subscription_payment_id);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id SERIAL PRIMARY KEY,
  payout_uid TEXT NOT NULL UNIQUE,
  partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
  method TEXT,
  reference TEXT,
  admin_notes TEXT,
  requested_at BIGINT NOT NULL,
  approved_by INTEGER,
  approved_at BIGINT,
  paid_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partner_payouts_partner ON partner_payouts(partner_id, status);

CREATE TABLE IF NOT EXISTS partner_payout_transactions (
  payout_id INTEGER NOT NULL REFERENCES partner_payouts(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES partner_transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (payout_id, transaction_id)
);

COMMIT;
