'use strict';
const tls=require('node:tls'),net=require('node:net'),dns=require('node:dns/promises'),os=require('node:os'),crypto=require('node:crypto'),fs=require('node:fs');
const {verifyTicket,publicIPv4,reader,readFrame,writeFrame}=require('../agent/proxy-protocol');
const {controlRequest}=require('./control-client');
function createProxyServer({config,tlsOptions,request=controlRequest,lookup=dns.lookup,allowPrivateTargetsForTests=false}){
 if(allowPrivateTargetsForTests&&config.listenHost!=='127.0.0.1')throw Error('TEST_MODE_REQUIRES_LOOPBACK');
 let state={enabled:false,endpoints:[],leases:[]},lastControl=0,refreshing=null,timer;
 const clients=new Map(),localIps=()=>new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(x=>x.address));
 function permitted(claims){return state.enabled&&state.endpoints.some(e=>e.id===claims.endpointId&&e.enabled&&e.verified)&&state.leases.some(l=>l.endpointId===claims.endpointId&&l.instanceUid===claims.instanceUid);}
 async function refresh(){if(refreshing)return refreshing;refreshing=(async()=>{
  let next;try{next=await request(config,'POST','/api/sandbox/proxy/heartbeat',{certificateFingerprint:config.certificateFingerprint});}catch(error){
   // Credential revocation is an explicit administrative action. Unlike a
   // transient backend outage it must also terminate established streams.
   if(error.message==='PROXY_CONTROL_HTTP_401'){state.enabled=false;for(const socket of clients.keys())socket.destroy();}
   throw error;
  }
  if(!next||typeof next.enabled!=='boolean'||!Array.isArray(next.endpoints)||!Array.isArray(next.leases))throw Error('PROXY_CONTROL_INVALID');
  state={...next,serverTime:Number.isSafeInteger(next.serverTime)?next.serverTime:Date.now()};lastControl=performance.now();for(const [socket,claims]of clients)if(claims&&!permitted(claims))socket.destroy();
 })().finally(()=>{refreshing=null;});return refreshing;}
 async function verifyIps(){for(const endpoint of state.endpoints){if(!localIps().has(endpoint.sourceAddress))continue;await request(config,'POST','/api/sandbox/proxy/ips/'+endpoint.id+'/verify',undefined,endpoint.sourceAddress).catch(()=>{});}}
 const server=tls.createServer({...tlsOptions,minVersion:'TLSv1.2',handshakeTimeout:10000},socket=>{
  if(clients.size>=(config.maxConnections||500)){socket.destroy();return;}
  clients.set(socket,null);let upstream,input=reader(socket);const timeout=setTimeout(()=>socket.destroy(),10000);timeout.unref();
  socket.on('error',()=>{if(upstream)upstream.destroy();});socket.on('close',()=>{clients.delete(socket);clearTimeout(timeout);if(upstream)upstream.destroy();});
  (async()=>{
   const frame=await readFrame(input),claims=verifyTicket(config.serverToken,frame.ticket,config.serverUid,state.serverTime+performance.now()-lastControl);
   if(!permitted(claims))await refresh();
   if(!permitted(claims)||performance.now()-lastControl>120000)throw Error('PROXY_ROUTE_DISABLED');
   if([...clients.values()].filter(c=>c?.instanceUid===claims.instanceUid).length>=(config.maxConnectionsPerSandbox||32))throw Error('PROXY_CONNECTION_LIMIT');
   clients.set(socket,claims);const endpoint=state.endpoints.find(e=>e.id===claims.endpointId);
   if(!localIps().has(endpoint.sourceAddress))throw Error('PROXY_SOURCE_IP_UNAVAILABLE');
   if(typeof frame.host!=='string'||frame.host.length>253||!frame.host.length||/[\s\0/@]/.test(frame.host)||!Number.isInteger(frame.port)||frame.port<1||frame.port>65535)throw Error('PROXY_DESTINATION_INVALID');
   const addresses=await lookup(frame.host,{all:true,family:4});
   if(!addresses.length||addresses.some(a=>a.family!==4||(!allowPrivateTargetsForTests&&!publicIPv4(a.address))))throw Error('PROXY_DESTINATION_BLOCKED');
   upstream=net.connect({host:addresses[0].address,port:frame.port,localAddress:endpoint.sourceAddress,family:4});
   await new Promise((resolve,reject)=>{upstream.once('connect',resolve);upstream.once('error',reject);upstream.setTimeout(10000,()=>upstream.destroy(Error('timeout')));});
   if(socket.destroyed){upstream.destroy();return;}clearTimeout(timeout);upstream.setTimeout(1800000);socket.setTimeout(1800000);socket.on('timeout',()=>socket.destroy());upstream.on('timeout',()=>upstream.destroy());
   writeFrame(socket,{ok:true,publicIp:endpoint.publicIp});input.release();socket.pipe(upstream).pipe(socket);socket.resume();upstream.on('error',()=>socket.destroy());upstream.on('close',()=>socket.destroy());
  })().catch(()=>{clearTimeout(timeout);if(upstream)upstream.destroy();if(!socket.destroyed){try{writeFrame(socket,{ok:false,error:'PROXY_CONNECTION_REJECTED'});}catch{}socket.end(()=>socket.destroy());}});
 });
 server.on('tlsClientError',()=>{});
 server.maxConnections=config.maxConnections||500;
 return {server,refresh,verifyIps,async start(){await refresh();await verifyIps();await refresh();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.listenHost||'0.0.0.0',resolve);});timer=setInterval(()=>{refresh().then(verifyIps).catch(()=>{});},15000);timer.unref();return server.address();},async close(){clearInterval(timer);for(const socket of clients.keys())socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
async function main(file){
 const config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\ufeff/,''));
 if(!/^cgp_[a-f0-9]{18}$/.test(config.serverUid||'')||!/^cgpx_[a-f0-9]{64}$/.test(config.serverToken||''))throw Error('PROXY_CONFIG_INVALID');
 if(!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('PROXY_PORT_INVALID');
 const pfx=fs.readFileSync(config.pfxPath),context=tls.createSecureContext({pfx,passphrase:config.pfxPassphrase});
 // The installer records the leaf certificate's SHA-256 fingerprint. Nodes
 // require this exact pin before sending any ticket or broker destination.
 if(typeof config.certificateFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(config.certificateFingerprint))throw Error('PROXY_CERT_INVALID');
 const proxy=createProxyServer({config,tlsOptions:{secureContext:context,pfx,passphrase:config.pfxPassphrase}});
 await proxy.start();console.log('CornGrid proxy ready; authenticated TLS connections only.');
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>proxy.close().finally(()=>process.exit(0)));
}
if(require.main===module)main(process.argv[2]).catch(()=>{console.error('CornGrid proxy startup failed. Check private configuration, certificate and backend connectivity.');process.exitCode=1;});
module.exports={createProxyServer};
