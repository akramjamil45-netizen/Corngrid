-- Optional destructive rollback of Marketplace metadata ONLY.
-- Back up Marketplace data/media and restore the previous application first.
BEGIN;
DROP TABLE IF EXISTS marketplace_settings;
DROP TABLE IF EXISTS marketplace_user_access;
DROP TABLE IF EXISTS marketplace_reviews;
DROP TABLE IF EXISTS marketplace_media;
DROP TABLE IF EXISTS marketplace_audit;
DROP TABLE IF EXISTS marketplace_eas;
COMMIT;
