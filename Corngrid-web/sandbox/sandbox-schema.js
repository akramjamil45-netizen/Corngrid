'use strict';

// CornGrid Sandbox schema (SQLite flavour).
//
// Follows the existing module convention: the SQLite schema is embedded here
// and applied with db.exec on registration (idempotent CREATE IF NOT EXISTS),
// while PostgreSQL deployments apply migrations/postgres/0005_sandbox.sql via
// scripts/apply-postgres-migrations.js. Keep both in sync.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sandbox_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    auth_token_hash TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
    is_test_node INTEGER NOT NULL DEFAULT 0 CHECK(is_test_node IN (0,1)),
    max_instances INTEGER NOT NULL DEFAULT 10,
    agent_version TEXT,
    machine_name TEXT,
    os_version TEXT,
    cpu_count INTEGER,
    ram_mb INTEGER,
    disk_free_mb INTEGER,
    cpu_percent REAL,
    memory_used_mb REAL,
    running_instances INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at INTEGER,
    last_seen_ip TEXT,
    connected_at INTEGER,
    disconnected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_status ON sandbox_nodes(status);
  CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_heartbeat ON sandbox_nodes(last_heartbeat_at);

  CREATE TABLE IF NOT EXISTS trading_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    version TEXT,
    ea_file_name TEXT,
    ea_file_path TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    is_published INTEGER NOT NULL DEFAULT 0 CHECK(is_published IN (0,1)),
    submission_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    trading_paused INTEGER NOT NULL DEFAULT 0 CHECK(trading_paused IN (0,1)),
    last_heartbeat_at INTEGER,
    last_error TEXT,
    started_at INTEGER,
    stopped_at INTEGER,
    cpu_percent REAL,
    memory_mb REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  DROP INDEX IF EXISTS idx_sandbox_instances_active_user;
  CREATE INDEX IF NOT EXISTS idx_sandbox_instances_user
    ON sandbox_instances(user_id) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_instances_active_account
    ON sandbox_instances(user_id, broker_server, mt5_account_number) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sandbox_instances_node ON sandbox_instances(node_id);
  CREATE INDEX IF NOT EXISTS idx_sandbox_instances_status ON sandbox_instances(status);
  CREATE INDEX IF NOT EXISTS idx_sandbox_instances_account ON sandbox_instances(mt5_account_number);

  CREATE TABLE IF NOT EXISTS sandbox_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL UNIQUE REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    cipher TEXT NOT NULL,
    key_version TEXT NOT NULL DEFAULT 'v1',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE SET NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
    source TEXT NOT NULL DEFAULT 'backend',
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_logs_instance ON sandbox_logs(instance_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sandbox_logs_node ON sandbox_logs(node_id, created_at);

  CREATE TABLE IF NOT EXISTS sandbox_deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_uid TEXT NOT NULL UNIQUE,
    instance_id INTEGER REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','sent','acknowledged','completed','failed','expired')),
    payload_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_deployments_node ON sandbox_deployments(node_id, status);
  CREATE INDEX IF NOT EXISTS idx_sandbox_deployments_instance ON sandbox_deployments(instance_id, created_at);

  CREATE TABLE IF NOT EXISTS sandbox_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE CASCADE,
    instance_id INTEGER REFERENCES sandbox_instances(id) ON DELETE CASCADE,
    cpu_percent REAL,
    memory_mb REAL,
    disk_free_mb REAL,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_metrics_node ON sandbox_metrics(node_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_sandbox_metrics_instance ON sandbox_metrics(instance_id, recorded_at);

  CREATE TABLE IF NOT EXISTS sandbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor_type TEXT,
    actor_id INTEGER,
    instance_id INTEGER,
    node_id INTEGER,
    payload_json TEXT,
    created_at INTEGER NOT NULL
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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ea_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    reviewed_at INTEGER,
    published_at INTEGER,
    strategy_id INTEGER REFERENCES trading_strategies(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ea_submissions_partner ON ea_submissions(partner_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ea_submissions_status ON ea_submissions(status);

  CREATE TABLE IF NOT EXISTS ea_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT,
    status TEXT NOT NULL DEFAULT 'stored' CHECK(status IN ('stored','scan_failed','compiled','compile_failed')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ea_versions_submission ON ea_versions(submission_id, created_at);

  CREATE TABLE IF NOT EXISTS ea_test_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE CASCADE,
    version_id INTEGER REFERENCES ea_versions(id) ON DELETE SET NULL,
    node_id INTEGER REFERENCES sandbox_nodes(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'runtime' CHECK(kind IN ('compile','runtime')),
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','passed','failed')),
    compile_log TEXT,
    runtime_log TEXT,
    cpu_avg REAL,
    memory_peak_mb REAL,
    error_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ea_test_reports_submission ON ea_test_reports(submission_id, created_at);

  CREATE TABLE IF NOT EXISTS partner_commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id INTEGER REFERENCES trading_strategies(id) ON DELETE CASCADE,
    model TEXT NOT NULL DEFAULT 'percent' CHECK(model IN ('percent','fixed')),
    percent REAL,
    fixed_amount REAL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    applies_to TEXT NOT NULL DEFAULT 'both' CHECK(applies_to IN ('subscription','renewal','both')),
    min_payout_threshold REAL NOT NULL DEFAULT 100,
    effective_from INTEGER NOT NULL,
    effective_to INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_partner_commissions_partner ON partner_commissions(partner_id, is_active);

  CREATE TABLE IF NOT EXISTS partner_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy_id INTEGER REFERENCES trading_strategies(id),
    subscription_payment_id INTEGER,
    subscription_id INTEGER,
    gross_amount REAL NOT NULL,
    commission_amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected','cancelled')),
    notes TEXT,
    created_at INTEGER NOT NULL,
    status_updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_partner_transactions_partner ON partner_transactions(partner_id, status);
  CREATE INDEX IF NOT EXISTS idx_partner_transactions_payment ON partner_transactions(subscription_payment_id);

  CREATE TABLE IF NOT EXISTS partner_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payout_uid TEXT NOT NULL UNIQUE,
    partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
    method TEXT,
    reference TEXT,
    admin_notes TEXT,
    requested_at INTEGER NOT NULL,
    approved_by INTEGER,
    approved_at INTEGER,
    paid_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_partner_payouts_partner ON partner_payouts(partner_id, status);

  CREATE TABLE IF NOT EXISTS partner_payout_transactions (
    payout_id INTEGER NOT NULL REFERENCES partner_payouts(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL UNIQUE REFERENCES partner_transactions(id) ON DELETE CASCADE,
    PRIMARY KEY (payout_id, transaction_id)
  );
`;

const PARTNER_EXTENSIONS_SCHEMA = "\nCREATE TABLE IF NOT EXISTS partner_applications (\n user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,\n display_name TEXT NOT NULL, company TEXT, website TEXT,\n status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),\n review_notes TEXT, reviewed_by TEXT, reviewed_at BIGINT,\n created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS ea_submission_presets (\n submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE CASCADE,\n symbol TEXT NOT NULL, file_name TEXT NOT NULL, content_text TEXT NOT NULL,\n PRIMARY KEY(submission_id,symbol)\n);\n";

// Default strategy catalogue seed. The CornGrid EA ships with the platform, so
// it is inserted at startup when missing; partner EAs appear here only after
// the review workflow publishes them.
const DEFAULT_STRATEGY = {
  code: 'corngrid-ea',
  name: 'CornGrid EA',
  description: 'The official CornGrid grid trading expert advisor.'
};

function ensureSchema(db) {
  return new Promise((resolve, reject) => {
    db.exec(SCHEMA + PARTNER_EXTENSIONS_SCHEMA, error => (error ? reject(error) : resolve()));
  });
}

function seedDefaultStrategy(db, { now = () => Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM trading_strategies WHERE code = ?', [DEFAULT_STRATEGY.code], (lookupError, row) => {
      if (lookupError) return reject(lookupError);
      if (row) return resolve(row.id);
      const timestamp = now();
      // TRUE/FALSE literals work in both SQLite (1/0) and PostgreSQL (boolean).
      db.run(
        `INSERT INTO trading_strategies (code, name, description, version, is_active, is_published, created_at, updated_at)
         VALUES (?, ?, ?, '1.0', TRUE, TRUE, ?, ?)`,
        [DEFAULT_STRATEGY.code, DEFAULT_STRATEGY.name, DEFAULT_STRATEGY.description, timestamp, timestamp],
        function (insertError) {
          if (insertError) return reject(insertError);
          resolve(this.lastID);
        }
      );
    });
  });
}

module.exports = { SCHEMA, ensureSchema, seedDefaultStrategy, DEFAULT_STRATEGY };
