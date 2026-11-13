# Stripe card checkout

This adds hosted, one-time card payments to existing `subscription_payments` and
`user_subscriptions`. DuitNow remains the default and retains manual approval.
No card numbers/CVC are collected or stored by CornGrid. No recurring billing.

## Local setup (test mode only)

For this repository, `.env` may reference the production database. Use
`node scripts/start-stripe-test.js` for an isolated local launch on port 3001.
It accepts only `sk_test_`/`rk_test_`, binds to loopback, clears inherited production
configuration and uses `storage/stripe-test/database.sqlite`. Its database starts
empty; production users/plans are not copied. Forward Stripe CLI to port 3001
when using this runner. Use a test account/sandbox signing secret, never live keys.

1. Run `npm ci` in `Corngrid-web` (Node >=20.17). Stripe SDK is locked in package-lock.
2. Apply `migrations/postgres/0008_stripe.sql` to a **development** PostgreSQL database
   after existing migrations. SQLite automatically creates these additive tables;
   the same SQL is in `migrations/sqlite/0008_stripe.sql`. Do not point tests at production.
3. Set backend `.env`: `STRIPE_SECRET_KEY=sk_test_...`,
   `APP_BASE_URL=http://localhost:3000`. Base URL must be an origin, without path,
   credentials, query or fragment; HTTPS is required except localhost.
4. Install/authenticate Stripe CLI and run:

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to localhost:3000/api/stripe/webhook
```

5. Put the CLI's signing secret in `STRIPE_WEBHOOK_SECRET`, then start/restart the
   development server. No frontend publishable key is needed. With incomplete
   configuration the card option stays disabled; DuitNow remains available.
6. Sign in, choose a subscription plan, select Card / Stripe and review the package,
   amount and currency. The server uses the existing payment snapshot, never client
   prices/durations. Test with Stripe's `4242 4242 4242 4242`, future expiry and any
   test CVC, **only inside Stripe test Checkout**. Decline card: `4000 0000 0000 0002`.

## Webhooks, routing and security

Dashboard endpoint: `https://YOUR_HOST/api/stripe/webhook`. Register the eight
events in the CLI command above, for your own account. Use snapshot events.
The webhook route is registered before Express JSON parsing and verifies the raw
body with the official SDK. IIS's existing `/api/*` proxy covers it; Cloudflare must
not challenge/cache this POST or change its bytes. The new `stripe-checkout.js`
is included in the root IIS proxy allowlist. API endpoints stay cookie authenticated;
checkout POSTs reject foreign Origin headers and are limited to 10/user/minute.

Success/cancel are existing dashboard routes:
`/dashboard.html?stripe=success&order=ID#subscription` and `stripe=cancel`.
Both are read-only. Success polls at most 12 times, then offers an explicit retry.
Order status is restricted to its owner. Never activate on redirect.

`stripe_orders` has one order per existing payment and unique Session/PaymentIntent.
The UUID is the Stripe idempotency key and metadata reference. Ambiguous network
failures retry the **same order**, up to 23 hours; after that reconcile with Stripe
before creating another purchase. This prevents reuse after Stripe's idempotency
retention window. Local order creation precedes the external API call.

Verified events retrieve the Session from Stripe, compare metadata, session, amount,
currency, mode and paid status, then use one database transaction for the event
ledger, payment approval, existing shared activation, notifications and fulfillment
marker. Unique event IDs and user/payment row locks prevent duplicate extensions
across processes. Existing account activation limits/licensing are unchanged.
Active renewals extend current expiry; lapsed renewals start at payment-event time.
Existing partner approval listeners are called after commit; as with manual approval,
listener failure is logged, not a reason to roll back entitlement. Review failed
commission delivery operationally; this integration does not add an outbox.

An open card Session blocks manual proof, approval and local cancellation. To select
DuitNow, the backend first expires the Session. Completed/processing payments cannot
be switched. Cancel redirects never change payment state. Refund/dispute events
are recorded in `review_status` for admin review and do not revoke access automatically.
The admin payment table shows provider, reference, amount, payment and activation
status. The authenticated `/api/admin/stripe-orders` exposes reconciliation IDs/times.

