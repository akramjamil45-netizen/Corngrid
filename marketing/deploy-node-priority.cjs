'use strict';
// Scoped operator deployment; no node registration, placement, trading command,
// token rotation or agent update. Private backup data never enters Git.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
const source=path.resolve(__dirname,'..'),target='C:\\Website\\Website',backend=path.join(target,'Corngrid-web'),modules=path.join(source,'Corngrid-web/node_modules');
assert.equal(require('node:os').hostname().toUpperCase(),'WINSLET','Unexpected deployment host');
const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(backend,'.env'))),{Client}=require(path.join(modules,'pg'));
const migration='Corngrid-web/migrations/postgres/0022_sandbox_node_preferences.sql';
const files=['Corngrid-web/public/admin.html','Corngrid-web/public/admin-sandbox.js','Corngrid-web/sandbox/sandbox-admin-api.js',
 'Corngrid-web/sandbox/sandbox-nodes.js','Corngrid-web/sandbox/sandbox-realtime.js','Corngrid-web/sandbox/sandbox-schema.js',migration,
 'Corngrid-web/migrations/sqlite/0022_sandbox_node_preferences.sql','Corngrid-web/migrations/rollback/0022_sandbox_node_preferences.sql','Corngrid-web/docs/NODE_PLACEMENT_PRIORITY.md'];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),normalized=file=>fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
