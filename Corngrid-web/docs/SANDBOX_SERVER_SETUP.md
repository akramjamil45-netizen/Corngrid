# Sandbox Server Setup (Backend Host)

How to configure the CornGrid main backend to run the sandbox system.

This document is for the **existing backend host**, not another MT5 VPS. For an
additional node use [VPS_NODE_INSTALLATION.md](VPS_NODE_INSTALLATION.md). Do not
copy the backend `.env`, PostgreSQL data, encryption key or payment keys to nodes.

## 1. Environment variables

Add these to `Corngrid-web/.env`:

```ini
# Required in production: 64 hex chars (32 bytes) for AES-256-GCM credential encryption.
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SANDBOX_ENCRYPTION_KEY=<64-hex-chars>

# Public base URL of the backend, sent to agents so EAs can phone home.
APP_BASE_URL=https://corngrid.com

# Source compile review uses an assigned test node and needs no demo credentials.
# Real runtime/demo testing remains a separate administrative review step.
```

The encryption key must live in the environment (or a secrets manager), **never** in the database or source control. In development, an ephemeral per-process key is generated with a warning; sandbox credentials encrypted with it become unreadable after a restart.

## 2. Database

**SQLite (default):** nothing to do — the schema self-applies at startup from `sandbox/sandbox-schema.js`.

**PostgreSQL:** apply the migration:

```powershell
npm run migrate:postgres:schema
```

The script applies all sorted PostgreSQL migrations, not only 0005. Inspect and
back up the deployment first. Current sandbox/publication code also requires
0014 (multiple sandboxes), 0015 (Marketplace) and 0016 (reviewed EA publication).
Adding an ordinary node to an already migrated backend does not require a new
database or a migration on that VPS.

## 3. Install dependencies

```powershell
npm.cmd ci --omit=dev
```

Use the existing lockfile. Node agents install their own small dependency set;
do not install the backend dependency tree on a hosting node.

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
- **Cloudflare:** verify WebSockets, TLS and WAF/challenge rules for the actual
  deployment. Agent paths need token authentication, not an interactive browser
  challenge. Do not disable authentication or weaken rules across unrelated routes.
- **nginx:** `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`

If WebSocket is blocked, agents automatically fall back to HTTPS heartbeat/polling — commands are delivered on the next poll instead of instantly.
