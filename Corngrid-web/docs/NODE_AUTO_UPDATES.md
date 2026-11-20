# Signed automatic Sandbox Agent updates

## Deployment hardening in 1.3.3

Version 1.3.3 skips process inventory entirely when there are no deployed
sandbox directories. The two low-memory idle VPS nodes rolled back 1.3.2
during startup; a subsequent read-only inventory on VPS80792 passed, so no
permanent CIM/permission failure was established. Empty nodes need neither
PowerShell nor access to unrelated manual terminals to connect. Startup
inventory errors now persist a sanitized diagnostic in agent-recovery.log.
The central publisher supports `-AgentTestsOnly` for an agent-only maintenance
patch after the full platform suite has passed. This still runs all agent,
broker, packaging, updater, sandbox API/realtime and compilation regression
files plus the Python broker tests before deploying. Backend changes require
the default full suite; this switch never skips a failed selected test.

The 1.3.1 rollout exposed a startup timing regression on the central node with
historical sandbox directories: repeated Windows CIM queries plus waiting for
the IPC keeper exceeded the launcher's 120-second health deadline. Rollback
preserved MT5 terminals and EA telemetry. Version 1.3.2 adopts terminals from
one Windows process inventory and initializes the keeper only on deployment;
backend authentication no longer waits for an unused broker probe. An invalid
or incomplete process inventory aborts startup rather than guessing that user
terminals are absent. Custom MT5 bases retain their sibling IpcProbe directory
and the existing CORNGRID_IPC_PROBE_DIR override.

The project source includes the Windows fixes previously published in 1.2.5,
while retaining the Linux/Wine runtime. New deployments use credentials during
MT5 initialization and validate the returned account, server, trading permission
and live symbol list before downloading/starting the EA. The entire shared
Windows IPC probe transaction is serialized, including broker cache reloads;
different accounts cannot change its login in the middle of another preflight.
Linux probes retain independent Wine prefixes and also use the preflight queue.

An exact XAUUSD match takes precedence, followed by the complete GOLD alias.
Prefix-only alternatives remain ambiguous unless configured explicitly. Account
and broker symbol mappings override automatic resolution and must refer to a
tradable symbol actually returned by that account.

Per-instance controls and recovery are serialized. WebSocket/HTTPS redelivery
with the same command ID reuses its in-memory outcome (bounded to 256 entries);
an intentional retry must receive a new backend command ID. This is not a
persistent exactly-once guarantee across agent restarts. Interrupted deployments
leave an incomplete marker until successful launch. Failed deployments attempt
cleanup with bounded file-lock retries. Start rejects incomplete environments
with a redeploy instruction, including legacy directories missing their licence.

The Windows IPC keeper has its own directory and starts with EA/live trading
disabled. It survives child-agent updates. A new deployment never stops a
running user terminal to acquire IPC port 22346. If a legacy terminal owns the
port, schedule a node maintenance handover before enabling new deployments.
Do not fix this by killing all terminal64.exe processes. The keeper directory
must not overlap the MT5 base or sandbox users directory.

