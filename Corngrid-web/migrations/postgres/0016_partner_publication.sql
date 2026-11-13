-- Immutable file/preset/advertisement snapshots bind EA review to publication.
CREATE TABLE IF NOT EXISTS ea_submission_links (
  submission_id INTEGER PRIMARY KEY REFERENCES ea_submissions(id) ON DELETE RESTRICT,
  version_id INTEGER NOT NULL UNIQUE REFERENCES ea_versions(id) ON DELETE RESTRICT,
  listing_id TEXT NOT NULL REFERENCES marketplace_eas(id) ON DELETE RESTRICT,
  listing_revision INTEGER NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  listing_snapshot_json TEXT NOT NULL,
  entry_file TEXT,
  superseded_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ea_one_current_submission ON ea_submission_links(listing_id) WHERE superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS ea_submission_artifacts (
  id TEXT PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES ea_submissions(id) ON DELETE RESTRICT,
  version_id INTEGER NOT NULL UNIQUE REFERENCES ea_versions(id) ON DELETE RESTRICT,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 10485760),
  origin TEXT NOT NULL CHECK(origin IN ('partner','test_node','admin')),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ea_release_approvals (
  submission_id INTEGER PRIMARY KEY REFERENCES ea_submissions(id) ON DELETE RESTRICT,
  version_id INTEGER NOT NULL UNIQUE REFERENCES ea_versions(id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL REFERENCES ea_submission_artifacts(id) ON DELETE RESTRICT,
  listing_id TEXT NOT NULL REFERENCES marketplace_eas(id) ON DELETE RESTRICT,
  listing_revision INTEGER NOT NULL,
  strategy_id INTEGER NOT NULL REFERENCES trading_strategies(id) ON DELETE RESTRICT,
  review_digest TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ea_release_listing ON ea_release_approvals(listing_id,approved_at);
