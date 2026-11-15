# Resource-aware sandbox placement

The existing allocator keeps its active/non-test/fresh-heartbeat/slot checks and PostgreSQL node lock. Before accepting a new deployment or user start/restart, it now checks resource/platform eligibility again **inside that transaction**. Manual node assignment cannot bypass the policy. No running instance is moved, stopped or de-licensed when resources fall below thresholds.

Fresh agent reports must include OS, total/used RAM, free disk, CPU percentage and running instance count. Unknown/malformed telemetry cannot prove a safe placement and is refused. The first agent CPU sample can be unknown: allow the next heartbeat rather than raising capacity to bypass it. Future timestamps beyond one minute are refused. Supported platform strings are the existing agent reports `Windows_NT ...` and `Linux ...`; Linux still requires the Wine/demo acceptance in its separate installation guide.

Defaults, configurable on the backend through `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_MIN_FREE_RAM_MB` | 256 | RAM reserve after accepting a sandbox |
| `SANDBOX_INSTANCE_RAM_MB` | 256 | Estimated additional RAM per pending/new placement |
| `SANDBOX_MIN_FREE_DISK_MB` | 1024 | Disk reserve |
| `SANDBOX_INSTANCE_DISK_MB` | 512 | Estimated additional disk per pending/new placement |
| `SANDBOX_MAX_CPU_PERCENT` | 90 | Refuse placement at/above this CPU usage |
| `SANDBOX_ALLOWED_NODE_PLATFORMS` | windows,linux | Backend-authorized platforms |

These estimates are minimum admission budgets, not promises that every EA uses only that RAM/disk. Wine prefixes, MT5 builds and EA/chart workloads can require more; raise estimates after measuring a demo node. Compare `occupied reservations - reported running terminals` to reserve estimated resources for commands not yet reflected in the next heartbeat. License allowance and physical slots are still separate limits and both apply.

Admin node responses include `placement` with safe reason codes and effective free resources. The existing node table explains blocked placements. Editing maximum capacity does not override this resource policy. A disk report of zero now replaces earlier free-space telemetry instead of retaining an obsolete value.

Deployment does not change any database schema. Before enabling hosting after deployment, let each node send complete telemetry and review blocked-placement reasons. Start with a demo node. Existing running-terminal recovery after an ordinary agent restart is unchanged.
