# Windows Sandbox Agent Setup

Reviewed against the repository on **13 November 2026**. For the complete Malay
VPS installation walkthrough, see [VPS_NODE_INSTALLATION_WINDOWS.md](VPS_NODE_INSTALLATION_WINDOWS.md).
This guide replaces the old unconditional SYSTEM/NSSM startup recommendation.

## Requirements and package

- Windows x64 VPS with Desktop Experience/RDP and an English MT5 program base.
  The broker discovery helper controls MT5 windows. Ubuntu/Linux uses a separate
  Wine/systemd installation and broker seeds: [Linux guide](VPS_NODE_INSTALLATION_LINUX.md).
  Windows Server Core does not meet this Windows GUI workflow requirement.
- Use a supported Node.js LTS. Node.js 24 LTS is the documented baseline; the
  package minimum >=20.17.0 is not an instruction to install EOL Node.js 20.
- Python 3.13 x64 and the MetaTrader5 Python package are required for broker
  login/symbol preflight. Node Online does not prove these tools are installed.
- Outbound HTTPS/WSS to the public CornGrid origin and connectivity to brokers.
  No inbound agent port, copied database, IIS or backend secrets are required.

Build the current bundle from the Website repository root:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Corngrid-web\scripts\build-node-agent.ps1'

The allowlisted ZIP contains 23 agent files, five guides and a per-file SHA-256
manifest. It excludes live config, node_modules, Python dependencies, logs and
customer runtime data. Do not copy an old node's identity to a new VPS.

## Fresh VPS installation

1. Extract CornGrid-Node-Agent.zip under C:\CornGrid. Create separate directories
   Sandbox\MT5, Sandbox\Users, Sandbox\AgentData and Sandbox\BrokerCaches.
2. Copy the complete clean MT5 program directory into Sandbox\MT5; use English
   UI for the broker discovery helper. Test nodes also need metaeditor64.exe.
3. Register a new node in Admin > Sandbox Management; retain its one-time token
   and activate it. A hosting node must not be marked as a test node.
4. In C:\CornGrid\agent, install dependencies and create local config:

       npm.cmd ci --omit=dev
       Copy-Item .\agent-config.example.json .\agent-config.json
       powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-broker-tools.ps1 -PythonPath 'C:\Python313\python.exe'

5. Set backendUrl to the public HTTPS origin, the new nodeUid/nodeToken, absolute
   local MT5/work paths and mt5PythonPath to that exact Python x64 interpreter.
   Do not use localhost for another VPS. Environment CORNGRID_* values override
   JSON; remove stale overrides if applicable. Restrict config access to the
   actual task account and authorized administrators/SYSTEM.
6. Prepare EA WebRequest settings on this VPS under the same Windows account.
   CornGrid EA uses https://corngrid.com, https://control.corngrid.com and
   https://nfs.faireconomy.media. Use MT5's actual Open Data Folder path for
   webRequestSettingsSource. Protected settings copied from another account or
   computer must not be assumed valid.
7. Optional brokerServerDataDirs profiles seed config/servers.dat only. The
   agent still verifies account/server and live symbols via Python. Exact symbols
   or unique variants resolve automatically; ambiguous variants require
   brokerSymbolMaps, with brokerAccountSymbolMaps taking precedence per account.

## Diagnostics and manual acceptance

    node .\check-installation.js --online
    node .\agent-launcher.js --trust-update-key
    node .\agent-launcher.js

Run the trust command once, after configuring the central signed-release
publisher. Preserve an existing pin and skip that command on subsequent starts.
Keep a new node Pending until runtime/resource checks pass. Online proves agent
connectivity; enable hosting only for the controlled demo acceptance below when
the machine has enough memory and disk. A capacity setting does not reserve RAM.

Resolve FAIL results before starting. Add --test-node to check MetaEditor.
Diagnostics import Python/MetaTrader5 without initializing a terminal and check
HTTPS health plus read-only node authentication. They do not send heartbeats,
consume commands, attach a live node WebSocket or start trading. They do not prove
ACLs, WSS, broker login, protected WebRequest settings or EA runtime behavior.

