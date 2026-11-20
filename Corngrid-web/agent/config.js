'use strict';

// Agent configuration. Values come from (lowest to highest precedence):
//   defaults < agent-config.json (next to this file) < environment variables.
//
// Required: backendUrl, nodeUid, nodeToken (issued by the CornGrid admin when
// the node is registered). Everything else has production-safe defaults.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.CORNGRID_AGENT_CONFIG_FILE || path.join(__dirname, 'agent-config.json');

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function loadConfig() {
  const file = readConfigFile();
  const env = process.env;
  const linux = process.platform === 'linux';

  const config = {
    agentHome: env.CORNGRID_AGENT_HOME || __dirname,
    autoUpdateEnabled: env.CORNGRID_AGENT_AUTO_UPDATE !== 'false' && file.autoUpdateEnabled !== false,
    autoUpdateIntervalMs: Number(file.autoUpdateIntervalMs) || 300000,
    // CornGrid backend base URL, e.g. https://corngrid.com
    backendUrl: env.CORNGRID_BACKEND_URL || file.backendUrl || 'https://corngrid.com',
    brokerServerDataDirs: file.brokerServerDataDirs || {},
    brokerSymbolMaps: file.brokerSymbolMaps || {},
    brokerAccountSymbolMaps: file.brokerAccountSymbolMaps || {},
    brokerCacheDir: env.CORNGRID_BROKER_CACHE_DIR || file.brokerCacheDir || (linux ? '/var/lib/corngrid/broker-caches' : 'C:\\CornGrid\\Sandbox\\BrokerCaches'),
    mt5PythonPath: env.CORNGRID_MT5_PYTHON_PATH || file.mt5PythonPath || (linux ? '/opt/corngrid/windows-python/python.exe' : 'python.exe'),
    webRequestSettingsSource: file.webRequestSettingsSource || '',
    startupSymbol: env.CORNGRID_STARTUP_SYMBOL || file.startupSymbol || '',
    nodeUid: env.CORNGRID_NODE_UID || file.nodeUid || '',
    nodeToken: env.CORNGRID_NODE_TOKEN || file.nodeToken || '',

    // Pre-deployed MT5 program directory (terminal64.exe lives here).
    mt5BaseDir: env.CORNGRID_MT5_BASE_DIR || file.mt5BaseDir || (linux ? '/opt/corngrid/mt5' : 'C:\\CornGrid\\Sandbox\\MT5'),
    // Per-user isolated instance directories are created under this root.
    sandboxUsersDir: env.CORNGRID_SANDBOX_USERS_DIR || file.sandboxUsersDir || (linux ? '/var/lib/corngrid/instances' : 'C:\\CornGrid\\Sandbox\\Users'),
    // Local working directory for downloaded EA binaries and agent logs.
    agentDataDir: env.CORNGRID_AGENT_DATA_DIR || file.agentDataDir || (linux ? '/var/lib/corngrid/agent-data' : 'C:\\CornGrid\\Sandbox\\AgentData'),
    ipcProbeDir: env.CORNGRID_IPC_PROBE_DIR || file.ipcProbeDir || '',
    linuxWineEnabled: env.CORNGRID_LINUX_WINE !== undefined ? env.CORNGRID_LINUX_WINE === 'true' : file.linuxWineEnabled === true,
    wineBinary: env.CORNGRID_WINE_BINARY || file.wineBinary || '/usr/bin/wine',
    wineTemplateDir: env.CORNGRID_WINE_TEMPLATE_DIR || file.wineTemplateDir || '/var/lib/corngrid/wine-template',
    winePrefixesDir: env.CORNGRID_WINE_PREFIXES_DIR || file.winePrefixesDir || '/var/lib/corngrid/wine-prefixes',
    wineDisplay: env.DISPLAY || file.wineDisplay || ':99',
    xAuthority: env.XAUTHORITY || file.xAuthority || '/etc/corngrid/xauthority',
    linuxStartupTimeoutMs: Number(file.linuxStartupTimeoutMs) || 90000,

    heartbeatIntervalMs: Number(env.CORNGRID_HEARTBEAT_INTERVAL_MS) || file.heartbeatIntervalMs || 15000,
    reconnectMinMs: Number(env.CORNGRID_RECONNECT_MIN_MS) || 1000,
    reconnectMaxMs: Number(env.CORNGRID_RECONNECT_MAX_MS) || 60000,

    // Crash recovery: restart a failed terminal at most this many times in the window.
    restartWindowMs: 10 * 60 * 1000,
    restartMaxAttempts: 5,

    // Process shutdown grace period before force-kill.
    stopGraceMs: 8000
  };

  config.backendUrl = String(config.backendUrl).replace(/\/+$/, '');
  config.wsUrl = config.backendUrl.replace(/^http/, 'ws') + '/ws/sandbox/node';
  if (!config.ipcProbeDir) config.ipcProbeDir = path.join(path.dirname(path.resolve(config.mt5BaseDir)), 'IpcProbe');

  if (!config.nodeUid || !config.nodeToken) {
    console.error('[config] CORNGRID_NODE_UID and CORNGRID_NODE_TOKEN must be configured (env or agent-config.json).');
  }
  return config;
}

module.exports = { loadConfig };
