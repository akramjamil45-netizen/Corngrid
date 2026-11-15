# Administrator System Health

Open Admin → System health (`/admin.html#system-health`). `GET /api/admin/system-health` requires the existing administrator session, returns private/no-store responses and performs no writes or external provider requests.

It aggregates backend uptime/memory, host RAM/disk, bounded database latency, fresh node reports, delayed/failed sandboxes and commands, MT5 heartbeat observations, unresolved Stripe verification and agent-update configuration. Database/component errors become generic unavailable states; SQL, connection strings, keys, customer/account details and raw errors are not returned.

Snapshots are cached for 15 seconds and concurrent requests share one collection. The visible page refreshes every 30 seconds, pauses polling when hidden, stops on navigation and supports manual Refresh. Database/component checks have 1.5-second deadlines. A failed database probe prevents follow-up queries. No migration is required for this feature.

Host RAM warns at 90%, critical at 95%; disk warns below 2 GiB, critical below 512 MiB. Node resource warnings use fresh reports only. Sandbox transitions/commands older than ten minutes are flagged for investigation. Offline linked desktop accounts do not automatically mean an EA failed. Open unpaid checkouts are observations; only paid orders awaiting activation are marked critical. Archived/cancelled payment requests are excluded. Local Stripe key/webhook presence does not prove provider connectivity or webhook delivery. Backend health does not prove Cloudflare/IIS or public-domain availability. Keep existing external watchdog checks.

The panel never restarts terminals, reconciles/approves payments, changes licences or clears data. Use existing authorized management workflows to act on an alert. Test with `node --test test/system-health.test.js`.
