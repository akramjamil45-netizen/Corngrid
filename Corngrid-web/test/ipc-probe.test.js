const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createIpcProbe } = require('../agent/ipc-probe');

test('keeper route changes write local proxy settings and reset them for the next direct preflight', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-keeper-network-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../agent/ipc-probe.js'),'utf8'),{
    require(name){if(name==='node:child_process')return {spawn(){throw Error('unexpected terminal launch');},execFile(command,args,options,callback){calls.push(command);callback(null,'');}};
      if(name==='./broker-server-cache')return require('../agent/broker-server-cache');if(name==='./proxy-protocol')return require('../agent/proxy-protocol');return require(name);},
    module,exports:module.exports,process,setTimeout,clearTimeout,Buffer
  });
  const probe=module.exports.createIpcProbe({config:{ipcProbeDir:path.join(root,'probe'),sandboxUsersDir:path.join(root,'users'),mt5BaseDir:path.join(root,'base')},logger:{}});
  await probe.prepareNetwork({ProxyEnable:1,ProxyType:1,ProxyAddress:'127.0.0.1:32123',ProxyLogin:'keeper',ProxyPassword:'private-fixture'});
  const file=path.join(root,'probe/config/probe-startup.ini');assert.match(fs.readFileSync(file,'utf16le'),/ProxyEnable=1[\s\S]*ProxyAddress=127\.0\.0\.1:32123/);
  await probe.prepareNetwork(null);const direct=fs.readFileSync(file,'utf16le');assert.match(direct,/ProxyEnable=0/);assert.ok(!direct.includes('private-fixture'));assert.ok(!calls.includes('taskkill.exe'),'no user terminal is stopped');
});

test('IPC keeper refuses directories overlapping MT5 base or sandbox data', () => {
  for (const ipcProbeDir of ['C:/sandbox', 'C:/sandbox/users', 'C:/sandbox/users/probe', 'C:/base']) {
    assert.throws(() => createIpcProbe({ config: { ipcProbeDir, sandboxUsersDir: 'C:/sandbox/users', mt5BaseDir: 'C:/base' } }), /must be separate/);
  }
});

test('busy port never stops an existing user terminal even if a legacy config requests takeover', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-keeper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probeDir = path.join(root, 'probe');
  fs.mkdirSync(probeDir); fs.writeFileSync(path.join(probeDir, 'terminal64.exe'), 'fixture');
  const calls = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../agent/ipc-probe.js'), 'utf8'), {
    module, process, Date, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? {
      spawn: () => { throw new Error('User terminal must remain untouched'); },
      execFile: (file, _args, _opts, done) => {
        calls.push(file);
        if (file === 'netstat.exe') done(null, 'TCP 127.0.0.1:22346 0.0.0.0:0 LISTENING 1234');
        else if (file === 'powershell.exe') done(null, 'terminal64.exe|' + path.join(root, 'users/sbx_0123456789abcdef01/terminal64.exe'));
        else throw new Error('Unexpected process mutation: ' + file);
      }
    } : name.startsWith('./') ? require('../agent/' + name.slice(2)) : require(name)
  });
  const keeper = module.exports.createIpcProbe({ config: { ipcProbeDir: probeDir, sandboxUsersDir: path.join(root, 'users'), mt5BaseDir: path.join(root, 'base') } });
  const result = await keeper.ensure({ allowTakeover: true });
  assert.equal(result.busy, true);
  assert.ok(!calls.includes('taskkill.exe'));
  const ini = fs.readFileSync(path.join(probeDir, 'config/probe-startup.ini'), 'utf16le');
  assert.match(ini, /Enabled=0/); assert.match(ini, /AllowLiveTrading=0/);
});
