# Partner Program Documentation

The CornGrid Partner Program lets external EA developers submit Expert Advisors for review, isolated testing, and distribution through the CornGrid sandbox platform, earning commission on resulting subscriptions.

## Roles & lifecycle

```
Partner                          Admin                            System
   │                                │                                │
   │  submit EA (.mq5/.mqh/.zip)    │                                │
   │ ─────────────────────────────► │  pending_review                │
   │                                │  start review                  │
   │                                │ ──────────────► under_review   │
   │                                │  run sandbox test              │
   │                                │ ──────────────► testing ──────►│ compile + run on
   │                                │                                │ isolated TEST node
   │                                │  testing_passed / testing_failed
   │                                │  approve / reject (reason)     │
   │                                │ ──────────────► approved       │
   │                                │  publish                       │
   │                                │ ──────────────► published ────►│ appears in user
   │                                │                                │ strategy selection
```

## Submission rules

- Files: `.mq5`, `.mqh`, or a `.zip` project. Max 20 files, 10 MB each (decoded).
- A submission must contain at least one `.mq5` or a `.zip`.
- On upload, a static heuristic scan flags suspicious constructs (non-system DLL imports, process creation, registry writes, arbitrary file manipulation, raw networking). Flagged submissions are still stored but carry review notes for the administrator.
- Source is stored under `storage/ea-submissions/<submissionUid>/` with sanitized filenames.

## Isolated testing

- Tests run **only** on nodes flagged `is_test_node` — never on production nodes hosting user sandboxes.
- The test agent downloads the source, compiles with `metaeditor64.exe` (when present), deploys a throwaway isolated instance with the demo account from `EA_TEST_*` env vars, observes CPU/memory/crashes for a bounded window, posts a report, and tears everything down.
- Reports are stored in `ea_test_reports` and visible to both admin and partner.

## Commissions

- Admin configures rules per partner, optionally per strategy (`partner_commissions`).
- Models: `percent` (e.g. 40% of the subscription payment) or `fixed` (e.g. RM40 flat).
- `applies_to`: `subscription` (first purchase only), `renewal` (renewals only), or `both`.
- When a subscription payment is approved, the engine checks the subscriber's active sandbox strategy. If it is a partner-published strategy, a commission row is written to the immutable `partner_transactions` ledger.
- **Idempotency:** the unique key `payment:<id>:partner:<id>` prevents duplicate commissions even if the approval hook replays.
- Amounts are never updated after insert; only the status transitions `pending → approved → paid` (or `rejected`/`cancelled`), each transition audited.

### Example

EA subscription RM100, partner commission 40% → partner earns RM40, CornGrid keeps RM60.

## Payouts

- Admin records a payout (`POST /api/admin/payouts`) up to the partner's available approved balance.
- The payout settles the oldest approved transactions (linked through `partner_payout_transactions`), marking them `paid` — a commission can never be paid twice.
- Partners see earnings, ledger, and payout history on the Partner Program page.

## Partner payout details

Bank/DuitNow details submitted in the partner profile are stored AES-256-GCM-encrypted (`payout_details_cipher`) and never returned by the API.


## Partner applications and EA presets

Users apply from Dashboard > Partner Program. Applications remain pending until an administrator approves them in Admin > EA Submissions > Partner Applications. Pending and rejected applicants cannot submit EAs or access partner functions. Rejections require a reason; applicants may update their details and reapply. Existing active partner profiles remain active.

Approved partners upload a separate .set preset for each supported pair (XAUUSD, EURUSD, GBPUSD, USDJPY) with each new EA submission. Files are limited to 128 KB each and validated as UTF-8 or UTF-16LE MT5 input settings. Presets are immutable with the submitted EA version and reviewed alongside source files. Publishing requires a preset. To change a published preset, submit a new EA version for review.

CornGrid EA uses only its official Dashboard Downloads presets: XAUUSD v2.60 and EURUSD/GBPUSD/USDJPY M1 v2.00. Partner strategies receive only their own reviewed pair preset. Unsupported pairs are unavailable; there is no fallback to CornGrid. CornGrid-only sync inputs and credential files are not injected into partner EAs. A partner EA must implement its own compatible telemetry if dashboard EA heartbeat data is needed.

Deployment: apply migrations/postgres/0006_partner_applications_presets.sql before restarting the backend. SQLite creates the additional tables through ensureSchema (the equivalent SQL is migrations/sqlite/0005_partner_applications_presets.sql). Both migrations add tables without modifying existing account, partner or trading records. Refresh dashboard/admin pages after deploying the updated JavaScript.
