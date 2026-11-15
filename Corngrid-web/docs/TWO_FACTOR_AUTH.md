# Two-factor authentication

Administrators use the **Security** button in the admin header. Active partners use **Settings → Security → Two-factor authentication**. Enrollment is opt-in and does not enroll or lock out existing accounts automatically. Regular users cannot enroll through partner-only management endpoints. A previously enrolled account keeps its second factor if partner status changes.

The user confirms their current password, enters the manual setup key into an authenticator app, and confirms a six-digit code. Setup expires after ten minutes. Eight random recovery codes are displayed once and can be downloaded privately as text. Each recovery code works once. Keep them offline; do not upload them to the feed or support chat. QR generation is not implemented; manual entry avoids sending secrets to an external QR service.

Login uses the existing email/password endpoint. If enrolled, it asks for an authenticator or recovery code before issuing a token or cookie. Password recovery does not remove the second factor. Enrollment/disable changes the MFA session version: previous HTTP sessions and administrator WebSockets are rejected. The current browser receives a refreshed HttpOnly cookie. Clients using bearer tokens must retain the replacement token returned by enrollment/disable.

Payout writes and partner bank-detail changes require a fresh second-factor proof when enrolled. The shared CornGrid dialog obtains it and retries the protected request once. External clients supply `X-MFA-Code`. No financial mutation occurs without proof. Existing payout ownership, CSRF, idempotency and approval checks still apply. TOTP codes are single use, including the code accepted during enrollment: wait for the next 30-second code for a subsequent action. Recovery codes can be used instead. If a request succeeds but its response is lost, the code is still consumed; follow the existing payout status/idempotency flow instead of assuming payment failed.

## Deployment

Apply additive PostgreSQL migration **0019_auth_factors.sql** before deploying the authentication integration. SQLite self-applies its equivalent. Missing factor tables cause verification to fail closed; do not deploy authentication code ahead of its migration. Existing MT5 installation/node credentials and licensing authentication are separate and remain unchanged.

Set a persistent 32-byte hex **MFA_ENCRYPTION_KEY**, or reuse the existing **SANDBOX_ENCRYPTION_KEY**. Never rotate/delete it without re-enrollment or a deliberate key migration. Ephemeral development keys cannot enroll persistent factors. Back up the database and encryption keys through private channels. No seed, recovery code or key belongs in Git, logs or analytics.

Endpoints, protected by the existing appropriate session:

- `GET /api/admin/security/mfa` and `GET /api/security/mfa`: own status and enrollment eligibility.
- `POST <prefix>/setup`: password reauthentication; returns the temporary setup secret/URI.
- `POST <prefix>/confirm`: confirms the temporary authenticator, returns one-time recovery codes and replacement session.
- `POST <prefix>/disable`: requires password and current factor/recovery code; replaces the current session.

AES-256-GCM encrypts seeds through the existing sandbox crypto service. Recovery codes are stored as subject-bound SHA-256 hashes. Authentication uses RFC 6238 SHA-1, six digits, 30-second steps, current/previous step only. A transaction with PostgreSQL row locks or the SQLite exclusive write queue prevents parallel reuse. Five failed factor attempts block verification for five minutes; state persists through restarts. Per-IP endpoint limits remain in place. Security events record enrollment, disabling and recovery usage without codes.

Recover a lost authenticator with an unused recovery code and the normal password, then disable and enroll a new authenticator. If both authenticator and recovery codes are lost, an operator identity-verification and audited recovery procedure is required; there is no public bypass or unauthenticated reset endpoint. TOTP is not phishing resistant; passkeys can be added as a later enhancement.

References: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
