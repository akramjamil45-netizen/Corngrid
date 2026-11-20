-- Stop the new application version and restore the preceding code first.
-- Compatible with PostgreSQL and SQLite 3.35+; discards priority metadata only.
BEGIN;
DROP INDEX IF EXISTS idx_sandbox_nodes_placement;
ALTER TABLE sandbox_nodes DROP COLUMN placement_priority;
COMMIT;
