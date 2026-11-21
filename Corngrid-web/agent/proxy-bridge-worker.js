'use strict';
// Detached bridge survives supervisor/agent updates alongside its MT5 terminal.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {loadConfig}=require('./config'),{createTransport}=require('./transport'),{atomicJson}=require('./update-protocol');
const {socksSession}=require('./proxy-tunnel'),{reader,readFrame,writeFrame,equal}=require('./proxy-protocol');
async function main(file){
 const config=loadConfig(),root=path.resolve(config.agentDataDir,'proxy-bridges'),target=path.resolve(file);
 if(path.dirname(target)!==root||!/^sbx_[a-f0-9]{18}\.json$/.test(path.basename(target)))throw Error('PROXY_STATE_PATH_INVALID');
 const state=JSON.parse(fs.readFileSync(target,'utf8'));if(path.basename(target)!==state.instanceUid+'.json')throw Error('PROXY_STATE_ID_INVALID');
 const transport=createTransport({config});let route=null,stopping=false;
 async function refresh(){const next=await transport.httpRequest('GET','/api/sandbox/node/network/'+state.instanceUid);if(next.mode!=='proxy'||next.serverUid!==state.serverUid||next.endpointId!==state.endpointId)throw Error('PROXY_ASSIGNMENT_CHANGED');route=next;return next;}
 // Publish an authenticated control channel before waiting for the backend.
 // A slow route request must not leave an unmanageable detached process when
 // its parent deployment times out or is cancelled.
 let timer;const sockets=new Set();
 const socks=net.createServer(socket=>{if(sockets.size>=32){socket.destroy();return;}sockets.add(socket);socket.on('close',()=>sockets.delete(socket));void socksSession(socket,{username:state.username,password:state.password,getRoute:async()=>{if(!route||route.expiresAt-Date.now()<60000)await refresh();return route;}});});
 await new Promise((resolve,reject)=>{socks.once('error',reject);socks.listen(0,'127.0.0.1',resolve);});
 const control=net.createServer(socket=>{
  socket.on('error',()=>{});socket.setTimeout(3000,()=>socket.destroy());const input=reader(socket);
  (async()=>{const request=await readFrame(input);if(!equal(request.token,state.controlToken))throw Error('UNAUTHORIZED');if(!['stop','status'].includes(request.action))throw Error('INVALID_ACTION');writeFrame(socket,{ok:true,instanceUid:state.instanceUid,pid:process.pid});socket.end(()=>{if(request.action==='stop')void close();});})().catch(()=>socket.destroy());
 });
 await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(0,'127.0.0.1',resolve);});
 function publish(ready){
  const current=JSON.parse(fs.readFileSync(target,'utf8'));
  if(current.instanceUid!==state.instanceUid||!equal(current.controlToken,state.controlToken))throw Error('PROXY_WORKER_REPLACED');
  atomicJson(target,{...state,pid:process.pid,port:socks.address().port,controlPort:control.address().port,ready});
 }
 async function close(){if(stopping)return;stopping=true;clearInterval(timer);for(const socket of sockets)socket.destroy();socks.close();control.close();process.exit(0);}
 publish(false);await refresh();
 timer=setInterval(()=>refresh().catch(()=>{route=null;}),30000);timer.unref();publish(true);
 process.on('SIGTERM',close);process.on('SIGINT',close);
}
if(require.main===module)main(process.argv[2]).catch(()=>{console.error('Sandbox proxy bridge could not start. Check proxy assignment and backend access.');process.exit(1);});
