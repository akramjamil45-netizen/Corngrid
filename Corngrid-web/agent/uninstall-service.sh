#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --help ]]; then echo 'sudo bash uninstall-service.sh: remove service registration only, preserving all data/configuration. Stop sandboxes in CornGrid first.'; exit 0; fi
[[ $# -eq 0 ]] || { echo 'Unknown option. Use --help; no changes were made.' >&2; exit 2; }
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || { echo 'Run on Linux with sudo.' >&2; exit 1; }
if id corngrid >/dev/null 2>&1; then
  agent_uid="$(id -u corngrid)"
  active="$(runuser -u corngrid -- env XDG_RUNTIME_DIR="/run/user/$agent_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$agent_uid/bus" systemctl --user list-units --type=service --state=running,activating,deactivating,reloading --no-legend 'corngrid-*.service')"
  [[ -z "$active" ]] || { echo 'Sandbox/test user units are running. Stop them through CornGrid before uninstalling; nothing was removed.' >&2; exit 1; }
fi
systemctl disable --now corngrid-agent.service corngrid-display.service
rm -f -- /etc/systemd/system/corngrid-agent.service /etc/systemd/system/corngrid-display.service
systemctl daemon-reload
echo 'Service registration removed. Agent files, account, credentials, Wine prefixes, sandbox data and update trust were preserved.'
