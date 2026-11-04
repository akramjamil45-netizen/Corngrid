# CornGrid Sandbox Architecture

## Overview

The CornGrid Sandbox Management System lets users run MetaTrader 5 with the CornGrid EA (or an approved partner EA) on managed remote Windows servers, controlled entirely from their CornGrid dashboard.

```
┌─────────────────────────────────────────────────────────────────┐
│                     CornGrid Main Backend                        │
│  Express 5 + SQLite/PostgreSQL + ws                              │
│                                                                  │
│  sandbox/          partner/           subscriptions/             │
│  ├─ sandbox-manager   ├─ partner-api    └─ subscription-api      │
│  ├─ sandbox-nodes     ├─ partner-admin  (license + payments)     │
│  ├─ sandbox-api       └─ commission-service                      │
│  ├─ sandbox-admin-api                                            │
│  ├─ sandbox-node-api  ◄── HTTPS (agent fallback channel)         │
│  └─ sandbox-realtime  ◄── WSS /ws/sandbox/node, /ws/admin/sandbox│
└──────────────┬───────────────────────────────────────────────────┘
               │  outbound-only WSS/HTTPS (no inbound ports on nodes)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Windows Sandbox Node (agent/agent.js)               │
│  ├─ transport.js     WSS primary, HTTPS polling fallback         │
│  ├─ mt5-manager.js   isolated per-user MT5 terminals             │
│  ├─ ea-tester.js     isolated EA compile/run testing             │
│  └─ system-monitor.js CPU / RAM / disk sampling                  │
│                                                                  │
│  C:\CornGrid\Sandbox\MT5\            base terminal files         │
│  C:\CornGrid\Sandbox\Users\sbx_*     per-user isolated copies    │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Main Backend (`Corngrid-web/`)
- Reuses the existing Express app, JWT user auth (`user-auth.js`), admin auth (`admin-auth.js`), and the subscription/license system (`subscriptions/subscription-api.js`).
- The sandbox subsystem is composed in `sandbox/index.js`; the partner subsystem in `partner/index.js`. Both follow the existing `register*(app, db, ...)` module pattern.
- SQLite deployments self-apply the schema from `sandbox/sandbox-schema.js`. PostgreSQL deployments apply `migrations/postgres/0005_sandbox.sql`.

### 2. Sandbox Manager (`sandbox/sandbox-manager.js`)
Orchestrates activation: validates input → verifies the active subscription via `subscriptionApi.eligibleSubscription` → allocates a node → creates the instance + AES-256-GCM-encrypted credentials → creates/reuses the `mt5_accounts` row, an installation secret, and an `ea_license_activations` row (automatic license integration) → queues the `deploy` command.

### 3. Node Registry (`sandbox/sandbox-nodes.js`)
- Node tokens are shown once at creation and stored as SHA-256 hashes.
- Heartbeats update resource metrics and reconcile per-instance status with a strict state-transition table.
- Commands are persisted in `sandbox_deployments` (queued → sent → completed/failed) and pushed over WebSocket when the agent is connected; agents also poll via HTTPS.
- `allocateNode` picks the active non-test node with the most free slots, breaking ties by lowest CPU.

### 4. Realtime Hub (`sandbox/sandbox-realtime.js`)
- `/ws/sandbox/node` — agent channel. First message must be `{type:'auth', nodeUid, token}` within 5 s.
- `/ws/admin/sandbox` — admin monitor. Authenticated from the HttpOnly session cookie on the upgrade request (query-token fallback for tooling). Receives every sandbox event plus a 15 s snapshot broadcast.
- A 30 s sweep marks nodes offline when their heartbeat lapses.

### 5. Windows Sandbox Agent (`agent/`)
- Node.js service (only dependency: `ws`). Runs under a Scheduled Task or NSSM.
- Outbound connections only — no inbound firewall rules needed.
- Manages the full MT5 lifecycle per sandbox: robocopy the base terminal into an isolated directory, write auto-login config + license bundle, download the EA, launch `terminal64.exe /portable`, monitor, restart on crash (max 5 restarts / 10 min), tear down on delete.

### 6. MT5 Execution Environment
- Base files are placed manually at `C:\CornGrid\Sandbox\MT5\` (validated before every deploy).
- Each sandbox is a full isolated copy launched with `/portable`, so terminal data lives inside the instance directory. Users can never share a data directory.
- Auto-login via `config/common.ini` (`[Common] Login/Password/Server`, `[Experts] AllowTrading=1`).
- The EA reads its license bundle from `MQL5/Files/corngrid_sandbox.ini` (installation secret + API base URL) — no user key entry.
- Pause/resume trading is signalled through `MQL5/Files/corngrid_pause.flag`, polled by the EA.

### 7. Dashboards
- User: `public/sandbox.js` (Sandbox page) and `public/partner.js` (Partner Program page) on the existing dashboard shell.
- Admin: `public/admin-sandbox.js` adds Sandbox Management, EA Submissions, and Commissions pages to the existing admin panel, with live updates over the admin WebSocket.

## Event model

All significant transitions are persisted to `sandbox_events` and broadcast to admin dashboards:

`SANDBOX_REQUESTED, SANDBOX_ALLOCATED, SANDBOX_DEPLOYING, SANDBOX_STARTED, SANDBOX_STOPPED, SANDBOX_FAILED, SANDBOX_DELETED, SANDBOX_SUSPENDED, MT5_CONNECTED, MT5_DISCONNECTED, LICENSE_VALIDATED, NODE_ONLINE, NODE_OFFLINE, NODE_REGISTERED, EA_SUBMITTED, EA_APPROVED, EA_REJECTED, EA_PUBLISHED, EA_TEST_STARTED, EA_TEST_FINISHED, COMMISSION_GENERATED, PAYOUT_REQUESTED, PAYOUT_APPROVED, PAYOUT_PAID`

## Idempotency & concurrency

- One active sandbox per user, enforced by a partial unique index (`sandbox_instances.user_id WHERE deleted_at IS NULL`). Repeated Activate clicks return the existing sandbox.
- Commission rows carry a unique `idempotency_key` (`payment:<id>:partner:<id>`), so replayed payment hooks can never double-pay.
- Command rows expire after 5 minutes if never acknowledged.
- Multi-step writes run inside the existing `db-write.js` exclusive queue (SQLite) or a pinned transaction (PostgreSQL).
