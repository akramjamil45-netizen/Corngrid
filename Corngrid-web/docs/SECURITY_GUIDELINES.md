# Security Guidelines — CornGrid Sandbox System

The sandbox system handles trading credentials and executable programs. These rules are mandatory.

## Credential protection

- MT5 passwords are encrypted at rest with **AES-256-GCM** (`sandbox/sandbox-crypto.js`). The key comes from `SANDBOX_ENCRYPTION_KEY` (64 hex chars) in the environment — never from the database, source control, or logs.
- Passwords are decrypted **in memory only**, at the moment a deploy/reassign command is dispatched to the authenticated node over TLS.
- Passwords are never returned by any API, never written to any log, and never sent to the browser. The API only ever exposes the masked account number (`account_masked`).
- Deleting a sandbox purges `sandbox_credentials` and revokes the installation secrets.
- Partner payout details are encrypted the same way (`payout_details_cipher`).

## Key management

- Rotate `SANDBOX_ENCRYPTION_KEY` by deploying a new key version and re-encrypting records lazily (the `v1.` payload prefix and `key_version` column support this).
- Node tokens are shown once at creation/rotation and stored as SHA-256 hashes; verification uses `crypto.timingSafeEqual`.
- Rotate a node token from the admin panel if a node may be compromised; the old token stops working immediately.

## User isolation

- One active sandbox per user, enforced by a partial unique index.
- Every user route scopes queries to `req.user.id`; there is no way to reference another user's sandbox.
- Each sandbox is a separate MT5 `/portable` copy in its own directory; the agent validates every `instanceUid` (`sbx_` + 18 hex chars) and resolves paths against the sandbox root before touching the filesystem, so path traversal is not possible.
- The agent spawns processes with argument arrays (no shell), eliminating command injection.

## Node authentication & transport

- Nodes authenticate with `X-Node-Id` + `X-Node-Token` (HTTPS) or a first-message auth (WSS, 5 s timeout).
- All agent traffic is **outbound only**; nodes need no inbound ports, shrinking their attack surface.
- Disabled nodes are rejected at authentication.
- Commands expire after 5 minutes if never acknowledged.

## EA submission safety

- Uploads are restricted to `.mq5`/`.mqh`/`.zip` with size limits, filename sanitization, and ZIP magic-byte validation.
- A static heuristic scan flags dangerous constructs (non-system DLL imports, process creation, registry writes, arbitrary file ops, raw networking).
- **Untrusted code never runs on production nodes or the main server.** Testing happens only on nodes flagged `is_test_node`, in throwaway isolated instances with a demo account, bounded observation time, and full teardown.
- Only admin-approved **and** published EAs appear in the user strategy selection.

## API hardening

- All routes require authentication; admin routes require the admin role; partner routes require an active partner profile.
- Rate limiting on activation, uploads, node traffic, and login/recovery (existing).
- Input validation on every field; parameterized SQL everywhere.
- Admin mutations are written to `subscription_audit_logs` with actor, action, and IP.
- Sandbox state transitions from agent reports follow a strict transition table — a stale or malicious report cannot resurrect a deleted/suspended sandbox.

## Financial integrity

- `partner_transactions` is an immutable ledger: amounts are never updated after insert; only status transitions occur, each audited.
- Commission idempotency keys (`payment:<id>:partner:<id>`, UNIQUE) prevent duplicate payments on hook replays.
- Payouts settle specific approved transactions through `partner_payout_transactions` (`transaction_id` UNIQUE), so a commission can never be paid twice.
- Payouts are capped at the partner's available approved balance.

## Operational recommendations

- Run the agent under a dedicated low-privilege Windows account (see `WINDOWS_AGENT_SETUP.md`).
- Restrict `agent-config.json` ACLs (it holds the node token).
- Serve the backend over HTTPS only; set `TRUST_PROXY=1` behind IIS/Cloudflare so rate limits and audit IPs are correct.
- Keep `NODE_ENV=production` in production — this enforces `SANDBOX_ENCRYPTION_KEY`, `JWT_SECRET`, and SMTP configuration at startup.
- Review the admin **System Events** tab regularly; every sandbox/node/EA/commission event is persisted there.
