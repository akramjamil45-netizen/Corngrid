'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const express=require('express');
const protocol=require('../agent/update-protocol'),{requestJson,stageRelease,createAutoUpdater}=require('../agent/auto-update'),{createLauncher}=require('../agent/agent-launcher');
const {sourceManifest,publishRelease,createNodeUpdates}=require('../sandbox/node-updates'),{createSandboxNodeApi}=require('../sandbox/sandbox-node-api'),{createSandboxAdminApi}=require('../sandbox/sandbox-admin-api');
const agentDir=path.resolve(__dirname,'../agent');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=12000){const deadline=Date.now()+timeout;while(!predicate()){if(Date.now()>deadline)throw Error('Condition timed out.');await sleep(25);}}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-update-test-')),home=path.join(root,'agent'),data=path.join(root,'data');fs.mkdirSync(home);fs.mkdirSync(data);
 const cleanup=[];t.after(async()=>{for(const callback of cleanup)await callback();assert.match(path.relative(os.tmpdir(),root),/^corngrid-update-test-[a-z0-9]+$/i);fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 for(const name of fs.readdirSync(agentDir).filter(protocol.allowedName))fs.copyFileSync(path.join(agentDir,name),path.join(home,name));
 const pair=crypto.generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'pem',type:'spki'});fs.writeFileSync(path.join(home,'update-trust.pem'),publicKey);
 fs.writeFileSync(path.join(home,'agent-config.json'),JSON.stringify({nodeToken:'fixture-only-secret'}));
 const config={backendUrl:'https://nodes.example.test',nodeUid:'node_'+'a'.repeat(18),nodeToken:'cgn_'+'a'.repeat(64),agentHome:home,agentDataDir:data};
 function envelope(version='1.2.1',sequence=1,code){
  const files=fs.readdirSync(home).filter(protocol.allowedName).sort().map(name=>{let bytes=fs.readFileSync(path.join(home,name));if(name==='agent.js'&&code!==undefined)bytes=Buffer.from(code);if(name==='package.json'||name==='package-lock.json'){const pkg=JSON.parse(bytes);pkg.version=version;if(pkg.packages?.[''])pkg.packages[''].version=version;bytes=Buffer.from(JSON.stringify(pkg));}return {name,bytes:bytes.length,sha256:protocol.hash(bytes),data:bytes.toString('base64')};});
  const payload={format:1,bootstrapVersion:1,id:protocol.releaseId(version,files),version,sequence,publishedAt:new Date().toISOString(),files};
  const raw=Buffer.from(JSON.stringify(payload));return {payload:raw.toString('base64'),signature:crypto.sign(null,raw,pair.privateKey).toString('base64')};
 }
 function sign(payload){const raw=Buffer.from(JSON.stringify(payload));return {payload:raw.toString('base64'),signature:crypto.sign(null,raw,pair.privateKey).toString('base64')};}
 return {root,home,data,config,publicKey,envelope,sign,cleanup};
}
async function killOwnedChild(child){if(!child||child.exitCode!==null)return;const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([exit,sleep(2000)]);}
const prepare=async()=>{},syntaxCheck=async()=>{};
const fakeAgent=`const fs=require('node:fs'),path=require('node:path');process.send({type:'agent_healthy'});process.on('message',m=>{if(m.type==='prepare_update'){if(fs.existsSync(path.join(process.env.CORNGRID_AGENT_HOME,'busy.flag')))process.send({type:'update_busy'});else{process.send({type:'update_ready',id:m.id});setTimeout(()=>process.exit(0),20);}}else if(m.type==='shutdown')process.exit(0);});setInterval(()=>{},1000);`;

