-- User-resource replacements are stored outside public static directories.
CREATE TABLE IF NOT EXISTS download_updates (
  resource_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  version TEXT NOT NULL,
  data BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
