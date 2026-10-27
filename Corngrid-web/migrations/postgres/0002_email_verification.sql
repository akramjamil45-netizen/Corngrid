-- CornGrid EA - Email OTP verification
-- Version: 0002
--
-- Additive migration. Existing users are explicitly marked verified so they
-- keep signing in after deployment. New registrations insert FALSE.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  otp_salt TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  sent_at BIGINT,
  consumed_at BIGINT,
  request_ip TEXT
);

CREATE TABLE IF NOT EXISTS email_verification_requests (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  kind TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS email_verification_requests_email
  ON email_verification_requests(email, created_at);
CREATE INDEX IF NOT EXISTS email_verification_requests_ip
  ON email_verification_requests(ip, created_at);

COMMIT;