test('Windows terminals launched by the real manager survive the exit of their agent process',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t);let terminalPid;
 const worker=spawn(process.execPath,[path.join(__dirname,'helpers/terminal-detachment-worker.cjs'),path.join(agentDir,'mt5-manager.js'),path.join(f.root,'users')],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 f.cleanup.push(async()=>{await killOwnedChild(worker);if(terminalPid){
  // A detached console has its own conhost.exe on Windows. End this test's
  // process tree so the console cannot retain a handle to the fixture cwd.
  try{require('node:child_process').execFileSync('taskkill.exe',['/PID',String(terminalPid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
  await until(()=>{try{process.kill(terminalPid,0);return false;}catch{return true;}},5000);
 }});
 const message=new Promise(resolve=>worker.once('message',resolve)),exit=new Promise(resolve=>worker.once('exit',resolve));
 terminalPid=(await message).terminalPid;assert.ok(Number.isInteger(terminalPid));assert.equal(await exit,0);await sleep(300);
 assert.doesNotThrow(()=>process.kill(terminalPid,0),'The actual Windows launch options must preserve the terminal across agent exit.');
});

test('signed releases reject tampering, another signing key, traversal, credentials and missing files before staging',async t=>{
 const f=fixture(t),valid=f.envelope(),payload=protocol.verifyEnvelope(valid,f.publicKey);
 assert.ok(payload.files.length>10);
 const altered={...valid,payload:Buffer.from(Buffer.from(valid.payload,'base64').toString().replace('1.2.1','9.9.9')).toString('base64')};
 assert.throws(()=>protocol.verifyEnvelope(altered,f.publicKey),/SIGNATURE/);
 assert.throws(()=>protocol.verifyEnvelope(valid,crypto.generateKeyPairSync('ed25519').publicKey),/SIGNATURE/);
 for(const name of ['../agent.js','agent-config.json','update-trust.pem','agent-launcher.js','broker-python/x.py','C:\\bad.js']){
  const changed=structuredClone(payload);changed.files[0].name=name;assert.throws(()=>protocol.verifyEnvelope(f.sign(changed),f.publicKey),/FILE_INVALID/);
 }
 const missing=structuredClone(payload);missing.files=missing.files.filter(file=>file.name!=='agent.js');assert.throws(()=>protocol.verifyEnvelope(f.sign(missing),f.publicKey),/RELEASE_INVALID/);
 await assert.rejects(stageRelease(f.config,altered,{prepare,syntaxCheck}),/SIGNATURE/);
 assert.equal(fs.existsSync(path.join(f.data,'node-releases')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'agent-config.json'))).nodeToken,'fixture-only-secret');
});

test('staging verifies every file, checks syntax and leaves current config, Python tools and active release unchanged on failure',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.home,'broker-python'));fs.writeFileSync(path.join(f.home,'broker-python','keep.txt'),'preserve');
 const bad=f.envelope('1.2.1',1,'this is not valid javascript @');
 await assert.rejects(stageRelease(f.config,bad,{prepare}));
 const root=protocol.safeReleaseRoot(f.config);assert.deepEqual(fs.readdirSync(root),[]);assert.equal(fs.readFileSync(path.join(f.home,'broker-python/keep.txt'),'utf8'),'preserve');
 assert.equal(fs.existsSync(path.join(f.data,'agent-active-release.json')),false);
 const valid=f.envelope('1.2.1',1,fakeAgent),payload=await stageRelease(f.config,valid,{prepare,syntaxCheck});
 const directory=protocol.releaseDirectory(root,payload.id,payload.sequence);assert.ok(fs.existsSync(path.join(directory,'agent.js')));
 assert.equal(fs.existsSync(path.join(directory,'agent-config.json')),false);assert.equal(fs.existsSync(path.join(directory,'broker-python')),false);
 fs.appendFileSync(path.join(directory,'agent.js'),'// corrupt');await assert.rejects(stageRelease(f.config,valid,{prepare,syntaxCheck}),/HASH_INVALID/);
});

test('launcher updates while a separate terminal process survives, defers busy work and automatically rolls back a failed version',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.home,'agent.js'),fakeAgent);
 const terminal=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});f.cleanup.push(()=>killOwnedChild(terminal));
 const logs=[],launcher=createLauncher({config:f.config,home:f.home,healthTimeoutMs:1500,log:line=>logs.push(line)});
 f.cleanup.push(async()=>{const child=launcher.child;launcher.stop();await killOwnedChild(child);});
 launcher.start();await until(()=>launcher.healthy);const initialPid=launcher.child.pid;
 const good=await stageRelease(f.config,f.envelope('1.2.1',1,fakeAgent),{prepare,syntaxCheck});
 fs.writeFileSync(path.join(f.home,'busy.flag'),'1');launcher.child.emit('message',{type:'activate_release',id:good.id,sequence:good.sequence});await until(()=>logs.some(s=>s.includes('deferred')));
 assert.equal(launcher.child.pid,initialPid);assert.equal(launcher.state().active,null);fs.unlinkSync(path.join(f.home,'busy.flag'));
 launcher.child.emit('message',{type:'activate_release',id:good.id,sequence:good.sequence});await until(()=>launcher.state().active===good.id&&launcher.state().phase==='ok');assert.notEqual(launcher.child.pid,initialPid);
 const failed=await stageRelease(f.config,f.envelope('1.2.2',2,'setTimeout(()=>process.exit(7),50);'),{prepare,syntaxCheck});
 launcher.child.emit('message',{type:'activate_release',id:failed.id,sequence:failed.sequence});await until(()=>logs.some(s=>s.includes('rolled back')));await until(()=>launcher.healthy&&launcher.state().active===good.id);
 assert.equal(protocol.readJson(path.join(f.data,'agent-update-failure.json')).id,failed.id);assert.doesNotThrow(()=>process.kill(terminal.pid,0));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'agent-config.json'))).nodeToken,'fixture-only-secret');
});

test('interrupted activation is rolled back before startup and old signed sequences cannot replace the current release',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.home,'agent.js'),fakeAgent);
 protocol.atomicJson(path.join(f.data,'agent-active-release.json'),{active:'f'.repeat(64),sequence:2,phase:'pending',previous:{active:null,sequence:1}});
 const launcher=createLauncher({config:f.config,home:f.home});f.cleanup.push(async()=>{const child=launcher.child;launcher.stop();await killOwnedChild(child);});launcher.start();await until(()=>launcher.healthy);
 assert.equal(launcher.state().active,null);assert.equal(launcher.state().sequence,1);
 launcher.child.emit('message',{type:'activate_release',id:'f'.repeat(64),sequence:1});await sleep(100);assert.equal(launcher.state().active,null);
});

