#!/usr/bin/env bash
# Linux installer: prepares the host/services; never starts hosting automatically.
set -euo pipefail
umask 077
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
config_source=""; install_deps=false; install_node=false; dry_run=false
while (($#)); do
  case "$1" in
    --config) [[ $# -ge 2 ]] || { echo 'Missing --config path.' >&2; exit 2; }; config_source="$2"; shift 2 ;;
    --install-deps) install_deps=true; shift ;;
    --install-node) install_node=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    --help) printf '%s\n' 'sudo bash install-service.sh [--config /root/node.json] [--install-deps] [--install-node] [--dry-run]' 'Creates an unprivileged agent and authenticated Xvfb services. Does not start hosting.'; exit 0 ;;
    *) echo 'Unknown installer option. Use --help.' >&2; exit 2 ;;
  esac
done
runtime=(agent.js config.js transport.js system-monitor.js mt5-manager.js mt5-startup.js broker-resolution.js broker-server-cache.js broker-probe.py resolve-broker.ps1 setup-broker-tools.ps1 source-compiler.js ea-tester.js check-installation.js auto-update.js update-protocol.js linux-runtime.js agent-launcher.js package.json package-lock.json RELEASE.json agent-config.linux.example.json install-service.sh uninstall-service.sh)
for file in "${runtime[@]}"; do [[ -f "$source_dir/$file" && ! -L "$source_dir/$file" ]] || { echo "Missing/linked package file: $file" >&2; exit 1; }; done
if $dry_run; then
  printf '%s\n' 'PLAN: Linux x86-64 + systemd; user corngrid; private configuration /etc/corngrid/agent-config.json.' 'PLAN: code /opt/corngrid/agent; MT5 /opt/corngrid/mt5; private state /var/lib/corngrid.' 'PLAN: corngrid-display.service (Xvfb :99, Xauthority, no TCP) and corngrid-agent.service.' 'PLAN: per-sandbox systemd user units + Wine prefixes; existing node identity/configuration preserved.' 'PLAN: dependency installation is opt-in; no service, MT5, network or filesystem changes in dry-run.'
  exit 0
fi
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Linux x86-64 is required; ARM is not supported.' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run the installer with sudo. The agent itself will not run as root.' >&2; exit 1; }
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || { echo 'A running systemd host is required (not a bare container).' >&2; exit 1; }
if systemctl is-active --quiet corngrid-agent.service; then echo 'Agent is running. Use signed code updates, or stop it deliberately before rerunning the installer.' >&2; exit 1; fi
if $install_deps; then
  command -v apt-get >/dev/null || { echo '--install-deps supports Ubuntu/Debian apt hosts. Install prerequisites manually on other Linux distributions.' >&2; exit 1; }
  apt-get update
  packages=(xvfb xauth x11-utils dbus-user-session python3 curl ca-certificates unzip fonts-liberation procps util-linux openssl)
  if ! command -v wine >/dev/null; then packages+=(wine wine64); fi
  apt-get install -y "${packages[@]}"
fi
for tool in python3 curl sha256sum tar xauth Xvfb xdpyinfo runuser loginctl openssl wine; do command -v "$tool" >/dev/null || { echo "Missing host prerequisite: $tool. See the Linux guide." >&2; exit 1; }; done
for directory in /opt/corngrid /etc/corngrid /var/lib/corngrid; do
  [[ ! -L "$directory" ]] || { echo 'Installation roots must not be symbolic links.' >&2; exit 1; }
  if [[ -e "$directory" && $(readlink -f -- "$directory") != "$directory" ]]; then echo 'Use canonical installation paths.' >&2; exit 1; fi
