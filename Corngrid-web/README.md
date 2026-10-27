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

`database.sqlite` receives backward-compatible `CREATE TABLE IF NOT EXISTS` additions at startup, plus the `idx_market_candles_symbol_feed` index on the candle table (an index build on an existing production database happens once, on the first start after this update). Back it up before deploying and ensure the service account can write to its directory. The included rate limits are process-local; deployments with multiple Node workers or instances must also enforce limits at the gateway.

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
- `POST /api/mt5/pair` with `{ "code": "...", "accountNumber": "...", "brokerServer": "...", "currency": "...", "eaVersion": "2.7" }` (`eaVersion` is optional for older EA builds)
- `PATCH /api/mt5/accounts/:id` with `{ "accountName": "..." }`
- `DELETE /api/mt5/accounts/:id`
- `PUT /api/user/profile`
- `PATCH /api/user/preferences`
- `GET /api/user/portfolio-sharing`
- `PATCH /api/user/portfolio-sharing` with `{ "isPublic": true|false, "accountIds": [1, 2] }`
- `POST /api/user/change-password`
- `GET /api/downloads/:resourceId` streams an allow-listed preset or setup guide and requires the existing bearer token.
- `GET /api/feed?filter=latest|popular|announcements|mine&cursor=123&limit=15` returns the community feed with cursor pagination (newest first; pinned announcements lead the default view).
- `POST /api/feed/posts` with `{ "content": "...", "imagePath": "/uploads/feed/<name>" }` (imagePath optional; the image must be uploaded first).
- `PATCH /api/feed/posts/:id` with `{ "content": "..." }` (owner only).
- `DELETE /api/feed/posts/:id` (owner only; soft delete).
- `GET /api/feed/posts/:id/comments?cursor=&limit=`; `POST /api/feed/posts/:id/comments` with `{ "content": "...", "parentId": 123 }` (parentId optional, one reply level).
- `PATCH /api/feed/comments/:id`; `DELETE /api/feed/comments/:id` (owner only).
- `POST /api/feed/posts/:id/like` and `DELETE /api/feed/posts/:id/like` are idempotent; uniqueness is enforced by the `(user_id, post_id)` primary key.
- `GET /api/feed/profile/:username`; `GET /api/feed/my-activity?cursor=&limit=`.
- `POST /api/feed/reports` with `{ "targetType": "post|comment", "targetId": 1, "reason": "..." }`.
- `POST /api/feed/uploads` streams a raw JPEG/PNG/WebP body (magic-byte validated, 5 MB cap) and returns `{ "url": "/uploads/feed/<name>" }`; files are stored under `public/uploads/feed`, which must exist at deployment and is excluded from version control.
- Administrator-only feed routes (separate admin token): `GET|POST /api/feed/announcements`, `PATCH|DELETE /api/feed/announcements/:id`, `GET /api/feed/admin/reports`, `POST /api/feed/admin/reports/:id/resolve`, and `DELETE /api/feed/admin/content/:kind/:id`. Announcements are authored by the administrator identity (no user row), so a community post can never impersonate an official announcement.

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

## Live Market Feed (CornGrid EA to Market Overview)

### Architecture

```
MT5 broker feed -> CornGrid EA (OnTimer, WebRequest) -> POST /api/mt5/market (installation credential)
  -> market-feed.js (validate, in-memory latest quotes + SQLite candles)
  -> SSE /api/market/stream (HTTP polling /api/market/quote as fallback) -> Market Overview chart
```

