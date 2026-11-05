# Sandbox recovery

The agent reconnects its authenticated WebSocket with exponential backoff. Until authentication succeeds it sends heartbeats over HTTP. A ping/pong watchdog closes an unresponsive socket so a network interruption cannot leave the agent attached to a dead connection.

At connection and every minute, the agent requests `/api/sandbox/node/instances`. This authenticated endpoint returns only this node's non-deleted instances in `running` or `starting` state. The agent starts missing terminals from their existing startup files without redeploying files or replacing credentials. Explicitly stopped, suspended, failed and deleted instances are excluded.

Terminal restart history survives each automatic launch: five attempts per ten minutes, then a cooldown before retry. An explicit stop cancels pending retries. Reports exclude dead PIDs and adopted processes are checked before reporting.

Production Windows task `CornGridSandboxAgent` runs at startup under `WINSLET\mohamad akram` with S4U and highest privileges. S4U needs no stored password or interactive login. This avoids the SYSTEM desktop where MT5 failed to create chart windows and reported insufficient handles. Task settings restart the agent after failure, prohibit duplicate task instances and impose no runtime limit. The `CornGridWeb` Windows service starts automatically and recovers after failure.

Agent diagnostics: `C:\CornGrid\Sandbox\AgentData\agent-recovery.log`. Backend/EA heartbeat verification: `node marketing/check-sandbox-recovery.cjs` from the workspace. This diagnostic requires the existing production PostgreSQL configuration and prints no credentials.

Validation includes a real backend service restart, a local WebSocket server restart test, retry/cooldown cancellation tests and node recovery authorization/state filtering tests. A full Windows reboot is not part of the deployment verification.
