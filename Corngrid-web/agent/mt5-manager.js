'use strict';

// MT5 process manager.
//
// Each sandbox gets a separate copy of the pre-deployed MT5 terminal, launched
// in /portable mode. Linux also uses a per-instance Wine prefix and systemd
// user unit. These isolate application state, not untrusted native execution;
// approved EA code and private filesystem permissions remain required.
//
//   C:\CornGrid\Sandbox\MT5\                 <- base files (placed manually)
//   C:\CornGrid\Sandbox\Users\sbx_xxx\       <- isolated per-user copy
//     terminal64.exe
//     config\common.ini                      <- auto-login (written by agent)
//     MQL5\Experts\CornGrid\<strategy>.ex5   <- deployed EA
//     MQL5\Files\corngrid_sandbox.ini        <- licence bundle for the EA
//
// All child processes are spawned with argument arrays (no shell), and every
// instance identifier is validated before touching the filesystem, so command
// and path injection are not possible.

const fs = require('fs');
const { copyBrokerServerCache } = require('./broker-server-cache');
const { prepareStartup, ensureStartup, loadStartupPayload } = require('./mt5-startup');
const { resolveBroker } = require('./broker-resolution');
const path = require('path');
const { spawn, execFile } = require('child_process');

const INSTANCE_UID_PATTERN = /^sbx_[a-f0-9]{18}$/;
const EA_UID_PATTERN = /^eatest_[a-f0-9]{18}$/;

function isValidInstanceUid(value) {
  return typeof value === 'string' && (INSTANCE_UID_PATTERN.test(value) || EA_UID_PATTERN.test(value));
}

