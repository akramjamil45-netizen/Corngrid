# Sandbox Server Setup (Backend Host)

How to configure the CornGrid main backend to run the sandbox system.

## 1. Environment variables

Add these to `Corngrid-web/.env`:

```ini
# Required in production: 64 hex chars (32 bytes) for AES-256-GCM credential encryption.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SANDBOX_ENCRYPTION_KEY=<64-hex-chars>

# Public base URL of the backend, sent to agents so EAs can phone home.
APP_BASE_URL=https://corngrid.com

# Demo account used by isolated EA testing on test nodes (optional but recommended).
EA_TEST_BROKER_SERVER=YourBroker-Demo
EA_TEST_ACCOUNT_NUMBER=12345678
EA_TEST_ACCOUNT_PASSWORD=<demo-password>
```

The encryption key must live in the environment (or a secrets manager), **never** in the database or source control. In development, an ephemeral per-process key is generated with a warning; sandbox credentials encrypted with it become unreadable after a restart.

## 2. Database

**SQLite (default):** nothing to do — the schema self-applies at startup from `sandbox/sandbox-schema.js`.

**PostgreSQL:** apply the migration:

```powershell
npm run migrate:postgres:schema
```

This applies `migrations/postgres/0005_sandbox.sql` (idempotent).

## 3. Install dependencies

```powershell
npm install
```

This adds `ws` (WebSocket) used by the realtime hub.

## 4. Start the server

```powershell
npm start
```

Verify:

- `GET /api/health` returns 200.
- `GET /api/sandbox/strategies` returns 401 unauthenticated (route registered).
- The default `corngrid-ea` strategy is seeded into `trading_strategies`.

## 5. Publish the CornGrid EA binary for sandbox deployment

The agent downloads the EA binary from the backend when deploying a sandbox. Point the default strategy at a compiled `.ex5` in `storage/`:

```sql
UPDATE trading_strategies
SET ea_file_name = 'Corngrid_v2.7.ex5',
    ea_file_path = 'ea-downloads/Corngrid_v2.7.ex5',
    version = '2.7'
WHERE code = 'corngrid-ea';
```

`ea_file_path` is relative to `Corngrid-web/storage/`. The node download endpoint (`/api/sandbox/node/strategies/:code/ea`) refuses paths outside `storage/`.

## 6. Register the first node

Admin panel → **Sandbox Management** → **Sandbox Nodes** → **+ Add node**. Copy the shown Node ID and token into the agent configuration on the Windows server (see `WINDOWS_AGENT_SETUP.md`), then activate the node.

## 7. Reverse proxy notes

The WebSocket endpoints (`/ws/sandbox/node`, `/ws/admin/sandbox`) must be proxied with upgrade support:

- **IIS/ARR:** enable WebSocket Protocol (Windows feature), ensure the reverse proxy rule forwards `/ws/*`.
- **Cloudflare:** WebSockets are supported on all plans; no extra config.
- **nginx:** `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`

If WebSocket is blocked, agents automatically fall back to HTTPS heartbeat/polling — commands are delivered on the next poll instead of instantly.
