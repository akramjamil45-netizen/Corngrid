'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const modules=path.resolve(__dirname,'../Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env')),jwt=require(path.join(modules,'jsonwebtoken'));
const adminVersion=crypto.createHash('sha256').update(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
const token=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'15m'});
async function api(route,method='GET',body){const response=await fetch('https://corngrid.com'+route,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('HTTP_'+response.status);return response.json();}
async function main(){
 const {nodes}=await api('/api/admin/sandbox/nodes');
 if(process.argv[2]==='verify'){
  const updates=await api('/api/admin/sandbox/updates'),expected=JSON.parse(fs.readFileSync(path.join(__dirname,'../Corngrid-web/agent/RELEASE.json'),'utf8'));
  assert.equal(updates.enabled,true);assert.equal(updates.release.id,expected.id);
  const targets=nodes.filter(n=>[3,4].includes(n.id));assert.equal(targets.length,2);
  for(const node of targets){assert.equal(node.online,true);assert.equal(node.status,'active');assert.equal(node.agentVersion,expected.version+'+'+expected.id.slice(0,12));}
  assert.equal(targets.find(n=>n.id===4).maxInstances,2);
  const statuses=await Promise.all(['/api/health/ready','/api/sandbox/node/update','/api/admin/sandbox/updates'].map(async route=>{const response=await fetch('https://corngrid.com'+route,{signal:AbortSignal.timeout(15000)});await response.arrayBuffer();return {route,status:response.status};}));
  assert.equal(statuses[0].status,200);assert.equal(statuses[1].status,401);assert.ok([401,403].includes(statuses[2].status));
  const report={verified:true,at:new Date().toISOString(),release:updates.release,nodes:targets.map(n=>({id:n.id,name:n.name,online:n.online,version:n.agentVersion,maxInstances:n.maxInstances,usedSlots:n.usedSlots})),statuses};fs.writeFileSync(path.join(__dirname,'node-auto-update-final-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return;
 }
 if(process.argv[2]==='wait'){
  const version=process.argv[3];assert.match(version,/^\d+\.\d+\.\d+$/);let previous='';const deadline=Date.now()+8*60*1000;
  while(Date.now()<deadline){const current=(await api('/api/admin/sandbox/nodes')).nodes.filter(n=>[3,4].includes(n.id)),state=JSON.stringify(current.map(n=>({id:n.id,version:n.agentVersion,online:n.online})));if(state!==previous){console.log(new Date().toISOString()+' '+state);previous=state;}
   if(current.length===2&&current.every(n=>n.online&&n.agentVersion?.startsWith(version+'+'))){console.log('Both nodes automatically installed '+version+'.');return;}await new Promise(resolve=>setTimeout(resolve,15000));}
  throw Error('UPDATE_WAIT_TIMEOUT');
 }
 if(process.argv[2]==='logs'){
  const id=Number(process.argv[3]);assert.ok([3,4].includes(id));const result=await api('/api/admin/sandbox/logs?nodeId='+id+'&pageSize=30');
  console.log(JSON.stringify({nodeId:id,logs:result.logs.map(r=>({at:r.created_at,level:r.level,message:r.message}))}));return;
 }
 if(process.argv[2]==='snapshot'){
  const label=process.argv[3];assert.match(label,/^[a-z-]{1,32}$/);
  const {Client}=require(path.join(modules,'pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
  try{
   const rows=(await db.query(`SELECT i.instance_uid,i.node_id,i.status,i.process_id,i.last_error,i.last_heartbeat_at,a.last_heartbeat AS ea_last_heartbeat,a.auth_error_at,a.ea_version FROM sandbox_instances i LEFT JOIN mt5_accounts a ON a.account_number=i.mt5_account_number AND a.broker_server=i.broker_server WHERE i.deleted_at IS NULL AND i.node_id IN (3,4) ORDER BY i.id`)).rows;
   const result={at:new Date().toISOString(),nodes:nodes.map(n=>({id:n.id,online:n.online,version:n.agentVersion,usedSlots:n.usedSlots,maxInstances:n.maxInstances})),instances:rows.map(r=>({instanceUid:r.instance_uid,nodeId:r.node_id,status:r.status,processId:r.process_id,lastError:r.last_error,agentHeartbeatAt:r.last_heartbeat_at,eaHeartbeatAt:r.ea_last_heartbeat,eaHeartbeatAgeSeconds:r.ea_last_heartbeat?Math.round((Date.now()-Number(r.ea_last_heartbeat))/1000):null,authErrorAt:r.auth_error_at,eaVersion:r.ea_version}))};
   fs.writeFileSync(path.join(__dirname,'node-updater-snapshot-'+label+'-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));return;
  }finally{await db.end();}
 }
 if(['pause','resume'].includes(process.argv[2])){const enabled=process.argv[2]==='resume';const result=await api('/api/admin/sandbox/updates','PATCH',{enabled});console.log(JSON.stringify({enabled:result.enabled,release:result.release}));return;}
 if(process.argv[2]==='restart'){
  const id=Number(process.argv[3]);assert.ok([3,4].includes(id));const node=nodes.find(n=>n.id===id);assert.ok(node&&node.online);assert.equal(node.nodeUid,id===3?'node_00131382007cf3e46a':'node_1677e8779f05aa567b');
  const report=JSON.parse(fs.readFileSync(path.join(__dirname,id===3?'node-updater-winslet-result.json':'node-updater-vps80481-result.json'),'utf8'));assert.equal(report.phase,'prepared');assert.equal(report.nodeUid,node.nodeUid);
  await api('/api/admin/sandbox/nodes/'+id+'/restart-agent','POST');console.log(JSON.stringify({gracefulAgentExitRequested:true,nodeId:id,existingSandboxes:node.usedSlots,terminalStopCommandsSent:0}));return;
 }
 const updates=await api('/api/admin/sandbox/updates');
 console.log(JSON.stringify({updates,nodes:nodes.map(n=>({id:n.id,name:n.name,nodeUid:n.nodeUid,online:n.online,status:n.status,agentVersion:n.agentVersion,maxInstances:n.maxInstances,usedSlots:n.usedSlots,diskFreeMb:n.diskFreeMb,lastHeartbeatAt:n.lastHeartbeatAt}))}));
}
main().catch(error=>{console.error('Node updater operation failed:',error.code||error.name);process.exitCode=1;});
