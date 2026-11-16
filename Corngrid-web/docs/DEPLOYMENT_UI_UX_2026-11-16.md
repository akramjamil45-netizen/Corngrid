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

## Sandbox spacing follow-up - 11:50 Malaysia time

- Deployed four changed files: dashboard markup, shared interface CSS, the UI guide and service worker (cache v33). Completion time: 03:50:01 UTC on 16 November 2026.
- Moved Last checked into the Your sandboxes card, removed empty loading grid tracks and reset the extra margin above the status cards.
- Browser acceptance passed at 1440px, 375px and 320px. The layout checks assert the timestamp stays within its card and the gap to the first health card stays within 28 CSS pixels. Mobile screenshots were visually reviewed.
- All eight API/readiness checks and 24 gateway/public asset checks passed. Both running Sandbox instances and all seven existing MT5 terminal processes were preserved. No service restart, backend, dependency, key or database change was required.
- Original files and the reviewed candidate were saved in `C:\ProgramData\CornGrid\WebsiteBackups\workplace-ux-20261116-034955`. This static-file release did not create or restore a database snapshot.

## Compact Overview follow-up - 17:43 Malaysia time

- Completed at 09:43:29 UTC on 16 November 2026. Deployed five changed UI/documentation files with matching `20261116-compact-attention1` dashboard references and service-worker cache v34.
- Replaced the large healthy-state panel with a compact status strip. Details expands the last-check timestamp and setup checklist; actionable warnings and refresh errors remain visible. Refreshes preserve the user's expanded/collapsed choice.
- Five focused model tests and browser acceptance at 1440px, 375px and 320px passed before deployment. Tests cover compact height, keyboard disclosure, checklist contents, refresh stability and existing navigation/payment flows. Desktop and mobile screenshots were reviewed.
- Eight API/readiness checks and 24 gateway/public asset checks passed after deployment. Both running Sandbox instances and all seven pre-existing MT5 terminal processes were preserved. No service restart, database, backend, dependency or key change was required.
- Rollback files are protected under `C:\ProgramData\CornGrid\WebsiteBackups\workplace-ux-20261116-094323`. No production test account or payment was created.

## Five mobile shortcuts follow-up - 18:00 Malaysia time

- Completed at 10:00:11 UTC on 16 November 2026. Deployed five changed UI/documentation files with `20261116-five-nav1` dashboard references and service-worker cache v35.
- Mobile navigation now provides Live Feed, Chat, Overview, Sandbox and More. Chat has its own active state and uses the existing authorized conversation screen.
- Downward content scrolling slides the bar below the viewport; upward scrolling restores it with a 240ms transition. Direction thresholds suppress jitter. Keyboard focus, menu visibility, virtual-keyboard handling and reduced-motion preferences remain supported. Nested Chat lists are supported without responding to sidebar scrolling.
- Eight focused model/API-path tests and browser acceptance at 1440px, 375px and 320px passed before deployment. Checks cover all five labels, direct Live Feed/Chat navigation, scroll hiding/restoration, keyboard recovery, jitter, nested Chat scrolling and reduced motion. Screenshots were reviewed.
- All eight API/readiness and 24 gateway/public asset checks passed after deployment. Both running Sandbox instances and all seven existing MT5 processes were preserved. No service restart, backend, schema, dependency or environment change was required.
- Original files and the candidate are protected under `C:\ProgramData\CornGrid\WebsiteBackups\workplace-ux-20261116-100006`. No production account, payment or trading-control action was created by these checks.

## Chat unread bubble follow-up - 18:20 Malaysia time

- Deployed six changed UI/documentation files at 10:20:49 UTC on 16 November 2026. Updated dashboard, coordinator and stylesheet references to `20261116-chat-bubble1`; service-worker cache is v36.
- The mobile Chat icon shares the sidebar's confirmed unread count, displays 99+ for large counts, animates once when the count increases and clears on confirmed zero. Partial reads update quietly. Refresh errors retain the last confirmed count. Existing polling and read-receipt rules remain authoritative.
- Eight focused model/API-path tests and browser acceptance at 1440px, 375px and 320px passed before deployment. Checks include initial unread state, both badge counts, accessible labels, increase-only animation, unchanged counts, partial reads, 99+, reduced motion, transient failure retention and clearing after all messages are read. Mobile screenshots were reviewed.
- All 24 gateway/public asset checks passed. Follow-up API verification passed nine readiness/authenticated checks, including the live Chat unread-count endpoint. Unauthenticated access was rejected. No production message, test account or payment was created by verification.
- Both running Sandbox instances and all seven existing MT5 terminal processes were preserved. No service restart, backend, schema, dependency or environment change was required. Rollback files are protected under `C:\ProgramData\CornGrid\WebsiteBackups\workplace-ux-20261116-102044`.
