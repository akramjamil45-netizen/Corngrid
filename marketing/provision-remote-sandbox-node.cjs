'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),modules=path.join(root,'Corngrid-web/node_modules'),stateFile=path.join(__dirname,'remote-node-provision-result.json'),name='CornGrid VPS80481';
const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env')),jwt=require(path.join(modules,'jsonwebtoken'));
const adminVersion=crypto.createHash('sha256').update(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`).digest('hex'),token=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'5m'});
async function api(route,{method='GET',body}={}){const response=await fetch('https://corngrid.com'+route,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)}),data=await response.json();if(!response.ok)throw Object.assign(Error('Node administration request failed'),{code:'HTTP_'+response.status});return data;}
async function main(){
 const {nodes}=await api('/api/admin/sandbox/nodes');
 const clean=n=>({id:n.id,nodeUid:n.nodeUid,name:n.name,status:n.status,online:n.online,maxInstances:n.maxInstances,usedSlots:n.usedSlots,machineName:n.machineName,ramMb:n.ramMb,diskFreeMb:n.diskFreeMb,lastHeartbeatAt:n.lastHeartbeatAt});
 if(process.argv.includes('--inspect')){console.log(JSON.stringify({nodes:nodes.map(clean)}));return;}
 if(process.argv.includes('--create')){
  const existing=nodes.find(n=>n.name===name);if(existing){const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.equal(existing.nodeUid,state.nodeUid);assert.ok(fs.existsSync(state.credentialsPath));console.log(JSON.stringify({alreadyProvisioned:true,...clean(existing)}));return;}
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-VPS80481-provision-'));
  const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/)[0];
  execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{stdio:'ignore',windowsHide:true});
  const created=await api('/api/admin/sandbox/nodes',{method:'POST',body:{name,maxInstances:2,isTestNode:false}});assert.match(created.token,/^cgn_[a-f0-9]{64}$/);assert.match(created.node.nodeUid,/^node_[a-f0-9]{18}$/);
  const credentialsPath=path.join(directory,'agent-config.json'),config={backendUrl:'https://corngrid.com',nodeUid:created.node.nodeUid,nodeToken:created.token,mt5BaseDir:'C:\\CornGrid\\Sandbox\\MT5',sandboxUsersDir:'C:\\CornGrid\\Sandbox\\Users',agentDataDir:'C:\\CornGrid\\Sandbox\\AgentData',brokerCacheDir:'C:\\CornGrid\\Sandbox\\BrokerCaches',mt5PythonPath:'C:\\Program Files\\Python312\\python.exe',webRequestSettingsSource:'C:\\CornGrid\\Sandbox\\WebRequest\\common.ini',heartbeatIntervalMs:15000,brokerSymbolMaps:{},brokerAccountSymbolMaps:{}};
  fs.writeFileSync(credentialsPath,JSON.stringify(config,null,2));
  const state={nodeId:created.node.id,nodeUid:created.node.nodeUid,name,maxInstances:2,targetHostname:'VPS80481',credentialsPath,createdAt:new Date().toISOString()};fs.writeFileSync(stateFile,JSON.stringify(state,null,2));
  console.log(JSON.stringify({registered:true,nodeId:state.nodeId,nodeUid:state.nodeUid,name,maxInstances:2,status:'pending',credentialsSavedInPrivateTemporaryFolder:true}));return;
 }
 const state=JSON.parse(fs.readFileSync(stateFile,'utf8')),node=nodes.find(n=>n.id===state.nodeId);assert.ok(node);assert.equal(node.nodeUid,state.nodeUid);assert.equal(node.name,name);assert.equal(node.maxInstances,2);
 if(process.argv.includes('--restart')){assert.equal(node.machineName,'VPS80481');assert.equal(node.online,true);assert.equal(node.usedSlots,0);await api('/api/admin/sandbox/nodes/'+node.id+'/restart-agent',{method:'POST'});state.restartTestRequestedAt=new Date().toISOString();fs.writeFileSync(stateFile,JSON.stringify(state,null,2));console.log(JSON.stringify({restartRequested:true,nodeUid:node.nodeUid,activeSandboxes:0}));return;}
 if(process.argv.includes('--activate')){assert.equal(node.machineName,'VPS80481');assert.equal(node.online,true);await api('/api/admin/sandbox/nodes/'+node.id+'/status',{method:'POST',body:{status:'active'}});console.log(JSON.stringify({activated:true,...clean({...node,status:'active'})}));return;}
 if(process.argv.includes('--cleanup-secret')){assert.equal(node.machineName,'VPS80481');assert.equal(node.online,true);const folder=path.dirname(state.credentialsPath),relative=path.relative(os.tmpdir(),folder);assert.match(relative,/^CornGrid-VPS80481-provision-[a-zA-Z0-9]+$/);if(fs.existsSync(state.credentialsPath))fs.unlinkSync(state.credentialsPath);fs.rmdirSync(folder);delete state.credentialsPath;state.secretTransferComplete=true;fs.writeFileSync(stateFile,JSON.stringify(state,null,2));console.log(JSON.stringify({temporaryCredentialRemoved:true,...clean(node)}));return;}
 console.log(JSON.stringify({verified:node.online&&node.machineName==='VPS80481',...clean(node)}));
}
main().catch(error=>{console.error('VPS node provisioning failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
