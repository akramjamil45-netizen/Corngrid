# User notification center

Workplace now has **Community → Notifications**, a header bell with a global unread count, and **Settings → Notifications**. The subscription page's existing updates use the same records and read/delete operations. Existing notification history is preserved. New controls use CornGrid styling, native checkboxes, accessible labels/status feedback, and compact desktop/mobile layouts. The notification center and alert settings use English consistently with Workplace, regardless of a language previously saved by the marketing site.

## Delivery and preferences

This release delivers **in-app notifications**. It does not send email, OS push notifications, SMS or Telegram messages, and does not request browser notification permission. Economic News retains its separate existing calendar/browser alerts.

Each authenticated user can enable or disable:

- Sandbox offline/failure alerts.
- EA disconnection/authentication-problem alerts.
- Subscription expiry and status alerts.
- DuitNow/Stripe payment and activation status alerts.

All four default to enabled. The expiry lead defaults to seven days and accepts 1–30 days. Reminders occur once at the configured lead, then once at the three-day and one-day urgency bands where applicable. An initial observation emits only the current urgency band. Renewal is identified by the real new expiry timestamp.

Preferences are stored per user in the database and shared across devices. Changes affect future alerts, including notifications emitted by existing subscription/payment flows. They do not remove history. Disabled categories still track observed state; enabling a category does not replay an unchanged outage or old payment history. A recovered connection that subsequently fails generates a new episode.

## Real observations and lifecycle

`notification-center.js` reads the existing sandbox/node, MT5 account, subscription and payment tables. It never starts/stops trading, activates a subscription, queries payment providers or changes license allowances. The existing verified payment/activation flow remains authoritative.

- Running/starting sandboxes require a recent node report (90 seconds) and an instance report (120 seconds, with startup grace). Failed instances are actionable. Intentionally stopped/stopping/suspended instances do not generate sandbox-offline alerts.
- EA alerts follow the configured `MT5_HEARTBEAT_TIMEOUT_SECONDS` (default 180 seconds) and existing authentication-error timestamps. Accounts without any previous heartbeat are waiting for setup, not reported as disconnected. Notifications contain a masked account suffix only.
- Subscription reminders use existing active, started, non-deleted subscriptions and real expiry timestamps. An already-paid active future renewal that covers the old expiry suppresses reminders for that old term.
- Payment observations cover local status/provider changes. Existing payment-submitted/approved/rejected hooks record immediately; Stripe webhook/reconciliation outcomes record failed/expired sessions transactionally. Settled historical payments are baselined instead of replayed on worker startup. A payment/activation's existing separate messages remain in the shared history.

The observer starts after backend schema readiness, runs every 30 seconds without overlapping itself, and stops/drains during graceful shutdown. Each sweep handles at most 100 users with a three-second budget checked between users; a cursor continues on the next sweep. Each user's source queries are bounded to 200 entities, with recent payments ordered by update time. At larger volumes, revisit batch sizes/latency and per-user cardinality before expanding these limits. Archived users are excluded.

Durable state suppresses repeated messages across polls, deletion of notification history and backend restarts. PostgreSQL uses transaction-scoped per-user advisory locks across workers; SQLite uses the existing serialized transaction queue. Enabling preferences and observation serialize on the same lock. Periodic page polling pauses while hidden and avoids replacing a list while the user is reading further down or focusing an item.

## Database and rollout

Apply additive **`migrations/postgres/0020_notification_center.sql`** before deploying the matching backend. It adds `notification_preferences`, `notification_alert_state` and `user_notification_details`, reusing the existing `user_notifications` table. No old records or operational tables are removed. SQLite applies the equivalent idempotent migration automatically through subscription readiness.

Deploy matching `notification-center.js`, subscription/Stripe/server integration, dashboard HTML/JS, `notifications.js`, `notifications.css`, IIS asset rules and service worker v30. No new environment secret or external service is required.

The authorized Windows rollout helper is `marketing/deploy-notification-center.ps1 -Apply`. It verifies the production Git baseline, protects a file/database backup outside the web root, applies only migration 0020 in a transaction, copies an explicit runtime allowlist and restarts `CornGridWeb` only. It checks existing terminal PIDs, authenticated read APIs and anonymous access rejection. The companion `deploy-notification-center.cjs public` checks gateway/public assets. Rollback restores the backed-up files while retaining additive schema and notification history; it never restores the live database automatically or changes existing keys.

## API

All routes require the existing user authentication, restrict ownership to the authenticated user, use private/no-store responses, retain cookie same-origin/CSRF enforcement and apply the server's rate limiter.

| Route | Purpose |
| --- | --- |
| `GET /api/notifications` | Newest first; `limit` 1–100, optional `before` ID, `category`, `unread=1`; global unread count and next cursor |
| `GET /api/notifications/preferences` | Own preferences and `delivery: in_app` |
| `PATCH /api/notifications/preferences` | Boolean category fields and/or integer `expiry_days`; unknown fields rejected |
| `POST /api/notifications/read` | Mark own notifications read |
| `POST /api/notifications/:id/read` | Mark one own notification read |
| `DELETE /api/notifications/:id` | Delete one own notification |
| `DELETE /api/notifications` | Clear own history while retaining deduplication state |

## Verification

- `node --test test/notification-center.test.js` covers outage episodes/recovery, intentional stops, waiting accounts, preferences, expiry bands/renewal, payment changes, Stripe failure deduplication, owner access, CSRF, validation, pagination and unread counts.
- `node test/helpers/run-isolated-postgres.cjs` creates its own disposable cluster and also runs `notifications-postgres.test.js`: migration replay, cross-pool deduplication/preferences and rollback. It does not load production `.env`.
- `npm run test:notifications:browser` uses an in-memory loopback fixture with real notification APIs and the actual dashboard navigation. Tests desktop 1440px, mobile 375px, English settings despite a saved Malay marketing preference, saved preferences after reload, read/clear/cancel operations and viewport overflow. Install Playwright Chromium for CI or set `PLAYWRIGHT_BROWSER_CHANNEL=chrome` to use an installed Chrome locally.
- `npm test` retains the existing payment, MT5, licensing, sandbox, authentication and account archive regressions. Hosted CI includes the PostgreSQL and notification browser checks when pushed/enabled.
