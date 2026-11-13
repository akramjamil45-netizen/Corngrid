-- Optional destructive removal of request evidence. Back up first and restore
-- previous application code before running. Existing archive markers remain.
BEGIN;
DROP TABLE IF EXISTS account_deletion_request_events;
DROP TABLE IF EXISTS account_deletion_requests;
COMMIT;