done
for file in /opt/corngrid/agent /etc/corngrid/agent-config.json /etc/corngrid/xauthority /etc/systemd/system/corngrid-agent.service /etc/systemd/system/corngrid-display.service; do [[ ! -L "$file" ]] || { echo 'Managed files/directories must not be symbolic links.' >&2; exit 1; }; done
install -d -m 0755 /opt/corngrid
temporary="$(mktemp -d /var/tmp/corngrid-node-install.XXXXXXXX)"
cleanup() {
  if [[ -d /opt/corngrid/agent ]]; then chown -R root:root /opt/corngrid/agent; chmod -R go-w /opt/corngrid/agent; fi
  if [[ -f /opt/corngrid/agent/update-trust.pem && ! -L /opt/corngrid/agent/update-trust.pem ]]; then chown root:corngrid /opt/corngrid/agent/update-trust.pem; chmod 0640 /opt/corngrid/agent/update-trust.pem; fi
  if [[ "$temporary" == /var/tmp/corngrid-node-install.* && -d "$temporary" ]]; then rm -rf -- "$temporary"; fi
}
trap cleanup EXIT
if $install_node; then
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://nodejs.org/dist/index.json -o "$temporary/index.json"
  version="$(python3 -c 'import json,sys; print(next(x["version"] for x in json.load(open(sys.argv[1])) if x["version"].startswith("v24.") and x.get("lts")))' "$temporary/index.json")"
  [[ "$version" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || { echo 'Unexpected Node release metadata.' >&2; exit 1; }
  archive="node-${version}-linux-x64.tar.gz"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/${version}/${archive}" -o "$temporary/$archive"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/${version}/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
  (cd "$temporary"; grep -F "  $archive" SHASUMS256.txt | sha256sum --check --status -)
  node_directory="/opt/corngrid/node-${version}"
  [[ ! -L "$node_directory" ]] || { echo 'Unsafe managed Node path.' >&2; exit 1; }
  if [[ ! -d "$node_directory" ]]; then install -d -m0755 "$node_directory"; tar -xzf "$temporary/$archive" --strip-components=1 -C "$node_directory"; fi
  [[ ! -e /opt/corngrid/node || -L /opt/corngrid/node ]] || { echo 'The managed Node link is already a real directory; review it manually.' >&2; exit 1; }
  ln -sfn -- "$node_directory" /opt/corngrid/node
  node_bin=/opt/corngrid/node/bin/node
else
  if [[ -x /opt/corngrid/node/bin/node ]]; then node_bin=/opt/corngrid/node/bin/node; else node_bin="$(command -v node || true)"; fi
fi
[[ -n ${node_bin:-} && -x "$node_bin" ]] || { echo 'Install Node.js 24/26 LTS or add --install-node.' >&2; exit 1; }
"$node_bin" -e 'if(![22,24,26].includes(Number(process.versions.node.split(".")[0])))process.exit(1)' || { echo 'Use supported Node.js LTS 22, 24 or 26.' >&2; exit 1; }
node_bin="$(readlink -f -- "$node_bin")"
if id corngrid >/dev/null 2>&1; then
  [[ $(id -u corngrid) -ne 0 && $(getent passwd corngrid | cut -d: -f6) == /var/lib/corngrid ]] || { echo 'Existing corngrid account has an unexpected identity/home; review it manually.' >&2; exit 1; }
else useradd --system --user-group --home-dir /var/lib/corngrid --create-home --shell /usr/sbin/nologin corngrid; fi
install -d -o root -g corngrid -m0750 /etc/corngrid
install -d -o corngrid -g corngrid -m0700 /var/lib/corngrid /var/lib/corngrid/instances /var/lib/corngrid/agent-data /var/lib/corngrid/broker-caches /var/lib/corngrid/wine-prefixes /var/lib/corngrid/wine-template
install -d -o corngrid -g corngrid -m0750 /opt/corngrid/mt5 /opt/corngrid/windows-python
if [[ -n "$config_source" ]]; then
  "$node_bin" -e 'try{const fs=require("fs"),c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(c.linuxWineEnabled!==true||!/^node_[a-f0-9]{18}$/.test(c.nodeUid)||!/^cgn_[a-f0-9]{64}$/.test(c.nodeToken))process.exit(1);for(const[k,v]of Object.entries(JSON.parse(fs.readFileSync(process.argv[2],"utf8"))))if(["mt5BaseDir","sandboxUsersDir","agentDataDir","brokerCacheDir","winePrefixesDir","wineTemplateDir","wineDisplay","xAuthority","mt5PythonPath"].includes(k)&&c[k]!==v)process.exit(1)}catch{process.exit(1)}' "$config_source" "$source_dir/agent-config.linux.example.json" || { echo 'Invalid Linux identity/config paths; use the Linux example with a fresh node token. Values were not printed.' >&2; exit 1; }
  if [[ -e /etc/corngrid/agent-config.json ]] && ! cmp -s -- "$config_source" /etc/corngrid/agent-config.json; then echo 'Existing configuration differs. It was preserved; edit/rotate it deliberately.' >&2; exit 1; fi
  if [[ $(readlink -f -- "$config_source") != /etc/corngrid/agent-config.json ]]; then install -o root -g corngrid -m0640 -- "$config_source" /etc/corngrid/agent-config.json; fi
elif [[ ! -e /etc/corngrid/agent-config.json ]]; then install -o root -g corngrid -m0640 "$source_dir/agent-config.linux.example.json" /etc/corngrid/agent-config.json; fi
backup="/var/backups/corngrid-agent-$(date -u +%Y%m%d-%H%M%S)"
install -d -m0700 "$backup"
for unit in corngrid-agent.service corngrid-display.service; do if [[ -f /etc/systemd/system/$unit ]]; then cp -a -- "/etc/systemd/system/$unit" "$backup/$unit"; fi; done
if [[ -d /opt/corngrid/agent && "$source_dir" != /opt/corngrid/agent ]]; then cp -a -- /opt/corngrid/agent "$backup/agent"; fi
install -d -m0755 /opt/corngrid/agent
if [[ "$source_dir" != /opt/corngrid/agent ]]; then
  for file in "${runtime[@]}"; do install -m0644 -- "$source_dir/$file" "/opt/corngrid/agent/$file"; done
fi
chmod 0755 /opt/corngrid/agent/install-service.sh /opt/corngrid/agent/uninstall-service.sh
chown -R corngrid:corngrid /opt/corngrid/agent
export PATH="$(dirname "$node_bin"):/usr/sbin:/usr/bin:/sbin:/bin"
npm_bin="$(command -v npm || true)"
[[ -n "$npm_bin" ]] || { echo 'npm must accompany the selected Node.js runtime.' >&2; exit 1; }
cd /opt/corngrid/agent
runuser -u corngrid -- env HOME=/var/lib/corngrid PATH="$PATH" "$npm_bin" ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:root /opt/corngrid/agent; chmod -R go-w /opt/corngrid/agent
if [[ -f /opt/corngrid/agent/update-trust.pem ]]; then chown root:corngrid /opt/corngrid/agent/update-trust.pem; chmod 0640 /opt/corngrid/agent/update-trust.pem; fi
if [[ ! -f /etc/corngrid/xauthority ]]; then
  touch /etc/corngrid/xauthority
  xauth -f /etc/corngrid/xauthority add :99 . "$(openssl rand -hex 16)"
fi
chown root:corngrid /etc/corngrid/xauthority; chmod 0640 /etc/corngrid/xauthority
agent_uid="$(id -u corngrid)"; xvfb_bin="$(command -v Xvfb)"
cat >/etc/systemd/system/corngrid-display.service <<EOF
[Unit]
Description=CornGrid authenticated virtual X11 display
[Service]
User=corngrid
Group=corngrid
Environment=HOME=/var/lib/corngrid
ExecStart=$xvfb_bin :99 -screen 0 1280x800x24 -nolisten tcp -auth /etc/corngrid/xauthority
Restart=on-failure
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/corngrid-agent.service <<EOF
[Unit]
Description=CornGrid Linux Sandbox Agent
Wants=network-online.target user@${agent_uid}.service
Requires=corngrid-display.service
After=network-online.target user@${agent_uid}.service corngrid-display.service
[Service]
Type=simple
User=corngrid
Group=corngrid
WorkingDirectory=/opt/corngrid/agent
Environment=HOME=/var/lib/corngrid
Environment=DISPLAY=:99
Environment=XAUTHORITY=/etc/corngrid/xauthority
Environment=XDG_RUNTIME_DIR=/run/user/$agent_uid
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$agent_uid/bus
Environment=CORNGRID_AGENT_HOME=/opt/corngrid/agent
Environment=CORNGRID_AGENT_CONFIG_FILE=/etc/corngrid/agent-config.json
Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin /opt/corngrid/agent/agent-launcher.js
Restart=always
RestartSec=10
TimeoutStopSec=20
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
loginctl enable-linger corngrid
systemctl start "user@${agent_uid}.service"
printf '%s\n' 'Installed. Hosting was NOT started.' 'Prepare the Wine template, clean MT5 folder, Windows Python SDK and broker/WebRequest seeds using VPS_NODE_INSTALLATION_LINUX.md.' 'Then run diagnostics, pin the update key, and explicitly enable/start corngrid-agent.service.' "Service files/code backup: $backup"
