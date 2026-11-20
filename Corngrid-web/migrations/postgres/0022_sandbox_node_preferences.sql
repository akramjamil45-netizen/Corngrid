BEGIN;
ALTER TABLE sandbox_nodes ADD COLUMN IF NOT EXISTS placement_priority INTEGER NOT NULL DEFAULT 100
  CHECK(placement_priority BETWEEN 1 AND 1000);
CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_placement ON sandbox_nodes(status, is_test_node, placement_priority, id);
COMMIT;
