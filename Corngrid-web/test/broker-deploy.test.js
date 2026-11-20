const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const rejectLogin of [false, true]) test(`deployment ${rejectLogin ? 'blocks EA on failed login' : 'starts EA only after verified canonical server and symbol'}`, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deploy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const base = path.join(temp, 'base');fs.mkdirSync(base);fs.writeFileSync(path.join(base, 'terminal64.exe'), 'fixture');
  const events=[];const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, process, Date, setTimeout, clearTimeout,
    require: name => name === './broker-resolution' ? { resolveBroker: async (dir, payload) => {
      events.push('verify');assert.equal(fs.existsSync(path.join(dir,'MQL5/Experts/CornGrid/CornGrid.ex5')),false);
      if(rejectLogin)throw new Error('Broker login failed');
      return {...payload,brokerServer:'JustMarkets-Demo6',resolvedSymbol:'XAUUSD.c'};
    }} : name === './broker-server-cache' ? require('../agent/broker-server-cache')
      : name === './mt5-startup' ? require('../agent/mt5-startup')
        : name === 'child_process' ? {
          execFile: (exe,args,_options,done) => {assert.equal(exe,'robocopy.exe');fs.cpSync(args[0],args[1],{recursive:true});done(null);},
          spawn: (_exe,args) => {events.push('launch');const ini=fs.readFileSync(args[1].slice('/config:'.length),'utf16le');assert.match(ini,/Server=JustMarkets-Demo6/);assert.match(ini,/Symbol=XAUUSD.c/);const child=new EventEmitter();child.pid=777;return child;}
        } : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const manager=module.exports.createMt5Manager({config:{mt5BaseDir:base,sandboxUsersDir:path.join(temp,'users'),backendUrl:'https://example.test'},logger:{info(){},warn(){},error(){}},downloadFile:async (_url,file)=>{events.push('download');fs.writeFileSync(file,'fixture EA');}});
  const payload={instanceUid:'sbx_0123456789abcdef01',accountNumber:'123456',password:'fixture-only',brokerServer:'JustMarkets-DEMO6',symbol:'XAUUSD',installationSecret:'a'.repeat(64),strategy:{code:'corngrid-ea',eaFileName:'CornGrid.ex5'}};
  if(rejectLogin){await assert.rejects(manager.deploy(payload),/Broker login failed/);assert.deepEqual(events,['verify']);}
  else{await manager.deploy(payload);assert.deepEqual(events,['verify','download','launch']);}
});

function environment(t, { verify, failDownload = false, failCleanup = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deploy-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base'), users = path.join(root, 'users');
  fs.mkdirSync(base); fs.writeFileSync(path.join(base, 'terminal64.exe'), 'fixture');
  const events = [], module = { exports: {} };
  const io = failCleanup ? new Proxy(fs, { get: (target, key) => key === 'promises'
    ? { rm: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } } : target[key] }) : fs;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/mt5-manager.js'), 'utf8'), {
    module, Date, setTimeout, clearTimeout,
    process: { platform: 'win32', kill: () => { throw Object.assign(new Error('fixture stopped'), { code: 'ESRCH' }); } },
    require: name => name === 'fs' ? io : name === './broker-resolution' ? {
      resolveBroker: async (dir, payload) => {
        events.push('verify');
        if (verify) await verify();
        return { ...payload, resolvedSymbol: 'GOLD' };
      }
    } : name === 'child_process' ? {
      execFile: (_exe, args, _opts, done) => { fs.cpSync(args[0], args[1], { recursive: true }); done(null); },
      spawn: () => { events.push('launch'); const child = new EventEmitter(); child.pid = 777; return child; }
    } : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const manager = module.exports.createMt5Manager({ config: { mt5BaseDir: base, sandboxUsersDir: users, backendUrl: 'https://example.test' },
    logger: { info() {}, warn() {}, error() {} }, downloadFile: async (_url, target) => {
      events.push('download'); if (failDownload) throw new Error('Download failed'); fs.writeFileSync(target, 'fixture EA');
    } });
  const payload = { instanceUid: 'sbx_0123456789abcdef01', accountNumber: '123', brokerServer: 'Broker-Demo', password: 'fixture',
    installationSecret: 'a'.repeat(64), strategy: { code: 'corngrid-ea', eaFileName: 'CornGrid.ex5' } };
  return { manager, payload, events, dir: path.join(users, payload.instanceUid) };
}

test('recovery Start waits for deployment and reuses its terminal instead of launching twice', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = environment(t, { verify: async () => { entered(); await gate; } });
  const deployment = f.manager.deploy(f.payload);
  await started;
  const recovery = f.manager.start(f.payload);
  await Promise.resolve();
  assert.deepEqual(f.events, ['verify']);
  release();
  assert.equal((await deployment).pid, 777);
  assert.equal((await recovery).alreadyRunning, true);
  assert.equal(f.events.filter(x => x === 'launch').length, 1);
  assert.equal(fs.existsSync(path.join(f.dir, '.corngrid-deployment-incomplete')), false);
});

test('failed EA download cleans up and cannot be started as a half-installed sandbox', async t => {
  const f = environment(t, { failDownload: true });
  await assert.rejects(f.manager.deploy(f.payload), /Download failed/);
  assert.equal(fs.existsSync(f.dir), false);
  await assert.rejects(f.manager.start(f.payload), /not deployed/);
  assert.equal(f.events.includes('launch'), false);
});

test('locked cleanup keeps a failure marker that blocks Start without raw ENOENT', async t => {
  const f = environment(t, { failDownload: true, failCleanup: true });
  await assert.rejects(f.manager.deploy(f.payload), /Download failed/);
  assert.equal(fs.existsSync(path.join(f.dir, '.corngrid-deployment-incomplete')), true);
  await assert.rejects(f.manager.start(f.payload), /deployment did not finish.*Redeploy/);
  assert.equal(f.events.includes('launch'), false);
});

test('legacy partial directory without a licence is rejected with a redeploy instruction', async t => {
  const f = environment(t);
  fs.mkdirSync(f.dir, { recursive: true }); fs.writeFileSync(path.join(f.dir, 'terminal64.exe'), 'fixture');
  await assert.rejects(f.manager.start(f.payload), /incomplete.*licence bundle.*Redeploy/);
  assert.equal(f.events.length, 0);
});
