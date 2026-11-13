CREATE TABLE IF NOT EXISTS account_deletion_requests (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 requested_username TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 reason TEXT NOT NULL DEFAULT '',
 requested_at BIGINT NOT NULL,
 reviewed_at BIGINT,
 reviewed_by TEXT,
 review_note TEXT NOT NULL DEFAULT '',
 CHECK((status='pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status<>'pending' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_one_pending ON account_deletion_requests(user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS account_deletion_user_time ON account_deletion_requests(user_id,requested_at);
CREATE INDEX IF NOT EXISTS account_deletion_status_time ON account_deletion_requests(status,requested_at);
CREATE TABLE IF NOT EXISTS account_deletion_request_events (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES account_deletion_requests(id) ON DELETE RESTRICT,
 actor_role TEXT NOT NULL CHECK(actor_role IN ('user','admin')),
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('submitted','cancelled','approved','rejected')),
 note TEXT NOT NULL DEFAULT '',
 created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_deletion_events_request ON account_deletion_request_events(request_id,created_at);