Supported two-decimal plan currencies: MYR, USD, EUR, GBP, SGD, AUD, CAD. Other
currencies fail closed until their Stripe currency exponent/minimum is implemented.
No conversion. International card acceptance depends on your Stripe account,
country eligibility, enabled card networks and issuer authorization.

The current Stripe API manages payment methods in Dashboard and rejects the old
`payment_method_types` Checkout create parameter. Enable cards in Dashboard; optional
`STRIPE_PAYMENT_METHOD_CONFIGURATION=pmc_...` selects a dedicated configuration.
The verified sandbox default offered Card and Link; disable Link or other methods
in the selected Dashboard configuration if only direct card entry is wanted.

## Validation and release checklist

Run `npm test`. `test/stripe-payments.test.js` uses the actual SDK's signed payload
verification and a fake Checkout transport. It covers authentication/ownership,
tampered amount/currency, pending/failure/expiry, forged signatures, manual-success
status reads, duplicate/concurrent/different events, renewal and DuitNow approval.
`subscription-api.test.js` checks existing licensing and activation limits.

Verified on 2026-11-11 using the actual Stripe Sandbox: MYR 10 Checkout creation,
hosted payment form, test-card decline without activation, successful test-card
payment, CLI-forwarded real webhook HTTP 200, approved payment, active subscription,
and the success-page confirmation. Three concurrent signed replays of the actual
event returned 200 without changing activation/expiry; an invalid signature returned
400. All data was in `storage/stripe-test/database.sqlite`, never production.

Still untested: 3DS challenge, PostgreSQL integration against a dedicated test
instance, and deployed IIS/Cloudflare delivery. Complete these before release.
`stripe trigger checkout.session.completed` alone is not a valid CornGrid payment:
it lacks the real local order metadata. Complete a Checkout created by CornGrid.

For live rollout **after review and authorization**: apply migrations with backups,
use live account keys and a separately registered live webhook/signing secret,
set the real HTTPS APP_BASE_URL, enable eligible card methods in Stripe, and verify
webhook delivery. Test and live IDs/secrets must not be mixed.

The user subsequently authorized live deployment on 2026-11-11. The additive
PostgreSQL migration, runtime files/dependencies and live configuration were applied
to `C:\Website\Website`, with backups outside the web root. Service/readiness and
public assets returned 200; a locally signed unsupported deployment-check event
returned 200 through IIS/Cloudflare, and an invalid signature returned 400. This
checks raw-body/signature routing, not a real Stripe-originated live payment.
Read-only Stripe checks confirmed the registered live webhook and active card
capability. No live Checkout, order or charge was created during deployment.
Reusable helpers: `marketing/deploy-stripe-live.cjs` and
`marketing/verify-stripe-live.cjs`. The former requires explicit live authorization;
it preserves other production environment settings and only adds Stripe tables.

Official references checked for this implementation:
- https://docs.stripe.com/checkout/fulfillment
- https://docs.stripe.com/webhooks/signature
- https://docs.stripe.com/api/checkout/sessions/create
- https://github.com/stripe/stripe-node
- https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods

Local test tools: `scripts/start-stripe-test.js`, `scripts/stripe-test-smoke.js`,
`scripts/start-stripe-webhook-test.js`, and `scripts/stripe-test-replay.js`.
The webhook launcher expects the official CLI at `storage/stripe-test/cli/stripe.exe`.
It reads the test key from `.env` into the child environment, masks the CLI signing
secret and saves it only in ignored local storage. Restart the isolated server
after the CLI is ready; the runner reads that local secret without changing `.env`.
`storage/stripe-test/local-test-login.json` contains the generated local-only login.

Closed payment requests: apply `0012_payment_request_archives.sql` before deploying
the updated subscription API on PostgreSQL (SQLite creates the additive table on
startup). Admin Delete removes cancelled/rejected requests from Payment Requests
using an archive marker, preserving the original payment, proof, Stripe order and
event records for reconciliation. For an unresolved order with a saved session,
Delete checks Stripe metadata, amount, currency, mode and PaymentIntent state.
An open, unpaid Checkout is expired using an idempotency key, then retrieved
again. Only a verified expired, unpaid session can clear the local pending state.
Paid, activated, processing or mismatched orders remain protected. No charge is
created, refunded or cancelled by this operation.

