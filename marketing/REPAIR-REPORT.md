# CornGrid public UI and PWA repair

## Readability and motion follow-up

Deployed 2026-11-05: public headers use one `Sign In` button linking to the existing login/registration screen. Homepage FAQ reduced from 12 to 5 essential questions. Main copy is 16px, hero introduction 18px, and FAQ summaries 17px. Added EA-style staggered hero entrances, scroll reveals, a gently floating infrastructure illustration and card hover effects. Reduced-motion users receive fully visible content without these animations. Browser checks at 390px and 1440px verified the single entry, five questions, font sizes, animation initialization and absence of horizontal overflow; reduced-motion checks verified no hidden content. Focused tests pass 5/5. Versioned assets use `20261105-visual4`. Deployment hash-verified 19 files, with backup at `C:\Users\mohamad akram\AppData\Local\Temp\CornGrid-ui-repair-20261105-121428`.

## Visual follow-up deployed 2026-11-05

Reused EA image backgrounds on the Infrastructure hero and sections. Infrastructure BM/EN and public portfolio pages now render the actual EA corporate footer template through `marketing/ea-footer.js`, reusing its original CSS and translations. EA footer section links retain their correct `/corngrid-ea#…` destinations.

Shared navigation uses 14px desktop text and 18px mobile text. The mobile menu now fills the viewport, scrolls in short landscape screens, and removes the header backdrop filter while open so the fixed panel is positioned against the viewport. The drawer breakpoint is 1280px to avoid crowded desktop links. Verified at 390, 844, 1280 and 1440px, with no horizontal overflow. Focused route/PWA tests pass 5/5. Deployed 19 files with matching hashes; no service restart was necessary. Backup: `C:\Users\mohamad akram\AppData\Local\Temp\CornGrid-ui-repair-20261105-120507`.

Deployed to `C:\Website\Website` on 2026-11-05. All 18 deployed files were hash-verified, production IIS rules received the targeted public-shell allowlist addition, and `CornGridWeb` restarted successfully with administrator rights. Backups are outside the web root at `C:\Users\mohamad akram\AppData\Local\Temp\CornGrid-ui-repair-20261105-115533`.

Post-deployment checks returned HTTP 200 for Infrastructure BM/EN, EA, Terminal Apps, portfolios, public-shell CSS, PWA JavaScript, service worker, manifest, public portfolio API, health, login and registration. Content checks confirmed the repaired navigation, bilingual popup and v20 worker are live. Standalone Node Terminal Apps also returned HTTP 200.

## Findings and repairs

- Git HEAD confirms the former homepage linked `/promote/terminal-app/` and `/portfolios`. Both implementations and the real Android APK remain present. The new homepage header omitted their links; neither page needed replacement or a new route.
- Restored both links in the shared Infrastructure/EA header and footer. Applied that header to Terminal Apps and portfolio pages, retaining the existing portfolio rendering, API calls, Android content, download URL and translations. Added the original Terminal Apps static directory to Node routing; IIS already served it.
- Infrastructure already imported the original `mystyle.css`, but used conflicting button proportions, corner radius, hover effects and shadows. Restored the original button values and readable shared footer typography. Logo, Poppins, gold `#FFD400`, black/white palette, and original support widget are retained. Portfolio color overrides are scoped to public pages; internal dashboards are unaffected.
- The Infrastructure template loaded `pwa.js` without `pwa.css`. Added the stylesheet and Apple touch icon. Repaired the existing install component with the requested BM/EN copy, eligibility checks, click-only native prompt, seven-day dismissal, duplicate prevention, installed-state handling and Safari manual instructions. It follows the existing document language and `selectedLang` preference.
- The worker previously cached PWA files first and automatically activated updates. Bumped its cache version, made changed UI/PWA resources network-first, and retained the existing user-triggered update flow. API responses, uploads, mutations and navigations are not stored by the runtime cache.
- Added only `public-shell.css` to the existing IIS proxy allowlists. Existing API/WebSocket proxy rules and error handling remain intact. Both root IIS configuration files parse as XML.
- Kept manifest identity `/login`, start URL `/login?source=pwa`, scope `/`, standalone display and existing 192/512 PNG icons unchanged.
- Portfolio backend still requires public sharing and selected account ownership. No authentication, database, subscription, MT5, admin, sandbox, email, partner or tunnel implementation was changed for this repair.

## Changed files

- Sources/shared UI: `marketing/build.js`, `site.js`, `infrastructure.css`, `marketing/header.html`, `locales/ms.json`, `locales/en.json`.
- Generated/existing pages: `index.html`, `en/index.html`, `corngrid-ea.html`, `promote/terminal-app/index.html`, `Corngrid-web/public/public-portfolios.html`, `Corngrid-web/public/public-portfolio.html`.
- PWA/public shell: `Corngrid-web/public/pwa.js`, `Corngrid-web/public/pwa.css`, `Corngrid-web/public/public-shell.css`, `sw.js`.
- Routing: `Corngrid-web/marketing-routes.js`, `web.config`, `web.config.xml`.
- Validation: `marketing/preview.js`, `Corngrid-web/test/marketing.test.js`, `Corngrid-web/test/pwa.test.js`, this report.

## Verification

- `node marketing/build.js` and JavaScript syntax checks pass.
- `node --test --test-concurrency=1 "test/*.test.js"`: 155/155 passed, including auth, subscriptions, MT5/public-sharing privacy, admin, partner, sandbox and WebSocket coverage. The additional worker privacy test was added afterward; focused PWA/marketing tests pass 5/5.
- Initial concurrent suite: 151/152 passed; an existing market-feed timing assertion exceeded its threshold under load. Its isolated rerun passed 14/14, and the subsequent sequential full suite passed.
- Local Playwright: Infrastructure BM/EN, EA, Terminal Apps and portfolios load with exactly one support widget and no horizontal overflow. At 390×844, hamburger menus open and Escape closes them. Existing language selection follows navigation.
- Local browser: exactly one root service-worker registration was active. A simulated eligible install event created one popup, invoked zero native prompts before clicking, and invoked one prompt after clicking. Unit tests additionally cover installed state, persistent dismissal, Safari instructions and private-request cache exclusions.
- Live read-only checks: original Terminal Apps route, portfolios route, public portfolio API, manifest and health endpoint all returned HTTP 200. The original APK exists locally (4,329,651 bytes); its download URL is preserved.
- Preview intentionally runs without a database/API; its portfolio error state was verified. Actual portfolio permissions/data are covered by existing backend tests and the live public endpoint, rather than introducing mock public data.

## Remaining manual verification

After deployment, confirm real native installation in Chrome desktop/Android and Edge, Safari Add to Home Screen, installed-app launch, update behavior with an older installed worker, and actual APK download/install on Android. Browser-emulated eligibility cannot prove native installation. Portfolio content retains its original English data labels; shared navigation and installation UI use the existing BM/EN preference.

Deploy only the repair files, preserving unrelated existing workspace changes. Use the regenerated HTML and locale files together with their shared sources, PWA files, route module and IIS allowlist addition.
