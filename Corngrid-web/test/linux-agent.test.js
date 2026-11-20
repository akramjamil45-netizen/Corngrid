'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib'),vm=require('node:vm');
const {createLinuxRuntime,toWinePath}=require('../agent/linux-runtime');
const protocol=require('../agent/update-protocol');
const backend=path.resolve(__dirname,'..'),uid='sbx_'+'a'.repeat(18),dir='/instances/'+uid;
// A POSIX filesystem backed by a disposable directory. No real /proc, Wine,
// systemd, credentials or live nodes are used, even when run on Windows.
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-linux-test-'));
 t.after(()=>{assert.match(path.relative(os.tmpdir(),root),/^corngrid-linux-test-[a-z0-9]+$/i);fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
 const native=value=>path.join(root,...String(value).split('/').filter(Boolean));
 const io={};
 for(const name of ['existsSync','lstatSync','readFileSync','readdirSync','chmodSync','mkdirSync','writeFileSync','rmSync'])io[name]=(value,...args)=>fs[name](native(value),...args);
 io.realpathSync=value=>'/'+path.relative(root,fs.realpathSync(native(value))).split(path.sep).join('/');
 io.cpSync=(source,target,options)=>fs.cpSync(native(source),native(target),{...options,filter:options.filter?(file)=>options.filter('/'+path.relative(root,file).split(path.sep).join('/')):undefined});
 io.renameSync=(a,b)=>fs.renameSync(native(a),native(b));
 for(const name of ['/instances','/data/tests','/prefixes','/template/drive_c','/proc','/agent'])io.mkdirSync(name,{recursive:true});
 io.writeFileSync('/template/system.reg','fixture registry');io.mkdirSync(dir);
 const config={sandboxUsersDir:'/instances',agentDataDir:'/data',winePrefixesDir:'/prefixes',wineTemplateDir:'/template',wineBinary:'/usr/bin/wine',wineDisplay:':99',xAuthority:'/auth',agentHome:'/agent',linuxWineEnabled:true,linuxStartupTimeoutMs:2};
 const calls=[];let onRun=()=>{},clock=0;
 const runtime=createLinuxRuntime({config,fsImpl:io,pathImpl:path.posix,run:(file,args,options,done)=>{calls.push({file,args,options});try{const value=onRun(file,args);done(value?.error||null,value?.stdout||'loaded');}catch(error){done(error,'');}},now:()=>clock,sleep:async()=>{clock+=3;}});
 function proc(pid,{prefix='/prefixes/'+uid,unit=runtime.unitFor(dir),exe='Z:\\instances\\'+uid+'\\terminal64.exe'}={}){
  const base='/proc/'+pid;io.mkdirSync(base,{recursive:true});io.writeFileSync(base+'/environ','WINEPREFIX='+prefix+'\0');io.writeFileSync(base+'/cmdline',exe+'\0/portable\0');io.writeFileSync(base+'/cgroup','0::/user.slice/'+unit+'\n');
 }
 return {root,io,native,config,runtime,calls,proc,onRun:callback=>onRun=callback};
}
test('Wine paths require absolute Linux paths and preserve spaces without shell interpolation',()=>{
 assert.equal(toWinePath('/opt/MT5 Folder/terminal64.exe'),'Z:\\opt\\MT5 Folder\\terminal64.exe');
 for(const value of ['relative','C:\\MT5','/a\nb','/a\\b','/a:b','/a\0b'])assert.throws(()=>toWinePath(value));
});
test('Linux process adoption checks exact prefix, terminal identity and sandbox unit cgroup',t=>{
 const f=fixture(t);f.proc(101);f.proc(102,{prefix:'/prefixes/'+uid+'extra'});f.proc(103,{prefix:'/prefixes/other'});
 assert.equal(f.runtime.findTerminalPid(dir),101);
 f.proc(104,{unit:f.runtime.unitFor(dir)+'-lookalike'});assert.throws(()=>f.runtime.findTerminalPid(dir),/unmanaged/);
 f.io.rmSync('/proc/104',{recursive:true});f.proc(105);assert.throws(()=>f.runtime.findTerminalPid(dir),/Multiple/);
});
test('Linux prefixes clone initialized templates, validate markers and refuse live deletion',t=>{
 const f=fixture(t),prefix=f.runtime.ensurePrefix(dir);assert.equal(prefix,'/prefixes/'+uid);assert.ok(f.io.existsSync(prefix+'/system.reg'));
 assert.equal(JSON.parse(f.io.readFileSync(prefix+'/corngrid-prefix.json')).instanceUid,uid);
 f.proc(101);assert.throws(()=>f.runtime.removePrefix(dir),/running/);assert.ok(f.io.existsSync(prefix));
 f.io.rmSync('/proc/101',{recursive:true});f.io.writeFileSync(prefix+'/corngrid-prefix.json','{}');assert.throws(()=>f.runtime.removePrefix(dir),/not created/);assert.ok(f.io.existsSync(prefix));
});
test('Linux rejects path traversal and canonical-directory escapes before filesystem changes',t=>{
 const f=fixture(t);
 for(const value of ['/other/'+uid,'/instances/invalid','/instances/nested/'+uid,'/instances/'+uid+'/../escape'])assert.throws(()=>f.runtime.identity(value),/Unsafe/);
 const original=f.io.realpathSync;f.io.realpathSync=value=>value===dir?'/elsewhere/'+uid:original(value);assert.throws(()=>f.runtime.ensurePrefix(dir),/links/);assert.equal(f.io.readdirSync('/prefixes').length,0);
});
test('Linux refuses copying a Wine template still used by a process',t=>{
 const f=fixture(t);f.proc(111,{prefix:'/template',unit:'operator.service'});assert.throws(()=>f.runtime.ensurePrefix(dir),/Stop Wine/);assert.equal(f.io.readdirSync('/prefixes').length,0);
});
test('Linux service arguments use private per-instance prefixes and argv arrays, then adopt actual terminal',async t=>{
 const f=fixture(t);f.onRun((file,args)=>{if(file==='systemd-run')f.proc(120);});
 const result=await f.runtime.startTerminal(dir,dir+'/config/startup.ini');assert.equal(result.pid,120);
 const command=f.calls.find(c=>c.file==='systemd-run');assert.ok(command.args.includes('--unit=corngrid-mt5-'+uid+'.service'));assert.ok(command.args.includes('--property=KillMode=control-group'));assert.ok(command.args.includes('--setenv=WINEPREFIX=/prefixes/'+uid));assert.ok(command.args.includes('/config:Z:\\instances\\'+uid+'\\config\\startup.ini'));assert.equal(command.options.shell,undefined);
 const before=f.calls.length;assert.equal((await f.runtime.startTerminal(dir,dir+'/config/startup.ini')).pid,120);assert.equal(f.calls.length,before,'adoption never creates a duplicate unit');
});
test('Linux preflight and compile units always stop their own process group on errors',async t=>{
 const f=fixture(t);f.onRun(file=>file==='systemd-run'?{error:Object.assign(Error('private stderr'),{code:1})}:undefined);
 await assert.rejects(f.runtime.runProgram(dir,'/opt/python.exe',['Z:\\agent\\broker-probe.py'],{kind:'probe'}),/Linux runtime command failed/);
 const runs=f.calls.filter(c=>c.file==='systemd-run');assert.ok(runs[0].args.includes('--wait'));assert.ok(runs[0].args.includes('--pipe'));
 const stops=f.calls.filter(c=>c.file==='systemctl'&&c.args.includes('stop'));assert.equal(stops.length,2);assert.ok(stops.every(c=>c.args.at(-1)==='corngrid-probe-'+uid+'.service'));
});
test('Linux stop only targets exact instance units and treats a missing unit differently from bus failure',async t=>{
 const f=fixture(t);f.onRun((_file,args)=>args.includes('show')?{error:Object.assign(Error('missing'),{code:1}),stdout:'not-found'}:undefined);
 await f.runtime.stopDirectory(dir);assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.args.includes('show')));
 f.onRun(()=>({error:Object.assign(Error('bus down'),{code:1})}));await assert.rejects(f.runtime.stopDirectory(dir),/command failed/);assert.ok(f.calls.every(c=>!c.args.includes('stop')));
});
test('Linux startup timeout stops its own unit and cannot report a fake terminal PID',async t=>{
 const f=fixture(t);await assert.rejects(f.runtime.startTerminal(dir,dir+'/startup.ini'),/did not start/);assert.equal(f.calls.filter(c=>c.file==='systemctl'&&c.args.includes('stop')).length,2);
});
test('Linux terminal launch command failures clean up only their own unit',async t=>{
 const f=fixture(t);f.onRun(file=>file==='systemd-run'?{error:Object.assign(Error('command timeout'),{code:'ETIMEDOUT'})}:undefined);
 await assert.rejects(f.runtime.startTerminal(dir,dir+'/startup.ini'),/ETIMEDOUT/);const stops=f.calls.filter(c=>c.file==='systemctl'&&c.args.includes('stop'));assert.equal(stops.length,2);assert.ok(stops.every(c=>c.args.at(-1)===f.runtime.unitFor(dir)));
});
for(const rejectLogin of [false,true])test('Linux deployment '+(rejectLogin?'blocks EA when broker verification fails':'keeps broker, licence and EA startup workflow'),async t=>{
 const f=fixture(t),base=path.join(f.root,'mt5'),users=path.join(f.root,'users');fs.mkdirSync(base);fs.writeFileSync(path.join(base,'terminal64.exe'),'Never executed');
 const events=[],module={exports:{}},runtime={validate:()=>({ok:true}),stopDirectory:async()=>events.push('stop'),removePrefix:()=>events.push('remove-prefix'),copyTerminal:(source,target)=>fs.cpSync(source,target,{recursive:true}),startTerminal:async(directory,startup)=>{events.push('launch');assert.match(fs.readFileSync(startup,'utf16le'),/Symbol=XAUUSDc/);assert.ok(fs.readFileSync(path.join(directory,'MQL5/Files/corngrid_sandbox.ini'),'utf8').includes('a'.repeat(64)));return {pid:500};}};
 vm.runInNewContext(fs.readFileSync(path.join(backend,'agent/mt5-manager.js'),'utf8'),{module,Date,setTimeout,clearTimeout,process:{platform:'linux',kill(){}},require:name=>name==='./linux-runtime'?{createLinuxRuntime:()=>runtime}:name==='./broker-resolution'?{resolveBroker:async(directory,payload)=>{events.push('verify');assert.equal(fs.existsSync(path.join(directory,'MQL5/Experts/CornGrid/Test.ex5')),false);if(rejectLogin)throw Error('Broker login failed');return {...payload,resolvedSymbol:'XAUUSDc'};}}:name==='./mt5-startup'?require('../agent/mt5-startup'):name==='./broker-server-cache'?{copyBrokerServerCache(){}}:name==='child_process'?{spawn(){throw Error('Native Windows spawn must not run');},execFile(){throw Error('PowerShell must not run');}}:name.startsWith('./')?require('../agent/'+name.slice(2)):require(name)});
 const manager=module.exports.createMt5Manager({config:{mt5BaseDir:base,sandboxUsersDir:users,backendUrl:'https://example.test'},logger:{info(){},warn(){},error(){}},downloadFile:async(_url,target)=>{events.push('download');fs.writeFileSync(target,'Fixture EX5');}});
 const payload={instanceUid:uid,accountNumber:'123456',password:'fixture-only',brokerServer:'Fixture-Demo',symbol:'XAUUSD',installationSecret:'a'.repeat(64),strategy:{code:'fixture',eaFileName:'Test.ex5'}};
 if(rejectLogin){await assert.rejects(manager.deploy(payload),/Broker login/);assert.equal(events.includes('download'),false);assert.equal(events.includes('launch'),false);}
 else{assert.equal((await manager.deploy(payload)).pid,500);assert.ok(events.indexOf('verify')<events.indexOf('download'));assert.ok(events.indexOf('download')<events.indexOf('launch'));await manager.stop({instanceUid:uid});assert.equal(events.at(-1),'stop');assert.equal(manager.trackedPids().length,0);}
});
test('launcher keeps the external Linux config path when spawning a replacement agent',t=>{
 const f=fixture(t),{EventEmitter}=require('node:events'),{createLauncher}=require('../agent/agent-launcher');
 const previous=process.env.CORNGRID_AGENT_CONFIG_FILE;process.env.CORNGRID_AGENT_CONFIG_FILE='/etc/corngrid/agent-config.json';
 t.after(()=>{if(previous===undefined)delete process.env.CORNGRID_AGENT_CONFIG_FILE;else process.env.CORNGRID_AGENT_CONFIG_FILE=previous;});
 let received;const child=new EventEmitter();child.connected=true;child.send=()=>{};
 const launcher=createLauncher({config:{agentDataDir:path.join(f.root,'state')},home:path.join(backend,'agent'),spawnAgent:options=>{received=options;return child;}});t.after(()=>launcher.stop());launcher.start();
 assert.equal(received.env.CORNGRID_AGENT_CONFIG_FILE,'/etc/corngrid/agent-config.json');assert.equal(received.env.CORNGRID_AGENT_HOME,path.join(backend,'agent'));
});
test('Linux updates reject Windows-only signed releases while keeping Windows compatibility',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
 function signed(linux){
  const files=protocol.REQUIRED.map(name=>{const body=name==='package.json'?{version:'1.3.0',os:linux?['win32','linux']:['win32']}:name==='package-lock.json'?{version:'1.3.0',packages:{'':{version:'1.3.0'}}}:null;const bytes=Buffer.from(body?JSON.stringify(body):'// fixture');return {name,bytes:bytes.length,sha256:protocol.hash(bytes),data:bytes.toString('base64')};});
  if(linux){const bytes=Buffer.from('// Linux fixture');files.push({name:'linux-runtime.js',bytes:bytes.length,sha256:protocol.hash(bytes),data:bytes.toString('base64')});}
  const raw=Buffer.from(JSON.stringify({format:1,bootstrapVersion:1,version:'1.3.0',sequence:1,id:protocol.releaseId('1.3.0',files),files}));return {payload:raw.toString('base64'),signature:crypto.sign(null,raw,privateKey).toString('base64')};
 }
 assert.throws(()=>protocol.verifyEnvelope(signed(false),publicKey,{platform:'linux'}),/PLATFORM_UNSUPPORTED/);assert.doesNotThrow(()=>protocol.verifyEnvelope(signed(false),publicKey,{platform:'win32'}));assert.doesNotThrow(()=>protocol.verifyEnvelope(signed(true),publicKey,{platform:'linux'}));
});
test('Linux package has POSIX shell modes/LF, matching hashes, complete local requires and no live state',t=>{
 const f=fixture(t),output=path.join(f.root,'linux.tar.gz'),{build}=require('../scripts/build-linux-node-agent');build({output});
 const bytes=fs.readFileSync(output);assert.equal(fs.readFileSync(output+'.sha256','utf8').split(' ')[0],protocol.hash(bytes));
 const archive=zlib.gunzipSync(bytes),members=new Map();
 for(let offset=0;offset<archive.length&&archive[offset]!==0;){const h=archive.subarray(offset,offset+512),name=h.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(h.subarray(124,136).toString(),8),mode=parseInt(h.subarray(100,108).toString(),8);members.set(name,{bytes:archive.subarray(offset+512,offset+512+size),mode});offset+=512+Math.ceil(size/512)*512;}
 const manifest=JSON.parse(members.get('MANIFEST.json').bytes);assert.equal(manifest.platform,'linux-x64-wine');
 for(const item of manifest.files){const entry=members.get(item.path);assert.ok(entry,item.path);assert.equal(entry.bytes.length,item.bytes);assert.equal(protocol.hash(entry.bytes),item.sha256);assert.equal(entry.mode,item.mode);assert.equal(/(?:^|\/)(?:agent-config\.json|\.env|node_modules|update-trust\.pem|broker-python)(?:\/|$)/.test(item.path),false);}
 for(const name of ['install-service.sh','uninstall-service.sh']){const entry=members.get('agent/'+name);assert.equal(entry.mode,0o755);assert.equal(entry.bytes.includes(13),false);}
 for(const [name,entry]of members)if(name.endsWith('.js'))for(const match of entry.bytes.toString().matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g))assert.ok(members.has('agent/'+match[1]+'.js')||members.has('agent/'+match[1]),name+' -> '+match[1]);
 for(const name of ['VPS_NODE_INSTALLATION_WINDOWS.md','VPS_NODE_INSTALLATION_LINUX.md'])assert.ok(members.has(name));
});
test('installer validates Linux identity and paths without printing malformed secret configuration',t=>{
 const f=fixture(t),{spawnSync}=require('node:child_process'),script=fs.readFileSync(path.join(backend,'agent/install-service.sh'),'utf8');
 const validator=script.match(/"\$node_bin" -e '([^']+)' "\$config_source"/);assert.ok(validator);
 const example=path.join(backend,'agent/agent-config.linux.example.json'),valid={...JSON.parse(fs.readFileSync(example)),nodeUid:'node_'+'a'.repeat(18),nodeToken:'cgn_'+'b'.repeat(64)},config=path.join(f.root,'input.json');
 function check(value){fs.writeFileSync(config,value);return spawnSync(process.execPath,['-e',validator[1],config,example],{encoding:'utf8',timeout:5000,windowsHide:true});}
 assert.equal(check(JSON.stringify(valid)).status,0);
 for(const value of [JSON.stringify({...valid,sandboxUsersDir:'/unsafe'}),JSON.stringify({...valid,linuxWineEnabled:false}),'{"nodeToken":"fixture-private-secret", invalid']){const result=check(value);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'');}
});
