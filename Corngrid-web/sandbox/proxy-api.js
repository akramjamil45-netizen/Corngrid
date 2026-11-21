'use strict';
function registerProxyApi(app,{service,nodes,verifyAdminToken,rateLimit}){
 const limited=typeof rateLimit==='function'?rateLimit({windowMs:60000,max:1200}):(_req,_res,next)=>next();
 const safe=handler=>async(req,res)=>{res.set('Cache-Control','private, no-store');try{await handler(req,res);}catch(error){res.status(error.statusCode||500).json({error:error.statusCode?error.message:'Proxy operation could not be completed.',code:error.statusCode?error.code:'PROXY_OPERATION_FAILED'});}};
 const id=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw Object.assign(Error('Invalid identifier.'),{statusCode:400});return n;};
 async function proxyAuth(req,res,next){try{const server=await service.authenticate(req.get('X-Proxy-Id'),req.get('X-Proxy-Token'));if(!server)return res.status(401).json({error:'Proxy credentials required.'});req.proxyServer=server;next();}catch{res.status(503).json({error:'Proxy authentication unavailable.'});}}
 async function nodeAuth(req,res,next){try{const node=await nodes.authenticateNode(req.get('X-Node-Id'),req.get('X-Node-Token'));if(!node)return res.status(401).json({error:'Node credentials required.'});req.proxyNode=node;next();}catch{res.status(503).json({error:'Node authentication unavailable.'});}}
 app.get('/api/admin/sandbox/proxies',verifyAdminToken,safe(async(_req,res)=>res.json(await service.list())));
 app.post('/api/admin/sandbox/proxies',verifyAdminToken,safe(async(req,res)=>{const result=await service.create(req.body||{},req.ip);result.bootstrap.backendUrl=process.env.APP_BASE_URL||'https://corngrid.com';res.status(201).json(result);}));
 app.patch('/api/admin/sandbox/proxies/:id',verifyAdminToken,safe(async(req,res)=>res.json({server:await service.update(id(req.params.id),req.body||{},req.ip)})));
 app.delete('/api/admin/sandbox/proxies/:id',verifyAdminToken,safe(async(req,res)=>{await service.removeServer(id(req.params.id),req.ip);res.json({removed:true});}));
 app.post('/api/admin/sandbox/proxies/:id/ips',verifyAdminToken,safe(async(req,res)=>res.status(201).json(await service.addEndpoint(id(req.params.id),req.body||{},req.ip))));
 app.delete('/api/admin/sandbox/proxies/:id/ips/:ipId',verifyAdminToken,safe(async(req,res)=>{await service.removeEndpoint(id(req.params.id),id(req.params.ipId),req.ip);res.json({removed:true});}));
 app.patch('/api/admin/sandbox/nodes/:id/proxy',verifyAdminToken,safe(async(req,res)=>{if(req.body?.serverId!==null&&!Number.isSafeInteger(req.body?.serverId))throw Object.assign(Error('Specify a proxy server or null for direct.'),{statusCode:400});res.json(await service.assign(id(req.params.id),req.body.serverId,req.ip));}));
 app.post('/api/sandbox/proxy/heartbeat',limited,proxyAuth,safe(async(req,res)=>res.json(await service.heartbeat(req.proxyServer,req.body||{}))));
 app.post('/api/sandbox/proxy/ips/:id/verify',limited,proxyAuth,safe(async(req,res)=>res.json(await service.verifyEgress(req.proxyServer,id(req.params.id),req.ip))));
 app.get('/api/sandbox/node/network/:instanceUid',limited,nodeAuth,safe(async(req,res)=>res.json(await service.route(req.proxyNode,req.params.instanceUid))));
 app.post('/api/sandbox/node/network/:instanceUid/prepare',limited,nodeAuth,safe(async(req,res)=>res.json(await service.route(req.proxyNode,req.params.instanceUid,{prepare:true}))));
 app.post('/api/sandbox/node/network/:instanceUid/release',limited,nodeAuth,safe(async(req,res)=>res.json(await service.release(req.proxyNode,req.params.instanceUid))));
}
module.exports={registerProxyApi};