Error -10005 is an internal/IPC timeout, not proof of an incorrect password;
-6 indicates authorization failure. Only transient IPC failures retry (at most
three attempts). See the [MetaQuotes error definitions](https://www.mql5.com/en/docs/python_metatrader5/mt5lasterror_py).
Broker outages, invalid credentials, missing server seeds and insufficient node
resources can still block deployment safely; these checks must not be bypassed.

Regression coverage: `broker-deploy.test.js`, `broker-resolution.test.js`,
`ipc-probe.test.js`, `node-command-execution.test.js`, `mt5-startup.test.js`,
`agent-recovery.test.js`, `linux-agent.test.js`, and `broker_probe_test.py`.
The Python tests use a fake MT5 API and never connect to a real account.

The protocol-v1 launcher keeps the Windows scheduled task or Linux systemd agent service alive while replacing
its agent child. Agent releases live in separate, immutable directories under
`agentDataDir\node-releases`. An atomic pointer selects the active version.
Updating the agent does not stop, delete, redeploy or reconfigure MT5 terminals.
The new agent adopts their existing processes through the existing recovery API.

Linux installation uses [its own guide](VPS_NODE_INSTALLATION_LINUX.md). It needs
Wine, Windows Python, Xvfb and systemd user units; setting a package OS flag alone
does not make MT5 native Linux. Linux nodes reject older Windows-only releases.
The immutable launcher respects `CORNGRID_AGENT_CONFIG_FILE` for `/etc/corngrid`.
Pin the public trust key as root with group-read access for `corngrid`; keep
bootstrap code root-owned. MT5 runs in independent user units, so restarting the
system agent service does not kill terminals. Keep normal control-group cleanup
for every unit; do not change to `KillMode=process`. Updating bootstrap services
and installer scripts is an explicit operator task, separate from signed child
agent updates. Validate Linux changes on a demo node before central publication.

Build the Linux installer separately with
`node Corngrid-web/scripts/build-linux-node-agent.js` from the Website root.
It generates `CornGrid-Node-Agent-Linux.tar.gz` and its checksum without publishing
the release or changing any running node. The Windows ZIP retains its existing
PowerShell builder and includes the separate platform guides.

## Central deployment

1. Change the agent code and update `agent/package.json` and the root package
   versions in `agent/package-lock.json` when assigning a new software version.
   Content hashes also detect code changes without a version-number change.
2. Run `npm test` in `Corngrid-web`.
3. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
   .\Corngrid-web\scripts\build-node-agent.ps1` from the Website root. This
   generates `agent/RELEASE.json` and the installer ZIP.
4. Deploy the agent source files to the central server and copy **RELEASE.json
   last**. Do not deploy live node config, tokens, Python tools or terminal data.
5. The backend checks every minute in a separate publisher process. It requires
   every deployed source hash to match RELEASE.json and checks JavaScript syntax
   before publishing. Partial deployments keep the previous release available.
6. Each bootstrapped node checks roughly every five minutes, with initial jitter.
   A node that was offline catches up when it reconnects.

For this repository's WINSLET deployment, the complete central command is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\marketing\publish-node-update.ps1
```

It tests, builds and copies the release marker last. It sends no node restart
commands and does not restart the website. `-SkipTests` is available when the
same source has already passed CI; do not use it to bypass a failed test.

Only these backend variables are needed:

```dotenv
SANDBOX_NODE_AUTO_UPDATE=true
SANDBOX_NODE_UPDATE_DIR=C:\ProgramData\CornGrid\NodeUpdates
```

Use a directory **outside the website**. On Windows protect that directory and
its descendants with NTFS permissions for the backend service identity, SYSTEM,
administrators and the authorized deployment account. The publisher creates and
retains `signing-key.pem` there; never publish, copy to a VPS, log or commit this
private key. Back it up securely: existing nodes pin its public key. Copying a
replacement public key silently is deliberately unsupported.

The first setup needs a website service restart to load these settings/routes.
Subsequent complete agent deployments publish automatically without a backend
restart. Manual publication uses `node scripts/publish-node-release.js` with
the same environment settings.

## One-time setup on each node

Install the current ZIP while preserving `agent-config.json`, `broker-python`,
node identity, MT5 runtime and sandbox data. Under the same Windows account as
MT5, in the agent directory:

```powershell
node .\check-installation.js --online
node .\agent-launcher.js --trust-update-key
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-service.ps1 -Mode Interactive
```

The explicit trust command authenticates to the configured HTTPS origin and
pins an Ed25519 public key in `update-trust.pem`. It refuses to replace an
existing pin. The scheduled task now starts `agent-launcher.js`; a directly
started `agent.js` has no supervising launcher and cannot activate updates.

For an already-running legacy task, disable its future triggers, gracefully
exit the old agent through the existing admin restart-agent command, and start
a new launcher task under the same Interactive principal. A separate task name
can be used for the handover (for example `CornGridSandboxManagedAgent`). Do not
force-stop the legacy task or its process tree: MT5 processes can belong to its
Windows job. Retain the disabled legacy task until a maintenance window if its
job still contains live terminals. Do not run two agents for the same Node ID.

This bootstrap is performed once. Normal operational agent-code changes then
require only the central deployment above. The stable launcher is protocol v1;
changes to that bootstrap protocol, Node.js/Python runtimes or the trust anchor
remain explicit maintenance operations. Python tools are shared from the
original agent home, including legacy-CPU NumPy constraints.

Legacy agents before 1.2.1 launched MT5 as attached Windows children. Their
first handover can stop those terminals when the old agent job exits. Perform
that initial migration in a maintenance window and verify automatic recovery
and fresh EA telemetry afterward. Agent 1.2.1 launches MT5 detached, allowing
subsequent child-agent changes to retain the same terminal processes. The
Windows regression test runs the real manager's launch path with a harmless
timer executable and verifies that it survives its agent parent's exit.

## Validation, activation and rollback

- Node authentication applies to metadata, public-key and release downloads.
  HTTPS redirects are rejected so credentials stay at the configured origin.
- Ed25519 signatures cover the complete payload, its sequence, file names,
  sizes, hashes and bytes. Paths, traversal, credentials, executables and
  oversized bundles are rejected. Payloads contain only application code and
  package manifests.
- Staging checks disk headroom, every file hash and JavaScript syntax. Locked
  dependencies install with `npm ci --omit=dev --ignore-scripts`; unchanged
  dependency trees are reused. It does not update Python, EAs or presets.
- Activation waits until deployment/review commands and recovery are idle. The
  child disconnects and exits gracefully; the parent scheduled task stays alive.
- The new child must initialize and authenticate to the backend within 120
  seconds. Otherwise the pointer returns to the previous release and that agent
  starts again. A failed release is blocked until a newer publication sequence.
- Interrupted pending activation rolls back before startup. Completed updates
  retain the current and previous code directories. MT5 data is not inside them.
- Ordinary backend/network outages defer updates and keep the working agent.
  Agents report `version+releaseHashPrefix` using the existing node version field.

## Administration and diagnosis

- `GET /api/admin/sandbox/updates`: current release and publisher result.
- `PATCH /api/admin/sandbox/updates` with `{"enabled":false}` pauses new automatic
  installations globally; `true` resumes them when the backend flag is enabled.
  The existing admin JWT and audit log protect these settings. A transaction
  already activating is allowed to finish or roll back.
- `GET /api/sandbox/node/update`, `/update-key`, and `/updates/:releaseId` require
  the node's X-Node-Id/X-Node-Token headers. Responses are private/no-store.
- On a node, `autoUpdateEnabled:false` in its private config opts it out.
- `agentDataDir\agent-updater.log`, `agent-update-failure.json`, and
  `agent-active-release.json` record activation/rollback. The updater log rotates.

Keep the Interactive Windows session logged in. Disconnect RDP instead of
signing out. Test an actual reboot separately during a maintenance window.

No new database migration, subscription system or licence bypass is introduced.
Existing MT5 account limits, licensing, strategy approval and commands still use
their existing APIs.