- The EA reuses the dashboard pairing credential (per-installation bearer secret, stored hashed server-side). No new secret exists and nothing privileged reaches the browser. Account passwords are never transmitted.
- Quotes (bid, ask, optional last, spread in points, digits, UTC tick time) are kept in memory only. Candles (M1-W1) are stored in the `market_candles` SQLite table, capped at 1,500 bars per feed/symbol/timeframe. Ticks are never stored.
- Freshness uses the server's receipt time, never the EA clock: LIVE (<= 10 s), DELAYED (<= 30 s), STALE (<= 120 s), OFFLINE (older). A connected EA with no new broker tick is still LIVE but flagged "market quiet". A faster update interval is not evidence of zero latency or exchange-grade real-time data.
- Replay/out-of-order protection: each request carries a strictly increasing `sentAtMs`; replays and older ticks are ignored (HTTP 202), and `sentAtMs` more than 5 minutes from server time is rejected (HTTP 422).
- Feeds are identified by the broker server name of the paired account. Brokers are never merged. Per feed/symbol one publisher owns the stream; other EAs get `202 standby` until the owner is silent for 15 s. Quotes and candles are owned separately, so an account that publishes only candles still keeps its stream. Ownership stays with the account that is actually publishing, so several accounts on the same broker server no longer make the visible price flip between them. Across feeds the healthiest feed wins; `MARKET_PREFERRED_FEED` wins while it is LIVE/DELAYED.
- Candle times are broker server time (as on the MT5 chart) and the UTC offset is sent with each request. History is limited to what the EA transmitted (default 300 bars per timeframe on start); nothing is invented.
- Source order: fresh EA feed, then the external provider only if `MARKET_FALLBACK_PROVIDER=external` (labeled FALLBACK, never "CornGrid EA"), then an honest unavailable/OFFLINE state. **The fallback is off by default**; set `MARKET_FALLBACK_PROVIDER=external` to keep the previous Twelve Data/Yahoo behavior while no EA publishes.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARKET_LIVE_MAX_AGE_SECONDS` | 10 | Max update age for LIVE |
| `MARKET_DELAYED_MAX_AGE_SECONDS` | 30 | Max age for DELAYED |
| `MARKET_STALE_MAX_AGE_SECONDS` | 120 | Max age for STALE; older is OFFLINE |
| `MARKET_QUIET_TICK_SECONDS` | 90 | No new tick for this long shows the "market quiet" flag |
| `MARKET_PREFERRED_FEED` | empty | Preferred broker feed (lowercase slug of the broker server name) |
| `MARKET_FALLBACK_PROVIDER` | empty | `external` enables the labeled fallback |
| `MARKET_SYMBOL_ALIASES` | empty | `BROKERNAME=XAUUSD,...` for names such as `GOLD` |
| `MARKET_PUBLISHER_TAKEOVER_SECONDS` | 15 | Silence before a standby publisher takes over |
| `MARKET_CLOCK_TOLERANCE_SECONDS` | 300 | Allowed EA clock skew |
| `MARKET_SSE_MAX_CLIENTS` / `MARKET_SSE_MAX_PER_USER` | 300 / 3 | Stream connection caps |
| `MARKET_SSE_MAX_LIFETIME_SECONDS` | 120 | Stream lifetime before the browser reconnects |
| `MARKET_STREAM_MIN_INTERVAL_MS` | 250 | Stream flush interval (update throttle) |

No new secrets are required. Website symbols: XAUUSD, EURUSD, GBPUSD, USDJPY; prefixes/suffixes such as `XAUUSD.a` or `m.EURUSD` are mapped automatically.

### Enable it in CornGrid EA

1. In MT5: Tools > Options > Expert Advisors > tick "Allow WebRequest for listed URL" and add `https://corngrid.com` (the origin used by Dashboard Sync).
2. Pair the EA as usual (generate a pairing code, set `Enable account data sync to CornGrid` = true and the code). The market feed requires this pairing and uses its credential.
3. Set `Publish broker prices/candles to the website` = true, then `Broker symbols` (comma separated, broker spelling; empty = chart symbol) and timeframes. The minimum quote interval is 2 s (the existing timer period). Defaults: timeout 1000 ms, 10 s base retry with exponential backoff, 5 consecutive failures then a 5-minute pause.
4. Only one chart per account publishes (terminal global-variable lock); other charts stay idle.
5. WebRequest is synchronous, so a request can delay `OnTick` by up to the timeout. The EA only sends when due, backs off after slow or failed responses, and never retries inline. If that is unacceptable on a live trading chart, run a second EA copy on another chart of the same account with trading disabled.

### Sample payload (example values only, not real market prices)

