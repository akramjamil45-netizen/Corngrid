# Sandbox API Documentation

All APIs are JSON over HTTPS. User routes require the CornGrid user session (JWT Bearer or HttpOnly cookie). Admin routes require the admin session. Node routes require `X-Node-Id` + `X-Node-Token` headers.

## User API

| Method | Route | Description |
|---|---|---|
| GET | `/api/sandbox/strategies` | List published strategies available for sandbox deployment. |
| GET | `/api/sandbox/status` | Live status: sandbox, subscription, node, MT5 connection. |
| POST | `/api/sandbox/activate` | Activate a sandbox. Body: `{strategyCode, brokerServer, accountNumber, password}`. Idempotent — repeated calls return the existing sandbox. Requires an active subscription. |
| POST | `/api/sandbox/start` | Start a stopped/failed sandbox. |
| POST | `/api/sandbox/stop` | Stop the terminal. Keeps configuration and subscription. |
| POST | `/api/sandbox/restart` | Restart the terminal. |
| POST | `/api/sandbox/pause` | Pause EA trading (terminal keeps running). |
| POST | `/api/sandbox/resume` | Resume EA trading. |
| POST | `/api/sandbox/reconnect` | Force MT5 to re-establish the broker session. |
| DELETE | `/api/sandbox` | Delete the sandbox. Body: `{confirm: true}` required. Purges stored credentials and revokes the installation secret. |

### Activation flow

1. Input validated (broker server 2–100 chars, account number 1–32 digits, password ≤ 128 chars).
2. Subscription verified via the existing subscription system (`eligibleSubscription`).
3. Node allocated (load-balanced by free slots, then lowest CPU).
4. Instance + AES-256-GCM-encrypted credentials created.
5. MT5 account linked, installation secret generated, license activation created automatically.
6. `deploy` command queued for the node's agent.

Errors: `403 SUBSCRIPTION_REQUIRED`, `503 NO_CAPACITY`, `409` (account linked to another user).

## Admin API — Sandbox

| Method | Route | Description |
|---|---|---|
| GET | `/api/admin/sandbox/overview` | Node/instance/user/capacity statistics. |
| GET | `/api/admin/sandbox/nodes` | List nodes with live resource data. |
| POST | `/api/admin/sandbox/nodes` | Create a node. Body: `{name, maxInstances?, isTestNode?}`. Returns the plaintext token **once**. |
| POST | `/api/admin/sandbox/nodes/:id/status` | `{status: 'active' \| 'disabled'}`. |
| POST | `/api/admin/sandbox/nodes/:id/rotate-token` | Rotate the node token (returned once). |
| POST | `/api/admin/sandbox/nodes/:id/restart-agent` | Queue an agent restart. |
| DELETE | `/api/admin/sandbox/nodes/:id` | Remove a node (must host no sandboxes). |
| GET | `/api/admin/sandbox/instances` | List/search instances. Query: `search`, `status`, `page`, `pageSize`. |
| POST | `/api/admin/sandbox/instances/:id/control` | `{action: 'start'|'stop'|'restart'|'suspend'|'unsuspend'}`. |
| POST | `/api/admin/sandbox/instances/:id/reassign` | `{nodeId}` — tear down and redeploy on another node. |
| DELETE | `/api/admin/sandbox/instances/:id` | Delete an instance. |
| GET | `/api/admin/sandbox/logs` | Deployment logs. Query: `instanceId`, `nodeId`, `level`, `page`. |
| GET | `/api/admin/sandbox/events` | Event audit stream. Query: `type`, `page`. |
| GET | `/api/admin/sandbox/monitoring` | Aggregated node metrics + recent deployments. Query: `hours`. |

All admin mutations are written to `subscription_audit_logs`.

## Node Agent API (node token auth)

| Method | Route | Description |
|---|---|---|
| POST | `/api/sandbox/node/heartbeat` | Resource + instance report in; pending commands out. |
| GET | `/api/sandbox/node/commands` | Poll queued commands (marks them sent; they expire after 5 min). |
| POST | `/api/sandbox/node/commands/:commandUid/result` | Report `{success, result?, error?}`. |
| POST | `/api/sandbox/node/logs` | Batch log upload: `{entries: [{level, instanceUid?, message}]}`. |
| GET | `/api/sandbox/node/strategies/:code/ea` | Download the published EA binary for a strategy. |
| GET | `/api/admin/ea-testing/:id/source` | List a submission's source files (test nodes). |
| GET | `/api/admin/ea-testing/:id/source/:filename` | Download one source file. |
| POST | `/api/admin/ea-testing/reports/:reportId/complete` | Submit a test report. |

## WebSocket channels

- `wss://<host>/ws/sandbox/node` — agent channel. First message `{type:'auth', nodeUid, token}` within 5 s. Then `{type:'heartbeat', ...}` / `{type:'command_result', ...}`; server pushes `{type:'command', ...}`.
- `wss://<host>/ws/admin/sandbox` — admin monitor. Authenticated from the session cookie (or `?token=` fallback). Receives `{type:'snapshot'}` on connect + every 15 s, and `{type:'event'}` for every sandbox event.

## Partner API

| Method | Route | Description |
|---|---|---|
| POST | `/api/partner/register` | `{displayName, company?, website?}`. |
| GET / PUT | `/api/partner/profile` | Read/update the partner profile (payout details stored encrypted). |
| GET | `/api/partner/overview` | Earnings, payout, and submission totals. |
| GET | `/api/partner/submissions` | List own submissions. |
| GET | `/api/partner/submissions/:uid` | Detail with versions and test reports. |
| POST | `/api/partner/submissions` | Submit an EA. Body: metadata + `files: [{name, contentBase64}]` (`.mq5`/`.mqh`/`.zip`, ≤ 10 MB each, ≤ 20 files). |
| GET | `/api/partner/transactions` | Own commission ledger. |
| GET | `/api/partner/payouts` | Own payout history. |

## Admin API — Partner Program

| Method | Route | Description |
|---|---|---|
| GET | `/api/admin/partners` | List partners with submission/earnings totals. |
| POST | `/api/admin/partners/:userId/status` | `{status: 'active' \| 'suspended'}`. |
| GET | `/api/admin/ea-submissions` | List submissions. Query: `status`. |
| GET | `/api/admin/ea-submissions/:id` | Detail: files, versions, test reports. |
| GET | `/api/admin/ea-submissions/:id/files/:filename` | Download a source file for review. |
| POST | `/api/admin/ea-submissions/:id/review` | pending_review → under_review. |
| POST | `/api/admin/ea-submissions/:id/test` | Deploy to an online **test node** and run isolated tests. |
| POST | `/api/admin/ea-submissions/:id/approve` | testing_passed/under_review → approved. |
| POST | `/api/admin/ea-submissions/:id/reject` | `{reason}` (≥ 5 chars) → rejected. |
| POST | `/api/admin/ea-submissions/:id/publish` | approved → published; creates the `trading_strategies` row. |
| GET / POST | `/api/admin/commissions` | List / create commission rules. |
| PUT | `/api/admin/commissions/:id` | Update a rule (rate, model, threshold, active). |
| GET | `/api/admin/commissions/transactions` | Ledger. Query: `status`. |
| POST | `/api/admin/commissions/transactions/:id/status` | `{status: 'approved' \| 'rejected'}` (pending only). |
| GET / POST | `/api/admin/payouts` | List payouts / record a manual payout (settles approved commissions). |
| POST | `/api/admin/payouts/:id/status` | `{status: 'approved' \| 'paid' \| 'rejected'}`. |
