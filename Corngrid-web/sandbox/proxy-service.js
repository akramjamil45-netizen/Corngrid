'use strict';
const crypto=require('node:crypto'),net=require('node:net');
const {dbRun:run,dbGet:get,dbAll:all,withTransaction,isPostgres}=require('../db-async');
const {digest,equal,publicIPv4,signTicket}=require('../agent/proxy-protocol');
const ONLINE_MS=90000,VERIFIED_MS=180000;
function fail(message,statusCode=400,code='PROXY_INVALID'){return Object.assign(Error(message),{statusCode,code});}
function label(value){if(typeof value!=='string'||value.trim().length<2||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))throw fail('Name must contain 2–80 characters.');return value.trim();}
function endpointHost(value){if(typeof value!=='string'||value.length>253||!value.length||!(/^[a-zA-Z0-9.-]+$/.test(value))||value.startsWith('.')||value.includes('..'))throw fail('Specify a hostname or IPv4 address without a URL or port.');return value.toLowerCase();}
function createProxyService({db,crypto:secrets,audit=async()=>{},now=()=>Date.now()}){
 const lock=isPostgres(db)?' FOR UPDATE':'';
 const online=server=>Boolean(server.last_heartbeat_at&&now()-Number(server.last_heartbeat_at)<ONLINE_MS&&Number(server.last_heartbeat_at)<=now()+30000);
 const publicServer=server=>({id:server.id,serverUid:server.server_uid,name:server.name,host:server.host,port:server.port,enabled:Boolean(server.enabled),certificateFingerprint:server.certificate_fingerprint,online:online(server),lastHeartbeatAt:server.last_heartbeat_at,lastError:server.last_error});
 async function list(){
  const servers=await all(db,'SELECT * FROM sandbox_proxy_servers ORDER BY id ASC');
  for(const server of servers){server.endpoints=await all(db,`SELECT e.id,e.public_ip,e.source_address,e.enabled,e.verified_at,e.last_error,
   (SELECT COUNT(*) FROM sandbox_proxy_leases l WHERE l.endpoint_id=e.id) AS sandbox_count FROM sandbox_proxy_endpoints e WHERE e.server_id=? ORDER BY e.id`,[server.id]);}
  return {servers:servers.map(s=>({...publicServer(s),endpoints:s.endpoints.map(e=>({id:e.id,publicIp:e.public_ip,sourceAddress:e.source_address,enabled:Boolean(e.enabled),verified:Boolean(e.verified_at&&now()-Number(e.verified_at)<VERIFIED_MS),verifiedAt:e.verified_at,lastError:e.last_error,sandboxCount:Number(e.sandbox_count)}))})),assignments:(await all(db,'SELECT node_id,server_id FROM sandbox_node_proxies ORDER BY node_id')).map(a=>({nodeId:a.node_id,serverId:a.server_id}))};
 }
 async function create(body,ip){
  const name=label(body.name),host=endpointHost(body.host),port=body.port??24443;
  if(!Number.isInteger(port)||port<1||port>65535)throw fail('Proxy port must be 1–65535.');
  const serverUid='cgp_'+crypto.randomBytes(9).toString('hex'),token='cgpx_'+crypto.randomBytes(32).toString('hex'),stamp=now();
  return withTransaction(db,async()=>{const row=await run(db,`INSERT INTO sandbox_proxy_servers(server_uid,name,host,port,auth_token_hash,auth_token_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,[serverUid,name,host,port,digest(token),secrets.encrypt(token),stamp,stamp]);
   await audit('proxy_server_created',row.lastID,{serverUid,name,host,port},ip);
   return {server:{id:row.lastID,serverUid,name,host,port,enabled:false},bootstrap:{format:1,serverUid,serverToken:token,host,port}};
  });
 }
 async function update(id,body,ip){return withTransaction(db,async()=>{
  const server=await get(db,'SELECT * FROM sandbox_proxy_servers WHERE id=?'+lock,[id]);if(!server)throw fail('Proxy server not found.',404);
  if(typeof body.enabled!=='boolean'||Object.keys(body).some(k=>k!=='enabled'))throw fail('Specify enabled as a boolean.');
  if(body.enabled&&(!server.certificate_fingerprint||!online(server)))throw fail('Install the proxy and wait for a healthy heartbeat before enabling it.',409,'PROXY_NOT_READY');
  if(body.enabled&&!await get(db,'SELECT id FROM sandbox_proxy_endpoints WHERE server_id=? AND enabled=TRUE AND verified_at>=? LIMIT 1',[id,now()-VERIFIED_MS]))throw fail('Add an IP and verify its public egress before enabling this proxy.',409,'PROXY_IP_UNVERIFIED');
  await run(db,'UPDATE sandbox_proxy_servers SET enabled=?,updated_at=? WHERE id=?',[body.enabled,now(),id]);await audit('proxy_server_'+(body.enabled?'enabled':'disabled'),id,{},ip);return publicServer({...server,enabled:body.enabled});
 });}
 async function addEndpoint(id,body,ip){
  if(!publicIPv4(body.publicIp)||net.isIP(body.sourceAddress)!==4)throw fail('Specify a real public IPv4 and an IPv4 source address configured on the proxy VPS.');
  return withTransaction(db,async()=>{if(!await get(db,'SELECT id FROM sandbox_proxy_servers WHERE id=?'+lock,[id]))throw fail('Proxy server not found.',404);
   if(await get(db,'SELECT id FROM sandbox_proxy_endpoints WHERE public_ip=? OR (server_id=? AND source_address=?)',[body.publicIp,id,body.sourceAddress]))throw fail('This public IP or source address is already registered.',409,'PROXY_IP_DUPLICATE');
   const result=await run(db,'INSERT INTO sandbox_proxy_endpoints(server_id,public_ip,source_address,created_at) VALUES(?,?,?,?)',[id,body.publicIp,body.sourceAddress,now()]);await audit('proxy_ip_added',id,{endpointId:result.lastID,publicIp:body.publicIp,sourceAddress:body.sourceAddress},ip);return {id:result.lastID};
  });
 }
 async function removeEndpoint(serverId,id,ip){return withTransaction(db,async()=>{
  const endpoint=await get(db,'SELECT id FROM sandbox_proxy_endpoints WHERE id=? AND server_id=?'+lock,[id,serverId]);if(!endpoint)throw fail('IP not found.',404);
  if(await get(db,'SELECT instance_id FROM sandbox_proxy_leases WHERE endpoint_id=?',[id]))throw fail('This IP is still reserved by a sandbox. Remove its proxy assignment, restart or delete the sandbox, then try again.',409,'PROXY_IP_IN_USE');
  await run(db,'DELETE FROM sandbox_proxy_endpoints WHERE id=?',[id]);await audit('proxy_ip_removed',serverId,{endpointId:id},ip);
 });}
 async function removeServer(id,ip){return withTransaction(db,async()=>{
  const server=await get(db,'SELECT * FROM sandbox_proxy_servers WHERE id=?'+lock,[id]);if(!server)throw fail('Proxy server not found.',404);
  if(server.enabled||await get(db,'SELECT node_id FROM sandbox_node_proxies WHERE server_id=? LIMIT 1',[id]))throw fail('Disable the proxy and remove its node assignments before removing it.',409);
  const active=await get(db,`SELECT l.instance_id FROM sandbox_proxy_leases l JOIN sandbox_proxy_endpoints e ON e.id=l.endpoint_id JOIN sandbox_instances i ON i.id=l.instance_id
   WHERE e.server_id=? AND i.deleted_at IS NULL AND i.status NOT IN ('stopped','failed','suspended') LIMIT 1`,[id]);
  if(active)throw fail('A sandbox still uses this proxy. Restart it with its new assignment or stop it before removing the proxy.',409);
  await run(db,'DELETE FROM sandbox_proxy_leases WHERE endpoint_id IN (SELECT id FROM sandbox_proxy_endpoints WHERE server_id=?)',[id]);
  await run(db,'DELETE FROM sandbox_proxy_endpoints WHERE server_id=?',[id]);await run(db,'DELETE FROM sandbox_proxy_servers WHERE id=?',[id]);await audit('proxy_server_removed',id,{serverUid:server.server_uid},ip);
 });}
 async function assign(nodeId,serverId,ip){return withTransaction(db,async()=>{
  const node=await get(db,'SELECT id,agent_version FROM sandbox_nodes WHERE id=?'+lock,[nodeId]);if(!node)throw fail('Sandbox node not found.',404);
  if(serverId!==null){
   const [major,minor]=String(node.agent_version||'').split('.').map(Number);
   if(!(major>1||(major===1&&minor>=4)))throw fail('Update this node to Sandbox Agent 1.4.0+ before assigning a proxy.',409,'PROXY_AGENT_UPDATE_REQUIRED');
   if(!Number.isSafeInteger(serverId)||serverId<1)throw fail('Invalid proxy server.');
   if(!await get(db,'SELECT id FROM sandbox_proxy_servers WHERE id=?',[serverId]))throw fail('Proxy server not found.',404);
   await run(db,`INSERT INTO sandbox_node_proxies(node_id,server_id,updated_at) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET server_id=excluded.server_id,updated_at=excluded.updated_at`,[nodeId,serverId,now()]);
  }else await run(db,'DELETE FROM sandbox_node_proxies WHERE node_id=?',[nodeId]);
  await audit('proxy_node_assignment_updated',serverId,{nodeId,serverId},ip);return {nodeId,serverId,applies:'next_sandbox_start'};
 });}
 async function authenticate(uid,token){if(typeof uid!=='string'||typeof token!=='string'||token.length>128)return null;const server=await get(db,'SELECT * FROM sandbox_proxy_servers WHERE server_uid=?',[uid]);return server&&equal(digest(token),server.auth_token_hash)?server:null;}
 async function heartbeat(server,body){
  const fingerprint=String(body.certificateFingerprint||'').replace(/:/g,'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(fingerprint))throw fail('Invalid TLS certificate fingerprint.');
  await withTransaction(db,async()=>{const current=await get(db,'SELECT * FROM sandbox_proxy_servers WHERE id=?'+lock,[server.id]);
   if(current.certificate_fingerprint&&current.certificate_fingerprint!==fingerprint)throw fail('TLS certificate changed. Re-register the proxy before using the replacement certificate.',409,'PROXY_CERT_CHANGED');
   await run(db,'UPDATE sandbox_proxy_servers SET certificate_fingerprint=?,last_heartbeat_at=?,updated_at=? WHERE id=?',[fingerprint,now(),now(),server.id]);});
  const current=await get(db,'SELECT enabled FROM sandbox_proxy_servers WHERE id=?',[server.id]);
  const endpoints=await all(db,'SELECT id,source_address,public_ip,enabled,verified_at FROM sandbox_proxy_endpoints WHERE server_id=?',[server.id]);
  // A reconnect/automatic restart can prepare its route while the last report
  // still says stopped/failed. The owned bridge closes streams on a real stop;
  // deletion and suspension revoke them here independently of agent reporting.
  const leases=await all(db,`SELECT e.id AS endpoint_id,i.instance_uid FROM sandbox_proxy_leases l JOIN sandbox_proxy_endpoints e ON e.id=l.endpoint_id JOIN sandbox_instances i ON i.id=l.instance_id WHERE e.server_id=? AND i.deleted_at IS NULL AND i.status<>'suspended'`,[server.id]);
  return {enabled:Boolean(current.enabled),endpoints:endpoints.map(e=>({id:e.id,sourceAddress:e.source_address,publicIp:e.public_ip,enabled:Boolean(e.enabled),verified:Boolean(e.verified_at&&now()-Number(e.verified_at)<VERIFIED_MS)})),leases:leases.map(l=>({endpointId:l.endpoint_id,instanceUid:l.instance_uid})),serverTime:now()};
 }
 async function verifyEgress(server,id,observedIp){
  const endpoint=await get(db,'SELECT public_ip FROM sandbox_proxy_endpoints WHERE id=? AND server_id=?',[id,server.id]);if(!endpoint)throw fail('IP not found.',404);
  const observed=String(observedIp).replace(/^::ffff:/,'');const verified=observed===endpoint.public_ip&&publicIPv4(observed);
  await run(db,'UPDATE sandbox_proxy_endpoints SET verified_at=?,last_error=? WHERE id=?',[verified?now():null,verified?null:'Observed source IP does not match the configured public IP.',id]);
  return {verified,observedIp:observed};
 }
 async function route(node,instanceUid,{prepare=false}={}){return withTransaction(db,async()=>{
  const instance=await get(db,'SELECT id FROM sandbox_instances WHERE instance_uid=? AND node_id=? AND deleted_at IS NULL'+lock,[instanceUid,node.id]);if(!instance)throw fail('Sandbox not found.',404);
  const assignment=await get(db,'SELECT server_id FROM sandbox_node_proxies WHERE node_id=?',[node.id]);
  let lease=await get(db,`SELECT e.*,l.instance_id FROM sandbox_proxy_leases l JOIN sandbox_proxy_endpoints e ON e.id=l.endpoint_id WHERE l.instance_id=?`,[instance.id]);
  if(prepare&&lease&&(!assignment||lease.server_id!==assignment.server_id)){await run(db,'DELETE FROM sandbox_proxy_leases WHERE instance_id=?',[instance.id]);lease=null;}
  if(!assignment){if(lease)throw fail('Proxy removal applies after the sandbox is restarted.',409,'PROXY_CHANGE_PENDING');return {mode:'direct'};}
  const [major,minor]=String(node.agent_version||'').split('.').map(Number);
  if(!(major>1||(major===1&&minor>=4)))throw fail('Update this node to an agent with proxy support before starting its sandbox.',409,'PROXY_AGENT_UPDATE_REQUIRED');
  const server=await get(db,'SELECT * FROM sandbox_proxy_servers WHERE id=?'+lock,[assignment.server_id]);
  if(!server||!server.enabled||!online(server)||!server.certificate_fingerprint)throw fail('Assigned proxy is disabled or offline. Direct fallback is not allowed for a proxy-assigned sandbox.',503,'PROXY_UNAVAILABLE');
  if(lease&&lease.server_id!==server.id)throw fail('Proxy change applies after the sandbox is restarted.',409,'PROXY_CHANGE_PENDING');
  if(!lease){
   if(!prepare)throw fail('Proxy IP has not been reserved. Start the sandbox to reserve one.',409,'PROXY_PREPARE_REQUIRED');
   const endpoint=await get(db,`SELECT e.* FROM sandbox_proxy_endpoints e WHERE e.server_id=? AND e.enabled=TRUE AND e.verified_at>=?
    ORDER BY (SELECT COUNT(*) FROM sandbox_proxy_leases l WHERE l.endpoint_id=e.id), e.id LIMIT 1${isPostgres(db)?' FOR UPDATE SKIP LOCKED':''}`,[server.id,now()-VERIFIED_MS]);
   if(!endpoint)throw fail('No verified egress IP is available on this proxy. Check its IP configuration or choose another proxy.',503,'PROXY_IP_UNAVAILABLE');
   await run(db,'INSERT INTO sandbox_proxy_leases(instance_id,endpoint_id,assigned_at) VALUES(?,?,?)',[instance.id,endpoint.id,now()]);lease=endpoint;
  }
  if(!lease.enabled||!lease.verified_at||now()-Number(lease.verified_at)>=VERIFIED_MS)throw fail('Reserved proxy IP is not verified.',503,'PROXY_IP_UNVERIFIED');
  const secret=secrets.decrypt(server.auth_token_enc);if(!secret)throw fail('Proxy credentials are unavailable.',503,'PROXY_KEY_UNAVAILABLE');
  return {mode:'proxy',serverUid:server.server_uid,host:server.host,port:server.port,certificateFingerprint:server.certificate_fingerprint,endpointId:lease.id,publicIp:lease.public_ip,ticket:signTicket(secret,{serverUid:server.server_uid,instanceUid,endpointId:lease.id,nodeUid:node.node_uid},now()),expiresAt:now()+300000};
 });}
 async function release(node,instanceUid){return withTransaction(db,async()=>{const instance=await get(db,'SELECT id FROM sandbox_instances WHERE instance_uid=? AND node_id=?'+lock,[instanceUid,node.id]);if(!instance)throw fail('Sandbox not found.',404);await run(db,'DELETE FROM sandbox_proxy_leases WHERE instance_id=?',[instance.id]);return {released:true};});}
 return {list,create,update,addEndpoint,removeEndpoint,removeServer,assign,authenticate,heartbeat,verifyEgress,route,release};
}
module.exports={createProxyService,ONLINE_MS,VERIFIED_MS};