```json
{
  "schema": 1,
  "sentAtMs": 1893499200000,
  "serverUtcOffsetSec": 10800,
  "eaVersion": "2.7",
  "quotes": [
    { "symbol": "XAUUSD.a", "bid": 1000.10, "ask": 1000.30, "last": null, "spreadPoints": 20,
      "digits": 2, "tickTimeMs": 1893499199500, "tickVolume": null, "volume": null }
  ],
  "candles": [
    { "symbol": "XAUUSD.a", "tf": "M1",
      "bars": [ { "t": 1893510000, "o": 1000.0, "h": 1000.5, "l": 999.8, "c": 1000.1, "tv": 42, "v": null } ] }
  ]
}
```

Responses: `200` accepted, `202` ignored on purpose (`stale` or `standby`), `400` malformed, `401` bad credential, `422` clock skew or unmappable symbols, `429` rate limited, `503` temporary storage failure (retry after the `Retry-After` seconds).

### Test the feed

- Automated: `npm test`. `test/market-feed.test.js` covers auth, validation, replay protection, state transitions, standby/primary, multi-broker selection, fallback labeling, candles, and SSE.
- Manual: with the EA running the Experts log prints `CornGrid market feed: connected`. Market Overview shows LIVE and names the broker feed. Stop the EA: the pill goes DELAYED, STALE, then OFFLINE; restart it and updates resume without a page refresh.

### Chart drawings (Market Overview)

- Horizontal lines and trend lines are saved per user and per symbol. Pick a tool (`— Line`, `／ Trend`), then click or tap the chart. A trend line needs two points. The `✕` button in "Saved drawings" removes one drawing; `Clear` removes them all.
- Drawings survive a timeframe change and a symbol change. A trend line keeps its two prices and is re-anchored onto the nearest bar of the new timeframe, so it stays visible instead of disappearing.
- Only one line is drawn per saved drawing. Changing the timeframe or reloading the page clears the previous lines first, so a saved line can never be duplicated on the chart or left behind as a line that cannot be removed.
- Automated: `test/market-drawings.test.js` locks in the drawing lifecycle (clear before re-apply, no double apply, delete before re-render, trend re-anchoring, clean teardown).

### Diagnose stale or offline data

- OFFLINE and no EA log line: the input is off, pairing is missing, or the EA is stopped.
- "request failed (MT5 error 4014)": the website URL is not in the WebRequest allow-list.
- HTTP 401: credential revoked, re-pair. HTTP 422 about `sentAtMs`: fix the EA computer's clock. `202 standby`: another EA owns the feed.
- LIVE with "market quiet": connected but the broker sent no new tick (market closed or illiquid).
- Missing candles for a timeframe: history is sent one timeframe per request; wait for "initial candle history sent".
- If the browser stays on polling, a proxy is buffering Server-Sent Events. Polling works unchanged; for IIS ARR disable response buffering for `/api/market/stream`.
- `Ignored a client-aborted request (POST /api/mt5/market)`: the EA gave up waiting and closed the connection before the body finished arriving. The log shows how many bytes arrived, e.g. `(30/9000 bytes received ...)` means the upload was cut short. The usual cause is a request that took longer than the EA's WebRequest timeout (default 1000 ms). The server now keeps every request inside that budget: candles are written in batched statements, the candle table carries an index on `symbol` so feed discovery never scans it, open positions and trades are written in batches instead of one statement per row, and all writes share one queue so a candle write can never collide with a heartbeat or an account unlink. If it still happens, raise `InpMarketRequestTimeoutMs` in the EA and check the server's own load.
- The market feed appears dead while the site itself is up: the EA gives up after 1000 ms and closes the socket, so the server logs an aborted request. The backend stays up; what stalls is the shared SQLite connection. A failed candle write now answers `503` with `Retry-After` so the EA retries shortly instead of backing off for minutes, and the process survives an unexpected error instead of exiting and taking the whole site down.

### Security notes

HTTPS only (the EA refuses non-HTTPS URLs). Request size is capped (256 KB, at most 16 quotes, 12 series, 2,000 bars), with a per-installation limit of 90 requests/min. SSE connections are capped globally and per user and recycled every 2 minutes (adjustable with `MARKET_SSE_MAX_LIFETIME_SECONDS`). In-memory structures are bounded by feeds and the four whitelisted symbols. Rate limits are process-local; multi-instance deployments need gateway limits. Stream and quote endpoints require the existing dashboard login; the existing `cors()` setup is unchanged.

### Rollback

