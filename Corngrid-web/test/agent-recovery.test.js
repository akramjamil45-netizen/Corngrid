const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createTransport } = require('../agent/transport');

test('an empty node authenticates without starting Windows process inventory', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cg-empty-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, Date, setTimeout, clearTimeout, process: { platform: 'win32' },
    require: name => name === 'child_process' ? { execFile() { throw new Error('No PowerShell is needed on an empty node'); } }
      : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const manager = module.exports.createMt5Manager({ config: { sandboxUsersDir: root }, logger: { info() {}, warn() {}, error() {} } });
  await manager.reconcile();
  assert.deepEqual(Array.from(manager.trackedPids()), []);
});

test('Windows adoption uses one process inventory for historical sandbox directories', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cg-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const uid = 'sbx_' + i.toString(16).padStart(18, '0');
    const dir = path.join(root, uid); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'terminal64.exe'), 'fixture');
    if (i < 3) rows.push({ ProcessId: 1000 + i, ExecutablePath: path.join(dir, 'terminal64.exe') });
  }
  let queries = 0, invalid = false, queryFailed = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, Date, setTimeout, clearTimeout, process: { platform: 'win32', kill: process.kill.bind(process) },
    require: name => name === 'child_process' ? {
      execFile: (exe, args, _opts, done) => {
        assert.equal(exe, 'powershell.exe'); queries++;
        assert.match(args.at(-1), /ErrorActionPreference='Stop'/);
        if (queryFailed) return done(new Error('Access denied'));
        done(null, JSON.stringify(invalid ? [{ ProcessId: 1000, ExecutablePath: null }] : rows));
      }
    } : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const manager = module.exports.createMt5Manager({ config: { sandboxUsersDir: root }, logger: { info() {}, warn() {}, error() {} } });
  await manager.reconcile();
  assert.equal(queries, 1); assert.deepEqual(Array.from(manager.trackedPids()).sort(), [1000, 1001, 1002]);
  invalid = true;
  await assert.rejects(manager.reconcile(), /inventory is incomplete/);
  queryFailed = true;
  await assert.rejects(manager.reconcile(), /inventory is unavailable/);
});

