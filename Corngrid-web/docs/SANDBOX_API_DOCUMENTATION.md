# Sandbox API Documentation

All APIs are JSON over HTTPS. User routes require the CornGrid user session (JWT Bearer or HttpOnly cookie). Admin routes require the admin session. Node routes require `X-Node-Id` + `X-Node-Token` headers.

For adding a VPS see [VPS_NODE_INSTALLATION.md](VPS_NODE_INSTALLATION.md).
Current partner release review and compile-only test-node behavior are described
in [PARTNER_PUBLICATION.md](PARTNER_PUBLICATION.md).

## User API

| Method | Route | Description |
|---|---|---|
| GET | `/api/sandbox/strategies` | List published strategies available for sandbox deployment. |
| GET | `/api/sandbox/status` | Returns `sandboxes[]`, `capacity`, subscription and selected `sandbox`/node/MT5 connection. Optional `?instanceUid=sbx_...` selects an owned instance; foreign/unknown IDs return 404. |
| POST | `/api/sandbox/activate` | Body: `{strategyCode, symbol, brokerServer, accountNumber, password}`. Retries for the same broker/account return its existing sandbox. New accounts share the existing EA activation allowance. |
| POST | `/api/sandbox/start` | Start a stopped/failed sandbox. |
| POST | `/api/sandbox/stop` | Stop the terminal. Keeps configuration and subscription. |
| POST | `/api/sandbox/restart` | Restart the terminal. |
| POST | `/api/sandbox/pause` | Pause EA trading (terminal keeps running). |
| POST | `/api/sandbox/resume` | Resume EA trading. |
| POST | `/api/sandbox/reconnect` | Force MT5 to re-establish the broker session. |
| DELETE | `/api/sandbox` | Body: `{instanceUid, confirm: true}`. Removes only the selected sandbox, purges its credentials and revokes its account's installation secrets. Preserves the existing EA activation and subscription. |

Controls (`start`, `stop`, `restart`, `pause`, `resume`, `reconnect`) accept `{instanceUid}`.
Omitting this identifier is supported only when the caller has zero/one live instance;
multiple instances return `409 INSTANCE_REQUIRED`, preventing legacy clients from
operating on an arbitrary account. Admin control/delete routes also select the exact instance.

`capacity` contains `maxSandboxes`, `sandboxCount`, `activeActivations`, `canAdd`.
The maximum uses the eligible subscription's existing `max_activations`, not a new
subscription system. Desktop EA activations consume the same allowance. At the
activation limit an already licensed MT5 account without a sandbox can still be
hosted; a new account cannot. Stopped/failed sandboxes still count toward the user's
sandbox allowance; stopped/failed processes release physical node slots, and starting
them again must reserve capacity. Deleting a sandbox preserves its EA activation;
license revocation remains an explicit administration operation.

### Activation flow

1. Input validated (broker server 2–100 chars, account number 1–32 digits, password ≤ 128 chars).
2. Subscription verified via the existing subscription system (`eligibleSubscription`).
3. Lock the user and subscription; check sandbox count and the shared activation count.
4. Reserve node capacity under its database lock (load-balanced by free slots, then lowest CPU).
5. Instance + AES-256-GCM-encrypted credentials created.
6. MT5 account linked, installation secret generated, license activation created/reused without rotating an active license identifier.
7. Persist the deploy command in the same transaction; deliver to the agent after commit.

Errors: `403 SUBSCRIPTION_REQUIRED`, `403 SANDBOX_LIMIT_REACHED`, `403 ACTIVATION_LIMIT_REACHED`, `403 ACTIVATION_BLOCKED`, `503 NO_CAPACITY`, `409` (account linked to another user).

Apply `migrations/postgres/0014_multiple_sandboxes.sql` before deploying the backend.
It replaces the singleton user index with a per-user/broker/account unique index;
existing instances and credentials are preserved. SQLite applies the equivalent
index change at startup. No new environment variables or agent update is needed:
the agent already isolates processes and directories by `instanceUid`.

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
| GET | `/api/sandbox/node/instances` | Read-only assigned running/starting instance IDs for recovery/auth diagnostics. Does not consume commands. |
| POST | `/api/sandbox/node/commands/:commandUid/result` | Report `{success, result?, error?}`. |
| POST | `/api/sandbox/node/logs` | Batch log upload: `{entries: [{level, instanceUid?, message}]}`. |
| GET | `/api/sandbox/node/strategies/:code/ea` | Download the published EA binary for a strategy. |
| GET | `/api/admin/ea-testing/:id/source` | List a submission's source files (test nodes). |
| GET | `/api/admin/ea-testing/:id/source/:filename` | Download one source file. |
| POST | `/api/admin/ea-testing/reports/:reportId/complete` | Assigned test node reports compilation; success requires the stored exact EX5 artifact. |
| POST | `/api/admin/ea-testing/reports/:reportId/artifact` | Assigned active test node uploads raw compiled EX5 before reporting successful compilation. |

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
| POST | `/api/partner/submissions` | Metadata + EA files (.ex5/.mq5/.mqh/.zip, 10 MB/file, 20 files, 20 MB total), per-pair .set presets and requestKey. Creates a linked private listing; see Partner Publication. |
| GET | `/api/partner/transactions` | Own commission ledger. |
| GET | `/api/partner/payouts` | Own payout history. |

## Admin API — Partner Program

| Method | Route | Description |
|---|---|---|
| GET | `/api/admin/partners` | List partners with submission/earnings totals. |
| POST | `/api/admin/partners/:userId/status` | `{status: 'active' \| 'suspended'}`. |
| GET | `/api/admin/ea-submissions` | List submissions. Query: `status`. |
| GET | `/api/admin/ea-submissions/:id` | Files, versions, compile reports, presets and current publication reviewDigest. |
| GET | `/api/admin/ea-submissions/:id/files/:filename` | Download an uploaded EA/source file for private admin review. |
| POST | `/api/admin/ea-submissions/:id/review` | Start review from pending_review or explicitly resume after testing_failed. |
| POST | `/api/admin/ea-submissions/:id/test` | Compile the current MQ5 submission on an assigned online test node. This does not claim runtime trading validation. |
| POST | `/api/admin/ea-submissions/:id/approve` | Body {reviewDigest}; atomically approve reviewed EX5/presets and publish the linked Marketplace listing and Sandbox strategy. |
| POST | `/api/admin/ea-submissions/:id/reject` | `{reason}` (≥ 5 chars) → rejected. |
| POST | `/api/admin/ea-submissions/:id/publish` | Compatibility alias for the same idempotent approve-and-publish operation; requires reviewDigest. |
| GET / POST | `/api/admin/commissions` | List / create commission rules. |
| PUT | `/api/admin/commissions/:id` | Update a rule (rate, model, threshold, active). |
| GET | `/api/admin/commissions/transactions` | Ledger. Query: `status`. |
| POST | `/api/admin/commissions/transactions/:id/status` | `{status: 'approved' \| 'rejected'}` (pending only). |
| GET / POST | `/api/admin/payouts` | List payouts / record a manual payout (settles approved commissions). |
| POST | `/api/admin/payouts/:id/status` | `{status: 'approved' \| 'paid' \| 'rejected'}`. |
