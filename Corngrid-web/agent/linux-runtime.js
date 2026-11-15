'use strict';
// Linux MT5 runtime. Each Wine prefix has independent systemd --user units;
// restarting the agent's system service cannot terminate another sandbox.
const fs=require('node:fs'),path=require('node:path');
const {execFile,execFileSync}=require('node:child_process');
const UID=/^(?:sbx|eatest)_[a-f0-9]{18}$/;
function toWinePath(value){
 if(typeof value!=='string'||!path.posix.isAbsolute(value)||/[\\:\r\n\0]/.test(value))throw Error('A canonical absolute Linux path is required.');
 return 'Z:'+path.posix.normalize(value).replace(/\//g,'\\');
}
function createLinuxRuntime({config,fsImpl=fs,pathImpl=path,run=execFile,runSync=execFileSync,procRoot='/proc',sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
 const io=fsImpl,p=pathImpl;
 const call=(file,args,options={})=>new Promise((resolve,reject)=>{
  const {allowNotFound,...settings}=options;
  run(file,args,{timeout:30000,maxBuffer:65536,...settings},(error,stdout)=>error&&!(allowNotFound&&String(stdout).trim()==='not-found')?reject(Error('Linux runtime command failed ('+(error.code||'process')+').')):resolve(String(stdout||'')));
 });
 function identity(directory){
  const dir=p.resolve(directory),id=p.basename(dir),roots=[config.sandboxUsersDir,p.join(config.agentDataDir,'tests')];
  if(!UID.test(id)||!roots.some(root=>p.dirname(dir)===p.resolve(root)))throw Error('Unsafe Linux sandbox directory.');
  if(io.existsSync(dir)&&(io.lstatSync(dir).isSymbolicLink()||io.realpathSync(dir)!==dir))throw Error('Sandbox directory links are not allowed.');
  return {dir,id};
 }
 function unitFor(directory,kind='mt5'){
  if(!['mt5','probe','compile'].includes(kind))throw Error('Invalid sandbox service kind.');
  return `corngrid-${kind}-${identity(directory).id}.service`;
 }
 function prefixFor(directory){
  const {id}=identity(directory),root=p.resolve(config.winePrefixesDir);
  if(!p.isAbsolute(config.winePrefixesDir)||io.lstatSync(root).isSymbolicLink()||io.realpathSync(root)!==root)throw Error('Unsafe Wine prefix root.');
  return p.join(root,id);
 }
 function wineProcesses(prefix){
  const found=[];
  for(const name of io.readdirSync(procRoot)){
   if(!/^[1-9][0-9]*$/.test(name))continue;
   try{
    const env=io.readFileSync(p.join(procRoot,name,'environ'),'utf8').split('\0');
    if(!env.includes('WINEPREFIX='+prefix))continue;
    const args=io.readFileSync(p.join(procRoot,name,'cmdline'),'utf8').split('\0');
    const group=io.readFileSync(p.join(procRoot,name,'cgroup'),'utf8');
    found.push({pid:Number(name),args,group,terminal:args.slice(0,2).some(arg=>/(?:^|[\\/])terminal64\.exe$/i.test(arg))});
   }catch{} // Other users and exited processes are not ours to manage.
  }
  return found;
 }
 function findTerminalPid(directory){
  const prefix=prefixFor(directory),unit=unitFor(directory);
  const processes=wineProcesses(prefix),terminals=processes.filter(item=>item.terminal);
  if(terminals.some(item=>!item.group.split(/[\/\r\n]/).includes(unit)))throw Error('An unmanaged MT5 terminal uses this prefix; stop it manually before hosting.');
  if(terminals.length>1)throw Error('Multiple MT5 terminals use this sandbox prefix.');
  return terminals[0]?.pid||null;
 }
 function ensurePrefix(directory){
  const prefix=prefixFor(directory),marker=p.join(prefix,'corngrid-prefix.json'),{id}=identity(directory);
  if(io.existsSync(prefix)){
   if(io.lstatSync(prefix).isSymbolicLink()||io.realpathSync(prefix)!==prefix)throw Error('Unsafe Wine prefix.');
   let saved;try{saved=JSON.parse(io.readFileSync(marker,'utf8'));}catch{}
   if(saved?.instanceUid!==id)throw Error('This Wine prefix was not created for this sandbox.');
   return prefix;
  }
  const template=p.resolve(config.wineTemplateDir);
  if(io.lstatSync(template).isSymbolicLink()||io.realpathSync(template)!==template||!io.existsSync(p.join(template,'system.reg'))||!io.existsSync(p.join(template,'drive_c')))throw Error('Prepare the clean Wine template before creating sandboxes.');
  if(wineProcesses(template).length)throw Error('Stop Wine processes using the template before copying it.');
  io.cpSync(template,prefix,{recursive:true,dereference:false,verbatimSymlinks:true});
  io.chmodSync(prefix,0o700);io.writeFileSync(marker,JSON.stringify({format:1,instanceUid:id}),{mode:0o600});
  return prefix;
 }
 function wineEnvironment(directory){
  return {WINEPREFIX:ensurePrefix(directory),WINEARCH:'win64',WINEDEBUG:'-all',DISPLAY:config.wineDisplay,
   XAUTHORITY:config.xAuthority,CORNGRID_AGENT_HOME:toWinePath(config.agentHome)};
 }
 async function stopUnit(directory,kind){
  const unit=unitFor(directory,kind);
  const state=(await call('systemctl',['--user','show',unit,'--property=LoadState','--value'],{allowNotFound:true})).trim();
  if(state==='not-found')return;
  await call('systemctl',['--user','stop',unit],{timeout:45000});
 }
 async function stopDirectory(directory){
  for(const kind of ['mt5','probe','compile'])await stopUnit(directory,kind);
  if(wineProcesses(prefixFor(directory)).length)throw Error('Wine processes remain in this sandbox prefix; files were preserved.');
 }
 function removePrefix(directory){
  const prefix=prefixFor(directory);if(!io.existsSync(prefix))return;
  ensurePrefix(directory);
  if(wineProcesses(prefix).length)throw Error('Cannot remove a running Wine prefix.');
  io.rmSync(prefix,{recursive:true,force:true});
 }
 function command(directory,kind,executable,args,wait){
  const env=wineEnvironment(directory),unit=unitFor(directory,kind);
  return ['--user','--quiet','--collect','--unit='+unit,'--property=Type=exec','--property=KillMode=control-group',
   '--property=TimeoutStopSec=15s','--property=NoNewPrivileges=yes','--property=UMask=0077','--property=WorkingDirectory='+identity(directory).dir,
   ...Object.entries(env).map(([key,value])=>'--setenv='+key+'='+value),...(wait?['--wait','--pipe']:[]),
   '--',config.wineBinary,executable,...args];
 }
 async function startTerminal(directory,startup){
  const existing=findTerminalPid(directory);if(existing)return {pid:existing,adopted:true};
  ensurePrefix(directory);
  await stopUnit(directory,'mt5');
  try{
   await call('systemd-run',command(directory,'mt5',p.join(directory,'terminal64.exe'),['/portable','/config:'+toWinePath(startup)],false));
   const deadline=now()+(config.linuxStartupTimeoutMs||90000);
   while(now()<deadline){const pid=findTerminalPid(directory);if(pid)return {pid,adopted:true};await sleep(250);}
   throw Error('MT5 did not start under Wine. Check the private user-unit journal and Xvfb configuration.');
  }catch(error){await stopUnit(directory,'mt5');throw error;}
 }
 async function runProgram(directory,executable,args,{kind='probe',timeout=240000}={}){
  ensurePrefix(directory);await stopUnit(directory,kind);
  try{await call('systemd-run',command(directory,kind,executable,args,true),{timeout});}
  finally{await stopUnit(directory,kind);}
 }
 function copyTerminal(source,target){
  io.cpSync(source,target,{recursive:true,dereference:false,filter:file=>{
   if(io.lstatSync(file).isSymbolicLink())throw Error('MT5 template must not contain symbolic links.');return true;
  }});
  // Node uses case-sensitive Linux paths; Wine itself uses Windows semantics.
  for(const [parent,name]of [[target,'config'],[target,'MQL5'],[p.join(target,'MQL5'),'Experts'],[p.join(target,'MQL5'),'Files'],[p.join(target,'MQL5'),'Presets']]){
   io.mkdirSync(parent,{recursive:true});const matches=io.readdirSync(parent).filter(value=>value.toLowerCase()===name.toLowerCase());
   if(matches.length>1)throw Error('Conflicting case variants in the MT5 template.');
   if(matches.length&&matches[0]!==name)io.renameSync(p.join(parent,matches[0]),p.join(parent,name));
  }
 }
 function validate(){
  try{
   if(config.linuxWineEnabled!==true||process.arch!=='x64')throw Error('Linux hosting requires linuxWineEnabled=true and an x86-64 VPS.');
   if(process.getuid&&process.getuid()===0)throw Error('Linux hosting must run as the unprivileged corngrid account, not root.');
   for(const key of ['wineBinary','mt5PythonPath','wineTemplateDir','winePrefixesDir','xAuthority'])if(!config[key]||!p.isAbsolute(config[key])||!io.existsSync(config[key]))throw Error('Missing Linux Wine prerequisite: '+key+'.');
   if(!/^:[0-9]{1,3}$/.test(config.wineDisplay||''))throw Error('Invalid Xvfb display.');
   if(!io.existsSync(p.join(config.wineTemplateDir,'system.reg')))throw Error('Wine template is not initialized.');
   runSync('systemctl',['--user','is-active','--quiet','default.target'],{timeout:10000,stdio:'pipe'});
   return {ok:true};
  }catch(error){return {ok:false,error:/^(Linux hosting|Missing Linux|Invalid Xvfb|Wine template)/.test(error.message)?error.message:'The Linux systemd user manager is unavailable. Enable linger and the user bus first.'};}
 }
 return {validate,toWinePath,identity,unitFor,prefixFor,wineEnvironment,wineProcesses,findTerminalPid,ensurePrefix,startTerminal,runProgram,stopDirectory,removePrefix,copyTerminal};
}
module.exports={createLinuxRuntime,toWinePath};
