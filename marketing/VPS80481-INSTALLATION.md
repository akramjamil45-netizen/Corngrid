# VPS80481 installation — 13 November 2026

CornGrid Sandbox Agent is installed on Windows VPS `188.42.230.32` as
`CornGrid VPS80481` (admin node ID `4`). The backend confirms **Active / Online**,
with a maximum of **2 hosting sandboxes**, zero customer sandboxes at handoff,
and the test-node flag disabled. Existing CornGrid nodes were not reconfigured.

## Installed configuration

- Agent: `C:\CornGrid\agent`, agent version `1.1.0`.
- Task: `CornGridSandboxAgent`, `Administrator`, Interactive logon.
- Clean MT5 runtime: `C:\CornGrid\Sandbox\MT5`.
- Customer terminal directories: `C:\CornGrid\Sandbox\Users`.
- Agent logs: `C:\CornGrid\Sandbox\AgentData\agent-recovery.log`.
- Node.js `26.13.1`, Python `3.12.2` x64, MetaTrader5 Python `5.0.6231`.
- NumPy `2.3.5` uses `numpy<2.4` for the exposed legacy virtual CPU.
- Node credentials are local to the VPS with restricted NTFS permissions.
  The temporary credential transfer copy has been removed.
- A local handoff file is also installed at `C:\CornGrid\README-VPS80481.txt`.

## Verification

| Check | Result |
| --- | --- |
| Installation diagnostic | All 16 checks passed |
| Backend HTTPS authentication and WSS connection | Passed |
| Two isolated MT5 processes simultaneously | Passed; both responsive |
| Disposable test terminals and folders removed | Passed |
| Python IPC to the existing MT5 terminal, read only | Passed; terminal build 6230, connected |
| Existing MT5 terminal preserved | Passed; no process or account changes |
| Agent exits and returns after admin restart | Passed after recovery-trigger fix |
| Duplicate task prevention | One agent process observed across repeated triggers |
| Automated installer/diagnostic/bundle regression tests | 4 passed |
| New sandbox broker login, EA licence/WebRequest and trading | Not tested; requires a demo sandbox with valid entitlements |
| Real Windows reboot recovery | Not tested |

The disposable terminals had no broker login or EA. Their Python initialization
timed out (`-10005`); do not count this as successful sandbox login. The separate
read-only check against the already connected original terminal confirmed that
Python can communicate with MT5 in this Windows session.

## Recovery and resource limits

The original RestartOnFailure setting did not relaunch an agent that exited
with code 1. The installer now also registers an indefinite one-minute trigger
with `IgnoreNew`; the live VPS successfully recovered automatically. Disable
the task before an intentional maintenance stop. Merely copying a new installer
to another node does not update that node's existing scheduled task.

Keep the Windows account logged in; disconnect RDP instead of signing out.
After a real reboot, log in to that account. No autologon credentials were set.

The VPS reports 1,500 MB RAM, one logical CPU, and approximately 702 MB free on
C: after cleanup. During the two-terminal smoke test, free RAM was approximately
181 MB. Capacity 2 is a configured maximum; two customer EAs under actual load
have not been validated. Use demo accounts for the remaining acceptance test
and check the assigned node, broker, symbol, licence, WebRequest and EA telemetry.

General setup: [VPS_NODE_INSTALLATION.md](../Corngrid-web/docs/VPS_NODE_INSTALLATION.md).

## Subsequent maintenance — 13 November 2026

Firefox and Mozilla Maintenance Service have been removed. Old temporary files,
pip download cache, old Windows Update download payloads and a hash-verified
duplicate Python installer were cleaned. Browser profiles and trading files
were preserved.

SysMain and DiagTrack are Disabled/Stopped. Edge Startup Boost and Edge/Chrome
background mode are disabled through registry policies; browser update tasks
remain enabled. Prior service/policy settings are backed up on the VPS at
`C:\CornGrid\Sandbox\AgentData\VpsMaintenance-20261113-004815\settings-before.json`.

Final measured free disk is **2,037 MB**, compared with **702 MB** before
maintenance (an increase of **1,335 MB**). The existing MT5 process is running,
one CornGrid agent is running, the node remains Active/Online with capacity 2,
and all 16 installation diagnostics pass. Defender, Firewall, Task Scheduler
and RDP services are running.

Windows has pending update servicing that requires a reboot. Component-store
cleanup was deferred; no reboot or DISM ResetBase was performed. Arrange a
maintenance window for reboot, log back in to the same Windows account, verify
MT5 and node heartbeat, then reassess component cleanup. The detailed local VPS
verification is `C:\CornGrid\Sandbox\AgentData\maintenance-result.json`.

## Automatic agent updates enabled

The node now runs signed agent **1.2.2** through **CornGridSandboxManagedAgent**.
The old CornGridSandboxAgent task is disabled. The verified automatic update
from 1.2.1 to 1.2.2 retained the existing MT5 PID and private configuration hash.
Future normal code updates are deployed centrally; see
[NODE_AUTO_UPDATE_DEPLOYMENT.md](NODE_AUTO_UPDATE_DEPLOYMENT.md).
