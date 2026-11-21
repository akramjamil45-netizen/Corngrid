'use strict';

// Dedicated MT5 probe terminal (the "IPC keeper").
//
// Broker checks reuse one dedicated terminal under the serialized preflight
// queue. TCP 22346 is MT5's optional MCP listener, not the Python IPC transport;
// it must never be used as a Python readiness/ownership check.
//
// The keeper is a bare MT5 copy outside the sandbox roots whose only job is to
// host preflight sessions. Exact executable paths identify it, and the Python
// probe verifies its actual account/connection. No user terminal is stopped
// for a probe. The keeper holds no sandbox and may stay signed in to
// the last verified account; that state is never read by an EA.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { copyBrokerServerCache } = require('./broker-server-cache');

const IPC_PORT = 22346;
const INSTANCE_UID_PATTERN = /^sbx_[a-f0-9]{18}$/;
const OWNER_CACHE_MS = 1500;

function createIpcProbe({ config, logger }) {
  const probeDir = path.resolve(config.ipcProbeDir);
  for (const other of [config.sandboxUsersDir, config.mt5BaseDir]) {
    const relative = path.relative(path.resolve(other), probeDir);
    const reverse = path.relative(probeDir, path.resolve(other));
    const inside = value => value === '' || (!value.startsWith('..' + path.sep) && value !== '..' && !path.isAbsolute(value));
    if (inside(relative) || inside(reverse)) throw new Error('IPC probe directory must be separate from MT5 base and sandbox data.');
  }
  const terminalPath = path.join(probeDir, 'terminal64.exe');
  const serversHashFile = path.join(probeDir, 'keeper-servers.hash');
  let startPromise = null;
  let ownerCache = null;

  function log(level, instanceUid, message) {
    const write = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
    if (write) write(instanceUid || null, message);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isSamePath(a, b) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }

  function fileHash(file) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (_error) {
      return null;
    }
  }

  // Hash of the broker list the running keeper loaded, recorded when it started.
  function readLoadedHash() {
    try {
      return fs.readFileSync(serversHashFile, 'utf8').trim() || null;
    } catch (_error) {
      return null;
    }
  }

  function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM';
    }
  }

  function exec(command, args, options = {}) {
    return new Promise(resolve => {
      execFile(command, args, { windowsHide: true, timeout: 20000, ...options }, (error, stdout) => {
        resolve(error ? null : String(stdout || ''));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Port ownership
  // -------------------------------------------------------------------------
  async function portOwnerPid(fresh = false) {
    if (!fresh && ownerCache && Date.now() - ownerCache.at < OWNER_CACHE_MS) return ownerCache.pid;
    const output = await exec('netstat.exe', ['-ano']);
    let pid = null;
    for (const line of String(output || '').split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      if (!parts[1].endsWith(':' + IPC_PORT)) continue;
      const value = Number.parseInt(parts[4], 10);
      if (Number.isInteger(value) && value > 0) { pid = value; break; }
    }
    ownerCache = { at: Date.now(), pid };
    return pid;
  }

  async function processInfo(pid) {
    const output = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p.Name + '|' + $p.ExecutablePath}`]);
    const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return { name: null, executablePath: null };
    const [name, executablePath] = lines[lines.length - 1].split('|');
    return { name: name || null, executablePath: executablePath || null };
  }

  function instanceUidFor(directory) {
    if (!directory) return null;
    const root = path.resolve(config.sandboxUsersDir);
    const relative = path.relative(root, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const [first] = relative.split(path.sep);
    return INSTANCE_UID_PATTERN.test(first) ? first : null;
  }

  // Reports who currently owns the IPC port and whether it is the keeper.
  // The keeper is identified by its executable directory: the agent runs
  // elevated, so it can read the image path of a terminal it started.
  async function owner(fresh = false) {
    const pid = await portOwnerPid(fresh);
    if (!pid) return { owned: false, pid: null, name: null, executablePath: null, directory: null, isProbe: false, instanceUid: null };
    const info = await processInfo(pid);
    const directory = info.executablePath ? path.dirname(info.executablePath) : null;
    return {
      owned: true,
      pid,
      name: info.name,
      executablePath: info.executablePath,
      directory,
      isProbe: !!directory && isSamePath(directory, probeDir),
      instanceUid: instanceUidFor(directory)
    };
  }

  async function probeOwner() {
    const escaped = terminalPath.replace(/'/g, "''");
    const output = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$rows=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" -ErrorAction Stop | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -ieq '${escaped}'} | ForEach-Object {@{pid=[int]$_.ProcessId;path=$_.ExecutablePath}}); ConvertTo-Json -InputObject $rows -Compress`]);
    if (output === null) throw new Error('Cannot inspect preflight terminal processes; no replacement was launched.');
    let rows;try { rows=JSON.parse(output.trim() || '[]'); } catch { throw new Error('Invalid preflight process inventory; no replacement was launched.'); }
    if (!Array.isArray(rows) || rows.some(row=>!Number.isInteger(row.pid)||row.pid<=0||typeof row.path!=='string'||!isSamePath(row.path,terminalPath))) throw new Error('Unverified preflight process inventory.');
    if (rows.length>1) throw new Error('Multiple processes use the preflight directory; maintenance is required.');
    const row=rows[0];return {owned:!!row,isProbe:!!row,pid:row?.pid||null,directory:probeDir,executablePath:row?.path||null,instanceUid:null};
  }

  // -------------------------------------------------------------------------
  // Keeper files
  // -------------------------------------------------------------------------
  async function robocopy(source, target) {
    await new Promise((resolve, reject) => {
      execFile('robocopy.exe', [source, target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:1'],
        { timeout: 5 * 60 * 1000, windowsHide: true }, error => {
          // robocopy exit codes 0-7 are success states; >= 8 is failure.
          if (error && typeof error.code === 'number' && error.code < 8) return resolve();
          if (error && typeof error.code === 'number') return reject(new Error(`Probe terminal copy failed with exit code ${error.code}`));
          if (error) return reject(error);
          resolve();
        });
    });
  }

  // The keeper is a portable MT5 copy, so it gets its own isolated data folder
  // and can never write into the shared base the sandboxes are copied from.
  async function prepare() {
    fs.mkdirSync(path.join(probeDir, 'config'), { recursive: true });
    if (fs.existsSync(terminalPath)) {
      writeProbeStartup();
      return { ok: true, created: false };
    }
    const base = path.resolve(config.mt5BaseDir);
    if (!fs.existsSync(path.join(base, 'terminal64.exe'))) {
      return { ok: false, error: `MT5 base terminal is missing at ${base}; the IPC probe cannot be created.` };
    }
    fs.mkdirSync(probeDir, { recursive: true });
    log('info', null, `Creating the IPC probe terminal at ${probeDir}.`);
    try {
      await robocopy(base, probeDir);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    if (!fs.existsSync(terminalPath)) return { ok: false, error: 'IPC probe terminal copy is incomplete.' };
    writeProbeStartup();
    return { ok: true, created: true };
  }

  function writeProbeStartup() {
    let proxySettings=null;
    try { proxySettings=JSON.parse(fs.readFileSync(path.join(probeDir,'config','probe-proxy-settings.json'),'utf8')); } catch {}
    fs.writeFileSync(path.join(probeDir, 'config', 'probe-startup.ini'), '\ufeff' + [
      '[Common]', ...require('./proxy-protocol').proxyLines(proxySettings), '',
      '[Experts]', 'Enabled=0', 'AllowLiveTrading=0', 'AllowDllImport=0', '', '[StartUp]', ''
    ].join('\r\n'), 'utf16le');
  }

  function launch() {
    const child = spawn(terminalPath, ['/portable', '/config:' + path.join(probeDir, 'config', 'probe-startup.ini')], {
      cwd: probeDir,
      // Detached so the keeper survives agent restarts and updates, exactly
      // like the sandbox terminals.
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', error => log('error', null, `IPC probe terminal failed to start: ${error.message}`));
    child.on('exit', code => {
      if (!startPromise) log('warn', null, `IPC probe terminal exited (code ${code}).`);
    });
    child.unref?.();
    // Remember which broker list this keeper loaded. A file that changes on
    // disk is not picked up by a running terminal, so the next preflight has to
    // recycle the keeper instead of trusting the file alone.
    try { fs.writeFileSync(serversHashFile, fileHash(path.join(probeDir, 'config', 'servers.dat')) || '', 'utf8'); } catch (_error) { /* best effort */ }
    log('info', null, `IPC probe terminal started (pid ${child.pid}).`);
    return child.pid;
  }

  async function waitFor(fn, timeoutMs, intervalMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  async function stopOwner(ownerInfo) {
    if (!ownerInfo || !ownerInfo.pid || !isAlive(ownerInfo.pid)) return;
    const pid = ownerInfo.pid;
    if ((await probeOwner()).pid !== pid) return;
    const terminate = force => new Promise(resolve => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
        { windowsHide: true, timeout: force ? 15000 : config.stopGraceMs }, () => resolve());
    });
    await terminate(false);
    const closed = await waitFor(() => !isAlive(pid), Math.max(1000, config.stopGraceMs));
    if (!closed) {
      await terminate(true);
      await waitFor(() => !isAlive(pid), 15000);
    }
    ownerCache = null;
  }

  // Stops the keeper (used when its server list changed and it has to reload).
  async function stop() {
    const current = await probeOwner();
    if (!current.isProbe) return { stopped: false };
    log('info', null, `Stopping the IPC probe terminal (pid ${current.pid}).`);
    await stopOwner(current);
    return { stopped: !(await probeOwner()).owned };
  }

  // Copies the broker server list into the keeper. A login can only resolve a
  // broker name that is listed there, and a running terminal keeps the list it
  // loaded, so any change recycles the keeper before the probe signs in.
  async function prepareForServer(server, runtimeConfig = config) {
    const target = path.join(probeDir, 'config', 'servers.dat');
    let copied = false;
    try {
      copied = copyBrokerServerCache(probeDir, server, runtimeConfig);
    } catch (error) {
      log('warn', null, `Could not refresh the IPC probe server list: ${error.message}`);
    }
    const current = fileHash(target);
    const loaded = readLoadedHash();
    if (!copied || !current) return { copied, changed: false };
    const changed = loaded !== current;
    if (changed) {
      if ((await probeOwner()).isProbe) await stop();
      try { fs.rmSync(serversHashFile, { force: true }); } catch (_error) { /* best effort */ }
    }
    return { copied, changed };
  }

  // -------------------------------------------------------------------------
  // Startup / on-demand ownership
  // -------------------------------------------------------------------------
  // `ensure()` is safe to call concurrently: the first call performs the work
  // and the others await the same promise.
  function ensure(options = {}) {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      // A node that never ran a deploy does not need a 380 MB terminal copy;
      // create the keeper the first time a probe actually needs the port.
      if (!fs.existsSync(terminalPath) && options.create === false) {
        return { ok: false, skipped: true, detail: 'IPC probe has not been created yet.' };
      }
      const prepared = await prepare();
      if (!prepared.ok) {
        log('warn', null, prepared.error);
        return { ok: false, error: prepared.error };
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await probeOwner();
        if (current.isProbe) return { ok: true, pid: current.pid, started: attempt > 0 };

        // No owned preflight process exists. MCP listeners on other terminals
        // do not block a new dedicated preflight process.
        launch();
        const pid = await waitFor(async () => {
          const info = await probeOwner();
          return info.isProbe ? info.pid : null;
        }, 20000, 500);
        if (pid) {
          log('info', null, `Preflight terminal running (pid ${pid}); Python will verify broker readiness.`);
          return { ok: true, pid, started: true };
        }
      }
      return { ok: false, error: 'Preflight terminal did not start from its owned directory.' };
    })().catch(error => {
      log('error', null, `IPC probe failed: ${error.message}`);
      return { ok: false, error: error.message };
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  async function status() {
    const info = await probeOwner();
    return {
      dir: probeDir,
      port: IPC_PORT,
      portPurpose: 'mcp_diagnostic_only',
      installed: fs.existsSync(terminalPath),
      ownedByProbe: info.isProbe,
      ownerPid: info.pid,
      ownerInstanceUid: info.instanceUid
    };
  }

  async function prepareNetwork(settings) {
    const value=require('./proxy-protocol').proxyCommon(settings),file=path.join(probeDir,'config','probe-proxy-settings.json');
    let previous=null;try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    if(JSON.stringify(previous)!==JSON.stringify(value)){
      await stop();
      if((await probeOwner()).isProbe)throw new Error('IPC keeper did not stop; proxy configuration was not changed.');
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});writeProbeStartup();
    }
  }
  return { dir: probeDir, port: IPC_PORT, terminalPath, prepare, prepareForServer, prepareNetwork, ensure, stop, owner, status };
}

module.exports = { createIpcProbe, IPC_PORT };