function createMt5Manager({ config, logger, downloadFile }) {
  const linux = process.platform === 'linux' ? require('./linux-runtime').createLinuxRuntime({config}) : null;
  // instanceUid -> { child, pid, startedAt, restarts: [timestamps], sandboxPath, meta }
  const running = new Map();
  const pendingRestarts = new Map();

  function instanceDir(instanceUid) {
    if (!isValidInstanceUid(instanceUid)) {
      throw new Error(`Invalid instance identifier: ${String(instanceUid).slice(0, 40)}`);
    }
    const dir = path.resolve(config.sandboxUsersDir, instanceUid);
    const root = path.resolve(config.sandboxUsersDir);
    if (!dir.startsWith(root + path.sep)) {
      throw new Error('Instance path escapes the sandbox root.');
    }
    return dir;
  }

  // -------------------------------------------------------------------------
  // Base validation
  // -------------------------------------------------------------------------
  function validateBase() {
    if (linux) { const check=linux.validate();if(!check.ok)return check; }
    const terminal = path.join(config.mt5BaseDir, 'terminal64.exe');
    if (!fs.existsSync(terminal)) {
      return { ok: false, error: `MT5 terminal not found at ${terminal}. Place the MT5 program files in ${config.mt5BaseDir}.` };
    }
    return { ok: true, terminal };
  }

  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------
  function robocopy(source, target) {
    if (linux) return Promise.resolve().then(()=>linux.copyTerminal(source,target));
    return new Promise((resolve, reject) => {
      // /E full tree, /NFL /NDL /NJH /NJS quiet, /R:2 /W:1 limited retries.
      execFile('robocopy.exe', [source, target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:1'],
        { timeout: 5 * 60 * 1000 }, (error, _stdout) => {
          // robocopy exit codes 0-7 are success states; >= 8 is failure.
          if (error && typeof error.code === 'number' && error.code < 8) return resolve();
          if (error && typeof error.code === 'number') return reject(new Error(`robocopy failed with exit code ${error.code}`));
          if (error) return reject(error);
          resolve();
        });
    });
  }

  function writeAutoLoginConfig(dir, { accountNumber, password, brokerServer }) {
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    // MT5 reads [Common] Login/Password/Server from the startup config and
    // signs in automatically. [Experts] enables algo trading on launch.
    const ini = [
      '[Common]',
      `Login=${accountNumber}`,
      `Password=${password}`,
      `Server=${brokerServer}`,
      'AutoLogin=1',
      '',
      '[Experts]',
      'AllowTrading=1',
      'AllowDllImport=0',
      'Enabled=1',
      ''
    ].join('\r\n');
    fs.writeFileSync(path.join(configDir, 'common.ini'), ini, 'utf8');
  }

  function writeLicenseBundle(dir, { installationSecret, accountNumber, brokerServer, apiBaseUrl }) {
    const filesDir = path.join(dir, 'MQL5', 'Files');
    fs.mkdirSync(filesDir, { recursive: true });
    const ini = [
      '[License]',
      `Secret=${installationSecret || ''}`,
      `Account=${accountNumber}`,
      `Server=${brokerServer}`,
      `ApiBaseUrl=${apiBaseUrl || config.backendUrl}`,
      ''
    ].join('\r\n');
    fs.writeFileSync(path.join(filesDir, 'corngrid_sandbox.ini'), ini, 'utf8');
  }

  async function deployEa(dir, strategy) {
    if (!strategy || !strategy.code) return;
    const expertsDir = path.join(dir, 'MQL5', 'Experts', 'CornGrid');
    fs.mkdirSync(expertsDir, { recursive: true });
    const fileName = strategy.eaFileName || `${strategy.code}.ex5`;
    const target = path.join(expertsDir, fileName);
    const url = `${config.backendUrl}/api/sandbox/node/strategies/${encodeURIComponent(strategy.code)}/ea`;
    await downloadFile(url, target);
  }

  async function deploy(payload) {
    const { instanceUid } = payload || {};
    if (!isValidInstanceUid(instanceUid)) throw new Error('Invalid instance identifier.');
    for (const field of ['brokerServer', 'accountNumber', 'password']) {
      if (!payload[field]) throw new Error(`Deploy payload is missing ${field}.`);
    }

    const base = validateBase();
    if (!base.ok) throw new Error(base.error);

    const dir = instanceDir(instanceUid);
    logger.info(instanceUid, `Deploying sandbox environment at ${dir}`);

    // Clean slate for a redeploy.
    if(linux){await stopInstanceProcesses(instanceUid);linux.removePrefix(dir);}
    if (fs.existsSync(dir)) {
      if(!linux)await stopInstanceProcesses(instanceUid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });

    await robocopy(path.resolve(config.mt5BaseDir), dir);
    copyBrokerServerCache(dir, payload.brokerServer, config);
    logger.info(instanceUid, 'Verifying broker login and resolving the account trading symbol before starting EA.');
    payload = await resolveBroker(dir, payload, config);
    logger.info(instanceUid, `Broker verified: ${payload.brokerServer}; chart symbol: ${payload.resolvedSymbol}.`);
    writeAutoLoginConfig(dir, payload);
    writeLicenseBundle(dir, payload);
    await deployEa(dir, payload.strategy);
    prepareStartup(dir, payload, config);

    const child = await launch(dir, instanceUid, payload);
    return { sandboxPath: dir, pid: child.pid };
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------
  async function launch(dir, instanceUid, meta = {}, restarts = []) {
    const terminal = path.join(dir, 'terminal64.exe');
    const startupPath = ensureStartup(dir, config);
    if (linux) {
      const child=await linux.startTerminal(dir,startupPath);
      running.set(instanceUid,{child:null,pid:child.pid,startedAt:Date.now(),restarts,sandboxPath:dir,meta,intentionallyStopped:false,adopted:true});
      logger.info(instanceUid,`Wine terminal running in its systemd user unit (pid ${child.pid}).`);
      return child;
    }
    const child = spawn(terminal, ['/portable', '/config:' + startupPath], {
      cwd: dir,
      // A Windows attached child belongs to the agent's libuv process job and
      // dies when the agent exits. Detached terminals survive agent updates.
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    const record = {
      child,
      pid: child.pid,
      startedAt: Date.now(),
      restarts,
      sandboxPath: dir,
      meta,
      intentionallyStopped: false
    };
    running.set(instanceUid, record);

    child.on('error', error => {
      logger.error(instanceUid, `Failed to launch terminal: ${error.message}`);
      if (running.get(instanceUid) === record) {
        running.delete(instanceUid);
        scheduleRestart(instanceUid, record);
      }
    });

    child.on('exit', (code, signal) => {
      const current = running.get(instanceUid);
      if (!current || current.child !== child) return;
      running.delete(instanceUid);
      if (current.intentionallyStopped) {
        logger.info(instanceUid, `Terminal stopped (code ${code}).`);
        return;
      }
      logger.error(instanceUid, `Terminal exited unexpectedly (code ${code}, signal ${signal}).`);
      scheduleRestart(instanceUid, current);
    });

    child.unref?.();

    logger.info(instanceUid, `Terminal launched (pid ${child.pid}).`);
    return child;
  }

  function scheduleRestart(instanceUid, record) {
    const nowTs = Date.now();
    record.restarts = record.restarts.filter(ts => nowTs - ts < config.restartWindowMs);
    if (record.restarts.length >= config.restartMaxAttempts) {
      logger.error(instanceUid, `Restart limit reached; cooling down before retry.`);
      const timer = setTimeout(() => {
        pendingRestarts.delete(instanceUid);
        if (!running.has(instanceUid)) scheduleRestart(instanceUid, record);
      }, Math.max(1000, config.restartWindowMs - (nowTs - record.restarts[0]) + 100));
      pendingRestarts.set(instanceUid, timer);
      return;
    }
    record.restarts.push(nowTs);
    const delayMs = Math.min(30000, 2000 * record.restarts.length);
    logger.info(instanceUid, `Restarting terminal in ${delayMs}ms (attempt ${record.restarts.length}).`);
    const timer = setTimeout(async () => {
      pendingRestarts.delete(instanceUid);
      if (running.has(instanceUid)) return;
      try {
        await launch(record.sandboxPath, instanceUid, record.meta, record.restarts);
      } catch (error) {
        logger.error(instanceUid, `Restart failed: ${error.message}`);
        scheduleRestart(instanceUid, record);
      }
    }, delayMs);
    pendingRestarts.set(instanceUid, timer);
  }

  function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM';
    }
  }

  async function stopInstanceProcesses(instanceUid) {
    clearTimeout(pendingRestarts.get(instanceUid));
    pendingRestarts.delete(instanceUid);
    const record = running.get(instanceUid);
    if (linux) {
      if (record) record.intentionallyStopped=true;
      await linux.stopDirectory(instanceDir(instanceUid));
      running.delete(instanceUid);return;
    }
    if (record) {
      record.intentionallyStopped = true;
      await killPid(record.pid);
      if (running.get(instanceUid) === record) running.delete(instanceUid);
    }
  }

  async function killPid(pid) {
    if (!isPidAlive(pid)) return;
    const terminate = force => new Promise(resolve => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
        { timeout: force ? 10000 : config.stopGraceMs }, () => resolve());
    });
    const waitForExit = async timeout => {
      const deadline = Date.now() + timeout;
      while (isPidAlive(pid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return !isPidAlive(pid);
    };
    // taskkill can acknowledge WM_CLOSE before MT5 has released its data folder.
    // Starting a replacement then launches a duplicate that immediately exits.
    await terminate(false);
    if (await waitForExit(config.stopGraceMs)) return;
    await terminate(true);
    if (!await waitForExit(10000)) throw new Error(`MT5 process ${pid} did not stop; replacement was not launched.`);
  }

  async function start(payload) {
    const { instanceUid } = payload || {};
    checkAdopted();
    if (running.has(instanceUid)) return { alreadyRunning: true, pid: running.get(instanceUid).pid };
    if (pendingRestarts.has(instanceUid)) return { recovering: true };
    const dir = instanceDir(instanceUid);
    const terminal = path.join(dir, 'terminal64.exe');
    if (!fs.existsSync(terminal)) throw new Error('Sandbox environment is not deployed.');
    if (!fs.existsSync(path.join(dir, 'config', 'broker-resolution.json'))) {
      logger.info(instanceUid, 'Verifying the existing sandbox broker and symbol before restart.');
      const verified = await resolveBroker(dir, loadStartupPayload(dir), config);
      writeLicenseBundle(dir, verified);
      prepareStartup(dir, verified, config);
    }
    const child = await launch(dir, instanceUid, payload);
    return { pid: child.pid };
  }

  async function stop(payload) {
    const { instanceUid } = payload || {};
    await stopInstanceProcesses(instanceUid);
    return { stopped: true };
  }

  async function restart(payload) {
    // Validate or repair startup before stopping a working legacy terminal.
    if (!isValidInstanceUid(payload && payload.instanceUid)) throw new Error('Invalid instance identifier.');
    ensureStartup(instanceDir(payload.instanceUid), config);
    await stop(payload);
    return start(payload);
  }

  async function destroy(payload) {
    const { instanceUid } = payload || {};
    if (!isValidInstanceUid(instanceUid)) throw new Error('Invalid instance identifier.');
    await stopInstanceProcesses(instanceUid);
    const dir = instanceDir(instanceUid);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if(linux)linux.removePrefix(dir);
    logger.info(instanceUid, `Sandbox environment removed (${dir}).`);
    return { destroyed: true };
  }

  // Trading pause/resume and reconnect are signalled to the EA through flag
  // files in MQL5\Files — the sandbox EA polls them on its timer. This avoids
  // restarting the terminal for a trading-state change.
  function writeFlag(instanceUid, name, enabled) {
    const dir = instanceDir(instanceUid);
    const flagPath = path.join(dir, 'MQL5', 'Files', name);
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    if (enabled) fs.writeFileSync(flagPath, String(Date.now()), 'utf8');
    else fs.rmSync(flagPath, { force: true });
  }

  async function pauseTrading(payload) {
    writeFlag(payload.instanceUid, 'corngrid_pause.flag', true);
    return { paused: true };
  }

  async function resumeTrading(payload) {
    writeFlag(payload.instanceUid, 'corngrid_pause.flag', false);
    return { resumed: true };
  }

  async function reconnect(payload) {
    // Terminal-level reconnect: restart is the reliable way to force MT5 to
    // re-establish the broker session.
    return restart(payload);
  }

  // -------------------------------------------------------------------------
  // Status reporting
  // -------------------------------------------------------------------------
  function statusReports() {
    checkAdopted();
    const reports = [];
    for (const [instanceUid, record] of running) {
      if (!isPidAlive(record.pid)) continue;
      reports.push({
        instanceUid,
        status: 'running',
        processId: record.pid,
        sandboxPath: record.sandboxPath,
        memoryMb: null // filled by the caller's per-process sampler
      });
    }
    return reports;
  }

  function trackedPids() {
    return [...running.values()].map(record => record.pid);
  }

  // Poll adopted (post-agent-restart) processes for liveness; child-spawned
  // processes report through their exit event instead.
  function checkAdopted() {
    for (const [instanceUid, record] of running) {
      if (!record.adopted) continue;
      if (!isPidAlive(record.pid)) {
        running.delete(instanceUid);
        if (!record.intentionallyStopped) {
          logger.error(instanceUid, 'Adopted terminal exited unexpectedly.');
          scheduleRestart(instanceUid, record);
        }
      }
    }
  }

  // After an agent restart, in-memory state is gone. Rebuild it by scanning
  // the sandbox root for deployed instances whose terminal is still running.
  async function reconcile() {
    const root = path.resolve(config.sandboxUsersDir);
    if (!fs.existsSync(root)) return;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidInstanceUid(entry.name)) continue;
      const dir = path.join(root, entry.name);
      const terminal = path.join(dir, 'terminal64.exe');
      if (!fs.existsSync(terminal)) continue;
      // Find a running terminal64.exe whose executable path is this one.
      let pid;
      try { pid = await findTerminalPid(dir); }
      catch { logger.warn(entry.name, 'Terminal adoption refused; verify this sandbox unit and Wine prefix before restarting it.'); continue; }
      if (pid) {
        running.set(entry.name, {
          child: null, // adopted: no child handle, liveness is polled
          pid,
          startedAt: Date.now(),
          restarts: [],
          sandboxPath: dir,
          meta: {},
          intentionallyStopped: false,
          adopted: true
        });
        logger.info(entry.name, `Adopted running terminal (pid ${pid}) after agent restart.`);
      }
    }
  }

  function findTerminalPid(dir) {
    if (linux) return Promise.resolve(linux.findTerminalPid(dir));
    return new Promise(resolve => {
      const normalized = path.join(dir, 'terminal64.exe').toLowerCase();
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq '${normalized.replace(/'/g, "''")}' } | Select-Object -ExpandProperty ProcessId`
      ], { timeout: 15000 }, (error, stdout) => {
        if (error) return resolve(null);
        const pid = Number.parseInt(String(stdout).trim(), 10);
        resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
      });
    });
  }

  return {
    validateBase,
    deploy,
    start,
    stop,
    restart,
    destroy,
    pauseTrading,
    resumeTrading,
    reconnect,
    statusReports,
    trackedPids,
    checkAdopted,
    reconcile,
    isValidInstanceUid
  };
}

module.exports = { createMt5Manager, isValidInstanceUid };
