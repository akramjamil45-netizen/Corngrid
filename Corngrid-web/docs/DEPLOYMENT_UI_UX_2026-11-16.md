# Workplace UI and UX deployment - 16 November 2026

The operator authorized production deployment and a Git commit after the UI and UX changes passed their isolated checks. Deployment completed at 03:24:37 UTC (11:24:37 Malaysia time).

## Applied

- Deployed 20 runtime, asset, configuration and documentation files to `C:\Website\Website` using `marketing/deploy-workplace-ux.ps1 -Apply`.
- Added shared interface assets, Overview setup guidance, compact notifications, per-user device shortcuts, mobile bottom navigation, four-step checkout presentation and separate Sandbox health signals.
- Restarted only `CornGridWeb`. Both running Sandbox instances and all seven pre-existing MT5 terminal processes remained active after verification.
- Production environment keys and dependencies were preserved. No schema migration, manual subscription activation, live payment, agent update or trading-control request was performed.
- Saved reviewed candidate files, original files, a manifest and a PostgreSQL snapshot under the access-restricted operator backup directory `C:\ProgramData\CornGrid\WebsiteBackups\workplace-ux-20261116-032416`. Rollback restores files and restarts the web backend; it does not automatically restore the database snapshot.

## Verification

- The deployment candidate matched the production Git baseline before changes; no unreviewed production file difference was overwritten.
- Eight authenticated/readiness API checks returned HTTP 200, including profile, MT5 accounts, subscription overview, Sandbox status and notification history/preferences. Unauthorized notification access remained rejected.
- Sandbox responses contained the new host, MT5 and EA signals. A running process was not presented as proof of a live broker connection. Subscription responses contained the scheduled-renewal presentation field.
- All 24 asset/markup checks passed through the local gateway and `https://corngrid.com`. JavaScript, CSS and service-worker content hashes matched the deployed files. Both dashboard shells referenced the new interface version; the Workplace referenced the new coordinator and checkout progress markup. Service-worker cache version is v31.
- Before deployment: 349 ordinary automated tests passed, with no failures. Four PostgreSQL-dependent tests skipped in that run passed separately against a disposable cluster. All three browser suites passed, including 1440px, 375px and 320px Workplace checks, notification preferences and administrator MFA enrollment.
- No production test account was created, no notification preference was changed and no payment was attempted during smoke checks.

## Operational notes

The MT5 connection signal deliberately reads **Not verified** until independent broker connectivity telemetry is available. EA heartbeat reporting and terminal process status remain separate observations.

Pinned shortcuts are stored per user on the current device. The mobile layouts were checked in browser emulation; real-device Android/WebView acceptance remains a separate device check. Users with an already open tab can refresh to load the new asset versions.

See `UI_UX_IMPROVEMENTS.md` for implementation details and test commands. The deployment helper requires the intended Windows host, refuses production drift, protects backups, verifies readiness and attempts file rollback if post-deployment checks fail.

## Follow-up: shortcuts and checkout layout

At 03:41:22 UTC (11:41:22 Malaysia time), the operator-authorized follow-up deployment completed:

- Removed the entire Pinned section from the sidebar. Saved shortcuts and editing are available in **Settings > Appearance**.
- Restored checkout panel padding that had been overridden by Subscription panel styles. Mobile step indicators now use two columns, the status message has its own separated area, and the last-check timestamp sits closer to the panel.
- Published five changed asset/documentation files. Dashboard CSS and Workplace script references use `20261116-checkout-layout1`; service-worker cache version is v32.
- Updated the deployment helper to select content changes independently of Windows line endings, derive public asset versions from current markup, and skip database snapshots and web-service restarts for static-only updates. Drift checks, file backups, API verification and rollback remain enforced.
- Backed up replaced files under `C:\ProgramData\CornGrid\WebsiteBackups\workplace-ux-20261116-034117`. No backend, dependency, environment or schema change was deployed, and no service was restarted.
- All eight API/readiness checks and 24 gateway/public asset checks passed. Both running Sandbox instances and all seven existing MT5 terminal processes were preserved.
- Before deployment, eight focused model/API-path tests passed. Browser acceptance passed at 1440px, 375px and 320px, including no sidebar Pinned section, shortcut persistence, checkout padding, step/message overlap checks and timestamp spacing.