Stripe requests run outside database locks. The final transaction locks the user
and payment, rechecks payment/order state and the reconciliation proof, then
stores the expired order, archive marker and audit together. Repeated or concurrent
Delete requests cannot duplicate removal. A remote expiration followed by a local
write failure is safe to retry. Delayed webhooks still resolve the retained order.
Missing session IDs and provider failures remain blocked rather than assuming
no payment exists. No existing record is archived by deployment itself.

References: [Expire Checkout](https://docs.stripe.com/api/checkout/sessions/expire)
and [Checkout PaymentIntent cancellation rules](https://docs.stripe.com/api/payment_intents/cancel).
Tests: `test/stripe-removal.test.js`, `test/payment-request-removal.test.js` and
`test/stripe-payments.test.js`. `marketing/verify-payment-removal-postgres.cjs`
checks concurrent removal with a mocked Stripe API in an isolated PostgreSQL
schema. Live inspection is read-only; no live checkout is expired by the tests.

## Recovery when webhook delivery is delayed or missed

Apply the additive `0013_stripe_reconciliation.sql` migration before deploying
the updated backend. SQLite applies its equivalent during Stripe initialization.
No existing order, payment, subscription or expiry is rewritten by migration.

Webhooks remain the primary fulfillment path. The server also starts a recovery
scan five seconds after startup, then every minute after each scan finishes.
Each batch checks at most 20 pending orders, with at most two Stripe requests in
flight. It only selects Stripe purchases that are still pending locally, have a
saved Checkout Session and have not been archived or removed. It runs even when
the customer never returns to CornGrid after paying.

The worker retrieves the existing Session with `payment_intent.latest_charge`
expanded. Fulfillment requires `complete` + `paid`, a succeeded PaymentIntent,
a matching paid Charge, matching owner/order/payment metadata, amount, currency
and live/test mode. The verified Charge creation timestamp supplies the payment
time. Refunded/disputed payments are retained for review, not automatically granted
or revoked. Restricted keys need read access to Sessions, PaymentIntents and
Charges; missing permissions produce a retriable verification error.

Webhook fulfillment and API recovery use the same transaction, user/payment locks,
subscription activation function and order activation marker. No synthetic Stripe
event is created by recovery. A successful recovery creates a
`stripe_payment_reconciled` audit record. A late or duplicate webhook cannot extend
the subscription twice. Existing duration, renewal and MT5 activation limits apply.

`stripe_reconciliation` stores the next check, attempt count, last error and a
two-minute lease with a unique token. Leases prevent simultaneous workers from
checking the same order; expired leases recover after a crash. Pending/provider
failures back off from one minute to a maximum of 15 minutes. State survives service
restart. A provider outage can still delay activation; the request stays pending
and is retried rather than being marked paid without proof.

Authenticated owners may POST
`/api/subscription/stripe/orders/:id/reconcile`. Ownership is checked before Stripe
is contacted. Origin validation, a 30-request/minute per-user limit, shared leases
and a 10-second check cooldown bound polling. The success/cancel page uses this
endpoint, and reopening a pending Stripe purchase triggers one quiet check.
Opening a URL by itself never grants access. The user must still have a real,
verified successful Stripe payment. Polling stops after 12 attempts; manual retry
and server recovery remain available. The subscription overview includes the
payment provider so reopening the page preserves the correct payment method.

Admin `/api/admin/stripe-orders` includes `last_checked_at`, `last_error_code` and
`next_check_at` for diagnosis. Secrets and complete provider payloads are not logged.
There is no auto-renewal, charge creation or refund action in the recovery worker.

Validation: `test/stripe-reconciliation.test.js` covers lost webhooks, owner isolation,
unpaid/processing/mismatched proofs, rollback, retries, restart, abandoned leases,
renewals, scheduler startup and concurrent webhook/API recovery.
`marketing/verify-stripe-recovery-postgres.cjs` runs two recovery processes and a
signed webhook against a temporary schema with a mocked Stripe API.
`marketing/preview-stripe-recovery.cjs` provides an isolated browser fixture.

The implementation follows Stripe's [server-side fulfillment guidance](https://docs.stripe.com/checkout/fulfillment):
verify the Session through Stripe and make the shared fulfillment function safe
for repeated and concurrent calls, including from the landing page.