test('update polling preserves the running worker on network failure, pause or busy work, and sends credentials only to its HTTPS origin',async t=>{
 const f=fixture(t),logs=[],sent=[];let calls=0,busy=true;
 const fetchImpl=async(url,options)=>{calls++;assert.ok(url.startsWith('https://nodes.example.test/api/sandbox/node/'));assert.equal(options.redirect,'error');assert.equal(options.headers['X-Node-Token'],f.config.nodeToken);return new Response(JSON.stringify({enabled:false}));};
 const updater=createAutoUpdater({config:f.config,logger:{info:()=>{},warn:(_,s)=>logs.push(s)},isBusy:()=>busy,fetchImpl,send:m=>sent.push(m)});
 await updater.check();assert.equal(calls,0);busy=false;await updater.check();assert.equal(calls,1);assert.deepEqual(sent,[]);
 const offline=createAutoUpdater({config:f.config,logger:{warn:(_,s)=>logs.push(s)},fetchImpl:async()=>{throw Error(f.config.nodeToken);},send:m=>sent.push(m)});await offline.check();assert.equal(logs.join('').includes(f.config.nodeToken),false);assert.deepEqual(sent,[]);
 let invoked=false;await assert.rejects(requestJson({...f.config,backendUrl:'http://malicious.example'},'/api/sandbox/node/update',{fetchImpl:async()=>{invoked=true;}}),/HTTPS/);assert.equal(invoked,false);
 await assert.rejects(requestJson(f.config,'/api/sandbox/node/update',{fetchImpl:async()=>new Response('x'.repeat(1000)),limit:10}),/SIZE/);
});

test('publisher requires a complete deploy manifest, signs one immutable code release, and keeps the old release on partial deployment',async t=>{
 const f=fixture(t),storageDir=path.join(f.root,'private');protocol.atomicJson(path.join(f.home,'RELEASE.json'),sourceManifest(f.home));
 const first=await publishRelease({sourceDir:f.home,storageDir});assert.equal(first.published,true);
 const publicKey=fs.readFileSync(path.join(storageDir,'public-key.pem'),'utf8'),envelope=protocol.readJson(path.join(storageDir,'releases',first.release.id+'.json'));protocol.verifyEnvelope(envelope,publicKey);
 assert.equal((await publishRelease({sourceDir:f.home,storageDir})).unchanged,true);
 fs.appendFileSync(path.join(f.home,'config.js'),'\n// new deploy');await assert.rejects(publishRelease({sourceDir:f.home,storageDir}),/incomplete/);assert.equal(protocol.readJson(path.join(storageDir,'channel.json')).release.id,first.release.id);
 assert.equal(JSON.stringify(envelope).includes('fixture-only-secret'),false);
});

test('release endpoints enforce node/admin roles, global pause, no-cache responses and never expose signing secrets',async t=>{
 const f=fixture(t),storageDir=path.join(f.root,'private');protocol.atomicJson(path.join(f.home,'RELEASE.json'),sourceManifest(f.home));await publishRelease({sourceDir:f.home,storageDir});
 const updates=createNodeUpdates({storageDir,enabled:true}),app=express();app.use(express.json());const audit=[];
 createSandboxNodeApi({updates,nodes:{authenticateNode:async(uid,token)=>uid==='fixture'&&token==='fixture-token'?{id:1}:null},rateLimit:()=>((_req,_res,next)=>next())}).registerRoutes(app);
 createSandboxAdminApi({updates,subscriptions:{logAudit:async(...args)=>audit.push(args)}}).registerRoutes(app,(req,res,next)=>req.headers.authorization==='Bearer fixture-admin'?next():res.status(403).json({error:'forbidden'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,nodeHeaders={'X-Node-Id':'fixture','X-Node-Token':'fixture-token'};
 assert.equal((await fetch(base+'/api/sandbox/node/update')).status,401);assert.equal((await fetch(base+'/api/admin/sandbox/updates',{headers:nodeHeaders})).status,403);
 let response=await fetch(base+'/api/sandbox/node/update',{headers:nodeHeaders});assert.match(response.headers.get('cache-control'),/no-store/);const metadata=await response.json();assert.equal(metadata.enabled,true);
 response=await fetch(base+metadata.release.url,{headers:nodeHeaders});assert.equal(response.status,200);const envelope=await response.json();assert.ok(envelope.signature);assert.equal(JSON.stringify(envelope).includes('PRIVATE KEY'),false);
 assert.equal((await fetch(base+'/api/sandbox/node/update-key',{headers:nodeHeaders})).status,200);
 response=await fetch(base+'/api/admin/sandbox/updates',{method:'PATCH',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:JSON.stringify({enabled:false})});assert.equal(response.status,200);assert.equal(audit.length,1);
 assert.equal((await fetch(base+metadata.release.url,{headers:nodeHeaders})).status,403);assert.equal(updates.status().enabled,false);
});
