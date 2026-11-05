'use strict';

// CornGrid Windows Sandbox Agent.
//
// Runs as a background service on each Windows sandbox node. Authenticates to
// the CornGrid backend with its node credentials, heartbeats resource usage,
// receives sandbox commands (deploy/start/stop/...), manages isolated MT5
// terminal processes, and reports status back. Outbound connections only.

const os = require('os');
const fs = require('fs');
const { loadConfig } = require('./config');
const { createMt5Manager } = require('./mt5-manager');
const { createEaTester } = require('./ea-tester');
const { createTransport } = require('./transport');
const systemMonitor = require('./system-monitor');

const AGENT_VERSION = '1.0.0';
const LOG_BUFFER_MAX = 200;

const config = loadConfig();

// ---------------------------------------------------------------------------
// Logging: console + in-memory buffer flushed to the backend in batches.
// ---------------------------------------------------------------------------
const logBuffer = [];

function pushLog(level, instanceUid, message) {
  const line = `[${new Date().toISOString()}] [${level}]${instanceUid ? ` [${instanceUid}]` : ''} ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try { fs.appendFileSync(require('path').join(config.agentDataDir, 'agent-recovery.log'), line + '\n'); } catch { /* console remains available */ }
  logBuffer.push({ level, instanceUid: instanceUid || undefined, message: String(message).slice(0, 1500) });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
}

const logger = {
  info: (instanceUid, message) => pushLog('info', instanceUid, message),
  warn: (instanceUid, message) => pushLog('warn', instanceUid, message),
  error: (instanceUid, message) => pushLog('error', instanceUid, message)
};

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------
let mt5;
let transport;
let tester;
let recoveryInProgress = false;
let lastRecovery = 0;
async function recoverInstances() {
  if (!mt5 || recoveryInProgress) return;
  recoveryInProgress = true;
  try {
    const state = await transport.httpRequest('GET', '/api/sandbox/node/instances');
    for (const instance of state.instances || []) {
      try { await mt5.start(instance); }
      catch (error) { logger.warn(instance.instanceUid, `Recovery failed: ${error.message}`); }
    }
    lastRecovery = Date.now();
  } catch (error) {
    logger.warn(null, `Recovery deferred: ${error.message}`);
  } finally { recoveryInProgress = false; }
}

const COMMAND_HANDLERS = {
  deploy: payload => mt5.deploy(payload),
  start: payload => mt5.start(payload),
  stop: payload => mt5.stop(payload),
  restart: payload => mt5.restart(payload),
  destroy: payload => mt5.destroy(payload),
  pause_trading: payload => mt5.pauseTrading(payload),
  resume_trading: payload => mt5.resumeTrading(payload),
  reconnect: payload => mt5.reconnect(payload),
  test_ea: payload => tester.runTest(payload),
  restart_agent: async () => {
    logger.info(null, 'Restart command received from backend; exiting for the service manager to restart us.');
    setTimeout(() => process.exit(1), 500);
    return { restarting: true };
  }
};

async function handleCommand(message, channel) {
  const { commandUid, command, payload } = message;
  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    logger.warn(null, `Unknown command "${command}" ignored.`);
    await transport.sendCommandResult(commandUid, { success: false, error: `Unknown command: ${command}` });
    return;
  }
  logger.info(payload && payload.instanceUid, `Executing command "${command}" (${commandUid}) via ${channel}.`);
  try {
    const result = await handler(payload || {});
    await transport.sendCommandResult(commandUid, { success: true, result: result || {} });
  } catch (error) {
    logger.error(payload && payload.instanceUid, `Command "${command}" failed: ${error.message}`);
    await transport.sendCommandResult(commandUid, { success: false, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------
async function heartbeat() {
  if (Date.now() - lastRecovery >= 60000) await recoverInstances();
  const cpuPercent = systemMonitor.sampleCpuPercent();
  const memory = systemMonitor.memoryMb();
  const reports = mt5.statusReports();

  // Fill per-instance memory numbers.
  const pidMemory = await systemMonitor.processMemoryMb(mt5.trackedPids());
  for (const report of reports) {
    if (report.processId && pidMemory.has(report.processId)) {
      report.memoryMb = pidMemory.get(report.processId);
    }
  }

  mt5.checkAdopted();

  try {
    await transport.sendHeartbeat({
      agentVersion: AGENT_VERSION,
      machineName: os.hostname(),
      osVersion: `${os.type()} ${os.release()}`,
      cpuCount: os.cpus().length,
      ramMb: memory.totalMb,
      diskFreeMb: systemMonitor.diskFreeMb(config.sandboxUsersDir),
      cpuPercent,
      memoryUsedMb: memory.usedMb,
      runningInstances: reports.length,
      instances: reports
    });
  } catch (error) {
    logger.warn(null, `Heartbeat failed: ${error.message}`);
  }

  // Flush buffered logs (best effort).
  if (logBuffer.length) {
    const batch = logBuffer.splice(0, 50);
    try {
      await transport.sendLogs(batch);
    } catch (_error) {
      logBuffer.unshift(...batch.slice(0, LOG_BUFFER_MAX - logBuffer.length));
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function main() {
  if (!config.nodeUid || !config.nodeToken) {
    console.error('Agent is not configured. Set CORNGRID_NODE_UID and CORNGRID_NODE_TOKEN.');
    process.exit(1);
  }

  fs.mkdirSync(config.sandboxUsersDir, { recursive: true });
  fs.mkdirSync(config.agentDataDir, { recursive: true });

  transport = createTransport({
    config,
    onCommand: handleCommand,
    onOpen: () => {
      logger.info(null, 'Connected to the CornGrid backend (WebSocket).');
      recoverInstances();
    },
    onClose: () => logger.warn(null, 'WebSocket disconnected; HTTPS fallback active, reconnecting...')
  });

  mt5 = createMt5Manager({ config, logger, downloadFile: (urlPath, target) => {
    // downloadFile receives a full URL from the manager; convert to a path.
    const parsed = new URL(urlPath);
    return transport.downloadFile(parsed.pathname, target);
  } });
  tester = createEaTester({ config, logger, mt5, transport, systemMonitor });

  const validation = mt5.validateBase();
  if (!validation.ok) {
    logger.error(null, validation.error);
    logger.error(null, 'The agent will keep running and retry deployments once MT5 files are in place.');
  } else {
    logger.info(null, `MT5 base validated: ${validation.terminal}`);
  }

  // Adopt terminals that survived an agent restart.
  await mt5.reconcile();

  transport.start();

  const heartbeatTimer = setInterval(heartbeat, config.heartbeatIntervalMs);
  heartbeatTimer.unref();
  // First heartbeat immediately so the node shows online without delay.
  heartbeat();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  function shutdown(signal) {
    logger.info(null, `Received ${signal}; agent shutting down (terminals keep running).`);
    clearInterval(heartbeatTimer);
    transport.stop();
    setTimeout(() => process.exit(0), 500);
  }

  logger.info(null, `CornGrid Sandbox Agent ${AGENT_VERSION} started on ${os.hostname()}.`);
}

process.on('unhandledRejection', reason => {
  logger.error(null, `Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', error => {
  logger.error(null, `Uncaught exception: ${error.stack}`);
});

main().catch(error => {
  console.error('Agent startup failed:', error);
  process.exit(1);
});