Set the EA input `Publish broker prices/candles to the website` = false (trading behavior is unaffected either way) and `MARKET_FALLBACK_PROVIDER=external`; Market Overview then serves the previous provider data, labeled as fallback. To remove entirely, revert `market-feed.js` and the edits in `server.js`, `market-api.js`, `mt5-api.js`, `public/market.js`, `public/dashboard.*`; the `market_candles` table can stay.

## Profile photos

- **Where:** Settings > Profile > Profile photo. Users choose a JPEG, PNG, or WebP, see a preview, then Save, Cancel, or Remove. The browser crops to a square, resizes to at most 512x512, and re-encodes (which drops EXIF/GPS) before upload.
- **Server (`avatar-api.js`):** `PUT /api/user/avatar` (raw image body) and `DELETE /api/user/avatar`, both session-authenticated, rate-limited (10 changes per 10 minutes per user), and always bound to the session user, never a client-supplied ID or URL. The server validates the declared type against the real file structure, rejects SVG/HTML/other types, limits size (default 5 MB) and dimensions (16-2048 px), strips EXIF/XMP/ICC and other metadata from JPEG, PNG, and WebP, rejects animated WebP, and stores the result under a random 32-hex filename.
- **Database:** new table `user_avatars (user_id PRIMARY KEY, file UNIQUE, updated_at)`, created automatically with `CREATE TABLE IF NOT EXISTS` like the other tables. `users` is unchanged, so existing accounts simply have no row and show the initials fallback. Deleting a user cascades the row; leftover files are removed by an hourly orphan sweep.
- **Storage:** files go to `AVATAR_DIR` (default `Corngrid-web/storage/avatars`, git-ignored, outside `public/`) and are served only by `GET /uploads/avatars/<hex>.<jpg|png|webp>` with `nosniff`, a sandbox CSP, and a one-year immutable cache. Each upload gets a new filename, so caches never show a stale photo. **This directory must be on persistent disk** (back it up with the database); on hosts with ephemeral disks, point `AVATAR_DIR` at a persistent volume.
- **Where avatars show:** header, Live Feed posts, comments and replies, profile views, chat conversation list, chat header, and chat bubbles. All APIs resolve the avatar from the author's user record via a join, so there are no extra per-item queries, and old posts/comments/messages update automatically. After a change the open page updates in place with no reload (`CornGridAvatar` in `public/dashboard.js`, shared with `feed.js`).
- **Environment (all optional):** `AVATAR_DIR`, `AVATAR_MAX_BYTES` (default 5242880), `AVATAR_MAX_DIMENSION` (default 2048).
- **Deploy:** pull, restart Node (the table is created on start), ensure `AVATAR_DIR` is writable and persistent. Hard-refresh once because the service worker cache name changed.
- **Rollback:** revert `avatar-api.js` and the edits to `server.js`, `feed-api.js`, `chat-api.js`, `mt5-api.js`, `public/avatar.js`, `public/dashboard.*`, and `public/feed.js`; the `user_avatars` table and `storage/avatars` can be left or deleted.
- **Test:** `npm test` runs `test/avatar-api.test.js`. Manually: sign in, open Settings, choose a photo, Save, then check the header, Live Feed, comments, and chat; then Remove and confirm the initials return.

## Live Market Feed (CornGrid EA to Market Overview)

### Architecture

```
MT5 broker feed -> CornGrid EA (OnTimer, WebRequest) -> POST /api/mt5/market (installation credential)
  -> market-feed.js (validate, in-memory latest quotes + SQLite candles)
  -> SSE /api/market/stream (HTTP polling /api/market/quote as fallback) -> Market Overview chart
```