test('agent authenticates and reports healthy without waiting for a broker keeper', async () => {
  let connected = false, healthy = false;
  const config = { nodeUid: 'fixture', nodeToken: 'fixture', agentDataDir: 'fixture', sandboxUsersDir: 'fixture', heartbeatIntervalMs: 15000 };
  const manager = { validateBase: () => ({ ok: true }), reconcile: async () => {}, statusReports: () => [], trackedPids: () => [], checkAdopted() {} };
  const transport = {
    httpRequest: async () => ({ instances: [] }), sendHeartbeat: async () => {}, sendLogs: async () => {},
    stop() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/agent.js'), 'utf8'), {
    process: { platform: 'win32', env: {}, on() {}, send: message => { if (message.type === 'agent_healthy') healthy = true; } },
    console: { log() {}, warn() {}, error: message => { throw new Error(String(message)); } },
    setTimeout, clearTimeout, clearInterval() {}, setInterval: () => ({ unref() {} }), URL, Date,
    require: name => name === 'fs' ? { mkdirSync() {}, appendFileSync() {} }
      : name === './config' ? { loadConfig: () => config }
      : name === './mt5-manager' ? { createMt5Manager: () => manager }
      : name === './ipc-probe' ? { createIpcProbe: () => ({ ensure() { throw new Error('Unavailable keeper must not block agent startup'); } }) }
      : name === './ea-tester' ? { createEaTester: () => ({}) }
      : name === './transport' ? { createTransport: options => { transport.start = () => { connected = true; options.onOpen(); }; return transport; } }
      : name === './system-monitor' ? { sampleCpuPercent: () => 0, memoryMb: () => ({}), processMemoryMb: async () => new Map(), diskFreeMb: () => 1000 }
      : name === './auto-update' ? { createAutoUpdater: () => ({ start() {} }) }
      : name === './package.json' ? { version: 'fixture' }
      : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(connected, true); assert.equal(healthy, true);
});

test('reconnect waits for the old terminal to exit after taskkill acknowledges close', async () => {
  let alive = true;
  let launches = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, Date, setTimeout, clearTimeout,
    process: { kill() { if (!alive) throw Object.assign(new Error('exited'), { code: 'ESRCH' }); } },
    require: name => name === 'fs' ? { existsSync: file => !file.endsWith('.corngrid-deployment-incomplete') }
      : name === './mt5-startup' ? { ensureStartup: () => 'startup.ini', loadStartupPayload: () => ({strategy:{eaFileName:'CornGrid.ex5'}}) }
        : name === './broker-resolution' ? require('../agent/broker-resolution')
        : name === './broker-server-cache' ? {} : name === 'child_process' ? {
          spawn: () => {
            if (launches++) assert.equal(alive, false, 'old terminal releases its data directory first');
            const child = new EventEmitter(); child.pid = 500 + launches; return child;
          },
          execFile: (_file, args, _opts, done) => {
            assert.ok(!args.includes('/F'), 'normal close gets time to complete');
            done(null);
            setTimeout(() => { alive = false; }, 30);
          }
        } : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const manager = module.exports.createMt5Manager({ config: { sandboxUsersDir: 'C:/test', stopGraceMs: 1000 },
    logger: { info() {}, warn() {}, error() {} } });
  const payload = { instanceUid: 'sbx_0123456789abcdef01' };
  await manager.start(payload);
  await manager.reconnect(payload);
  assert.equal(launches, 2);
});

test('agent reconnects and authenticates after backend restarts on the same port', async t => {
  let server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  let opens = 0;
  const authenticate = ws => ws.on('message', raw => {
    if (JSON.parse(raw).type === 'auth') ws.send(JSON.stringify({ type: 'authenticated' }));
  });
  server.on('connection', authenticate);
  const transport = createTransport({ config: {
    wsUrl: `ws://127.0.0.1:${port}`, backendUrl: `http://127.0.0.1:${port}`,
    nodeUid: 'node-test', nodeToken: 'test', reconnectMinMs: 10, reconnectMaxMs: 50
  }, onOpen: () => opens++ });
  t.after(async () => {
    transport.stop();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'connection recovered before deadline');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  transport.start();
  await until(() => opens === 1);
  for (const client of server.clients) client.terminate();
  await new Promise(resolve => server.close(resolve));
  server = new WebSocket.Server({ port, host: '127.0.0.1' });
  server.on('connection', authenticate);
  await until(() => opens === 2);
});

test('terminal failures preserve retry history and explicit stop cancels recovery', async () => {
  const children = [];
  const timers = new Map();
  let counter = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, Date, process: { kill() {} },
    setTimeout: (fn, delay) => { timers.set(++counter, { fn, delay }); return counter; },
    clearTimeout: id => timers.delete(id),
    require: name => name === 'fs' ? { existsSync: file => !file.endsWith('.corngrid-deployment-incomplete') }
      : name === './mt5-startup' ? { ensureStartup: () => 'startup.ini', loadStartupPayload: () => ({strategy:{eaFileName:'CornGrid.ex5'}}) }
        : name === './broker-resolution' ? require('../agent/broker-resolution')
        : name === './broker-server-cache' ? {} : name === 'child_process' ? {
          spawn: () => { const child = new EventEmitter(); child.pid = 100 + children.length; children.push(child); return child; }
        } : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const manager = module.exports.createMt5Manager({ config: {
    sandboxUsersDir: 'C:/test', restartWindowMs: 600000, restartMaxAttempts: 2
  }, logger: { info() {}, warn() {}, error() {} } });
  const payload = { instanceUid: 'sbx_0123456789abcdef01' };
  await manager.start(payload);
  for (let i = 0; i < 2; i++) {
    children[i].emit('exit', 0);
    const [id, timer] = [...timers][0]; timers.delete(id); await timer.fn();
  }
  children[2].emit('exit', 0);
  assert.equal(children.length, 3);
  assert.ok([...timers.values()][0].delay > 500000, 'crash loop enters cooldown');
  assert.equal((await manager.start(payload)).recovering, true, 'polling cannot bypass cooldown');
  await manager.stop(payload);
  assert.equal(timers.size, 0, 'manual stop cancels pending restart');
  assert.equal(manager.statusReports().length, 0);
});
