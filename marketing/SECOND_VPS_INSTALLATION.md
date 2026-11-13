# VPS81258 sandbox agent installation

Installed and verified on 13 November 2026.

- Node: CornGrid VPS81258, database ID 5.
- Agent root: `C:\CornGrid\agent`.
- Sandbox root: `C:\CornGrid\Sandbox`.
- Runtime: Node.js 24.20.0, Python 3.13.9, MetaTrader5 Python package 5.0.6231, NumPy 2.3.5.
- Clean MT5 runtime copied from the installed JustMarkets terminal. No customer account files copied.
- Startup/recovery task: `CornGridSandboxManagedAgent`, interactive Administrator session, starts at logon and retries every minute with IgnoreNew.
- One launcher and one worker verified. HTTPS authentication and backend health checks passed. WebSocket connection and heartbeat verified.
- Signed auto-update public key pinned. The agent downloaded the centrally published release, restarted its worker gracefully, reported a healthy update, and reconnected successfully.
- Original RoboForex MT5 process (PID 5220) preserved.
- Temporary node credential transfer file removed after backend identity verification. Node credentials remain only in the protected agent configuration on the VPS.
- Installation archives removed from `C:\CornGrid\InstallTemp` after runtime verification.

## Hosting state

Node remains **pending**, online, with configured capacity **1**, and zero assigned sandboxes. Final local sample: 1500 MB total RAM, 95 MB free RAM, 690 MB free disk. Do not activate for customer hosting with this headroom. Add resources or review memory/storage use, then recheck before activating it in Admin. Capacity is an assignment limit, not proof that the VPS has enough resources.

The interactive Windows session must stay logged on. Disconnect Remote Desktop rather than signing out. This installation does not configure automatic Windows login.

No broker login, EA execution or demo trade was performed. Those require an explicitly selected demo account and should follow resource remediation. Installation checks alone do not prove successful trading.

## Verification artifacts

- `second-vps-runtime-result.json`: installed runtime versions.
- `second-vps-agent-result.json`: task, process, MT5 preservation and resource checks.
- `second-node-provision-result.json`: node identity and completed credential transfer; no token.
- VPS: `C:\CornGrid\installation-result.json`, `C:\CornGrid\installation-check.log`, `C:\CornGrid\Sandbox\AgentData\agent-updater.log`.

Setup helpers have a VPS81258 hostname guard. These operational scripts are specific to this installation; they are not production website changes.

## User-requested cleanup, 13 November 2026

MT4 RoboForex and Firefox were uninstalled using their vendor uninstallers. The MT4 personal-data deletion option stayed unchecked; Firefox profiles were preserved. Mozilla Maintenance was also removed by the Firefox uninstall process. A leftover broken MT4 desktop shortcut was removed after its exact target path was verified.

Disabled optional services: DiagTrack, SysMain, WSearch and Spooler (no queued print jobs). Windows Search indexing and printing consequently remain unavailable until those services are re-enabled. Edge startup boost/background mode and Chrome background mode were disabled. Browser security updater tasks remain enabled.

Previous service modes and browser policy values are stored on the VPS under `C:\CornGrid\Sandbox\AgentData\Maintenance-20261113-085148\settings-before.json`. Regenerable cache files were cleaned with an explicit path allowlist, age checks, no reparse-point traversal and locked-file skipping. Windows component store and installer caches were preserved.

Verified free disk increased from 690 MB before maintenance to 944 MB. Verification confirmed MT4/Firefox executables and Mozilla registrations are absent, optional services are disabled/stopped, and Defender, firewall, Remote Desktop and Task Scheduler remain running. Original MT5 PID 5220 and the CornGrid agent task remained running. Post-cleanup installation and HTTPS authentication checks returned exit code 0. The setup PowerShell console was closed to release its memory.

The subsequent backend heartbeat confirmed the agent remained online on version `1.2.2+53be40452dd2`, with 299 MB free RAM and 944 MB free disk. Node remained pending, capacity 1, zero assigned sandboxes. RAM availability fluctuates and no demo trading load test has been performed.

Local reports: `C:\CornGrid\cleanup-audit.json`, `cleanup-result.json`, `cleanup-verification.json`, `post-cleanup-check.log`. Sanitized copies are in `marketing/second-vps-cleanup-*.json`. Node remains pending with capacity 1; maintenance does not activate customer hosting or prove sufficient trading headroom.
