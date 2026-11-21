# CornGrid Proxy Server — Windows VPS installation

This is a **proxy server**, separate from a Sandbox Node. It relays MT5 broker
connections over authenticated TLS. Several sandboxes, including sandboxes on
different nodes, can share the same proxy VPS public IPv4. One VPS IP is enough;
different proxy ports or sandbox credentials do not create different public IPs.

EA WebRequest calls, node heartbeats, Windows traffic and browser traffic are
outside this feature's scope. They keep using the node's normal connection.

## Requirements

- Windows Server 2019/2022/2025 x64, Administrator PowerShell, outbound HTTPS access.
- One reachable public IPv4 or hostname, with TCP port **24443** forwarded to
  this VPS if the provider uses NAT. The port must not be used by another app.
  DNS must point directly to the VPS; an HTTP/CDN proxy cannot carry this raw
  TLS protocol unless it explicitly supports TCP forwarding on that port.
- The public IPs of the Sandbox Nodes allowed to connect, for the firewall rule.
- CornGrid backend migration `0023_sandbox_proxy.sql` and the matching backend
  deployed before nodes use this feature. Sandbox Agent **1.4.0+** is required.
- Proxy VPS and nodes must have synchronized clocks; connection tickets expire.

The installer installs a private Node.js 24 runtime from the official release
endpoint, checking its published SHA-256 checksum. MT5/Python/Office are not
needed on a dedicated proxy VPS. An existing Node.js 24+ executable can be
selected using `-NodeExe`, without changing the machine-wide runtime.

## 1. Register in CornGrid Admin

1. Open **Admin → Sandbox Management → Proxy Servers → Add proxy**.
2. Enter a name, public hostname/IPv4 and TLS port (default 24443).
3. Download the private bootstrap JSON. The server starts **disabled**. This
   credential is shown once and is never returned in the normal server list.
4. Transfer the bootstrap JSON and `CornGrid-Proxy-Server.zip` privately to the
   proxy VPS. Do not paste bootstrap contents into chat or commit them to Git.

The bootstrap backend URL must be the public HTTPS CornGrid origin, e.g.
`https://corngrid.com`. Set the existing backend `APP_BASE_URL` correctly before
exporting the file. HTTP and embedded URL credentials are rejected by the installer.

## 2. Install on the proxy VPS

Extract the ZIP, open PowerShell **as Administrator** in its directory, then run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Install-CornGridProxy.ps1 `
  -BootstrapPath 'C:\PrivateSetup\CornGrid-Proxy-<server-id>.json' `
  -AllowedNodeAddresses @('<node-1-public-ip>', '<node-2-public-ip>')
```

Replace the placeholders. The default installation directory is
`C:\CornGridProxy`; use `-InstallRoot` for a dedicated alternative directory.
For a provider with an additional firewall/security group, allow the same TCP
port there, restricted to the same node source IPs. For nodes behind NAT, use
their modem/router's **public** source IP, not `192.168.x.x`.

`-AllowedNodeAddresses Any` is an explicit option for changing/dynamic node IPs;
the listener still requires valid per-sandbox tickets and TLS. Restricting the
firewall to known source IPs is preferable.

The installer creates:

- An ACL-protected private configuration and self-signed TLS certificate/PFX.
- The `CornGridProxyServer` scheduled task, running as SYSTEM at boot, with
  recovery triggers. No Windows login/RDP session is required on this proxy VPS.
- The `CornGridProxyTLS` inbound TCP firewall rule for the selected sources.
- Logs under `C:\CornGridProxy\logs`; no passwords, tickets or broker data are logged.

No RDP setting, default gateway, Windows proxy, node licence or MT5 terminal is
changed on the proxy server or other computers by this installer.

## 3. Configure and verify the VPS IP

On the VPS, inspect the local interface addresses:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object AddressState -eq Preferred |
  Select-Object InterfaceAlias, IPAddress
```

In **Proxy Servers → Add IP**, enter:

- **Public egress IPv4:** the VPS's actual public IPv4, as seen from the internet.
- **Source IPv4 on the VPS:** the address configured on its Windows interface.
  This may be the same public IPv4, or a private IPv4 if the provider uses NAT.

The proxy binds outgoing connections to this source address. Every ~15 seconds
it sends a verification HTTPS request **from that address** to CornGrid. The
backend compares the observed source IP with the configured public IP. Until
they match, the IP is marked unverified and cannot carry new sandbox connections.
Backend reverse-proxy/trusted-source configuration must preserve the real client
IP; do not trust arbitrary client-supplied forwarding headers.

Refresh Admin until the daemon is online and the IP is verified, then click
**Enable proxy**. The first authenticated daemon heartbeat registers the TLS
certificate pin. A different certificate is rejected until the proxy identity
is deliberately re-registered.

Optional diagnostic, from Administrator PowerShell in the extracted package:

```powershell
.\Test-CornGridProxy.ps1 -InstallRoot 'C:\CornGridProxy'
```

