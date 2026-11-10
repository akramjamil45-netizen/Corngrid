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
        } : require(name)
  });
  const manager=module.exports.createMt5Manager({config:{mt5BaseDir:base,sandboxUsersDir:path.join(temp,'users'),backendUrl:'https://example.test'},logger:{info(){},warn(){},error(){}},downloadFile:async (_url,file)=>{events.push('download');fs.writeFileSync(file,'fixture EA');}});
  const payload={instanceUid:'sbx_0123456789abcdef01',accountNumber:'123456',password:'fixture-only',brokerServer:'JustMarkets-DEMO6',symbol:'XAUUSD',installationSecret:'a'.repeat(64),strategy:{code:'corngrid-ea',eaFileName:'CornGrid.ex5'}};
  if(rejectLogin){await assert.rejects(manager.deploy(payload),/Broker login failed/);assert.deepEqual(events,['verify']);}
  else{await manager.deploy(payload);assert.deepEqual(events,['verify','download','launch']);}
});