- The EA reuses the dashboard pairing credential (per-installation bearer secret, stored hashed server-side). No new secret exists and nothing privileged reaches the browser. Account passwords are never transmitted.
- Quotes (bid, ask, optional last, spread in points, digits, UTC tick time) are kept in memory only. Candles (M1-W1) are stored in the `market_candles` SQLite table, capped at 1,500 bars per feed/symbol/timeframe. Ticks are never stored.
- Freshness uses the server's receipt time, never the EA clock: LIVE (<= 10 s), DELAYED (<= 30 s), STALE (<= 120 s), OFFLINE (older). A connected EA with no new broker tick is still LIVE but flagged "market quiet". Thresholds are configurable (see below). A faster update interval is not evidence of zero latency or exchange-grade real-time data.
- Replay/out-of-order protection: each request carries a strictly increasing `sentAtMs`; replays and older ticks are ignored (HTTP 202), and `sentAtMs` more than 5 minutes from server time is rejected (HTTP 422).
- Feeds are identified by the broker server name of the paired account. Brokers are never merged. Per feed/symbol one publisher owns the stream; other EAs get `202 standby` until the owner is silent for 15 s. Quotes and candles are owned separately, so an account that publishes only candles still keeps its stream. Ownership stays with the account that is actually publishing, so several accounts on the same broker server no longer make the visible price flip between them. Across feeds the healthiest feed wins; `MARKET_PREFERRED_FEED` wins while it is LIVE/DELAYED.
- Candle times are broker server time (as on the MT5 chart) and the UTC offset is sent with each request. History is limited to what the EA transmitted (default 300 bars per timeframe on start); there is no invented history.
- Source order: fresh EA feed, then the external provider only if `MARKET_FALLBACK_PROVIDER=external` (labeled FALLBACK, never "CornGrid EA"), then an honest unavailable/OFFLINE state. **Default is off**, so set `MARKET_FALLBACK_PROVIDER=external` to keep the old Twelve Data/Yahoo behavior while no EA publishes.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARKET_LIVE_MAX_AGE_SECONDS` | 10 | Max update age for LIVE |
| `MARKET_DELAYED_MAX_AGE_SECONDS` | 30 | Max age for DELAYED |
| `MARKET_STALE_MAX_AGE_SECONDS` | 120 | Max age for STALE, beyond it OFFLINE |
| `MARKET_QUIET_TICK_SECONDS` | 90 | No new tick for this long shows the "market quiet" flag |
| `MARKET_PREFERRED_FEED` | empty | Preferred broker feed (slug of the broker server name) |
| `MARKET_FALLBACK_PROVIDER` | empty | `external` enables the labeled fallback |
| `MARKET_SYMBOL_ALIASES` | empty | `BROKERNAME=XAUUSD,...` for names such as `GOLD` |
| `MARKET_PUBLISHER_TAKEOVER_SECONDS` | 15 | Silence before a standby publisher takes over |
| `MARKET_CLOCK_TOLERANCE_SECONDS` | 300 | Allowed EA clock skew |
| `MARKET_SSE_MAX_CLIENTS` / `MARKET_SSE_MAX_PER_USER` | 300 / 3 | Stream connection caps |
| `MARKET_SSE_MAX_LIFETIME_SECONDS` | 120 | Stream lifetime before the browser reconnects |
| `MARKET_STREAM_MIN_INTERVAL_MS` | 250 | Stream flush interval (update throttle) |

No new secrets are required. Symbols recognised by the website: XAUUSD, EURUSD, GBPUSD, USDJPY; prefixes/suffixes such as `XAUUSD.a`, `m.EURUSD` are mapped automatically.

### Enable it in CornGrid EA

1. In MT5 allow the website: Tools > Options > Expert Advisors > tick "Allow WebRequest for listed URL" and add `https://corngrid.com` (the same origin used by Dashboard Sync).
2. Pair the EA with the dashboard as usual (generate a pairing code, set `Enable account data sync to CornGrid` = true and the code). The market feed requires this pairing.
3. Set `Publish broker prices/candles to the website` = true. Set `Broker symbols` (comma separated, broker spelling, empty = chart symbol) and the timeframes. Quote interval minimum is 2 s (the existing timer period). Defaults: timeout 1000 ms, retry 10 s base with exponential backoff, 5 failures then a 5-minute pause.
4. Only one chart per account publishes (terminal global-variable lock). Attach the EA to other charts freely; they stay idle.
5. Recommended for production: run the publishing instance on a quiet chart. WebRequest is synchronous, so a timer-triggered request can delay `OnTick` by up to the timeout. The EA skips publishing when it is not due, backs off after slow or failed responses, and never retries inline. If this is unacceptable on a live trading chart, run a second EA copy with trading disabled on another chart of the same account.

### Sample payload (example values only, not real market prices)

