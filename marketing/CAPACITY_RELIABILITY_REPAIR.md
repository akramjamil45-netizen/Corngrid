# Capacity save and IIS queue repair — 13 November 2026

The website host is Windows 10 Home. Persistent Sandbox agent/admin WebSockets occupied the IIS request quota. With an admin page live, the IIS request queue reached 5 while PostgreSQL was idle and the direct Express API remained responsive. Closing that admin socket drained the queue to zero; the identical capacity request then completed in 56ms.

The deployed `CornGridGateway` Windows service listens only on `127.0.0.1:8080`. API, SSE and WebSocket requests stream directly to the existing backend on port 3000. `CorngridMaster` IIS now handles pages/static files on loopback port 18080. The control site on port 80 is unchanged. Gateway startup/recovery is independent of normal application-backend restarts.

The admin capacity workflow now confirms state after interrupted responses, retries at most once, preserves input on failure, prevents stale concurrent edits, and avoids duplicate audit writes for already-saved values. Sandbox deep links and the header Refresh action now work correctly. PostgreSQL timeouts and service monitoring bound failures and recover the relevant service.

Validation:

- `npm test`: **278 tests, 277 passed, 0 failed, 1 skipped**. The optional PostgreSQL test was then run explicitly against a random isolated schema and **passed**; that schema was removed.
- A real mobile browser opened **three authenticated live admin pages**, with ordinary PWA registration enabled. A successful capacity response was deliberately lost: the UI read back the saved value, closed its dialog and sent only **one** mutation. Completion took **414ms**.
- During those three live sessions, all IIS request queues were **0** and **16** additional local/domain probes succeeded. Maximum probe latency was **147ms**.
- Gateway tests cover concurrent authenticated sockets plus an API write, raw webhook/upload byte preservation, cookie/Origin forwarding, denied unauthenticated access, static routing and unavailable-upstream handling.
- Both hosting nodes remained online on release **1.2.2+53be40452dd2**. The two customer sandboxes remained running; all seven original MT5 process IDs were preserved.
- Final watchdog checks: backend healthy, gateway healthy, public HTTP 200, four tunnel connections, no pending recovery actions.

Deployment/rollback locations:

- Gateway runtime/service configuration: `C:\ProgramData\CornGrid\Gateway`.
- Original IIS binding: `C:\ProgramData\CornGrid\Gateway\binding-before.json`.
- Application backups: `C:\ProgramData\CornGrid\WebsiteBackups\capacity-*`.
- The tunnel currently uses HTTP/2 and warning-level rotated logs. It was evaluated during diagnosis; the confirmed bottleneck was IIS, and the gateway is the fix for that quota.
- Full operating notes: `Corngrid-web/docs/WEBSITE_RELIABILITY.md`.

No subscription migration, broker credential change, terminal stop command or new production test account was required. Configured capacities at this repair were Winslet **10** (2 occupied) and VPS80481 **2**.

The separate VPS81258 node has since been installed, registered and verified online with signed auto-update. MT4/Firefox cleanup was completed at the user's request. It remains Pending with one configured slot and zero assigned sandboxes because resources are limited; see `SECOND_VPS_INSTALLATION.md` for the completed installation and verification record.
