# One-time free subscription promotions

## Administrator setup

1. Open **Admin → Subscriptions → Subscription Plans → Add Plan**.
2. Select **Free promotional plan**. This sets the price to zero, duration to
   **7 days**, and maximum EA activations to **1**.
3. Enter the name and description. Adjust duration (1–3650 days) and maximum
   activations (1–100) as required, then select **Create Plan**.
4. Active promotions appear alongside paid plans in the user's Subscription page.
   Use **Edit** to change terms or **Deactivate** to stop new claims.

No promotional offer is seeded automatically. Existing paid plans remain paid
unless an administrator explicitly changes them to promotional plans.

## User claim and entitlement

Select **Claim free access** on the Subscription page. There is no Stripe/DuitNow
checkout, payment proof, payment record, or payment approval step. A successful
claim creates a normal active subscription period with a zero purchase price.
Existing licence, MT5 account activation, expiry, and Sandbox entitlement checks
still apply; a claim does not automatically start a trading session.

The limit is **one promotion per user account in total**, across all promotional
plans. Editing, deactivating, reactivating, or recreating an offer does not reset
eligibility. Expiry and subscription record removal do not reset it either.
Archived/restored accounts retain their original user ID and claim history.
This is a per-account limit; it does not identify people who create new accounts.

Users with existing active subscriptions can claim once: the promotional period
is scheduled after the latest existing active subscription period, including
scheduled renewals. Existing paid periods and their activation limits are
preserved. Suspended subscriptions and subscriptions without an expiry require
support review before claiming. An unsuccessful claim does not consume eligibility.

Terms are snapshotted when claimed. Subsequent plan edits affect future claims,
not previously granted periods. Admin plan cards show promotional claim counts.

## Storage, API, and concurrency

- `subscription_plan_promotions` marks which existing plan records are free offers.
- `subscription_promotion_claims` keeps the original plan name, duration,
  activation limit, and dates. Its primary key is `user_id`.
- `POST /api/subscription/promotions/claim` accepts `{ "planId": 123 }` and requires
  the existing authenticated user session and CSRF protections. Ownership and
  entitlement terms come from the server, not the request body.
- `GET /api/subscription/plans` includes `isPromotion`, `promotionClaimed`, and
  the user's original `promotionClaim` summary.
- Existing admin plan POST/PUT endpoints accept the boolean `is_promotion`.
  They enforce a zero price for promotional plans.
- The ordinary `/api/subscription/subscribe` payment endpoint rejects promotions.

Claims serialize on the same user lock used by paid activation. SQLite uses the
shared transaction queue; PostgreSQL locks the user row across workers. The
subscription, unique claim record, and audit entry commit together or roll back
together. A used plan cannot be deleted through admin plan deletion; deactivate
it instead. The claim snapshot survives direct deletion of a linked subscription
or plan through nullable foreign keys.

## Installation and rollback

PostgreSQL: apply `migrations/postgres/0021_subscription_promotions.sql` using the
existing migration runner **before** starting the updated backend:

```powershell
npm.cmd run migrate:postgres:schema
```

Use the deployment's existing environment/database configuration. The migration
is additive and idempotent. SQLite creates the equivalent schema during
subscription API initialization; its SQL is also in
`migrations/sqlite/0021_subscription_promotions.sql`.

For an application rollback, first deactivate free offers, then restore the
previous application. Preserve both promotion tables and all granted
subscriptions. Dropping the claim ledger would reset eligibility and must not
be part of routine rollback. No production data is changed by the tests below.

## Verification

```powershell
node --test test/subscription-promotions.test.js test/subscription-api.test.js
node test/helpers/run-isolated-postgres.cjs
$env:PLAYWRIGHT_BROWSER_CHANNEL='chrome'
node scripts/check-promotions-browser.js
```

The PostgreSQL harness starts its own disposable loopback cluster and schema;
it does not load the production environment. UI acceptance serves actual admin
and dashboard assets with deterministic API responses. Backend tests separately
exercise real authentication, SQL, concurrent claims, immutable history,
paid-period scheduling, failure rollback, and licence expiry/activation limits.
