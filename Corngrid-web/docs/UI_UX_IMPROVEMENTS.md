# CornGrid Workplace UI and UX improvements

This update extends the existing vanilla JavaScript Workplace and administrator interfaces. User-facing additions use English and the existing black, gold and white theme. It adds no framework, dependency, database migration or environment variable.

## Implemented experience

1. **Shared interface primitives.** `public/interface.css` defines compact headings, cards, spacing, controls, badges, focus indicators and responsive layouts for both dashboard shells. `public/interface.js` supplies accessible loading, empty, retry, confirmation and status components.
2. **Notification controls.** All and Unread tabs support keyboard navigation; the category selector remains available. Bulk actions move into More, individual actions into an Actions menu. Empty states explain what to do next. Existing notification preferences and APIs remain authoritative.
3. **Sandbox status clarity.** Hosting node, MT5 connection and EA heartbeat are separate signals with last-report timestamps and relevant next actions. A running terminal process is not proof of a broker connection or trade execution. The current node agent does not independently report a live broker connection, so MT5 correctly shows Not verified. An authenticated EA heartbeat shows Reporting. Terminal and node freshness are checked independently.
4. **Overview guidance.** Needs your attention uses existing account, subscription and Sandbox endpoints. When there are no issues, the panel is a compact status strip. Details expands the last-check time and setup checklist; actionable alerts remain visible. The setup checklist reflects actual subscription access, account links, Sandbox records and EA reporting. Paid scheduled renewals suppress unnecessary expiry prompts.
5. **Navigation.** Mobile users get Live Feed, Chat, Overview, Sandbox and More shortcuts. More opens the existing sidebar. Users can choose up to three saved menu shortcuts, saved in device local storage under their user ID. Manage saved shortcuts in Settings > Appearance; the Pinned section is hidden from the sidebar. Pins use only visible, permitted navigation entries; they confer no API access. Saved pins do not sync across devices. The Chat shortcut shares the existing sidebar unread count, shows a compact 99+ cap and plays one brief pop only when the count increases. Confirmed zero clears both badges; transient refresh failures retain the last confirmed count. No extra polling loop is added. The five-column bottom navigation respects safe areas. It slides down on downward content scrolling and returns on upward scrolling or at the top, with 240ms motion. Direction thresholds prevent jitter; keyboard focus, an open sidebar or dialog keep it accessible. It also handles nested Chat lists, ignores unrelated sidebar/gallery scrolling and preserves content spacing to avoid layout shifts. Programmatic scroll changes do not start hiding without recent user scroll input. The virtual keyboard hides the bar separately, and reduced-motion preferences disable its transition.
6. **Payment progress.** Choose plan, Payment, Verification and Active are derived from backend payment and subscription records. DuitNow review and Stripe confirmation have distinct explanations. Pending renewals do not hide existing access. An approved payment does not imply currently active access when the subscription is suspended. Order status responses include the internal payment ID to prevent displaying another purchase's status after a selection changes. Return URLs do not activate access.
7. **Loading and recovery.** Account, subscription, Sandbox and trading views show loading, last-check times and retry feedback. Failed refreshes preserve previously received data only where it still belongs to the same account and filter selection. Different selections clear old values. Superseded responses cannot overwrite newer Sandbox state. Trading history exports cannot use an old result count after filters change.
8. **Accessibility.** Added a skip link, visible keyboard focus, tab keyboard controls, text alongside status colors, screen-reader progress labels and comfortable touch controls. Inputs use readable mobile text sizes. Reduced-motion preferences stop decorative animation. Notification updates avoid replacing focused controls during background refreshes.

## Main files

- `public/interface.css`, `public/interface.js`: shared visual and interaction primitives.
- `public/workplace.js`, `public/experience-model.js`: navigation, per-user device pins, attention checklist and payment presentation.
- `public/dashboard.html`, `public/dashboard.js`, `public/admin.html`: existing shell integration and refresh recovery.
- `public/notifications.js`, `public/notifications.css`: compact controls and keyboard interaction.
- `public/sandbox.js`, `sandbox/sandbox-health.js`, `sandbox/sandbox-manager.js`: observed health signals and safe status refreshes.
- `public/stripe-checkout.js`, `subscriptions/stripe-payments.js`, `subscriptions/subscription-api.js`: existing checkout integration and additive read-only response fields.
- Root `web.config`, `web.config.xml`, `sw.js`: IIS static routing and asset cache update (v36).

No operational strategy configuration, MT5 credentials, entitlement limits or payment activation transaction rules are changed. Loading navigation or status does not send Sandbox start, stop or reconnect commands. Existing authenticated Stripe reconciliation can still verify a payment with its established idempotent backend flow.

## Verification

Run from `Corngrid-web`:

```powershell
npm.cmd test
npm.cmd run test:experience:browser
npm.cmd run test:notifications:browser
npm.cmd run test:browser
```

Browser checks require Playwright Chromium (`npx playwright install chromium`) or installed Chrome selected with `$env:PLAYWRIGHT_BROWSER_CHANNEL='chrome'`. CI runs all three browser suites.

`test/browser/experience.browser.js` checks 1440px, 375px and 320px layouts, per-user pin isolation, five-button mobile/sidebar navigation, scroll direction and jitter, nested Chat scrolling, keyboard recovery and reduced motion, keyboard focus, light-theme body text contrast, setup guidance, payment states, failed-refresh retention, clearing data after filter changes and absence of unintended trading-control requests. Notification browser checks cover existing preference/history behavior and English copy. Platform browser checks cover the administrator health screen and MFA enrollment; they wait for the browser's asynchronous dialog-close event before checking that recovery secrets have left the DOM.

`test/experience-model.test.js` covers payment evidence, renewal/access distinctions and honest telemetry. Existing Sandbox, subscription, Stripe, authorization and licensing regression tests remain part of the full suite.

On the Windows development machine with PostgreSQL tools installed, run `node test/helpers/run-isolated-postgres.cjs`. It creates and removes its own loopback test cluster without reading `.env` or production services. The PostgreSQL platform tests exercise the new owner-scoped status query as well as existing migration, transaction, MFA and backup checks.

Browser previews use loopback fixtures with synthetic trading data and real test authentication/notification APIs. They do not connect to a broker, create live payments or start MT5. Real-device Android/WebView testing and production verification remain deployment checks; browser mobile emulation is not a substitute for them.

Verified on 16 November 2026: the full Node suite passed 349 tests with no failures and four PostgreSQL-dependent skips. All four PostgreSQL tests passed separately in the disposable cluster. The experience, notification and administrator browser suites passed using installed Chrome. Syntax checks, credential scanning and Git whitespace checks passed. Both IIS templates parse correctly and route the four new shared assets; their pre-existing environment-specific differences are preserved.

## Release notes

Publish matching dashboard/admin HTML, all changed and new public assets, the three changed backend modules plus `sandbox/sandbox-health.js`, both IIS configurations and `sw.js` together using the established deployment procedure. Restart only the web backend when deploying its code. The existing Sandbox agents require no update for this interface release. No production deployment is performed by the implementation or test commands above.
