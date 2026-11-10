const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createTransport } = require('../agent/transport');

test('reconnect waits for the old terminal to exit after taskkill acknowledges close', async () => {
  let alive = true;
  let launches = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, Date, setTimeout, clearTimeout,
    process: { kill() { if (!alive) throw Object.assign(new Error('exited'), { code: 'ESRCH' }); } },
    require: name => name === 'fs' ? { existsSync: () => true }
      : name === './mt5-startup' ? { ensureStartup: () => 'startup.ini' }
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
        } : require(name)
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
    require: name => name === 'fs' ? { existsSync: () => true }
      : name === './mt5-startup' ? { ensureStartup: () => 'startup.ini' }
        : name === './broker-resolution' ? require('../agent/broker-resolution')
        : name === './broker-server-cache' ? {} : name === 'child_process' ? {
          spawn: () => { const child = new EventEmitter(); child.pid = 100 + children.length; children.push(child); return child; }
        } : require(name)
  });
  const manager = module.exports.createMt5Manager({ config: {
    sandboxUsersDir: 'C:/test', restartWindowMs: 600000, restartMaxAttempts: 2
  }, logger: { info() {}, warn() {}, error() {} } });
  const payload = { instanceUid: 'sbx_0123456789abcdef01' };
  await manager.start(payload);
  for (let i = 0; i < 2; i++) {
    children[i].emit('exit', 0);
    const [id, timer] = [...timers][0]; timers.delete(id); timer.fn();
  }
  children[2].emit('exit', 0);
  assert.equal(children.length, 3);
  assert.ok([...timers.values()][0].delay > 500000, 'crash loop enters cooldown');
  assert.equal((await manager.start(payload)).recovering, true, 'polling cannot bypass cooldown');
  await manager.stop(payload);
  assert.equal(timers.size, 0, 'manual stop cancels pending restart');
  assert.equal(manager.statusReports().length, 0);
});
