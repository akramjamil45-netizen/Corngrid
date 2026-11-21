'use strict';
// Shared by the backend ticket issuer, Windows proxy daemon and node bridge.
const crypto=require('node:crypto'),net=require('node:net');
const MAX_FRAME=8192,MAX_TICKET_SECONDS=300;
function digest(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function publicIPv4(value){
 if(net.isIP(value)!==4)return false;const [a,b,c]=value.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
function signTicket(secret,claims,now=Date.now()){
 const body=Buffer.from(JSON.stringify({...claims,v:1,scope:'sandbox-proxy',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+MAX_TICKET_SECONDS})).toString('base64url');
 return body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');
}
function verifyTicket(secret,ticket,serverUid,now=Date.now()){
 if(typeof ticket!=='string'||ticket.length>MAX_FRAME)throw Error('PROXY_AUTH_INVALID');
 const parts=ticket.split('.');if(parts.length!==2||!equal(crypto.createHmac('sha256',secret).update(parts[0]).digest('base64url'),parts[1]))throw Error('PROXY_AUTH_INVALID');
 let claims;try{claims=JSON.parse(Buffer.from(parts[0],'base64url'));}catch{throw Error('PROXY_AUTH_INVALID');}
 const seconds=Math.floor(now/1000);
 if(claims.v!==1||claims.scope!=='sandbox-proxy'||claims.serverUid!==serverUid||!/^sbx_[a-f0-9]{18}$/.test(claims.instanceUid||'')||!Number.isSafeInteger(claims.endpointId)||claims.endpointId<1||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.iat>seconds+30||claims.exp<=seconds||claims.exp-claims.iat>MAX_TICKET_SECONDS)throw Error('PROXY_AUTH_INVALID');
 return claims;
}
// Bounded, fragmented handshake reader. Once released, surplus bytes are put
// back before stream piping starts, preserving coalesced application traffic.
function reader(socket){
 let buffer=Buffer.alloc(0),pending=null,failure=null;
 const finish=()=>{if(pending&&buffer.length>=pending.length){const p=pending;pending=null;const result=buffer.subarray(0,p.length);buffer=buffer.subarray(p.length);p.resolve(result);}};
 const fail=error=>{failure=error;if(pending){pending.reject(error);pending=null;}};
 const data=chunk=>{if(buffer.length+chunk.length>65536){socket.destroy();fail(Error('PROXY_FRAME_TOO_LARGE'));return;}buffer=Buffer.concat([buffer,chunk]);finish();};
 const close=()=>fail(Error('PROXY_CONNECTION_CLOSED'));
 socket.on('data',data);socket.on('error',fail);socket.on('close',close);socket.on('end',close);
 return {read(length){if(!Number.isInteger(length)||length<0||length>MAX_FRAME)return Promise.reject(Error('PROXY_FRAME_TOO_LARGE'));if(failure)return Promise.reject(failure);if(pending)return Promise.reject(Error('PROXY_READ_BUSY'));return new Promise((resolve,reject)=>{pending={length,resolve,reject};finish();});},release(){socket.pause();socket.removeListener('data',data);socket.removeListener('error',fail);socket.removeListener('close',close);socket.removeListener('end',close);if(buffer.length)socket.unshift(buffer);buffer=Buffer.alloc(0);}};
}
async function readFrame(input){const size=(await input.read(4)).readUInt32BE();if(size<2||size>MAX_FRAME)throw Error('PROXY_FRAME_TOO_LARGE');return JSON.parse((await input.read(size)).toString('utf8'));}
function writeFrame(socket,value){const data=Buffer.from(JSON.stringify(value));if(data.length>MAX_FRAME)throw Error('PROXY_FRAME_TOO_LARGE');const header=Buffer.alloc(4);header.writeUInt32BE(data.length);socket.write(Buffer.concat([header,data]));}
function proxyCommon(value){
 if(!value||Number(value.ProxyEnable)===0)return {ProxyEnable:0,ProxyType:1,ProxyAddress:'',ProxyLogin:'',ProxyPassword:''};
 if(Number(value.ProxyEnable)!==1||Number(value.ProxyType)!==1||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.ProxyAddress||'')||Number(value.ProxyAddress.split(':')[1])>65535)throw Error('PROXY_LOCAL_ADDRESS_INVALID');
 for(const key of ['ProxyLogin','ProxyPassword'])if(typeof value[key]!=='string'||!value[key].length||value[key].length>255||/[\r\n\0]/.test(value[key]))throw Error('PROXY_LOCAL_CREDENTIAL_INVALID');
 return {ProxyEnable:1,ProxyType:1,ProxyAddress:value.ProxyAddress,ProxyLogin:value.ProxyLogin,ProxyPassword:value.ProxyPassword};
}
const proxyLines=value=>Object.entries(proxyCommon(value)).map(([key,value])=>key+'='+value);
module.exports={digest,equal,publicIPv4,signTicket,verifyTicket,reader,readFrame,writeFrame,proxyCommon,proxyLines,MAX_TICKET_SECONDS};
