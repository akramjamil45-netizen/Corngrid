-- Optional destructive removal of review evidence only. Back up first.
-- Restore older application code before running. Published strategies remain.
BEGIN;
DROP TABLE IF EXISTS ea_release_approvals;
DROP TABLE IF EXISTS ea_submission_artifacts;
DROP TABLE IF EXISTS ea_submission_links;
COMMIT;
