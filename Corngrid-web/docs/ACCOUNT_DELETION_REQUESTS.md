# User-requested account closure

Users open **Settings → Profile → Account closure**, type their current display
name exactly and confirm that approval archives the account. A reason is optional.
Submitting creates one pending request; it does not archive, log out, suspend,
stop trading or change any subscription immediately. Users can cancel while the
request is pending. An admin must make the final decision.

**Admin → Account requests** displays the user, email, current/requested display
names, reason, timestamp and status. A sidebar badge shows the pending count.
Filter pending, approved, rejected, cancelled or all records; lists are paginated.
The UI refreshes visible status/badges every 30 seconds and offers manual refresh.

**Approve & archive** requires the user's current display name again. Approval
uses the existing account archive service: account access is blocked and the
existing authentication version is incremented, invalidating old user sessions.
The user row, EA publication, presets, partner ownership, customer references,
subscriptions, financial records, agreements and running terminals are retained.
This is account closure through archive; it is not permanent personal-data erasure
or an automatic trading stop/subscription cancellation. Separate controls remain
responsible for those operations. The profile UI explains this before submission.

Reject requires a reason, which the user can see. Cancellation/rejection keeps
account access unchanged and allows a new request. Archive restoration remains
the existing explicit admin action; approval history remains recorded. Replaying
an old approved request after restoration never re-archives the restored account.

## Storage and safety

Apply additive PostgreSQL migration `0017_account_deletion_requests.sql` before
deploying the backend. SQLite applies the equivalent at startup. No new environment
variables are needed. Startup waits for request/archive schema readiness.

- `account_deletion_requests`: UUID, user foreign key, submitted display name,
  status, reason, timestamps, reviewer and note.
- `account_deletion_request_events`: append-only application audit of submission,
  cancellation and decisions. Existing `account_archive_events` records access changes.
- A partial unique index enforces one pending request per user. Retries return
  the same pending record; row locks serialize duplicate requests and review/cancel races.
- Approval, archive marker, session revocation and both audits share one transaction.
  Audit failure rolls everything back. The archive's internal transaction body is
  reused rather than opening a nested SQLite transaction.
- Request ownership always comes from authenticated user identity. Frontend owner,
  status or admin flags cannot select another account or approve a request.
- The normal user/admin authentication, archived/suspended/verified checks,
  cookie CSRF rules, parameterized SQL and mutation rate limits remain in force.
- Reasons/review notes are bounded plain text, escaped when rendered. No password,
  broker credential, bank detail or external message is required for this feature.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/user/account-deletion-request` | Current user's latest request and current display name |
| POST | `/api/user/account-deletion-request` | `{confirmUsername, confirm:true, reason?}`; create/reuse pending request |
| DELETE | `/api/user/account-deletion-request/:id` | Cancel an owned pending request |
| GET | `/api/admin/account-deletion-requests?status=pending&page=1` | Admin list, pending count and pagination |
| POST | `/api/admin/account-deletion-requests/:id/approve` | `{confirmUsername, note?}`; approve and archive atomically |
| POST | `/api/admin/account-deletion-requests/:id/reject` | `{note}`; reject with a reason of 5–1000 characters |

Shared UI assets are `public/account-requests.js` and `.css`; both IIS proxy
allowlists and the service worker must include them. Admin routing remains
`/admin.html#account-requests`; user access uses the existing Settings page.

## Verification and rollback

`test/account-deletion.test.js` covers approval/login revocation, duplicate
submissions, ownership/CSRF/admin checks, cancellation/rejection, review races,
audit rollback and restored-account replay. Existing account archive tests verify
real partner EA/preset/customer/ledger preservation.

`marketing/verify-account-deletion-postgres.cjs` uses two independent pools in a
random temporary schema to check the actual PostgreSQL migration, concurrency,
archive/session atomicity and audit rollback. Production accounts are never
modified by this check. `marketing/preview-account-deletion.cjs` runs the real UI
against an isolated in-memory database.

To roll back code, restore the deployment backup and restart CornGridWeb; retain
the additive request tables as audit evidence. An optional schema-removal script
is provided only for deliberate removal after backing up that evidence. It does
not restore archived accounts; restoration is still an explicit admin operation.
