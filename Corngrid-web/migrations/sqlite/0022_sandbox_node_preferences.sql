-- Existing SQLite installations apply this extension idempotently through
-- sandbox/sandbox-schema.js. All existing nodes keep equal priority.
ALTER TABLE sandbox_nodes ADD COLUMN placement_priority INTEGER NOT NULL DEFAULT 100
  CHECK(placement_priority BETWEEN 1 AND 1000);
CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_placement ON sandbox_nodes(status, is_test_node, placement_priority, id);