function contained(root,name){const full=path.resolve(root,name);assert(full.startsWith(root+path.sep),'Unsafe manifest path');return full;}
function backupRoot(value){const full=path.resolve(value||'.');assert.equal(path.dirname(full),'C:\\ProgramData\\CornGrid\\WebsiteBackups');assert(/^node-priority-\d{8}-\d{6}$/.test(path.basename(full)));return full;}
async function connect(){const db=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:15000});await db.connect();return db;}
async function snapshot(db){
 const schema=(await db.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sandbox_nodes' AND column_name='placement_priority') AS present")).rows[0].present;
 const nodes=(await db.query('SELECT id,node_uid,name,status,max_instances,'+(schema?'placement_priority':'100 AS placement_priority')+' FROM sandbox_nodes ORDER BY id')).rows;
 const instances=(await db.query('SELECT id,node_id,status,process_id FROM sandbox_instances WHERE deleted_at IS NULL ORDER BY id')).rows;
 return {schema,nodes,instances};
}
async function inspect(){
 const runtime=files.map(name=>{const from=contained(source,name),to=contained(target,name);assert(fs.existsSync(from),'Missing source '+name);let baseline=null;
  try{baseline=cp.execFileSync('git',['show','HEAD:'+name],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','ignore']}).replace(/\r\n/g,'\n');}catch{}
  const exists=fs.existsSync(to),changed=!exists||normalized(from)!==normalized(to);
  return {name,exists,changed,sourceHash:hash(from),originalHash:exists?hash(to):null,productionDiverged:exists&&changed&&(baseline===null||normalized(to)!==baseline)};
 });
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source,'Corngrid-web/package.json'))).dependencies,JSON.parse(fs.readFileSync(path.join(backend,'package.json'))).dependencies,'Dependencies differ');
 assert.equal(hash(path.join(source,'Corngrid-web/package-lock.json')),hash(path.join(backend,'package-lock.json')),'Dependency lockfile differs');
 const db=await connect();try{return {phase:'inspected',runtime,database:await snapshot(db)};}finally{await db.end();}
}
async function prepare(value){
 const backup=backupRoot(value),state=await inspect();assert(fs.existsSync(backup),'Create private backup directory first');assert(!state.runtime.some(item=>item.productionDiverged),'Deployment target differs from reviewed baseline');
 const plan={...state,backup,envHash:hash(path.join(backend,'.env')),appliedFiles:[],phase:'prepared'};
 for(const item of state.runtime){const candidate=contained(path.join(backup,'candidate'),item.name);fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.copyFileSync(contained(source,item.name),candidate);
  if(item.exists){const saved=contained(path.join(backup,'files'),item.name);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(contained(target,item.name),saved);}}
 const url=new URL(env.DATABASE_URL),dump=path.join(backup,'database-before.dump'),dumpEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGCONNECT_TIMEOUT:'8'};
 if(url.searchParams.get('sslmode'))dumpEnv.PGSSLMODE=url.searchParams.get('sslmode');
 const operation=cp.spawnSync(env.PG_DUMP_BIN||'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe',['--format=custom','--no-password','--file',dump],{env:dumpEnv,windowsHide:true,timeout:120000,encoding:'utf8'});
 assert.equal(operation.status,0,'Private database backup failed');assert(fs.statSync(dump).size>0,'Empty backup');
 fs.writeFileSync(path.join(backup,'plan.json'),JSON.stringify(plan,null,2));return {phase:'prepared',backup,files:files.length,databaseSnapshot:true,nodeCount:state.database.nodes.length,runningSandboxes:state.database.instances.filter(i=>i.status==='running').length};
}
function loadPlan(value){const backup=backupRoot(value),plan=JSON.parse(fs.readFileSync(path.join(backup,'plan.json')));assert.equal(plan.backup,backup);assert.deepEqual(plan.runtime.map(i=>i.name),files);return plan;}
async function apply(value){
 const plan=loadPlan(value);assert.equal(hash(path.join(backend,'.env')),plan.envHash,'Environment changed');
 for(const item of plan.runtime){const to=contained(target,item.name);assert.equal(fs.existsSync(to)?hash(to):null,item.originalHash,'Deployment file changed '+item.name);assert.equal(hash(contained(path.join(plan.backup,'candidate'),item.name)),item.sourceHash,'Candidate changed');}
 const db=await connect();try{await db.query("SET lock_timeout='5s'");await db.query(fs.readFileSync(contained(path.join(plan.backup,'candidate'),migration),'utf8'));}
 catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end();}
 const save=()=>fs.writeFileSync(path.join(plan.backup,'plan.json'),JSON.stringify(plan,null,2));plan.phase='applying';save();
 for(const item of plan.runtime){plan.appliedFiles.push(item);save();const to=contained(target,item.name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(contained(path.join(plan.backup,'candidate'),item.name),to);assert.equal(hash(to),item.sourceHash);}
 assert.equal(hash(path.join(backend,'.env')),plan.envHash);plan.phase='applied';save();return {phase:'applied',files:files.length,migration:path.basename(migration),environmentPreserved:true,nodeSettingsChanged:false,agentReleaseChanged:false};
}
async function verify(value){
 const plan=loadPlan(value),db=await connect();let state,mfaVersion;
 const email=env.ADMIN_EMAIL.trim().toLowerCase(),adminVersion=crypto.createHash('sha256').update(email+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
 try{state=await snapshot(db);assert(state.schema,'Priority migration missing');mfaVersion=Number((await db.query('SELECT version FROM auth_factors WHERE subject=$1',['admin:'+crypto.createHash('sha256').update(email).digest('hex')])).rows[0]?.version||0);
  for(const before of plan.database.nodes){const node=state.nodes.find(n=>n.id===before.id);assert(node,'Existing node missing');for(const field of ['node_uid','name','status','max_instances','placement_priority'])assert.equal(node[field],before[field],'Existing node setting changed: '+field);}
  for(const before of plan.database.instances.filter(i=>i.status==='running')){const instance=state.instances.find(i=>i.id===before.id);assert(instance,'Running sandbox missing');assert.equal(instance.status,'running','Sandbox no longer running');assert.equal(instance.node_id,before.node_id);assert.equal(instance.process_id,before.process_id,'Terminal PID changed');}
 }finally{await db.end();}
 const token=require(path.join(modules,'jsonwebtoken')).sign({sub:'admin',role:'admin',adminVersion,mfaVersion},env.JWT_SECRET,{expiresIn:'2m'}),checks=[];
 for(const origin of ['http://127.0.0.1:3000','http://127.0.0.1:8080','https://corngrid.com']){
  const response=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,'Readiness failed');
  const list=await fetch(origin+'/api/admin/sandbox/nodes',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});assert.equal(list.status,200,'Admin nodes failed');const data=await list.json();
  assert(data.nodes.every(n=>Number.isInteger(n.placementPriority)&&n.placementPriority>=1&&n.placementPriority<=1000));
  for(let i=1;i<data.nodes.length;i++)assert(data.nodes[i-1].placementPriority<=data.nodes[i].placementPriority,'Priority sort incorrect');
  const invalid=await fetch(origin+'/api/admin/sandbox/nodes/0/settings',{method:'PATCH',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});assert.equal(invalid.status,400,'New settings route unavailable');
  const blocked=await fetch(origin+'/api/admin/sandbox/nodes/0/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});assert([401,403].includes(blocked.status),'Unauthenticated settings access allowed');
  for(const name of ['admin.html','admin-sandbox.js']){const local=path.join(backend,'public',name),asset=await fetch(origin+'/'+name+'?v='+hash(local).slice(0,16),{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});assert.equal(asset.status,200);assert.equal(crypto.createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),hash(local),'Stale asset '+name);}
  checks.push({origin,readiness:200,nodeList:200,settingsValidation:400,unauthenticatedSettings:blocked.status,assetsMatch:true});
 }
 for(const item of plan.runtime)assert.equal(hash(contained(target,item.name)),item.sourceHash,'Deployment file mismatch');
 const result={phase:'verified',checks,nodes:state.nodes.length,runningSandboxes:state.instances.filter(i=>i.status==='running').length,existingTerminalPidsPreserved:true,environmentPreserved:hash(path.join(backend,'.env'))===plan.envHash,productionMutationsTested:false};
 fs.writeFileSync(path.join(plan.backup,'verification.json'),JSON.stringify(result,null,2));return result;
}
async function rollback(value){const plan=loadPlan(value);for(const item of [...plan.appliedFiles].reverse()){const to=contained(target,item.name);if(item.exists)fs.copyFileSync(contained(path.join(plan.backup,'files'),item.name),to);else if(fs.existsSync(to))fs.unlinkSync(to);}assert.equal(hash(path.join(backend,'.env')),plan.envHash);return {phase:'rolled-back',additivePriorityColumnPreserved:true};}
const [mode='inspect',backup]=process.argv.slice(2),operations={inspect,prepare,apply,verify,rollback};
Promise.resolve().then(()=>{assert(operations[mode],'Unknown operation');return operations[mode](backup);}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({phase:'failed',type:error.code||error.name,reason:error instanceof assert.AssertionError?error.message:'Deployment operation failed; inspect private state.'}));process.exitCode=1;});
