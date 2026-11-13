'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
const {MAX_BUNDLE_BYTES,hash,verifyEnvelope,safeReleaseRoot,releaseDirectory,validateInstalled,atomicJson,readJson}=require('./update-protocol');
function origin(config){const url=new URL(config.backendUrl);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('UPDATE_HTTPS_REQUIRED');return url.origin;}
async function requestJson(config,route,{fetchImpl=fetch,limit=MAX_BUNDLE_BYTES}={}){
 if(!route.startsWith('/api/sandbox/node/'))throw Error('UPDATE_ROUTE_INVALID');
 const response=await fetchImpl(origin(config)+route,{headers:{'X-Node-Id':config.nodeUid,'X-Node-Token':config.nodeToken},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('UPDATE_HTTP_'+response.status);
 if(Number(response.headers.get('content-length'))>limit)throw Error('UPDATE_SIZE_INVALID');
 const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>limit){await response.body.cancel?.().catch(()=>{});throw Error('UPDATE_SIZE_INVALID');}chunks.push(Buffer.from(chunk));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function prepareDependencies(directory,previousDir){
 const lock=path.join(directory,'package-lock.json'),previousLock=path.join(previousDir,'package-lock.json'),previousModules=path.join(previousDir,'node_modules');
 if(fs.existsSync(previousLock)&&fs.existsSync(previousModules)&&hash(fs.readFileSync(lock))===hash(fs.readFileSync(previousLock))){
  if(fs.lstatSync(previousModules).isSymbolicLink())throw Error('UPDATE_DEPENDENCIES_UNSAFE');
  fs.cpSync(previousModules,path.join(directory,'node_modules'),{recursive:true,dereference:false});
 }else{
  const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');if(!fs.existsSync(cli))throw Error('UPDATE_NPM_NOT_AVAILABLE');
  await run(process.execPath,[cli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--cache',path.join(directory,'.npm-cache')],{cwd:directory,windowsHide:true,timeout:120000,maxBuffer:65536});
  const cache=path.resolve(directory,'.npm-cache');if(path.dirname(cache)!==path.resolve(directory))throw Error('UPDATE_CACHE_UNSAFE');fs.rmSync(cache,{recursive:true,force:true});
 }
 await run(process.execPath,['-e',"require('ws');"],{cwd:directory,windowsHide:true,timeout:15000,maxBuffer:65536});
}
async function stageRelease(config,envelope,{expected={},previousDir=__dirname,prepare=prepareDependencies,syntaxCheck=async file=>run(process.execPath,['--check',file],{windowsHide:true,timeout:15000,maxBuffer:65536})}={}){
 const home=config.agentHome||__dirname,key=fs.readFileSync(path.join(home,'update-trust.pem'),'utf8'),payload=verifyEnvelope(envelope,key,expected);
 const root=safeReleaseRoot(config),destination=releaseDirectory(root,payload.id,payload.sequence);
 if(fs.existsSync(destination)){const stored=readJson(path.join(destination,'release-envelope.json'));verifyEnvelope(stored,key,{id:payload.id,sequence:payload.sequence});validateInstalled(destination,payload);return payload;}
 const disk=fs.statfsSync(root);if(Number(disk.bavail)*Number(disk.bsize)<128*1024*1024)throw Error('UPDATE_DISK_LOW');
 const temporary=path.join(root,'.staging-'+payload.id+'-'+require('node:crypto').randomBytes(4).toString('hex'));fs.mkdirSync(temporary);
 try{
  for(const file of payload.files)fs.writeFileSync(path.join(temporary,file.name),Buffer.from(file.data,'base64'));
  for(const file of payload.files.filter(f=>f.name.endsWith('.js')))await syntaxCheck(path.join(temporary,file.name));
  await prepare(temporary,previousDir);validateInstalled(temporary,payload);
  atomicJson(path.join(temporary,'release-envelope.json'),envelope);fs.renameSync(temporary,destination);return payload;
 }finally{
  const resolved=path.resolve(temporary);if(path.dirname(resolved)!==path.resolve(root)||!/^\.staging-[a-f0-9]{64}-[a-f0-9]{8}$/.test(path.basename(resolved)))throw Error('UPDATE_CLEANUP_UNSAFE');
  fs.rmSync(resolved,{recursive:true,force:true});
 }
}
async function trustUpdateKey(config,{fetchImpl=fetch}={}){
 const target=path.join(config.agentHome||__dirname,'update-trust.pem');if(fs.existsSync(target))throw Error('UPDATE_KEY_ALREADY_PINNED');
 const {publicKey}=await requestJson(config,'/api/sandbox/node/update-key',{fetchImpl,limit:16384});
 const key=require('node:crypto').createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519')throw Error('UPDATE_KEY_INVALID');
 fs.writeFileSync(target,key.export({format:'pem',type:'spki'}),{flag:'wx',mode:0o600});return hash(publicKey);
}
function createAutoUpdater({config,logger,isBusy=()=>false,send=message=>process.send?.(message),fetchImpl=fetch,stage=stageRelease}={}){
 let checking=false,stopped=false,timer;const interval=Math.max(60000,Math.min(3600000,Number(config.autoUpdateIntervalMs)||300000));
 async function check(){
 if(stopped||checking||config.autoUpdateEnabled===false||isBusy())return;
  checking=true;
  try{
   if(!fs.existsSync(path.join(config.agentHome||__dirname,'update-trust.pem')))return;
   const metadata=await requestJson(config,'/api/sandbox/node/update',{fetchImpl,limit:16384});
   const release=metadata.release;if(!metadata.enabled||!release||release.id===process.env.CORNGRID_AGENT_RELEASE_ID)return;
   if(!/^[a-f0-9]{64}$/.test(release.id)||!Number.isSafeInteger(release.sequence))throw Error('UPDATE_RELEASE_INVALID');
   const state=readJson(path.join(config.agentDataDir,'agent-active-release.json'),{}),failed=readJson(path.join(config.agentDataDir,'agent-update-failure.json'),{});
   if(release.sequence<=Number(state.sequence||0)||failed.id===release.id&&failed.sequence>=release.sequence)return;
   const envelope=await requestJson(config,'/api/sandbox/node/updates/'+release.id,{fetchImpl});
   const candidate=await stage(config,envelope,{expected:{id:release.id,sequence:release.sequence}});
   if(!stopped&&!isBusy()){logger.info(null,'Verified agent release '+candidate.version+'; requesting a graceful agent update.');send({type:'activate_release',id:candidate.id,sequence:candidate.sequence});}
  }catch(error){logger.warn(null,'Agent update deferred ('+safeError(error)+'); the current agent remains active.');}
  finally{checking=false;}
 }
 function start(){timer=setTimeout(async()=>{await check();if(!stopped){timer=setInterval(check,interval);timer.unref();}},20000+Math.random()*15000);timer.unref();}
 function stop(){stopped=true;clearTimeout(timer);clearInterval(timer);}
 return {start,stop,check};
}
function safeError(error){return /^UPDATE_[A-Z0-9_]+$/.test(error?.message||'')?error.message:typeof error?.code==='string'?error.code:'UPDATE_FAILED';}
module.exports={requestJson,stageRelease,trustUpdateKey,prepareDependencies,createAutoUpdater,safeError};
