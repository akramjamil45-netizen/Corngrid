# Partner EA release publication

## User flow

1. Approved partner opens **Partner Program → Submit EA**. Upload one `.ex5`
   executable, optionally `.mq5`/`.mqh` source or ZIP project, and at least one
   instrument preset `.set`. Each declared pair must have its own preset.
   Submitting creates a private Marketplace listing in `pending_review`.
2. Alternatively open **My EA listings**, save metadata and images, then upload
   EA and preset files under **EA & preset files for review** and submit. This
   updates the existing listing rather than creating another operational strategy.
3. Admin opens **EA Submissions → View** or **Marketplace → Edit**. Review the
   exact executable, source scan, listing text/images and preset contents. The
   review screen exposes a private EX5 download, SHA-256 and preset text.
4. Admin selects **Approve & publish**. One transaction records approval,
   publishes the operational EX5/presets, links the stable `trading_strategies.id`,
   and sets the listing `published` / infrastructure `available`. A rejected
   release stays private and shows the rejection reason to its partner.
5. Users see it in Marketplace when the global feature is ON, and in the existing
   Sandbox strategy selector. Deployment still requires an eligible subscription,
   remaining shared license/sandbox allowance, broker credentials and node capacity.
   Publication never creates a terminal or claims a broker connection.

Marketplace's existing global switch is preserved. Partner Program submissions
and admin review remain available while Marketplace is OFF. The switch controls
Marketplace browsing and APIs; it does not stop Sandbox or existing trading EAs.

## Source-only releases

An MQ5/ZIP upload is accepted for review, but cannot be published without a
reviewed compiled EX5. Choose the main MQ5 filename when uploading several MQ5s.
Admin can either upload a separately compiled, reviewed `.ex5` on the EA review
screen, or select **Start review → Compile on test node** for a flat MQ5 project.
After a failed compile, stage a manually reviewed EX5 and select **Resume review**
before approving, or retry compilation on the test node. Failed reports remain
in the audit history; they are never rewritten as successful runtime tests.
ZIP projects are retained privately for manual review; they are never extracted
or executed by the website.

Automatic compilation requires an online node marked `is_test_node`, with
MetaEditor (`metaeditor64.exe`) in its configured MT5 base directory. Update the
test-node agent's `agent/ea-tester.js`, `agent/source-compiler.js` and
`agent/transport.js` together. Do not use a node hosting real customer terminals
for review. The compile agent uses `execFile` arguments, finite timeouts and
bounded paths, uploads the exact generated EX5 before deleting its temporary
directory, and requires the server to acknowledge it. Missing compiler, missing
output or failed transfer produces failure. These reports validate compilation
and transfer only; they do **not** claim runtime trading, safety or profitability.
Admin must perform appropriate executable/runtime review before approval.

MetaEditor reference: [compilation](https://www.metatrader5.com/en/metaeditor/help/development/compile).

## Integrity, idempotency and storage

- Migration `0016_partner_publication.sql` is additive for PostgreSQL and SQLite.
  It adds `ea_submission_links`, `ea_submission_artifacts` and
  `ea_release_approvals`, with unique submission/version/request-key/current-listing
  constraints. Existing published EAs and subscriptions are unchanged.
- Uploads accept at most 20 files, 10 MB each and 20 MB total. Presets are limited
  to 128 KB, decoded/validated by the existing preset service, for the currently
  supported XAUUSD, EURUSD, GBPUSD and USDJPY pairs. EX5 validation checks marker
  and bounds only; administrator approval remains mandatory.
- Files stay under private `storage/ea-submissions`; authenticated owners/admins
  and assigned test nodes have different restricted routes. No public executable
  upload or static source download is introduced.
- Review binds listing revision, media hashes, every source file, exact preset
  text and executable SHA-256. Any change invalidates approval. A file-only update
  also increments the listing revision. Resubmit and review the new release.
- A UUID `requestKey` identifies retries of an upload. Same key/payload returns
  the existing submission; different payload returns 409. Two admin entrypoints
  share the same approval service and row locks, preventing duplicate publication.
- Publication copies the verified bytes to immutable
  `storage/ea-releases/<submission-uid>/<sha256>.ex5`, then commits database state,
  approval and audit together. A failed transaction can leave an unreferenced
  private release file; retry safely verifies and reuses identical bytes.
- New approved versions update the same strategy ID/code. No restart, stop,
  reconfiguration, deletion or new command is sent to running EAs. Existing
  terminals retain their deployed files; later deployments use the new release.
- Source/artifact/strategy storage and database must be backed up together.
  No automatic evidence purge is implemented.
- Legacy submissions without immutable snapshots must be resubmitted through the
  new file flow. They cannot use the new automatic approval without file evidence.
  Existing legacy published strategies are left operating.

## API additions and changes

All use existing authentication/CSRF/account checks. Partner ownership is checked
server-side; only admin can approve or manually stage a compiled artifact.

| Method | Endpoint | Input / purpose |
| --- | --- | --- |
| POST | `/api/partner/submissions` | Existing form: metadata, files, presets, requestKey; optional marketplaceId/marketplaceRevision |
| POST | `/api/partner/marketplace/eas/:id/submit` | Existing listing revision, files, presets, requestKey, optional entryFile |
| GET | `/api/admin/ea-submissions/:id` | Existing detail plus publication proof and review digest |
| POST | `/api/admin/ea-submissions/:id/approve` | `{reviewDigest}`; approve and automatically publish |
| POST | `/api/admin/ea-submissions/:id/publish` | Compatibility alias to the same idempotent operation |
| GET, POST | `/api/admin/ea-submissions/:id/artifact` | Download reviewed EX5 / stage raw octet-stream EX5 |
| POST | `/api/admin/ea-submissions/:id/test` | Queue source compilation on an assigned test node |
| POST | `/api/admin/ea-testing/reports/:reportId/artifact` | Assigned node's raw compiled EX5 |
| POST | `/api/admin/ea-testing/reports/:reportId/complete` | Assigned node compile report; success requires the stored artifact |
| POST | `/api/admin/marketplace/eas/:id/approve` | `{revision,reviewDigest}`; same unified publication service |

IIS/Cloudflare continue to proxy these existing `/api/` paths. JSON source
submission parsing is scoped to 30 MB; artifact endpoints take raw octet-stream
up to 10 MB, separate from the normal 256 KB JSON parser. No new public asset
allowlist entries or environment variables are required. Apply PostgreSQL 0016
before restarting CornGridWeb. SQLite applies its equivalent at startup.

## Verification and rollback

Run `node --test "test/*.test.js"` in `Corngrid-web`. Tests cover own/other/official
permissions, required files, stale/tampered review, node artifact authorization,
concurrent/idempotent approval, audit rollback, stable strategy updates, exact
download bytes and unchanged subscription/license limits. Compiler tests inject
a test double; they never execute sample artifacts or customer terminals.

`node marketing/verify-marketplace-postgres.cjs` uses two independent pools and a
random disposable schema for PostgreSQL concurrency checks. It never changes
production tables. `marketing/preview-marketplace.cjs` serves the real UI against
an isolated in-memory API for browser testing.

For rollback restore the backed-up website/agent code and restart the website.
The additive tables and files should remain for audit. If intentionally discarding
new release evidence, back it up first and apply `migrations/rollback/0016_partner_publication.sql`
before any 0015 rollback. The rollback leaves published operational strategy files
and trading records intact; it does not undo published releases.
