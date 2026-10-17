# CornGrid Dashboard

The dashboard extends the existing Express, SQLite, and JWT application. It keeps the existing login and password-recovery routes. Dashboard API requests use the existing bearer token; no second authentication system is introduced.

## Current implementation

- Responsive overview, MT5 accounts, open positions, trade history, EA monitoring, and profile/settings views. The overview selector scopes its summary, performance analytics, equity chart, EA status, and preview positions to one owner-verified MT5 account at a time; the selection is saved in the current browser. Daily and monthly totals use the owner's saved time zone.
- Financial values are shown only when supported by stored MT5 snapshots or imported deal data. Missing or mixed-currency aggregate values are shown as `N/A`.
- MT5 pairing codes are single-use, expire after ten minutes, and are stored as hashes.
- Pairing issues a random installation credential once. The database stores only its hash; authenticated EA requests use it as a bearer credential.
- Heartbeat status is based on the last authenticated heartbeat, not on whether an account row exists. The default online timeout is 180 seconds.
- Heartbeats store account snapshots and replace the open-position snapshot when the request includes a `positions` array. Send an empty array when there are no open positions.
- Imported deals are deduplicated by `(account_id, deal_id)`. Use the MT5 deal ticket as `dealId`; partial exits remain separate deal records and are not combined into position-level trades.
- Changing or resetting a password increments the user's authentication version, invalidating older JWT sessions.
- Appearance preferences and account profile changes are persisted. Email notifications, image uploads, personal-data export/deletion workflows, and MT5 terminal source changes are not included.
- The authenticated dashboard Downloads page provides the available MT5 `.set` presets and CornGrid Setup Guide PDF.
- Administrator access uses the existing login page and a separate bcrypt password hash from `.env`. The protected administrator dashboard shows aggregate profile/portfolio visibility counts and a paginated, minimal user directory; it does not expose account identifiers, balances, positions, or trade history.

## Windows Server deployment

1. Use the existing Node.js service and IIS/Cloudflare Tunnel routing. Do not expose `database.sqlite` or change the existing tunnel configuration as part of this dashboard deployment.
2. Install the Node.js version required in `package.json` (Node.js 20.17 or later), then run `npm ci` in this directory.
3. Create a private `.env` from `.env.example`. Set a unique random `JWT_SECRET` of at least 32 characters, production `NODE_ENV`, the public `APP_BASE_URL`, and working SMTP values. To enable administrator login, set a dedicated `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH`; generate the hash with `node -e "require('bcryptjs').hash(process.argv[1], 12).then(console.log)" "choose-a-long-password"` and store only the resulting bcrypt hash, never the plaintext password. Both admin variables must be set together. Never copy real credentials into `.env.example` or commit `.env`.
4. Optionally set `MT5_HEARTBEAT_TIMEOUT_SECONDS` (default `180`). Keep the SQLite database directory writable only by the Node service account and outside the IIS public directory.
5. Run the app through the existing Windows service/process manager. Keep Node bound to the intended local interface and let the existing IIS reverse proxy and Cloudflare Tunnel handle public TLS traffic.
6. Confirm that the existing proxy forwards `/api/*`, `/admin`, `/portfolios`, `/portfolio/*`, and serves the dashboard and public portfolio assets (`/admin.html`, `/admin.css`, `/admin.js`, `/dashboard.html`, `/dashboard.css`, `/dashboard.js`, `/public-portfolios*`, `/public-portfolio*`, and `/images/*`) from the Express public directory. Do not publish `/Corngrid-web/database.sqlite`.
7. After deployment, test registration/login, password reset, dashboard access, public/private portfolio visibility, and the EA pairing/heartbeat flow over HTTPS. Use the local integration checks described below before enabling real account linking.

`database.sqlite` receives backward-compatible `CREATE TABLE IF NOT EXISTS` additions at startup. Back it up before deploying and ensure the service account can write to its directory. The included rate limits are process-local; deployments with multiple Node workers or instances must also enforce limits at the gateway.

## API contract

All browser endpoints below require the existing `Authorization: Bearer <JWT>` token:

- `GET /api/me`
- `GET /api/portfolio?accountId=123` (optional owner-verified account filter)
- `GET /api/portfolio/performance?period=today|7d|30d|90d|all&accountId=123`
- `GET /api/portfolio/performance?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=123`
- `GET /api/portfolio/positions?page=1&limit=20&search=EURUSD&direction=BUY&sort=profit-desc&accountId=123`
- `GET /api/portfolio/trades?page=1&limit=20&from=YYYY-MM-DD&to=YYYY-MM-DD&symbol=EURUSD&result=win&sort=closed-desc`
- `GET /api/mt5/accounts`
- `POST /api/mt5/pairing-code`
- `POST /api/mt5/pair` with `{ "code": "...", "accountNumber": "...", "brokerServer": "...", "currency": "...", "eaVersion": "2.60" }` (`eaVersion` is optional for older EA builds)
- `PATCH /api/mt5/accounts/:id` with `{ "accountName": "..." }`
- `DELETE /api/mt5/accounts/:id`
- `PUT /api/user/profile`
- `PATCH /api/user/preferences`
- `GET /api/user/portfolio-sharing`
- `PATCH /api/user/portfolio-sharing` with `{ "isPublic": true|false, "accountIds": [1, 2] }`
- `POST /api/user/change-password`
- `GET /api/downloads/:resourceId` streams an allow-listed preset or setup guide and requires the existing bearer token.
- `GET /api/admin/overview?page=1&limit=50&search=username&visibility=public|private|all` requires an administrator token issued by the existing login endpoint.

