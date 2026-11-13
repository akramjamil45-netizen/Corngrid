-- Marketplace metadata is independent of operational EA/subscription state.
CREATE TABLE IF NOT EXISTS marketplace_eas (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('official','partner')),
  provider_id INTEGER REFERENCES partner_profiles(user_id) ON DELETE RESTRICT,
  existing_strategy_id INTEGER UNIQUE REFERENCES trading_strategies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  short_description TEXT NOT NULL DEFAULT '',
  full_description TEXT NOT NULL DEFAULT '{}',
  version TEXT NOT NULL DEFAULT '',
  strategy_type TEXT NOT NULL DEFAULT 'other',
  supported_symbols TEXT NOT NULL DEFAULT '[]',
  supported_timeframes TEXT NOT NULL DEFAULT '[]',
  minimum_balance NUMERIC,
  balance_currency TEXT NOT NULL DEFAULT 'USD',
  recommended_leverage TEXT NOT NULL DEFAULT '',
  account_mode TEXT NOT NULL DEFAULT 'unspecified' CHECK(account_mode IN ('hedging','netting','both','unspecified')),
  platform TEXT NOT NULL DEFAULT 'MetaTrader 5' CHECK(platform = 'MetaTrader 5'),
  listing_status TEXT NOT NULL DEFAULT 'draft' CHECK(listing_status IN ('draft','pending_review','approved','published','rejected','archived')),
  infrastructure_status TEXT NOT NULL DEFAULT 'coming_soon' CHECK(infrastructure_status IN ('available','coming_soon','unavailable','maintenance')),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1,
  review_notes TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK((provider_type='official' AND provider_id IS NULL) OR (provider_type='partner' AND provider_id IS NOT NULL)),
  CHECK(minimum_balance IS NULL OR minimum_balance >= 0)
);
CREATE INDEX IF NOT EXISTS marketplace_eas_public ON marketplace_eas(listing_status,featured,updated_at);
CREATE INDEX IF NOT EXISTS marketplace_eas_owner ON marketplace_eas(provider_id,updated_at);
CREATE TABLE IF NOT EXISTS marketplace_media (
  id TEXT PRIMARY KEY,
  ea_id TEXT REFERENCES marketplace_eas(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('logo','screenshot','banner')),
  file_name TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CHECK((kind='banner' AND ea_id IS NULL) OR (kind IN ('logo','screenshot') AND ea_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS marketplace_media_ea ON marketplace_media(ea_id,kind,display_order);
CREATE TABLE IF NOT EXISTS marketplace_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  marketplace_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  promo_visible BOOLEAN NOT NULL DEFAULT FALSE,
  promo_title TEXT NOT NULL DEFAULT '',
  promo_description TEXT NOT NULL DEFAULT '',
  promo_ea_id TEXT REFERENCES marketplace_eas(id) ON DELETE SET NULL,
  promo_image_id TEXT REFERENCES marketplace_media(id) ON DELETE SET NULL,
  updated_by TEXT,
  updated_at BIGINT NOT NULL
);
INSERT INTO marketplace_settings(id,updated_at) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS marketplace_user_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id TEXT PRIMARY KEY,
  ea_id TEXT NOT NULL REFERENCES marketplace_eas(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by TEXT,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected','superseded')),
  rejection_reason TEXT,
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_one_pending_review ON marketplace_reviews(ea_id) WHERE decision='pending';
CREATE INDEX IF NOT EXISTS marketplace_reviews_ea ON marketplace_reviews(ea_id,created_at);
CREATE TABLE IF NOT EXISTS marketplace_audit (
  id TEXT PRIMARY KEY,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  ea_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS marketplace_audit_time ON marketplace_audit(created_at);
