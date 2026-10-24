-- CornGrid EA - PostgreSQL initial schema
-- Version: 0001

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password TEXT,
  bio TEXT DEFAULT 'CornGrid EA Terminal user',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_auth_versions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_account_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  suspended_until BIGINT NOT NULL,
  reason TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_portfolios (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL UNIQUE,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mt5_pairing_codes_user ON mt5_pairing_codes(user_id);
CREATE TABLE IF NOT EXISTS mt5_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_number TEXT NOT NULL,
  broker_server TEXT NOT NULL,
  currency TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT 'CornGrid EA',
  balance DOUBLE PRECISION,
  equity DOUBLE PRECISION,
  margin DOUBLE PRECISION,
  free_margin DOUBLE PRECISION,
  floating_profit DOUBLE PRECISION,
  ea_name TEXT,
  ea_version TEXT,
  last_heartbeat BIGINT,
  last_sync BIGINT,
  linked_at BIGINT NOT NULL,
  auth_error_at BIGINT,
  UNIQUE(account_number, broker_server)
);
CREATE INDEX IF NOT EXISTS mt5_accounts_user ON mt5_accounts(user_id);

CREATE TABLE IF NOT EXISTS public_portfolio_accounts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL UNIQUE REFERENCES mt5_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, account_id)
);

CREATE OR REPLACE FUNCTION check_portfolio_account_owner() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mt5_accounts WHERE id = NEW.account_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Portfolio account owner mismatch.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS public_portfolio_account_owner_insert ON public_portfolio_accounts;
CREATE TRIGGER public_portfolio_account_owner_insert
BEFORE INSERT ON public_portfolio_accounts
FOR EACH ROW EXECUTE FUNCTION check_portfolio_account_owner();

CREATE TABLE IF NOT EXISTS mt5_installations (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS mt5_snapshots (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
  captured_at BIGINT NOT NULL,
  balance DOUBLE PRECISION NOT NULL,
  equity DOUBLE PRECISION NOT NULL,
  floating_profit DOUBLE PRECISION NOT NULL,
  UNIQUE(account_id, captured_at)
);
CREATE INDEX IF NOT EXISTS mt5_snapshots_account_time ON mt5_snapshots(account_id, captured_at);

CREATE TABLE IF NOT EXISTS mt5_positions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
  ticket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('BUY', 'SELL')),
  volume DOUBLE PRECISION NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL,
  current_price DOUBLE PRECISION,
  stop_loss DOUBLE PRECISION,
  take_profit DOUBLE PRECISION,
  profit DOUBLE PRECISION NOT NULL,
  swap DOUBLE PRECISION,
  commission DOUBLE PRECISION,
  opened_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(account_id, ticket)
);
CREATE INDEX IF NOT EXISTS mt5_positions_account_symbol ON mt5_positions(account_id, symbol);

CREATE TABLE IF NOT EXISTS mt5_deals (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL,
  position_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('BUY', 'SELL')),
  volume DOUBLE PRECISION NOT NULL,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  stop_loss DOUBLE PRECISION,
  take_profit DOUBLE PRECISION,
  profit DOUBLE PRECISION NOT NULL,
  commission DOUBLE PRECISION,
  swap DOUBLE PRECISION,
  closed_at BIGINT NOT NULL,
  duration_seconds INTEGER,
  magic_number TEXT,
  ea_version TEXT,
  UNIQUE(account_id, deal_id)
);
CREATE INDEX IF NOT EXISTS mt5_deals_account_time ON mt5_deals(account_id, closed_at);

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  file TEXT NOT NULL UNIQUE,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_participants ON direct_messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_recipient_read ON direct_messages(recipient_id, read_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('user', 'admin')),
  message TEXT NOT NULL,
  read_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_user_created ON support_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_unread ON support_messages(sender_role, read_at);

CREATE TABLE IF NOT EXISTS feed_posts (
  id SERIAL PRIMARY KEY,
  author_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'community' CHECK(kind IN ('community', 'announcement')),
  title TEXT,
  content TEXT NOT NULL,
  image_path TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT,
  deleted_at BIGINT,
  CHECK (
    (kind = 'announcement' AND author_user_id IS NULL) OR
    (kind = 'community' AND author_user_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_feed_posts_live ON feed_posts(deleted_at, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_feed_posts_author ON feed_posts(author_user_id, deleted_at, created_at);

CREATE TABLE IF NOT EXISTS feed_comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES feed_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, deleted_at, id);
CREATE INDEX IF NOT EXISTS idx_feed_comments_author ON feed_comments(author_user_id, deleted_at);

CREATE TABLE IF NOT EXISTS feed_likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_likes_post ON feed_likes(post_id);

CREATE TABLE IF NOT EXISTS feed_reports (
  id SERIAL PRIMARY KEY,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment')),
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_feed_reports_open ON feed_reports(resolved_at, created_at);

CREATE TABLE IF NOT EXISTS market_drawings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('hline', 'trend')),
  data TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_drawings_user_symbol ON market_drawings(user_id, symbol);

CREATE TABLE IF NOT EXISTS market_candles (
  feed TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL,
  t BIGINT NOT NULL,
  o DOUBLE PRECISION NOT NULL,
  h DOUBLE PRECISION NOT NULL,
  l DOUBLE PRECISION NOT NULL,
  c DOUBLE PRECISION NOT NULL,
  tv INTEGER,
  v DOUBLE PRECISION,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (feed, symbol, tf, t)
);
CREATE INDEX IF NOT EXISTS idx_market_candles_symbol_feed ON market_candles(symbol, feed, updated_at);

CREATE TABLE IF NOT EXISTS economic_calendar_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  source_url TEXT,
  updated_at BIGINT NOT NULL
);

COMMIT;