Download resource IDs are `setup-guide`, `xauusd-v260`, `xauusd-v25`, `eurusd-m1-v200`, `gbpusd-m1-v200`, and `usdjpy-m1-v200`. Files are served from the sibling `files` directory, not the public static directory. Keep this directory alongside `Corngrid-web` in deployment; the endpoint is authenticated and rate-limited.

The administrator signs in at the existing `/login` page with `ADMIN_EMAIL` and the plaintext password corresponding to `ADMIN_PASSWORD_HASH`. Successful admin login redirects to `/admin.html`. The admin token has an administrator-only role and cannot access the user dashboard APIs. Changing the admin email or bcrypt hash invalidates existing admin tokens. The overview includes every registered profile, treats portfolios as public only when public visibility is enabled and at least one account is selected, and computes account online status from the configured heartbeat timeout. User email addresses and financial/account details are not included.

Public portfolio routes do not require authentication:

- `GET /api/public/portfolios` lists portfolios their owners have explicitly published.
- `GET /api/public/portfolios/:shareId` returns a published portfolio only while it remains public.
- `/portfolios` serves the public directory; `/portfolio/:shareId` serves the public portfolio page.

Private is the default. Users can link multiple MT5 accounts by generating and using a separate one-time pairing code for each account. In Dashboard → Settings → Privacy, owners choose which of their linked accounts to include and whether the selected accounts are private or public. Publishing requires at least one selected account. The server rejects selected account IDs not owned by the authenticated user; account selection is persisted separately and applied to every public summary, chart, position, and trade query. Owners can change the selection or revoke public access at any time. Public pages show only selected accounts, masked account identifiers, account names, open positions, and recent deals; they omit email, broker/server, full account numbers, position/deal ticket IDs, magic numbers, and credentials. Values across multiple currencies are not combined, and combined equity curves/drawdown are withheld unless there is one selected account.

The private dashboard overview selects one linked MT5 account at a time and applies its account ID to the balance/equity summary, period performance statistics, equity history, EA status, and overview positions. The server checks account ownership for each filtered request and returns `404` for an account not linked to the authenticated user. The selected overview account is remembered in that browser; it does not change which accounts are selected for public sharing.

The one-time website pairing code is exchanged by an EA installation at `POST /api/mt5/pair` with `{ "code": "...", "accountNumber": "...", "brokerServer": "...", "currency": "USD" }`. The response contains `installationSecret` once. Keep this secret in the EA installation's protected local configuration, never in browser code, logs, or a shared configuration file.

Authenticated EA requests use `Authorization: Bearer <installationSecret>`:

- `POST /api/mt5/heartbeat` with `timestamp`, `balance`, `equity`, `floatingProfit`, and optional `margin`, `freeMargin`, `eaName`, `eaVersion`, and `positions`.
- `POST /api/mt5/trades` with a `deals` array. Each record includes a stable MT5 `dealId`, `symbol`, `direction`, `volume`, `profit`, and `closedAt`; optional commission, swap, entry/exit/stop-loss/take-profit prices, position ID, duration, magic number, and EA version are accepted.

All timestamps should be ISO-8601 UTC values. Snapshot timestamps must not be in the future; older snapshots are ignored. Payloads are size-limited, fields are validated, and heartbeat/deal data endpoints are rate-limited. Net profit and win-rate metrics require commission and swap values; absent costs are not treated as zero. Never send or request an MT5 trading password. The ingestion API cannot execute trades.

## MQL5 dashboard sync

The source file `public/Corngrid@ v37.mq5` includes opt-in account snapshot, open-position, and closed-deal uploads to the API. Dashboard sync is disabled by default and does not execute or modify trades.

1. Generate a one-time pairing code in the authenticated dashboard. Enable `InpEnableDashboardSync`, set `InpDashboardPairingCode`, and verify `InpDashboardApiBaseURL` uses the production HTTPS origin.
2. Add that HTTPS origin to MT5's Tools → Options → Expert Advisors → “Allow WebRequest for listed URL”.
3. Attach the EA to a demo account and allow its timer to pair and send the initial heartbeat. After successful pairing, the installation credential is stored in the terminal's `MQL5/Files` folder and is not printed to the log. The local file is not encrypted by the EA; protect it with Windows account and filesystem permissions.
4. The EA sends a complete account position list and the latest closed deals, using MT5 deal tickets as stable deal IDs. The sync interval defaults to 30 seconds (minimum 15 seconds). Sync does not run in the strategy tester.
5. Validate heartbeat freshness, published dashboard values, empty positions, duplicate deal handling, and retry behavior on demo before production use. If the local credential is lost or the account is unlinked, remove the old account entry and pair again with a new code.

## Validation

The dashboard/API integration can be checked without live MT5 data by running an isolated in-memory SQLite/Express test. Cover unauthenticated access, user ownership isolation, public/private portfolio visibility and data redaction, pairing expiry/replay, invalid installation credentials, heartbeat freshness, duplicate deal imports, password-session invalidation, empty data responses, and preference persistence. Real charts and statistics require actual snapshots and deal imports; no frontend demo trading values are bundled.

## Known limitations

- MQL5 dashboard sync is opt-in and the source has not been compiled or tested in MetaEditor in this environment. Validate on a demo account before using it live.
- Connection state uses the latest heartbeat, but a separate connection-event history and detailed EA synchronization-error feed are not yet stored.
- Combined equity curves and drawdown are withheld for multiple linked accounts until a synchronized portfolio curve can be calculated safely.
- Email notifications, avatar uploads, personal-data export/deletion workflows, and logout-from-all-sessions UI are not implemented.
- The existing JWT bearer login is preserved and its token remains in browser storage for compatibility. Password changes/recovery revoke earlier JWTs, but migration to HttpOnly cookie sessions is a separate security change and remains outstanding.
- Built-in API rate limiting is in-memory and per Node process. Enforce complementary edge-level limits for multi-worker or multi-instance deployments.
