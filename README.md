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
