'use strict';
// Operator-only deployment helper. Secrets stay in memory; reports contain
// hashes/counts/status only. Never deploy agent code or alter production keys.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
const source=path.resolve(__dirname,'..'),target='C:\\Website\\Website',backend=path.join(target,'Corngrid-web');
const modules=path.join(source,'Corngrid-web/node_modules');
const {Client}=require(path.join(modules,'pg'));
const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(backend,'.env')));
const report=path.join(__dirname,'platform-deployment-result.json');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function contained(root,relative){const full=path.resolve(root,relative);assert(full.startsWith(root+path.sep),'Unsafe deployment path');return full;}
function files(){
 const changed=cp.execFileSync('git',['diff','--name-only','HEAD'],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/);
 const added=cp.execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:source,encoding:'utf8'}).trim().split(/\r?\n/);
 return [...new Set([...changed,...added])].filter(name=>['sw.js','web.config','web.config.xml'].includes(name)||name.startsWith('Corngrid-web/')&&!/^Corngrid-web\/(test|agent)\//.test(name)&&!/^Corngrid-web\/(\.env|package)/.test(name)&&!/^Corngrid-web\/scripts\/(check-platform-browser|preview-platform)\.js$/.test(name)).concat(['Corngrid-web/package.json','Corngrid-web/package-lock.json']);
}
function dependencies(){
 const lock=JSON.parse(fs.readFileSync(path.join(source,'Corngrid-web/package-lock.json'))),changes=[];
 for(const [name,pkg]of Object.entries(lock.packages)){
  if(!name.startsWith('node_modules/')||pkg.dev)continue;
  const from=contained(path.join(source,'Corngrid-web'),name),to=contained(backend,name);
  if(!fs.existsSync(path.join(from,'package.json')))continue; // Other-platform optional native packages.
  const expected=JSON.parse(fs.readFileSync(path.join(from,'package.json'))).version;
  assert.equal(expected,pkg.version,'Source dependency differs from tested lock');
  const actual=fs.existsSync(path.join(to,'package.json'))?JSON.parse(fs.readFileSync(path.join(to,'package.json'))).version:null;
  if(actual!==expected)changes.push({name,expected,actual});
 }
 return changes.sort((a,b)=>a.name.split('/').length-b.name.split('/').length);
}
async function client(){const db=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:10000});await db.connect();return db;}
async function inspect(){
 assert.equal(require('node:os').hostname().toUpperCase(),'WINSLET');
 assert(env.DATABASE_URL,'PostgreSQL configuration required');
 assert(/^[a-f\d]{64}$/i.test(env.MFA_ENCRYPTION_KEY||env.SANDBOX_ENCRYPTION_KEY||''),'Persistent MFA encryption key required');
 assert.notEqual(env.CORNGRID_STAGING,'true','Production is unexpectedly staging');
 const db=await client();let database;
 try{database={...((await db.query("SELECT current_setting('server_version') AS version, (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM user_subscriptions)::int AS subscriptions, (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL)::int AS sandboxes, to_regclass('public.auth_factors') IS NOT NULL AS mfa_schema")).rows[0])};
 if(database.mfa_schema)database.enrolledFactors=Number((await db.query('SELECT COUNT(*) FROM auth_factors WHERE enabled=1')).rows[0].count);
 }finally{await db.end();}
 const runtime=files().filter(name=>fs.existsSync(contained(source,name))).map(name=>{
  const to=contained(target,name),exists=fs.existsSync(to);let baseline=null;
  try{baseline=cp.execFileSync('git',['show','HEAD:'+name],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','ignore']}).replace(/\r\n/g,'\n');}catch{}
  return {name,exists,changed:!exists||hash(to)!==hash(contained(source,name)),productionDivergedFromHead:exists&&baseline!==null&&fs.readFileSync(to,'utf8').replace(/\r\n/g,'\n')!==baseline};
 });
 const result={phase:'inspected',runtime,dependencies:dependencies(),database,configuration:{persistentMfaKey:true,backupKeyConfigured:Boolean(env.BACKUP_ENCRYPTION_KEY),stripeConfigured:Boolean(env.STRIPE_SECRET_KEY),nodeAutoPublishConfigured:Boolean(env.SANDBOX_NODE_UPDATE_DIR)}};
 fs.writeFileSync(report,JSON.stringify(result,null,2));return result;
}
async function prepare(backup){
 const result=await inspect();assert(path.resolve(backup).startsWith('C:\\ProgramData\\CornGrid\\WebsiteBackups\\platform-'),'Unexpected backup path');
 assert(!result.runtime.some(item=>item.productionDivergedFromHead),'Production differs from reviewed baseline');
 assert(fs.existsSync(backup),'Create private backup directory first');
 const plan={...result,phase:'prepared',backup,envHash:hash(path.join(backend,'.env')),files:[],packages:[]};
 for(const item of result.runtime.filter(item=>item.changed)){
  const to=contained(target,item.name),saved=contained(path.join(backup,'files'),item.name),candidate=contained(path.join(backup,'candidate'),item.name);
  fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.copyFileSync(contained(source,item.name),candidate);
  if(item.exists){fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(to,saved);}
  plan.files.push({...item,sourceHash:hash(candidate),originalHash:item.exists?hash(to):null});
 }
 for(const item of result.dependencies){
  const candidate=contained(path.join(backup,'candidate/Corngrid-web'),item.name);fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.cpSync(contained(path.join(source,'Corngrid-web'),item.name),candidate,{recursive:true});plan.packages.push(item);
 }
 // Credentials are passed only through child environment, never command arguments.
 const url=new URL(env.DATABASE_URL),dump=path.join(backup,'database-before.dump');
 const dumpEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGCONNECT_TIMEOUT:'8'};
 if(url.searchParams.get('sslmode'))dumpEnv.PGSSLMODE=url.searchParams.get('sslmode');
 const proc=cp.spawnSync(env.PG_DUMP_BIN||'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe',['--format=custom','--no-password','--file',dump],{env:dumpEnv,windowsHide:true,encoding:'utf8',timeout:120000});
 assert.equal(proc.status,0,'Private pre-deployment PostgreSQL snapshot failed');assert(fs.statSync(dump).size>0,'Empty database snapshot');
 fs.writeFileSync(path.join(backup,'plan.json'),JSON.stringify(plan,null,2));
 fs.writeFileSync(report,JSON.stringify({...plan,databaseSnapshot:true},null,2));return {phase:plan.phase,files:plan.files.length,packages:plan.packages.length,databaseSnapshot:true,backup};
}
async function apply(backup){
 const plan=JSON.parse(fs.readFileSync(path.join(backup,'plan.json')));assert.equal(plan.backup,backup);assert.equal(hash(path.join(backend,'.env')),plan.envHash,'Production environment changed after preparation');
 for(const item of plan.files){const to=contained(target,item.name);assert.equal(fs.existsSync(to)?hash(to):null,item.originalHash,'Production source changed after preparation');assert.equal(hash(contained(path.join(backup,'candidate'),item.name)),item.sourceHash);}
 const db=await client();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query(fs.readFileSync(contained(source,'Corngrid-web/migrations/postgres/0019_auth_factors.sql'),'utf8'));await db.query('COMMIT');}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end();}
 plan.phase='applying';plan.appliedFiles=[];plan.appliedPackages=[];const save=()=>fs.writeFileSync(path.join(backup,'plan.json'),JSON.stringify(plan,null,2));save();
 for(const item of plan.packages){
  const to=contained(backend,item.name),saved=contained(path.join(backup,'packages'),item.name),candidate=contained(path.join(backup,'candidate/Corngrid-web'),item.name);
  if(fs.existsSync(path.join(to,'package.json'))&&JSON.parse(fs.readFileSync(path.join(to,'package.json'))).version===item.expected)continue;
  item.existed=fs.existsSync(to);plan.appliedPackages.push(item);save();
  if(item.existed){fs.mkdirSync(path.dirname(saved),{recursive:true});fs.renameSync(to,saved);}fs.mkdirSync(path.dirname(to),{recursive:true});fs.cpSync(candidate,to,{recursive:true});
 }
 for(const item of plan.files){plan.appliedFiles.push(item);save();const to=contained(target,item.name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(contained(path.join(backup,'candidate'),item.name),to);assert.equal(hash(to),item.sourceHash);}
 for(const name of ['sqlite3','pg','express','sharp','stripe','nodemailer'])require(path.join(backend,'node_modules',name));
 assert.equal(hash(path.join(backend,'.env')),plan.envHash,'Production keys must remain untouched');plan.phase='applied';save();return {phase:'applied',files:plan.appliedFiles.length,packages:plan.appliedPackages.length,migration:'0019_auth_factors.sql',environmentPreserved:true};
}
async function verify(){
 const jwt=require(path.join(modules,'jsonwebtoken')),admin=require(path.join(backend,'admin-auth'))({email:env.ADMIN_EMAIL,passwordHash:env.ADMIN_PASSWORD_HASH,jwtSecret:env.JWT_SECRET});
 const adminVersion=crypto.createHash('sha256').update(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`).digest('hex');
 const db=await client();let version;try{version=Number((await db.query('SELECT version FROM auth_factors WHERE subject=$1',[admin.mfaSubject])).rows[0]?.version)||0;}finally{await db.end();}
 const token=jwt.sign({sub:'admin',role:'admin',adminVersion,mfaVersion:version},env.JWT_SECRET,{expiresIn:'2m'});
 const base='http://127.0.0.1:3000',headers={Authorization:'Bearer '+token};
 const ready=await fetch(base+'/api/health/ready',{signal:AbortSignal.timeout(10000)});assert.equal(ready.status,200);
 const unauth=await fetch(base+'/api/admin/system-health',{signal:AbortSignal.timeout(10000)});assert.equal(unauth.status,401);
 const health=await fetch(base+'/api/admin/system-health',{headers,signal:AbortSignal.timeout(10000)});assert.equal(health.status,200);const data=await health.json();assert.equal(data.checks.length,10);assert(!data.checks.some(c=>c.message==='CHECK_UNAVAILABLE'),'A diagnostic query failed');
 const mfa=await fetch(base+'/api/admin/security/mfa',{headers,signal:AbortSignal.timeout(10000)});assert.equal(mfa.status,200);
 const state=await mfa.json();
 return {readiness:true,unauthorizedHealthRejected:true,adminDiagnostics:true,checks:data.checks.map(({id,status,values})=>({id,status,values})),mfaStatusAvailable:true,mfaEnabled:state.enabled??state.mfa?.enabled};
}
async function smoke(){
 const assets=['admin-health.js?v=20261116-health1','security.js?v=20261116-mfa1','security.css?v=20261116-mfa1','admin.html','dashboard.html','login','sw.js'];const checks=[];
 for(const base of ['http://127.0.0.1:8080','https://corngrid.com']){
  for(const asset of assets){
   const response=await fetch(base+'/'+asset,{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});assert.equal(response.status,200,'Deployed asset unavailable: '+asset);const text=await response.text();
   if(asset.startsWith('admin-health')||asset.startsWith('security.')){assert(!/text\/html/.test(response.headers.get('content-type')||''),'Asset incorrectly routed to HTML');const file=path.join(backend,'public',asset.split('?')[0]);assert.equal(crypto.createHash('sha256').update(text).digest('hex'),hash(file),'Deployed asset content mismatch');}
   if(asset==='admin.html')assert(text.includes('20261116-health1')&&text.includes('20261116-mfa1'),'Stale admin HTML');
   if(asset==='dashboard.html')assert(text.includes('20261116-mfa1'),'Stale workplace HTML');
   if(asset==='login')assert(text.includes('20261116-mfa1'),'Stale login HTML');
   if(asset==='sw.js')assert(text.includes('v28'),'Stale service worker');
   checks.push({origin:base,asset,status:response.status});
  }
 }
 const db=await client();let user;
 try{user=(await db.query(`SELECT u.id,COALESCE(v.version,0) AS version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN account_archives a ON a.user_id=u.id LEFT JOIN auth_factors f ON f.subject='user:'||u.id::text WHERE u.email_verified::text IN ('1','true','t') AND a.archived_at IS NULL AND COALESCE(f.version,0)=0 AND NOT EXISTS(SELECT 1 FROM user_account_access x WHERE x.user_id=u.id AND x.suspended_until>$1) ORDER BY u.id LIMIT 1`,[Date.now()])).rows[0];}finally{await db.end();}
 assert(user,'No existing verified unenrolled account for read-only compatibility check');
 const token=require(path.join(modules,'jsonwebtoken')).sign({id:user.id,authVersion:Number(user.version)},env.JWT_SECRET,{expiresIn:'2m'});
 for(const route of ['/api/me','/api/mt5/accounts','/api/security/mfa','/api/subscription/overview','/api/sandbox/status']){
  const response=await fetch('http://127.0.0.1:3000'+route,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,'Existing authenticated user API regression: '+route);await response.arrayBuffer();checks.push({route,status:response.status});
 }
 return {phase:'smoke-passed',checks,productionAccountsCreated:0,productionPaymentsAttempted:0};
}
async function rollback(backup){
 const plan=JSON.parse(fs.readFileSync(path.join(backup,'plan.json')));assert.equal(plan.backup,backup);
 const db=await client();try{assert.equal(Number((await db.query('SELECT COUNT(*) FROM auth_factors WHERE enabled=1 OR version>0')).rows[0].count),0,'MFA has been enrolled; old authentication rollback requires security review');}finally{await db.end();}
 for(const item of [...(plan.appliedFiles||[])].reverse()){
  const to=contained(target,item.name);if(item.exists)fs.copyFileSync(contained(path.join(backup,'files'),item.name),to);else if(fs.existsSync(to))fs.unlinkSync(to);
 }
 for(const item of [...(plan.appliedPackages||[])].reverse()){
  const to=contained(backend,item.name),saved=contained(path.join(backup,'packages'),item.name);
  if(item.existed&&!fs.existsSync(saved))continue;
  if(fs.existsSync(to)){const failed=contained(path.join(backup,'failed-packages'),item.name);fs.mkdirSync(path.dirname(failed),{recursive:true});fs.renameSync(to,failed);}
  if(item.existed)fs.renameSync(saved,to);
 }
 return {phase:'rolled-back',additiveMigrationRetained:true};
}
async function main(){const mode=process.argv[2]||'inspect',backup=process.argv[3];let result;if(mode==='inspect')result=await inspect();else if(mode==='prepare')result=await prepare(backup);else if(mode==='apply')result=await apply(backup);else if(mode==='verify')result=await verify();else if(mode==='smoke')result=await smoke();else if(mode==='rollback')result=await rollback(backup);else throw Error('Unknown deployment operation');console.log(JSON.stringify(result));}
main().catch(error=>{console.error(JSON.stringify({phase:'failed',errorType:error.code||error.name,reason:error instanceof assert.AssertionError?error.message:'Deployment operation failed; inspect private operator state.'}));process.exitCode=1;});
