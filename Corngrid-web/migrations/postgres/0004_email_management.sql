-- CornGrid EA - Administrator Email Management
-- PostgreSQL Schema
-- Version: 0004

BEGIN;

CREATE TABLE IF NOT EXISTS email_settings (
  id INTEGER PRIMARY KEY,
  smtp_host TEXT,
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_username TEXT,
  smtp_password_enc TEXT,
  smtp_password_iv TEXT,
  smtp_password_tag TEXT,
  from_email TEXT,
  from_name TEXT,
  encryption TEXT NOT NULL DEFAULT 'tls',
  smtp_enabled INTEGER NOT NULL DEFAULT 0,
  last_test_at BIGINT,
  last_test_status TEXT,
  last_test_message TEXT,
  updated_at BIGINT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_logs (
  id SERIAL PRIMARY KEY,
  recipient TEXT NOT NULL,
  to_recipients TEXT NOT NULL,
  cc_recipients TEXT,
  bcc_recipients TEXT,
  subject TEXT NOT NULL,
  sender_email TEXT,
  sender_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_status TEXT,
  error_message TEXT,
  message_id TEXT,
  smtp_response TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  html_body TEXT,
  text_body TEXT,
  source TEXT NOT NULL DEFAULT 'composer',
  user_id INTEGER,
  created_at BIGINT NOT NULL,
  sent_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
CREATE INDEX IF NOT EXISTS idx_email_logs_recipient ON email_logs(recipient);

CREATE TABLE IF NOT EXISTS email_drafts (
  id SERIAL PRIMARY KEY,
  name TEXT,
  to_recipients TEXT,
  cc_recipients TEXT,
  bcc_recipients TEXT,
  subject TEXT,
  html_body TEXT,
  text_body TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_queue (
  id SERIAL PRIMARY KEY,
  log_id INTEGER,
  user_id INTEGER,
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  html_body TEXT,
  text_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  scheduled_at BIGINT NOT NULL,
  message_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  sent_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending ON email_queue(status, scheduled_at);

CREATE TABLE IF NOT EXISTS email_admin_audit (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT,
  ip_address TEXT,
  metadata TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_audit_created ON email_admin_audit(created_at);

COMMIT;