```json
{
  "schema": 1,
  "sentAtMs": 1893499200000,
  "serverUtcOffsetSec": 10800,
  "eaVersion": "2.7",
  "quotes": [
    { "symbol": "XAUUSD.a", "bid": 1000.10, "ask": 1000.30, "last": null, "spreadPoints": 20,
      "digits": 2, "tickTimeMs": 1893499199500, "tickVolume": null, "volume": null }
  ],
  "candles": [
    { "symbol": "XAUUSD.a", "tf": "M1",
      "bars": [ { "t": 1893510000, "o": 1000.0, "h": 1000.5, "l": 999.8, "c": 1000.1, "tv": 42, "v": null } ] }
  ]
}
```

Responses: `200` accepted, `202` ignored on purpose (`stale` or `standby`), `400` malformed, `401` bad credential, `422` clock skew or unmappable symbols, `429` rate limited, `503` temporary storage failure (retry after the `Retry-After` seconds).

### Test the feed

- Automated: `npm test` (`test/market-feed.test.js` covers auth, validation, replay protection, state transitions, standby/primary, multi-broker selection, fallback labeling, candles, and SSE).
- Manual: with the EA running, the Experts log prints `CornGrid market feed: connected`. Open Market Overview: the pill shows LIVE and the source line names the broker feed. Stop the EA or disconnect it: the pill goes DELAYED, STALE, then OFFLINE; restart it and updates resume without a page refresh.

### Diagnose stale or offline data

- OFFLINE and no log line: the EA input is off, sync/pairing is missing, or the chart's EA is stopped.
- Experts log "request failed (MT5 error 4014)": the website URL is not in the WebRequest allow-list.
- HTTP 401: credential revoked, re-pair. HTTP 422 `sentAtMs`: fix the EA PC clock. `202 standby`: another EA owns the feed.
- LIVE with "market quiet": connected but the broker sent no new tick (market closed or illiquid).
- No candles for a timeframe: history is still being sent one timeframe per request; wait for "initial candle history sent".
- If the browser stays on polling, a proxy is buffering Server-Sent Events. Polling works without changes; for IIS ARR disable response buffering for `/api/market/stream`.
- `Ignored a client-aborted request (POST /api/mt5/market)`: the EA gave up waiting and closed the connection before the body finished arriving. The log shows how many bytes arrived, e.g. `(30/9000 bytes received ...)` means the upload was cut short. The usual cause is a request that took longer than the EA's WebRequest timeout (default 1000 ms). The server now keeps every request inside that budget: candles are written in batched statements, the candle table carries an index on `symbol` so feed discovery never scans it, open positions and trades are written in batches instead of one statement per row, and all writes share one queue so a candle write can never collide with a heartbeat or an account unlink. If it still happens, raise `InpMarketRequestTimeoutMs` in the EA and check the server's own load.
- The market feed appears dead while the site itself is up: the EA gives up after 1000 ms and closes the socket, so the server logs an aborted request. The backend stays up; what stalls is the shared SQLite connection. A failed candle write now answers `503` with `Retry-After` so the EA retries shortly instead of backing off for minutes, and the process survives an unexpected error instead of exiting and taking the whole site down.

### Security notes

HTTPS only (the EA refuses non-HTTPS URLs); credential only server-side hashed and in the MT5 `MQL5/Files` key file; request size capped (256 KB, at most 16 quotes, 12 series, 2,000 bars); per-installation rate limit of 90 requests/min; SSE connections capped globally and per user and recycled every 2 minutes (adjustable with `MARKET_SSE_MAX_LIFETIME_SECONDS`); in-memory structures are bounded by feeds and the four whitelisted symbols. Rate limits are process-local, so multi-instance deployments need gateway limits. The existing `cors()` setup is unchanged; the stream and quote endpoints require the existing dashboard login.

### Rollback

Set the EA input `Publish broker prices/candles to the website` = false (EA behavior is otherwise unchanged) and set `MARKET_FALLBACK_PROVIDER=external`; Market Overview then serves the previous provider data, labeled as fallback. To remove entirely, revert `market-feed.js`, the `server.js`/`market-api.js`/`mt5-api.js`/`public/market.js` edits, and drop the `market_candles` table (harmless to keep).
