'use strict';
const https=require('node:https');
function controlRequest(config,method,route,body,sourceAddress){
 const origin=new URL(config.backendUrl);if(origin.protocol!=='https:')return Promise.reject(Error('PROXY_BACKEND_HTTPS_REQUIRED'));
 const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
 return new Promise((resolve,reject)=>{
  const req=https.request(new URL(route,origin),{method,family:4,localAddress:sourceAddress,timeout:15000,headers:{'X-Proxy-Id':config.serverUid,'X-Proxy-Token':config.serverToken,...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy();reject(Error('PROXY_CONTROL_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
   res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200)return reject(Error('PROXY_CONTROL_HTTP_'+res.statusCode));resolve(data);}catch{reject(Error('PROXY_CONTROL_INVALID'));}});
  });req.on('error',()=>reject(Error('PROXY_CONTROL_UNAVAILABLE')));req.on('timeout',()=>req.destroy());if(payload)req.write(payload);req.end();
 });
}
module.exports={controlRequest};
