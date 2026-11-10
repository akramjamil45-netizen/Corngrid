# Windows Sandbox Agent Setup

The CornGrid Sandbox Agent runs on each Windows server that hosts MT5 sandboxes. It connects **outbound only** to the CornGrid backend — no inbound firewall rules or port forwarding are required.

## Prerequisites

- Windows Server 2019+ / Windows 10+ (64-bit)
- Node.js ≥ 20.17.0 (LTS) — https://nodejs.org
- The MetaTrader 5 program files placed manually at `C:\CornGrid\Sandbox\MT5\`
  (copy the installed `terminal64.exe` folder contents; include `metaeditor64.exe` on test nodes for EA compilation)
- Outbound HTTPS (443) access to the CornGrid backend
- 64-bit Python 3 and its MetaTrader5 package for broker login/symbol verification:

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\agent\setup-broker-tools.ps1 -PythonPath C:\Python313\python.exe
  ```

  Set `mt5PythonPath` in `agent-config.json` to that interpreter. Use an English MT5 base terminal. The agent drives MT5's own broker directory in the same Windows account/session as the terminal; it does not create a trading account.

## Broker discovery and symbol mapping

Before starting an EA on a new deployment, the agent launches an isolated terminal with algorithmic trading disabled, searches MT5's broker directory, verifies the requested account/server with the saved trading password, and reads that account's symbols. A failed login, an investor-only password, a different account/server, or an ambiguous symbol stops deployment with an error. There is no automatic switch to another account or numbered server.

The actual server spelling returned by MT5 seeds both startup and CornGrid dashboard credentials. `XAUUSD` can resolve to a unique broker variant such as `XAUUSD.c`, `XAUUSDm`, or `GOLD`; the same suffix matching applies to EURUSD, GBPUSD and USDJPY. Exact symbols take priority. Disabled, close-only, one-direction and custom instruments are excluded. Multiple eligible variants require an explicit mapping:

```json
{
  "mt5PythonPath": "C:\\Python313\\python.exe",
  "brokerCacheDir": "C:\\CornGrid\\Sandbox\\BrokerCaches",
  "brokerSymbolMaps": {
    "Broker-Demo": { "XAUUSD": "XAUUSDm", "EURUSD": "EURUSDm" }
  },
  "brokerAccountSymbolMaps": {
    "Broker-Demo": { "12345678": { "XAUUSD": "XAUUSD.c" } }
  }
}
```

Account mappings override server mappings and must exist in the account's live symbol list. The shared cache contains only `config/servers.dat`, never account databases, passwords or dashboard keys. Missing caches trigger discovery again. `config/broker-resolution.json` records the verified server/symbol for each sandbox without credentials. Existing running terminals are adopted during an agent upgrade; idle legacy terminals are verified on their next start. Keep Python tools and the MT5 base updated when broker builds change.

Official API references: [initialize](https://www.mql5.com/en/docs/python_metatrader5/mt5initialize_py), [symbols_get](https://www.mql5.com/en/docs/python_metatrader5/mt5symbolsget_py).

## Directory layout

```
C:\CornGrid\Sandbox\
  MT5\            <- base terminal files (you place these manually)
  Users\          <- per-user isolated instances (agent-managed)
  AgentData\      <- downloaded EAs, test workspaces, logs
```

## Install

1. Copy the `agent/` folder to the server, e.g. `C:\CornGrid\agent\`.

2. Install dependencies:

   ```powershell
   cd C:\CornGrid\agent
   npm install --omit=dev
   ```

3. Create `agent-config.json` (copy `agent-config.example.json`):

   ```json
   {
     "backendUrl": "https://corngrid.com",
     "nodeUid": "node_xxxxxxxxxxxxxxxxxx",
     "nodeToken": "cgn_xxxxxxxx...",
     "mt5BaseDir": "C:\\CornGrid\\Sandbox\\MT5",
     "sandboxUsersDir": "C:\\CornGrid\\Sandbox\\Users",
     "agentDataDir": "C:\\CornGrid\\Sandbox\\AgentData",
     "heartbeatIntervalMs": 15000
   }
   ```

   The `nodeUid`/`nodeToken` come from the admin panel (Sandbox Management → Add node). The token is shown **once**.

4. Restrict the config file (it contains the node token):

   ```powershell
   icacls C:\CornGrid\agent\agent-config.json /inheritance:r /grant:r "SYSTEM:F" "Administrators:F"
   ```

5. Register the agent to start at boot (elevated PowerShell):

   ```powershell
   cd C:\CornGrid\agent
   npm run install:task
   ```

   This registers a Scheduled Task (`CornGridSandboxAgent`) running as SYSTEM with automatic restart on failure.

   **Production alternative — NSSM (recommended):**

   ```powershell
   nssm install CornGridSandboxAgent "C:\Program Files\nodejs\node.exe" "C:\CornGrid\agent\agent.js"
   nssm set CornGridSandboxAgent AppDirectory C:\CornGrid\agent
   nssm set CornGridSandboxAgent AppRestartDelay 5000
   nssm start CornGridSandboxAgent
   ```

6. Verify: in the admin panel the node should show **online** within ~15 seconds, with CPU/RAM/disk metrics.

## Running under a restricted account

For strongest isolation, run the agent (and therefore the MT5 terminals) under a dedicated low-privilege Windows account instead of SYSTEM:

1. Create `CornGridAgent` user, grant it full control only over `C:\CornGrid\Sandbox\` and `C:\CornGrid\agent\`.
2. Deny that account access to other users' profile directories.
3. Register the task/service under that account.

## Updating the agent

1. Stop the task/service.
2. Replace the `agent/` files.
3. `npm install --omit=dev`
4. Start the task/service. Running terminals are adopted automatically (the agent reconciles by scanning `sandboxUsersDir`).

## Uninstall

```powershell
npm run uninstall:task   # removes the scheduled task
```

Then delete the directories. Deleting a node in the admin panel requires its sandboxes to be reassigned or deleted first.

## Troubleshooting

- **Node shows offline:** check outbound connectivity to the backend, and that the token in `agent-config.json` matches (rotate it in the admin panel if unsure).
- **"MT5 terminal not found":** place the MT5 program files in `mt5BaseDir` and restart the agent.
- **Deploy fails immediately:** check the admin Deployment Logs tab — the agent uploads its log buffer with every heartbeat.

## Required EA chart and dashboard sync startup

Users choose XAUUSD, EURUSD, GBPUSD or USDJPY when activating a sandbox; XAUUSD is the default. The validated pair is saved in the deployment payload and used for the EA chart. Older deployment payloads can use `startupSymbol` in `agent-config.json` (or `CORNGRID_STARTUP_SYMBOL`), otherwise they default to XAUUSD. Deployment generates `config/sandbox-startup.ini` and launches MT5 with `/portable /config:<path>`. Its `[StartUp]` section attaches the published EA and loads `MQL5/Presets/corngrid-sandbox.set`, which enables dashboard sync. The installation credential is provisioned in the EA's existing `CGDash_*.key` format; the accompanying settings fingerprint matches the EA's credential-reset checks. Credentials must never be logged.

A running terminal process alone does not confirm broker login or EA telemetry. Confirm broker authorization and EA loading in the terminal journals, then verify the account heartbeat in the dashboard. The API origin must also be allowed in the terminal's WebRequest settings.

Older instances need their startup configuration generated from their original deployment payload before restarting; restarting the agent alone does not retrofit a chart or preset. Keep the existing account, strategy binary and installation credential when repairing an instance.