The actual agent should validate the MT5 base and authenticate over WSS. HTTPS
polling is the fallback. Admin should show Active and Online with fresh metrics;
heartbeats normally arrive every 15 seconds and become offline after ~90 seconds.
Proxy/WAF challenges must not block authenticated agent API or WebSocket paths.

Deploy one demo sandbox and verify Assigned node, broker identity, chart symbol,
loaded EA/preset, Journal/Experts and account telemetry. Marketplace publication
does not add CornGrid telemetry support to a partner EA. Existing subscriptions
and shared activation/node capacity limits still apply. Adding a node does not
move existing terminals.

## Startup task

Agent 1.2 tasks start `agent-launcher.js`. Pin the central update public key once
with `node .\agent-launcher.js --trust-update-key` before task installation. For
legacy task handover, central release publication and rollback, see
[NODE_AUTO_UPDATES.md](NODE_AUTO_UPDATES.md). A raw `node agent.js` run remains a
manual diagnostic mode and does not automatically activate releases.

Stop the manual agent first. From elevated PowerShell under the same Windows
account used for MT5 setup:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-service.ps1 -Mode Interactive
    Get-ScheduledTask -TaskName CornGridSandboxAgent
    Get-ScheduledTaskInfo -TaskName CornGridSandboxAgent

The current VPS walkthrough uses `-TaskName CornGridSandboxManagedAgent` to make
the managed task explicit. The installer default above remains
`CornGridSandboxAgent`; use your actual task name for diagnostics and maintenance.
The process-scoped ExecutionPolicy argument avoids changing machine policy.

Interactive is now the default. It uses an AtLogOn trigger, the selected user,
Interactive logon, automatic restart, no execution time limit and IgnoreNew.
A second trigger retries every minute indefinitely when the task has exited;
IgnoreNew prevents a second task instance while the agent is running. This also
recovers application exits that Windows treats as completed tasks rather than
task failures. Disable the task before an intentional maintenance stop.
Use -UserId 'VPSNAME\CornGridAgent' to choose a different prepared user. That user
must be logged on. After reboot, log in; disconnecting RDP differs from signing
out. Check provider/RDP session policies and test actual reboot recovery.

- -WhatIf previews registration without registering or starting a task.
- -NoStart skips the immediate start; enabled scheduled triggers still apply.
- Existing registrations are rejected unless -Replace is explicitly supplied.
- A Running existing task is always rejected; the installer does not stop it.

SYSTEM at boot is an explicit advanced option: -Mode System. Existing installed
tasks are not changed by copying these files. SYSTEM/NSSM uses another session;
Online alone cannot validate broker window automation or protected WebRequest.
Test under that exact context before hosting users. Installing NSSM does not
resolve desktop/session dependencies by itself.

## Updates, recovery and removal

Back up local config. Plan maintenance before stopping tasks or switching users;
forced task termination may affect child processes. Replace package code while
preserving local identity and Sandbox\Users. Reinstall locked dependencies if
the lockfile changed. Run diagnostics, restart the agent and verify each terminal.

The agent reconciles surviving processes and requests assigned running/starting
instances for recovery. Recovery still depends on valid local instance files,
account permissions and broker connectivity. Stopped/suspended/deleted instances
must not be auto-started. Test reboot behavior rather than assuming recovery.

uninstall-service.ps1 removes the default scheduled task. Before deleting folders
or a backend node, explicitly migrate/retire its sandboxes; uninstalling the task
is not authorization to delete user terminal data.

## References

- [Node release status](https://nodejs.org/en/about/previous-releases)
- [Microsoft task principal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)
- [MetaTrader5 Python](https://www.mql5.com/en/docs/python_metatrader5)
- [MT5 portable startup](https://www.metatrader5.com/en/terminal/help/start_advanced/start)
- [EA publication](PARTNER_PUBLICATION.md)
