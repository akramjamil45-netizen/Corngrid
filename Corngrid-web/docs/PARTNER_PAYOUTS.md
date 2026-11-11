# Partner payout requests

Partners save a bank name, account holder and account number in Dashboard → Partner Program → Bank details, confirm ownership, then submit an amount from Request payout. Only approved, unpaid MYR commissions are eligible. The page shows available funds, funds awaiting payment and the minimum payout. One request may await payment at a time.

Admin opens Commissions → Payouts → Review & pay. The dialog retrieves the recipient account captured when the request was made. Admin transfers the exact amount externally, enters the bank reference, checks the completed-transfer confirmation, then selects **Approve & record payment**. The website records the payment; it does not initiate a bank transfer. Admin may instead reject with a reason.

On confirmation, payout status, timestamps, transfer reference, allocations, commission status and audit records commit in one database transaction. Payment history refreshes after the operation; partners can refresh manually and active partner pages refresh every 30 seconds. Rejected requests release their reservations and show the rejection reason. Paid and rejected records cannot be changed into another status. Repeating the same request or payment confirmation does not create a second payment.

## Storage and balance rules

- Bank details remain AES-256-GCM encrypted using the existing sandbox encryption key in `partner_profiles.payout_details_cipher`. Account numbers are masked on normal responses. Only the authenticated admin recipient endpoint returns a complete account number; access is audited and the response uses `Cache-Control: no-store`.
- `partner_payout_details` stores the encrypted recipient snapshot, idempotency key and rejection reason. Changing the profile cannot change an existing request's destination.
- `partner_payout_allocations` records integer cents allocated to each commission. Pending, approved and paid payouts consume those allocations. Rejected payouts do not. A partially paid commission stays approved until paid allocations cover its full amount.
- Existing `partner_payout_transactions` links are preserved and excluded from available balances while active or paid. No legacy records are rewritten by the migration.
- Current commission rules determine the request minimum. For available earnings spanning several strategies, the highest of their resolved minimum thresholds applies. Existing manual admin recording remains available and uses the same reservation/partial-settlement rules, with a required transfer reference. Repeating a paid reference for the same partner and amount returns the existing record.
- PostgreSQL locks the partner profile during financial changes; SQLite uses the existing exclusive write queue and `BEGIN IMMEDIATE`. A partial unique index also permits at most one pending/approved payout per partner.

## Deployment

Apply `migrations/postgres/0011_partner_payout_requests.sql` before restarting a PostgreSQL backend. SQLite self-applies its equivalent on first payout access. Deploy `partner/partner-payouts.js` with the updated partner composer, commission service, APIs, dashboard/admin HTML and scripts, and `public/partner-payouts.css`. No dependency installation or rate changes are needed. Preserve `SANDBOX_ENCRYPTION_KEY` across restarts.

If old data contains more than one pending/approved payout for a partner, review those records before applying the unique index; deployment must not silently remove or settle them.

Validation: `node --test test/partner-api.test.js test/partner-presets.test.js test/security-regressions.test.js`. The payout cases cover encryption, access control, snapshots, thresholds, currency, concurrent requests, repeated approval, partial settlement, rejection, and rollback when persistence fails. `marketing/preview-partner-payouts.cjs` provides an isolated in-memory browser preview with fake earnings.
