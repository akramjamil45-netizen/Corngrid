'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {reader,readFrame,writeFrame}=require('./proxy-protocol'),{atomicJson}=require('./update-protocol'),{mergeIni}=require('./mt5-startup');
const DIRECT={ProxyEnable:0,ProxyType:1,ProxyAddress:'',ProxyLogin:'',ProxyPassword:''};
async function control(state,action){
 if(!Number.isInteger(state.controlPort)||state.controlPort<1||state.controlPort>65535)throw Error('PROXY_CONTROL_INVALID');
 const socket=net.connect({host:'127.0.0.1',port:state.controlPort});socket.on('error',()=>{});socket.setTimeout(3000,()=>socket.destroy());
 try{await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);socket.once('close',()=>reject(Error('PROXY_CONTROL_CLOSED')));});const input=reader(socket);writeFrame(socket,{token:state.controlToken,action});const result=await readFrame(input);if(!result.ok||result.instanceUid!==state.instanceUid||result.pid!==state.pid)throw Error('PROXY_CONTROL_OWNER_MISMATCH');return result;}finally{socket.destroy();}
}
function createProxyNetwork({config,httpRequest}){
 const root=path.resolve(config.agentDataDir,'proxy-bridges');fs.mkdirSync(root,{recursive:true});
 const statePath=uid=>{if(!/^sbx_[a-f0-9]{18}$/.test(uid))throw Error('PROXY_INSTANCE_INVALID');return path.join(root,uid+'.json');};
 function read(uid){try{return JSON.parse(fs.readFileSync(statePath(uid),'utf8'));}catch{return null;}}
 async function stopWorker(uid){const previous=read(uid);if(!previous)return;
  try{await control(previous,'stop');}catch{if(previous.pid){try{process.kill(previous.pid,0);throw Error('PROXY_WORKER_CANNOT_BE_VERIFIED');}catch(error){if(error.code!=='ESRCH')throw error;}}}
  fs.rmSync(statePath(uid),{force:true});
 }
 async function prepare(uid){
  const route=await httpRequest('POST','/api/sandbox/node/network/'+uid+'/prepare',{});
  if(route.mode==='direct'){await stopWorker(uid);return {mode:'direct',common:{...DIRECT}};}
  if(route.mode!=='proxy')throw Error('PROXY_ROUTE_INVALID');
  let state=read(uid),reuse=false;
  if(state?.ready&&state.serverUid===route.serverUid&&state.endpointId===route.endpointId){try{await control(state,'status');reuse=true;}catch{}}
  if(!reuse){
   await stopWorker(uid);state={instanceUid:uid,serverUid:route.serverUid,endpointId:route.endpointId,username:'cgb_'+crypto.randomBytes(8).toString('hex'),password:crypto.randomBytes(24).toString('hex'),controlToken:crypto.randomBytes(32).toString('hex'),ready:false};atomicJson(statePath(uid),state);
   // A persistent Windows bridge must not lock an immutable release directory
   // as its current directory when the launcher later prunes old releases.
   const child=spawn(process.execPath,[path.join(__dirname,'proxy-bridge-worker.js'),statePath(uid)],{cwd:config.agentDataDir,detached:true,windowsHide:true,stdio:'ignore'});let launchError=false;child.on('error',()=>{launchError=true;});child.once('exit',()=>{launchError=true;});child.unref();
   const deadline=Date.now()+20000;while(Date.now()<deadline){state=read(uid);if(state?.ready&&state.pid===child.pid)break;if(launchError){await stopWorker(uid);throw Error('PROXY_WORKER_LAUNCH_FAILED');}await new Promise(resolve=>setTimeout(resolve,200));}
   if(!state?.ready||state.pid!==child.pid){await stopWorker(uid);throw Error('PROXY_WORKER_TIMEOUT');}await control(state,'status');
  }
  return {mode:'proxy',publicIp:route.publicIp,serverUid:route.serverUid,common:{ProxyEnable:1,ProxyType:1,ProxyAddress:'127.0.0.1:'+state.port,ProxyLogin:state.username,ProxyPassword:state.password}};
 }
 function apply(dir,network){for(const name of ['common.ini','sandbox-startup.ini']){const file=path.join(dir,'config',name);if(fs.existsSync(file))mergeIni(file,{Common:network.common});}atomicJson(path.join(dir,'config','proxy-status.json'),{mode:network.mode,publicIp:network.publicIp||null,serverUid:network.serverUid||null,scope:'mt5_broker',appliedAt:Date.now()});}
 async function release(uid){await stopWorker(uid);await httpRequest('POST','/api/sandbox/node/network/'+uid+'/release',{});}
 return {prepare,apply,stopWorker,release};
}
module.exports={createProxyNetwork,DIRECT,control};
