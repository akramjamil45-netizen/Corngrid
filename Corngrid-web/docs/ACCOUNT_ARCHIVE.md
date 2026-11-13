# Account archive

Users can now submit an account closure request in Settings → Profile, with
administrator approval in Account requests. See [ACCOUNT_DELETION_REQUESTS.md](ACCOUNT_DELETION_REQUESTS.md).
The approval calls this same archive mechanism and retains its existing behavior.

Admin Archive replaces permanent account deletion. The legacy
`DELETE /api/admin/users/:userId` endpoint also archives, protecting old clients
from cascading deletion. New actions:

- `POST /api/admin/users/:userId/archive` with exact `confirmUsername` and optional reason.
- `DELETE /api/admin/users/:userId/archive` to restore, with the same confirmation.
- `/api/admin/overview?accountState=all|active|archived` filters the directory.

The user row is never deleted. An `account_archives` marker blocks normal user
login and every protected user API. Both archive and restore increment the existing
`user_auth_versions` counter, so old tokens cannot become usable again on restore.
An existing suspension is preserved and still applies after restore. Transitions
are transactional, serialized on the user row, and logged to `account_archive_events`.
Repeated archive requests are idempotent. No archive state is applied automatically
to any real user during deployment.

Published partner profiles/strategies retain their status and ownership. EA source,
versions, presets, review reports, subscriptions, Stripe references, commission and
payout records, user agreements and customer sandbox references remain intact. The
existing strategy/preset authorization continues to allow customer use. Archive
does not revoke a published EA or switch a partner to Suspended.

Archive is an account-access action, not an automatic trading stop, subscription
cancellation, commission forfeiture, public-content removal or personal-data erasure.
Existing installations/agents and customer strategies are not stopped, trades are
not closed, and account sharing/public-content settings remain recorded. Use the
separate controls for those outcomes. Data legitimately deleted before this change
is not reconstructed; recovery of historical deletions requires an appropriate backup.

Apply `migrations/postgres/0010_account_archives.sql` **before** deploying the new
authentication code. SQLite initializes the additive schema automatically. Missing
archive schema fails closed. Old databases without the email-verification column
still get the archive check when using the legacy verification fallback.

The admin directory shows an Archived badge, archive count and Restore account
button. Admin access to historical trading and agreement data is retained.

Tests cover legacy Delete becoming Archive, authorization, exact name confirmation,
archive filtering, data/preset/customer preservation, login and token rejection,
duplicate archive, restored accounts and preservation of a pre-existing suspension.
