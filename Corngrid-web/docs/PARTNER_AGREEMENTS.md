# Partner terms and digital acceptance

Operator name: **CornGrid**, as instructed by the operator. No company registration
number or address has been invented. Contact: support@corngrid.com. The bilingual
terms in `partner/partner-terms.js` are a programme agreement draft; the operator
should obtain jurisdiction-specific legal review, including its legal identity,
commission arrangements, privacy/retention process and mandatory rights.

Version `2026-11-11.1` contains 19 sections covering eligibility, approval,
submissions, IP ownership/limited hosting licence, third-party components, security,
testing/infrastructure, trading risks/marketing, commission eligibility/calculation,
payouts/taxes, refunds/disputes, support, confidentiality/data, termination,
responsibility, changes and Malaysian law/dispute resolution. No invented commission
rate, payout schedule, minimum earnings or blanket forfeiture is introduced.

## Acceptance

The existing authenticated partner registration flow opens a native accessible
dialog. The user chooses BM/English, reviews the full text, enters their full name
and checks two initially empty boxes (terms + age/authority). Cancel/Escape does not
register anything. The server rejects missing/false consent, missing authority,
invalid signer names and stale version/hash. A selected checkbox is not a verified
identity certificate; this is authenticated electronic clickwrap acceptance, not
a certified digital signature or a guarantee of enforceability.

Application and receipt database insertion share a transaction and a per-user write
lock. Pending submission retries reuse the linked receipt rather than creating
duplicates. Rejected resubmissions receive a new receipt, preserving the old one.
Partner approval still requires an administrator; agreement acceptance grants no
extra account access. Existing applications/profiles are not backfilled or falsely
marked as accepted. Admin displays the legacy absence explicitly.

## Private files and access

Authoritative rows are in `partner_agreements`; `partner_applications.agreement_id`
links the acceptance submitted with the application. Each receipt is also stored at:

`Corngrid-web/storage/user-agreements/<user-id>/<receipt-uuid>.json`

This is outside public static directories and excluded from Git. Receipt includes
account ID/email/username, typed signer name, supplied application organisation,
language, full bilingual terms, terms SHA256, server UTC time, IP, browser information
and explicit acceptance/authority flags. No password, MT5 secret, bank details or IC
number is collected. A separate receipt SHA256 checks the original JSON bytes.
Hashes provide integrity checking against the database copy; they are not external
notarisation or protection against an attacker who can rewrite both DB and files.

Files are written privately via temporary-file rename before application commit.
File failure rolls back registration and the DB receipt. Missing/corrupt file copies
can be restored from the hash-checked authoritative DB record on authorised export.
A process crash/commit failure can leave an unreferenced private file: administrators
should reconcile file IDs against DB IDs when maintaining storage; never treat an
unreferenced file as an approved application. Back up DB **and** this directory.

User endpoints: `GET /api/partner/terms`, `/api/partner/agreements`, and
`/api/partner/agreements/:id/file` (owner only).
Admin endpoints: `GET /api/admin/partner-agreements?userId=...`,
`/api/admin/partner-agreements/:id/file`, and
`/api/admin/partner-applications/:userId/agreement` (linked application receipt).
Admin → User Agreements lists up to the latest 200 records; optional userId filter
is available in the API. Downloads are private/no-store and require authentication.

### Review and readable TXT copies

Admin → User Agreements provides **Review** and **Download TXT**. Review displays
the same text as the download in a scrollable dialog; **Original JSON** remains
available inside the dialog. Both user-owned and admin receipt endpoints support
`?format=txt` (including the linked-application admin endpoint). The default format
remains the original JSON. TXT uses UTF-8, CRLF line endings and an attachment name
`CornGrid-Partner-Agreement-<agreement-id>.txt`.

The readable copy includes recorded signer/account details, acceptance time in UTC,
consent flags, recorded technical evidence and the full saved bilingual terms, with
the selected language first. It verifies the receipt and terms hashes before export
and uses the accepted snapshot, never the current terms document. The source JSON,
its hashes and database records are unchanged. Hashes printed in the text refer to
the original JSON and terms, not the generated TXT bytes. No migration is needed.

Deleting a rejected application does not delete its acceptance history. Agreement
rows intentionally have no cascading user deletion: access/erasure/retention requests
must be reviewed for contractual, claims and legal requirements rather than retaining
personal data indefinitely or destroying evidence automatically. Handle corrections
through support/audit records, without overwriting the accepted snapshot. Restrict
filesystem/DB access to the service account and authorised operators. Define and
operate the retention review process described in the terms; no automatic purge or
fixed statutory retention period is assumed by this feature.

## Migration and updates

Apply `migrations/postgres/0009_partner_agreements.sql` before production deployment.
It only adds a receipt table/index and a nullable application link. SQLite creates
its table and checks PRAGMA table_info before adding the link. Keep old receipt
rows/files when publishing a new terms version. Bump the version when changing
wording; the deterministic full-document SHA256 makes stale forms fail closed.
This release requires consent for new partner applications, not automatic suspension
of existing partners; a future general re-consent rollout needs an explicit policy
and corresponding existing-partner flow.

## Validation

Partner API tests exercise required/current consent, ownership/admin boundaries,
concurrent retry deduplication, old-receipt preservation after rejected resubmission
and transaction rollback on filesystem failure. Browser checks cover 320, 390, 768
and 1440px, cancellation without submission, full 19-section rendering, two unchecked
boxes, typed name and BM acceptance payload. Existing partner, commission, payout,
EA review and preset tests remain enabled.

Reference material consulted (not a claim of certified legal compliance):
- Malaysian Electronic Commerce Act 2006, Act 658: https://lom.agc.gov.my/ilims/upload/portal/akta/LOM/EN/Act%20658.pdf
- JPDP privacy principles: https://www.pdp.gov.my/en/principles-of-personal-data-protection/
