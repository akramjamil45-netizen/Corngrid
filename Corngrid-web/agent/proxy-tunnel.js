'use strict';
const tls=require('node:tls'),crypto=require('node:crypto');
const {reader,readFrame,writeFrame,equal}=require('./proxy-protocol');
async function openTunnel(route,host,port){
 if(!route||route.mode!=='proxy'||!/^[a-f0-9]{64}$/.test(route.certificateFingerprint||''))throw Error('PROXY_PIN_REQUIRED');
 const socket=tls.connect({host:route.host,port:route.port,rejectUnauthorized:false,minVersion:'TLSv1.2',servername:require('node:net').isIP(route.host)?undefined:route.host});
 // Self-signed VPS certificates use mandatory out-of-band pinning. No ticket
 // or destination is sent until the exact registered leaf has been verified.
 let input;try{
  await new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject);socket.setTimeout(10000,()=>socket.destroy(Error('PROXY_CONNECT_TIMEOUT')));});
  const cert=socket.getPeerCertificate();if(!cert.raw||!equal(crypto.createHash('sha256').update(cert.raw).digest('hex'),route.certificateFingerprint))throw Error('PROXY_CERT_MISMATCH');
  input=reader(socket);writeFrame(socket,{ticket:route.ticket,host,port});const response=await readFrame(input);if(response.ok!==true)throw Error('PROXY_CONNECTION_REJECTED');input.release();socket.setTimeout(0);return socket;
 }catch(error){socket.destroy();throw Error(error.message?.startsWith('PROXY_')?error.message:'PROXY_CONNECTION_FAILED');}
}
async function socksSession(socket,{username,password,getRoute,connect=openTunnel}){
 const input=reader(socket);let remote;socket.setTimeout(10000,()=>socket.destroy());
 socket.on('error',()=>remote?.destroy());socket.on('close',()=>remote?.destroy());
 try{
  const greeting=await input.read(2);if(greeting[0]!==5||greeting[1]<1)throw Error('SOCKS_VERSION');
  const methods=await input.read(greeting[1]);if(!methods.includes(2)){socket.end(Buffer.from([5,255]));return;}socket.write(Buffer.from([5,2]));
  const auth=await input.read(2);if(auth[0]!==1||auth[1]<1)throw Error('SOCKS_AUTH');const user=(await input.read(auth[1])).toString();const length=(await input.read(1))[0],pass=(await input.read(length)).toString();
  if(!equal(user,username)||!equal(pass,password)){socket.end(Buffer.from([1,1]));return;}socket.write(Buffer.from([1,0]));
  const header=await input.read(4);if(header[0]!==5||header[1]!==1||header[2]!==0)throw Error('SOCKS_CONNECT_ONLY');let host;
  if(header[3]===1)host=[...await input.read(4)].join('.');else if(header[3]===3){const count=(await input.read(1))[0];if(!count)throw Error('SOCKS_HOST');host=(await input.read(count)).toString('utf8');}else throw Error('SOCKS_IPV4_REQUIRED');
  const port=(await input.read(2)).readUInt16BE();remote=await connect(await getRoute(),host,port);if(socket.destroyed){remote.destroy();return;}
  socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));input.release();socket.setTimeout(0);remote.on('error',()=>socket.destroy());remote.on('close',()=>socket.destroy());socket.pipe(remote).pipe(socket);socket.resume();remote.resume();
 }catch{if(remote)remote.destroy();if(!socket.destroyed)socket.end(Buffer.from([5,1,0,1,0,0,0,0,0,0]));}
}
module.exports={openTunnel,socksSession};