It reports task/listener state and local IPs without printing credentials.
It does not replace the real public-egress verification shown in Admin.

## 4. Assign Sandbox Nodes

In **Proxy Servers → Node assignments**, select a node and the proxy server.
Multiple nodes and multiple sandboxes may use the same server/IP. Existing
subscription, licence, node resource and sandbox capacity limits still apply.
If several verified egress addresses are configured on a proxy, new sandboxes
choose the least assigned address, retaining their route across ordinary restarts.

Assignment changes apply on the **next sandbox start/restart**. Running terminals
are not automatically restarted. Use the existing sandbox restart control during
an appropriate maintenance period to apply a changed assignment.

The node creates a separate authenticated SOCKS5 listener on **127.0.0.1 only**
for each sandbox. MT5 connects to that bridge; the bridge validates the pinned
proxy TLS certificate and presents a short-lived sandbox ticket. Broker preflight
uses the same route; the shared IPC keeper is recycled safely inside the existing
serialized preflight queue when its network configuration changes. Customer
terminals are never stopped merely to change the keeper's route.

The detached bridge survives normal agent updates. Proxy/node credentials remain
in private files; only short-lived tickets traverse the TLS connection.
Agent 1.4.1 runs the bridge from its persistent data directory so Windows does
not lock an old release directory when the launcher prunes it after updates.

## Direct mode, disable and outages

- **No node proxy assignment:** the sandbox uses the node's normal public IP.
- **Proxy assigned but disabled/offline/unverified:** new starts/connections fail
  closed with a useful error, rather than silently changing the broker-facing IP.
- **Disable proxy:** the daemon closes its proxy broker connections on the next
  control refresh (normally within 15 seconds). MT5 processes themselves stay open.
  The confirmation dialog makes this disruption explicit.
- **Remove assignment:** select Direct, then restart affected sandboxes using
  their existing control. The bridge is removed and MT5 proxy settings are reset.
- A temporary backend control outage does not deliberately kill existing broker
  streams. New connections require recent control state and an unexpired ticket.
  An unreachable proxy never falls back to direct while proxy mode is assigned.

## Maintenance and uninstall

Keep `C:\CornGridProxy\private` backed up securely; it contains the server token,
PFX and its passphrase. Certificate replacement changes the pin and requires a
planned identity re-registration. Preserve this directory for ordinary upgrades.

For planned maintenance, first move nodes to another proxy (or Direct) and
restart affected sandboxes. Then disable this proxy in Admin. To remove its
scheduled task and firewall rule:

```powershell
.\Uninstall-CornGridProxy.ps1 -InstallRoot 'C:\CornGridProxy'
```

This preserves files and TLS identity. It does not delete personal documents or
uninstall machine-wide Node.js. After stopping/unregistering the task and removing
its firewall rule, reinstall with the **same** bootstrap and private directory to
preserve its identity. Never reuse one identity on two running proxy VPSs.
To replace a lost certificate/credential, first remove node assignments and stop
affected sandboxes, disable and uninstall the old daemon, then choose **Remove
proxy** in Admin. Active sandbox routes block removal. Register a new identity
and reinstall privately; do not force a pin change on a running daemon.

Private configuration must be protected with SYSTEM/Administrators/installer-owner
ACLs. Do not share it with standard Windows users. External targets are restricted
to public IPv4 destinations, with DNS answers validated and pinned before connect;
loopback, private networks, metadata/link-local and reserved ranges are blocked.

## Deployment and tests

Apply migration 0023 before deploying the new backend and updating nodes. SQLite
development installations self-create the same tables. Pause automatic agent
publication during a partial backend rollout; publish the complete signed 1.4.1
agent release only after the proxy APIs and existing direct sandbox flow pass smoke
checks. Do not copy an incomplete subset of agent files into production.

The proxy package is built with `scripts/build-proxy-server.ps1` and contains a
SHA-256 file manifest, generic scripts and this guide, with no real credentials.
The node package is built separately with `scripts/build-node-agent.ps1`.

Automated tests cover shared IP assignments, authorization/ownership, ticket
validation, TLS pinning, byte forwarding, direct defaults and fail-closed behavior.
A real VPS egress and a demo MT5 broker login still need acceptance testing after
installation; local protocol tests are not evidence of broker-side connectivity.

From `Corngrid-web`, run the focused checks with:

```powershell
node --test test/proxy.test.js test/sandbox-api.test.js test/mt5-startup.test.js test/ipc-probe.test.js
node test/helpers/run-isolated-postgres.cjs test/proxy-postgres.test.js
$env:PLAYWRIGHT_BROWSER_CHANNEL='chrome'
npm.cmd run test:proxy:browser
```

The PostgreSQL harness starts its own temporary cluster and never reads the
production `.env` or database. Browser checks use an isolated local UI fixture.

References: [official MT5 startup proxy settings](https://www.metatrader5.com/en/terminal/help/start_advanced/start#configuration_file),
[Node.js TLS API](https://nodejs.org/docs/latest-v24.x/api/tls.html).
