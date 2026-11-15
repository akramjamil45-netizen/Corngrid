'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {checkLocal,checkOnline,RUNTIME_FILES}=require('../agent/check-installation');
const backend=path.resolve(__dirname,'..');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-node-install-test-'));
  t.after(()=>{assert.match(path.relative(path.resolve(os.tmpdir()),path.resolve(root)),/^corngrid-node-install-test-[a-z0-9]+$/i);fs.rmSync(path.resolve(root),{recursive:true,force:true});});
  const agentDir=path.join(root,'agent');fs.mkdirSync(agentDir);for(const name of RUNTIME_FILES)fs.copyFileSync(path.join(backend,'agent',name),path.join(agentDir,name));
  const config={backendUrl:'https://corngrid.example',nodeUid:'node_'+'a'.repeat(18),nodeToken:'cgn_'+'b'.repeat(64),mt5PythonPath:'test-python.exe'};
  for(const field of ['mt5BaseDir','sandboxUsersDir','agentDataDir','brokerCacheDir']){config[field]=path.join(root,field);fs.mkdirSync(config[field]);}
  fs.writeFileSync(path.join(config.mt5BaseDir,'terminal64.exe'),'Fixture, never executed');
  const options={config,agentDir,platform:'win32',arch:'x64',nodeVersion:'24.20.0',run:()=>JSON.stringify({bits:64,version:'test'}),resolveModule:()=>true};
  return {root,config,agentDir,options};
}
test('node diagnostics detect missing modules, wrong Python, unsafe layout and placeholder identity without starting MT5',t=>{
  const f=fixture(t);assert.equal(checkLocal(f.options).filter(c=>c.status==='FAIL').length,0);
  fs.unlinkSync(path.join(f.agentDir,'source-compiler.js'));let checks=checkLocal(f.options);assert.match(checks.find(c=>c.name==='Agent files').message,/source-compiler/);
  checks=checkLocal({...f.options,config:{...f.config,nodeToken:'placeholder',sandboxUsersDir:path.join(f.config.mt5BaseDir,'Users')},run:()=>JSON.stringify({bits:32}),resolveModule:()=>{throw Error('missing');}});
  for(const name of ['Dependencies','Node identity','Directory isolation','Python + MetaTrader5'])assert.equal(checks.find(c=>c.name===name).status,'FAIL',name);
  assert.equal(checkLocal({...f.options,testNode:true}).find(c=>c.name==='MetaEditor').status,'FAIL');
  const text=JSON.stringify(checks);assert.equal(text.includes(f.config.nodeToken),false);
  assert.equal(fs.readdirSync(f.config.sandboxUsersDir).length,0);
});
test('online diagnostics use only read-only HTTPS routes, reject redirects and never print secrets or provider payloads',async t=>{
  const f=fixture(t),calls=[];
  let checks=await checkOnline(f.config,{fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/health')?{status:'ok'}:{instances:[]}};}});
  assert.ok(checks.every(c=>c.status==='PASS'));assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/api/health','/api/sandbox/node/instances']);
  assert.ok(calls.every(c=>c.options.redirect==='error'&&!c.options.body));assert.equal(calls[1].options.headers['X-Node-Token'],f.config.nodeToken);assert.equal(JSON.stringify(checks).includes(f.config.nodeToken),false);
  let invoked=false;checks=await checkOnline({...f.config,backendUrl:'http://other.example'},{fetchImpl:async()=>{invoked=true;}});assert.equal(invoked,false);assert.equal(checks[0].status,'FAIL');
  checks=await checkOnline(f.config,{fetchImpl:async()=>{throw Error(f.config.nodeToken);}});assert.ok(checks.every(c=>c.status==='FAIL'));assert.equal(JSON.stringify(checks).includes(f.config.nodeToken),false);
});
test('task installer plans interactive startup, preserves existing tasks and supports SYSTEM/WhatIf without touching the real scheduler',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),installer=path.join(f.agentDir,'install-service.ps1');fs.copyFileSync(path.join(backend,'agent/install-service.ps1'),installer);fs.copyFileSync(path.join(backend,'agent/agent-launcher.js'),path.join(f.agentDir,'agent-launcher.js'));fs.copyFileSync(path.join(backend,'agent/check-installation.js'),path.join(f.agentDir,'check-installation.js'));fs.writeFileSync(path.join(f.agentDir,'agent-config.json'),'{}');
  const harness=path.join(__dirname,'helpers/node-installer-harness.ps1');
  const run=kind=>{const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness,'-Installer',installer,'-Case',kind],{encoding:'utf8',windowsHide:true,timeout:15000});const line=output.split(/\r?\n/).find(s=>s.startsWith('CORNGRID_TEST_RESULT '));assert.ok(line,output);return JSON.parse(line.slice('CORNGRID_TEST_RESULT '.length));};
  let result=run('Interactive');assert.equal(result.error,null);assert.equal(result.registration.principal.LogonType,'Interactive');assert.equal(result.registration.trigger[0].AtLogOn,true);assert.equal(result.registration.settings.MultipleInstances,'IgnoreNew');assert.equal(result.registration.settings.ExecutionSeconds,0);assert.equal(result.starts,0);
  const recovery=result.registration.trigger[1];assert.equal(recovery.Once,true);assert.equal(recovery.Repetition.IntervalMinutes,1);assert.equal(recovery.Repetition.Duration,null);assert.equal(recovery.Repetition.StopAtDurationEnd,false);
  result=run('System');assert.equal(result.error,null);assert.equal(result.registration.principal.UserId,'SYSTEM');assert.equal(result.registration.trigger[0].AtStartup,true);assert.equal(result.registration.trigger[1].Repetition.IntervalMinutes,1);
  result=run('WhatIf');assert.equal(result.registration,null);assert.equal(result.starts,0);assert.equal(result.error,null);
  result=run('Existing');assert.match(result.error,/already exists/);assert.equal(result.registration,null);
  result=run('Running');assert.match(result.error,/existing task is running/);assert.equal(result.registration,null);assert.equal(result.starts,0);
});
test('node bundle contains matching runtime files and hashes, with no live configuration or runtime data',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),zip=path.join(f.root,'agent.zip');
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(backend,'scripts/build-node-agent.ps1'),'-OutputPath',zip],{windowsHide:true,timeout:20000});
  const output=path.join(f.root,'unpacked');fs.mkdirSync(output);
  const extractor=path.join(f.root,'extract.ps1');fs.writeFileSync(extractor,"param($Zip,$Output)\n$ErrorActionPreference='Stop'\nExpand-Archive -LiteralPath $Zip -DestinationPath $Output\n");
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',extractor,'-Zip',zip,'-Output',output],{windowsHide:true,timeout:20000});
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'MANIFEST.json'),'utf8'));assert.equal(manifest.files.length,31);
  for(const item of manifest.files){assert.equal(item.path.includes('..'),false);const bytes=fs.readFileSync(path.join(output,item.path));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256);assert.equal(bytes.length,item.bytes);}
  for(const name of RUNTIME_FILES){const file=path.join(output,'agent',name);assert.ok(fs.existsSync(file),name);assert.deepEqual(fs.readFileSync(file),fs.readFileSync(path.join(backend,'agent',name)));}
  for(const item of manifest.files)assert.equal(/(?:^|\/)(?:agent-config\.json|node_modules|broker-python|\.env|agent-recovery\.log)(?:\/|$)/.test(item.path),false,item.path);
  const packed=path.join(output,'agent');
  // Check every local JS require is shipped, including newly added compiler code.
  for(const name of fs.readdirSync(packed).filter(n=>n.endsWith('.js'))){const code=fs.readFileSync(path.join(packed,name),'utf8');for(const match of code.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g))assert.ok(fs.existsSync(path.join(packed,match[1]+'.js'))||fs.existsSync(path.join(packed,match[1])),name+' -> '+match[1]);}
});
