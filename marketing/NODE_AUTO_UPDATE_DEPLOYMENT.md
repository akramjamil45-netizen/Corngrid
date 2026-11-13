# Automatic node updates — deployment verification

Completed on 13 November 2026. Central publication, signed downloads, staged
dependencies, agent handover, rollback and the one-time launcher installation
are implemented. No database migration was required.

At the original rollout, both existing nodes were Active/Online on **1.2.2**:

| Node | ID | Capacity | Existing hosted sandboxes |
| --- | --- | --- | --- |
| CornGrid winslet | 3 | 20 | 2 |
| CornGrid VPS80481 | 4 | 2 | 0 |

Later on the same day, Winslet capacity was set to 10 during the capacity-save
repair. VPS81258 was added with one configured slot, online but Pending due to
limited resources. These later changes do not alter the rollout measurements
below; see `SECOND_VPS_INSTALLATION.md` for the third node's installation.

The real rollout from 1.2.1 to 1.2.2 was triggered by a central source deployment
only. No website restart, node restart command or per-VPS code copy was used for
that rollout. Both nodes downloaded and activated release
`53be40452dd24b217008becd5bba7ebfb876297098ef0b4911777efca02f3c7a` (sequence 3).
The active file hashes match the signed payload on both nodes.

The two WINSLET sandbox terminals retained PIDs **8288** and **15988** across the
update. Their status remained running, no authentication error was recorded,
and fresh CornGrid EA 2.7 heartbeats were confirmed afterward. The five other
WINSLET MT5 terminals and the VPS80481 terminal (PID **3172**) also retained their
PIDs. Private node config hashes were unchanged across the verified update.
Each node has exactly one launcher and one agent worker.

Full regression suite: **267 tests passed**. The final package/version checks
also passed **12 tests** after the 1.2.2 metadata update. Tests include signature
tampering, file/path restrictions, interrupted activation, network failures,
busy-worker deferral, rollback and an actual Windows process-survival test using
the real MT5 manager launch path with a harmless timer executable.

During the initial legacy-task migration, the two WINSLET sandbox terminals
stopped and were recovered automatically. The old manager had launched MT5 as
attached Windows children. This was corrected in 1.2.1 using detached launches;
the subsequent 1.2.1-to-1.2.2 rollout verified process continuity. Existing
non-sandbox terminals were preserved throughout.

The new task on both existing nodes is **CornGridSandboxManagedAgent**. The
legacy **CornGridSandboxAgent** task is disabled. Keep the Interactive Windows
session logged on; disconnect RDP instead of signing out. WINSLET's agent origin
was migrated from local HTTP to `https://corngrid.com` for authenticated HTTPS
updates, preserving its identity/token and operational paths.

Private signing storage is outside the website at
`C:\ProgramData\CornGrid\NodeUpdates`, with protected NTFS access. Each node pins
the public key; no private signing key is transferred to a node. The central
pause control is enabled for normal rollout at handoff. Agent code is checked
roughly every five minutes; publication checks run every minute.

For future releases, from the Website repository root on WINSLET:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\marketing\publish-node-update.ps1
```

That command tests, builds, backs up source and deploys RELEASE.json last.
Normal agent-code updates then propagate automatically. The stable bootstrap
protocol, trust-anchor changes and Node.js/Python upgrades remain explicit
maintenance operations. Actual OS reboot recovery was not performed during this
deployment.

Implementation and setup: [NODE_AUTO_UPDATES.md](../Corngrid-web/docs/NODE_AUTO_UPDATES.md).
The per-node verification files are saved in each configured AgentData directory
as `auto-update-verification.json`.
