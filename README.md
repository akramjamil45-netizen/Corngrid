# CornGrid Website

CornGrid is a multi-page website with a static marketing site at the repository root and an Express 5 application in `Corngrid-web`. The app serves the existing SQLite-backed user dashboard, public portfolios, administrator view, and authentication routes. The PWA reuses those pages and APIs; it does not introduce a separate account system or database.

## Run and test

```powershell
cd .\Corngrid-web
npm ci
npm test
npm start
```

The server requires Node.js 20.17 or later. Configure the existing backend environment variables before production deployment, including `JWT_SECRET`, `NODE_ENV=production`, and `APP_BASE_URL=https://corngrid.com`. Password recovery also requires the existing SMTP settings (`SMTP_HOST` and `SMTP_FROM`, with credentials as needed). `DATABASE_PATH` is optional and defaults to `Corngrid-web/database.sqlite`; use `DATABASE_PATH=:memory:` for isolated local smoke tests. Do not put secrets in frontend files.

## PWA deployment and installation

The app manifest and static PWA assets are served from `Corngrid-web/public`; the root service worker is served at `/sw.js` so it can control the site-wide `/` scope. Keep both IIS rewrite configurations (`web.config` and `web.config.xml`) aligned with the Express routes. Production must be available over HTTPS with a valid certificate; the service worker and secure session cookie are not available on ordinary HTTP origins.

On Android, open `https://corngrid.com` in Chrome, then use the browser’s **Install app** or **Add to Home screen** option. When Chrome exposes the install prompt, CornGrid also offers an optional in-page install action. The app uses the existing backend and requires an online connection for login and current account data.

The service worker caches only an explicit list of same-origin static assets. It never caches HTML pages, API responses, login/session data, or trading/account information. When offline, navigations show a generic offline page rather than cached financial information. New service-worker versions wait for the user to choose **Reload** before taking control.

The browser UI uses an HttpOnly, SameSite=Lax session cookie. Production cookies require HTTPS; cookie-authenticated write requests are checked against the configured application origin. Existing bearer-token authentication remains available for external API and MT5 clients.

## Promotional pages

`promote/terminal-app/` holds the static Trading Terminal and Android App landing page. It is served by IIS through the `promote/terminal-app/?$` rewrite rule in `web.config`; Express does not mount this directory, so keep the rule when deploying to a new host.

The page carries its own translation module at `promote/terminal-app/i18n.js` and its own stylesheet at `promote/terminal-app/style.css`. Both are independent of the root `script.js` and `mystyle.css` bundles, but they reuse the shared design tokens, the `.btn-hero` buttons, the header, and the footer from `mystyle.css`.

### Language switching

The promotional page offers an English / Bahasa Melayu switcher in the header, matching the control on the main marketing page. Both pages store the visitor's choice in the same `localStorage` key (`selectedLang`), so the language follows the visitor between the main site and the promotional page.

Markup is translated through `data-i18n` attributes; `data-i18n-alt`, `data-i18n-title`, and `data-i18n-desc` cover image alt text, the document title, and the meta description. Adding a new translatable string means adding the key to both the `en` and `bm` dictionaries in `promote/terminal-app/i18n.js` — the `en` and `bm` dictionaries must stay in sync.

### Floating support button

The bottom-right `.cg-contact` widget is the same support launcher used on the main website, and it is also translated here. Its behaviour (open on click, close on outside click or `Escape`) is handled by the inline script at the end of the promotional page.

After changing `promote/terminal-app/style.css`, bump the `?v=` query string on its `<link>` tag in `promote/terminal-app/index.html` so browsers pick up the new stylesheet.

