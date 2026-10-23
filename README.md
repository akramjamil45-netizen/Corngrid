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

### IIS site binding and ARR (check this first when the site returns 404)

Two separate IIS settings must both be correct. Neither is visible from the Node backend, and a wrong value makes every API call fail while the backend itself looks perfectly healthy.

**1. The rewrite rules need Application Request Routing (ARR).** `web.config` forwards requests with `<action type="Rewrite" url="http://127.0.0.1:3000/{R:0}" />`. An absolute `http://` target is an **ARR reverse proxy**, not a plain URL Rewrite. Without ARR installed, IIS cannot proxy to Node at all: the rule is ignored and the request falls through to the static file handler, which answers **404**.

Check whether ARR is installed (from an administrator PowerShell prompt):

```
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\IIS\Extensions\ApplicationRequestRouting' | Select InstalledVersion
# "not installed" or a missing key means the proxy rules cannot work
```

If it is missing, install "Application Request Routing 3.0" (x64) from the IIS site, then enable the proxy:

```
appcmd add config /section:system.webServer/proxy /enabled:true /commit:apphost
iisreset
```

**2. The site must point at this `Website/` folder.** IIS reads `web.config` from the site root, so a site whose physical path is anywhere else ignores every rule in it. Confirm with `appcmd list site` and `appcmd list vdir`; each site must show a physical path of `...\CornGrid EA\Website`.

Symptoms of either misconfiguration:

- `GET /api/...` returns **404** (the Node backend returns 200/401/503 for these paths, never 404) and the body is an IIS HTML error page rather than JSON.
- `GET /` serves the IIS default page instead of the CornGrid homepage.
- Static files such as `/market.js`, `/feed.js`, `/dashboard.js`, and `/sw.js` all return 404.
- The Cloudflare Tunnel origin is `http://127.0.0.1:80` (IIS). If IIS cannot reach Node, the tunnel reports **502 Bad Gateway** at `https://corngrid.com` even though `http://127.0.0.1:3000` answers normally.

Verify each layer separately before touching the app:

```
curl http://127.0.0.1:3000/api/me                 # Node: expect 401 (alive)
curl -H "Host: corngrid.com" http://127.0.0.1/api/me   # IIS: expect 401, not 404
curl https://corngrid.com/api/me                   # Cloudflare: expect 401, not 502
```

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

