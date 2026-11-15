'use strict';
// Stable protocol-v1 bootstrap. The scheduled task stays alive while its agent
// child changes version, so an update does not end the Windows task's job.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {loadConfig}=require('./config');
const {readJson,atomicJson,verifyEnvelope,safeReleaseRoot,releaseDirectory,validateInstalled}=require('./update-protocol');
function createLauncher({config,home=__dirname,spawnAgent,healthTimeoutMs=120000,log=()=>{},now=Date.now}={}){
 const root=safeReleaseRoot(config),pointer=path.join(config.agentDataDir,'agent-active-release.json'),failure=path.join(config.agentDataDir,'agent-update-failure.json');
 let child=null,healthy=false,healthTimer=null,restartTimer=null,pending=null,closed=false,starting=false;
 const state=()=>readJson(pointer,{active:null,sequence:0,phase:'ok'});
 function selected(){const current=state();return current.active?releaseDirectory(root,current.active,current.sequence):home;}
 function verifyCandidate(id,sequence){const directory=releaseDirectory(root,id,sequence),key=fs.readFileSync(path.join(home,'update-trust.pem'),'utf8'),payload=verifyEnvelope(readJson(path.join(directory,'release-envelope.json')),key,{id,sequence,platform:process.platform});validateInstalled(directory,payload);return payload;}
 function clearHealth(){clearTimeout(healthTimer);healthTimer=null;}
 function start(){
  if(closed||child||starting)return;starting=true;
  try{
   let current=state();if(current.phase==='pending'&&!pending){const previous=current.previous||{active:null,sequence:0};atomicJson(pointer,{...previous,phase:'ok'});atomicJson(failure,{id:current.active,sequence:current.sequence,reason:'UPDATE_INTERRUPTED',at:now()});current=state();log('Interrupted update reverted before startup.');}
   if(current.active)verifyCandidate(current.active,current.sequence);
   const directory=selected(),env={...process.env,CORNGRID_AGENT_HOME:home,CORNGRID_AGENT_CONFIG_FILE:process.env.CORNGRID_AGENT_CONFIG_FILE||path.join(home,'agent-config.json'),CORNGRID_AGENT_RELEASE_ID:current.active||''};
   healthy=false;const launched=spawnAgent?spawnAgent({directory,env}):spawn(process.execPath,[path.join(directory,'agent.js')],{cwd:directory,env,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
   child=launched;launched.on('message',message=>onMessage(launched,message));launched.on('error',()=>onExit(launched));launched.on('exit',()=>onExit(launched));
   if(pending?.phase==='testing'){healthTimer=setTimeout(()=>{if(child===launched&&!healthy){log('New agent did not pass its health check.');launched.kill();}},healthTimeoutMs);healthTimer.unref?.();}
  }catch{log('Agent startup validation failed.');if(pending)rollback();scheduleRestart();}finally{starting=false;}
 }
 function scheduleRestart(){if(closed||restartTimer)return;restartTimer=setTimeout(()=>{restartTimer=null;start();},3000);restartTimer.unref?.();}
 function rollback(){
  if(!pending)return;const failed=pending;pending=null;atomicJson(pointer,{...failed.previous,phase:'ok'});atomicJson(failure,{id:failed.id,sequence:failed.sequence,reason:'UPDATE_HEALTH_FAILED',at:now()});log('Agent update rolled back; MT5 terminals were preserved.');
 }
 function onExit(exited){
  if(child!==exited)return;clearHealth();child=null;
  if(closed)return;
  if(pending?.phase==='draining'){
   const p=pending;p.phase='testing';atomicJson(pointer,{active:p.id,sequence:p.sequence,phase:'pending',previous:p.previous});start();
  }else{if(pending)rollback();scheduleRestart();}
 }
 async function onMessage(from,message){
  if(from!==child||!message||closed)return;
  if(message.type==='agent_healthy'){
   healthy=true;clearHealth();
   if(pending?.phase==='testing'){
    const p=pending;pending=null;atomicJson(pointer,{active:p.id,sequence:p.sequence,phase:'ok',previous:p.previous,activatedAt:now()});log('Agent update healthy: '+p.version+'.');prune();
   }
  }else if(message.type==='activate_release'&&!pending&&healthy){
   try{
    const previous=state();if(message.sequence<=Number(previous.sequence||0))return;
    const candidate=verifyCandidate(message.id,message.sequence);
    pending={id:candidate.id,sequence:candidate.sequence,version:candidate.version,previous:{active:previous.active||null,sequence:previous.sequence||0},phase:'requested'};
    from.send({type:'prepare_update',id:candidate.id});
    healthTimer=setTimeout(()=>{if(pending?.phase==='requested'){pending=null;log('Agent update deferred while the worker is busy.');}},30000);healthTimer.unref?.();
   }catch{log('Agent update rejected by bootstrap signature/integrity validation.');}
  }else if(message.type==='update_busy'&&pending?.phase==='requested'){clearHealth();pending=null;log('Agent update deferred while a deployment/review is active.');}
  else if(message.type==='update_ready'&&pending?.phase==='requested'&&message.id===pending.id){clearHealth();pending.phase='draining';healthTimer=setTimeout(()=>{if(child===from&&pending?.phase==='draining'){pending=null;log('Agent update deferred because shutdown did not finish.');}},30000);healthTimer.unref?.();}
 }
 function prune(){
  const current=state(),keep=new Set([current,current.previous].filter(s=>s?.active).map(s=>s.active+'-'+s.sequence));
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
   if(!entry.isDirectory()||! /^[a-f0-9]{64}-[1-9][0-9]*$/.test(entry.name)||keep.has(entry.name))continue;
   const [id,sequence]=entry.name.split('-'),target=releaseDirectory(root,id,Number(sequence));if(fs.lstatSync(target).isSymbolicLink())continue;
   fs.rmSync(target,{recursive:true,force:true});
  }
 }
 function stop(){closed=true;clearHealth();clearTimeout(restartTimer);if(child?.connected)child.send({type:'shutdown'});}
 return {start,stop,state,get child(){return child;},get healthy(){return healthy;}};
}
async function main(){
 const config=loadConfig(),home=__dirname;fs.mkdirSync(config.agentDataDir,{recursive:true});
 if(process.argv.includes('--trust-update-key')){await require('./auto-update').trustUpdateKey({...config,agentHome:home});console.log('CornGrid update public key pinned. No secret was printed.');return;}
 const logfile=path.join(config.agentDataDir,'agent-updater.log');
 const log=message=>{const line='['+new Date().toISOString()+'] '+message;console.log(line);try{if(fs.existsSync(logfile)&&fs.statSync(logfile).size>1024*1024){fs.rmSync(logfile+'.old',{force:true});fs.renameSync(logfile,logfile+'.old');}fs.appendFileSync(logfile,line+'\n');}catch{}};
 const launcher=createLauncher({config,home,log});launcher.start();
 const keepAlive=setInterval(()=>{},60000);process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
 function shutdown(){launcher.stop();clearInterval(keepAlive);setTimeout(()=>process.exit(0),1500);}
}
if(require.main===module)main().catch(()=>{console.error('Agent bootstrap failed; inspect local configuration and update trust.');process.exitCode=1;});
module.exports={createLauncher};
