DROP INDEX IF EXISTS idx_sandbox_instances_active_user;
CREATE INDEX IF NOT EXISTS idx_sandbox_instances_user
  ON sandbox_instances(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_instances_active_account
  ON sandbox_instances(user_id, broker_server, mt5_account_number)
  WHERE deleted_at IS NULL;
