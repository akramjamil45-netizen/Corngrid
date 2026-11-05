# Sandbox automatic recovery

The production `CornGridSandboxAgent` scheduled task runs in the signed-in
Windows user's interactive session. MT5 failed to create its EA chart in session
0, so an unattended noninteractive launch is not a verified substitute.

- Boot and user logon triggers start the agent when an interactive session is available.
- A repeating trigger runs every minute with `IgnoreNew`, recovering a stopped
  agent without launching concurrent task instances.
- Task failures retry every minute, with no task execution time limit.
- The agent restarts unexpectedly closed MT5 terminals after an initial two-second
  delay. Repeated crashes enter a cooldown before retrying.
- An explicit sandbox Stop remains intentional and cancels terminal recovery.
- After a computer restart, Windows sign-in is required. Locking the session is
  supported; signing out removes the interactive session. Automatic Windows
  sign-in has not been configured.

`verify-sandbox-autorestart.ps1` backs up the task, configures recovery triggers,
restarts the agent and closes only the target LiteFinance terminal to verify
automatic recovery. This interrupts that terminal briefly. It does not reboot
Windows. The result is written to `sandbox-autorestart-result.json`.

Verified on 2026-11-05: agent restart recovered the terminal, then closing MT5
changed PID 13460 to 20396 in session 2. Agent logs recorded a two-second retry.
The 12 agent recovery and MT5 startup tests passed.
