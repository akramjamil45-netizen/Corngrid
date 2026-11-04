# Windows Sandbox Agent Setup

The CornGrid Sandbox Agent runs on each Windows server that hosts MT5 sandboxes. It connects **outbound only** to the CornGrid backend — no inbound firewall rules or port forwarding are required.

## Prerequisites

- Windows Server 2019+ / Windows 10+ (64-bit)
- Node.js ≥ 20.17.0 (LTS) — https://nodejs.org
- The MetaTrader 5 program files placed manually at `C:\CornGrid\Sandbox\MT5\`
  (copy the installed `terminal64.exe` folder contents; include `metaeditor64.exe` on test nodes for EA compilation)
- Outbound HTTPS (443) access to the CornGrid backend

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
