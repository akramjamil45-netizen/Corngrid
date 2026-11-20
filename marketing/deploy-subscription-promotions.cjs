'use strict';
// Local deployment operator. No production claims, offers, payments or agent
// releases are created. Private backups contain the database snapshot.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
const source=path.resolve(__dirname,'..'),target='C:\\Website\\Website',backend=path.join(target,'Corngrid-web');
const modules=path.join(source,'Corngrid-web/node_modules');
const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(backend,'.env')));
const {Client}=require(path.join(modules,'pg'));
const migration='Corngrid-web/migrations/postgres/0021_subscription_promotions.sql';
const files=[
 'Corngrid-web/subscriptions/promotions.js',
 'Corngrid-web/migrations/sqlite/0021_subscription_promotions.sql',migration,
 'Corngrid-web/subscriptions/subscription-api.js',
 'Corngrid-web/public/admin.css','Corngrid-web/public/admin.js','Corngrid-web/public/admin.html',
 'Corngrid-web/public/dashboard.js','Corngrid-web/public/dashboard.html',
 'Corngrid-web/docs/SUBSCRIPTION_PROMOTIONS.md'
];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const normalized=file=>fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
function contained(root,relative){const full=path.resolve(root,relative);assert(full.startsWith(root+path.sep),'Unsafe manifest path');return full;}
function backupRoot(value){const full=path.resolve(value||'.');assert.equal(path.dirname(full),'C:\\ProgramData\\CornGrid\\WebsiteBackups');assert(/^subscription-promotions-\d{8}-\d{6}$/.test(path.basename(full)));return full;}
async function client(){const db=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:15000});await db.connect();return db;}
async function inspect(){
 assert.equal(require('node:os').hostname().toUpperCase(),'WINSLET','Wrong deployment host');
 assert(env.DATABASE_URL&&env.JWT_SECRET,'Production configuration unavailable');
 const runtime=files.map(name=>{
  const from=contained(source,name),to=contained(target,name);assert(fs.existsSync(from),'Missing source '+name);
  let baseline=null;try{baseline=cp.execFileSync('git',['show','HEAD:'+name],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','ignore']}).replace(/\r\n/g,'\n');}catch{}
  const exists=fs.existsSync(to),changed=!exists||normalized(from)!==normalized(to);
  return {name,exists,changed,sourceHash:hash(from),originalHash:exists?hash(to):null,productionDiverged:exists&&changed&&(baseline===null||normalized(to)!==baseline)};
 });
 const db=await client();let database;
 try{database=(await db.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users,
  (SELECT COUNT(*) FROM user_subscriptions)::int AS subscriptions,
  (SELECT COUNT(*) FROM subscription_payments)::int AS payments,
  (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL AND status='running')::int AS running_sandboxes,
  to_regclass('public.subscription_promotion_claims') IS NOT NULL AS promotion_schema`)).rows[0];}finally{await db.end();}
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source,'Corngrid-web/package.json'))).dependencies,JSON.parse(fs.readFileSync(path.join(backend,'package.json'))).dependencies,'Dependencies differ');
 assert.equal(hash(path.join(source,'Corngrid-web/package-lock.json')),hash(path.join(backend,'package-lock.json')),'Lockfile differs');
 return {phase:'inspected',runtime,database};
}
async function prepare(value){
 const backup=backupRoot(value),state=await inspect();assert(fs.existsSync(backup));assert(!state.runtime.some(x=>x.productionDiverged),'Production differs from reviewed baseline');
 const plan={...state,backup,envHash:hash(path.join(backend,'.env')),appliedFiles:[],phase:'prepared'};
 for(const item of plan.runtime){
  const candidate=contained(path.join(backup,'candidate'),item.name);fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.copyFileSync(contained(source,item.name),candidate);
  if(item.exists){const saved=contained(path.join(backup,'files'),item.name);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(contained(target,item.name),saved);}
 }
 const url=new URL(env.DATABASE_URL),dump=path.join(backup,'database-before.dump');
 const dumpEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGCONNECT_TIMEOUT:'8'};
 if(url.searchParams.get('sslmode'))dumpEnv.PGSSLMODE=url.searchParams.get('sslmode');
 const operation=cp.spawnSync(env.PG_DUMP_BIN||'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe',['--format=custom','--no-password','--file',dump],{env:dumpEnv,windowsHide:true,timeout:120000,encoding:'utf8'});
 assert.equal(operation.status,0,'Private database backup failed');assert(fs.statSync(dump).size>0,'Empty backup');
 fs.writeFileSync(path.join(backup,'plan.json'),JSON.stringify(plan,null,2));
 return {phase:'prepared',backup,files:files.length,databaseSnapshot:true,database:state.database};
}
function loadPlan(value){const backup=backupRoot(value),plan=JSON.parse(fs.readFileSync(path.join(backup,'plan.json')));assert.equal(plan.backup,backup);assert.deepEqual(plan.runtime.map(x=>x.name),files);return plan;}
async function apply(value){
 const plan=loadPlan(value);assert.equal(hash(path.join(backend,'.env')),plan.envHash,'Production environment changed');
 for(const item of plan.runtime){const to=contained(target,item.name);assert.equal(fs.existsSync(to)?hash(to):null,item.originalHash,'Deployment target changed '+item.name);assert.equal(hash(contained(path.join(plan.backup,'candidate'),item.name)),item.sourceHash,'Candidate changed');}
 const db=await client();
 try{await db.query("SET lock_timeout='5s'");await db.query(fs.readFileSync(contained(path.join(plan.backup,'candidate'),migration),'utf8'));}
 catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end();}
 plan.phase='applying';const save=()=>fs.writeFileSync(path.join(plan.backup,'plan.json'),JSON.stringify(plan,null,2));save();
 for(const item of plan.runtime){plan.appliedFiles.push(item);save();const to=contained(target,item.name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(contained(path.join(plan.backup,'candidate'),item.name),to);assert.equal(hash(to),item.sourceHash);}
 assert.equal(hash(path.join(backend,'.env')),plan.envHash);plan.phase='applied';save();
 return {phase:'applied',files:files.length,migration:path.basename(migration),environmentPreserved:true};
}
async function verify(){
 const db=await client();let user,adminVersion,mfaVersion,database,downloadAccess;
 try{
  database=(await db.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users,
   (SELECT COUNT(*) FROM user_subscriptions)::int AS subscriptions,(SELECT COUNT(*) FROM subscription_payments)::int AS payments,
   (SELECT COUNT(*) FROM subscription_plan_promotions)::int AS promotional_plans,(SELECT COUNT(*) FROM subscription_promotion_claims)::int AS promotion_claims,
   (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL AND status='running')::int AS running_sandboxes`)).rows[0];
  user=(await db.query(`SELECT u.id,COALESCE(v.version,0) AS version,COALESCE(f.version,0) AS mfa_version FROM users u
   LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN auth_factors f ON f.subject='user:'||u.id::text
   LEFT JOIN account_archives a ON a.user_id=u.id WHERE u.email_verified::text IN ('1','true','t') AND a.archived_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM user_account_access x WHERE x.user_id=u.id AND x.suspended_until>$1)
   ORDER BY EXISTS(SELECT 1 FROM subscription_promotion_claims c WHERE c.user_id=u.id) DESC,u.id LIMIT 1`,[Date.now()])).rows[0];
  if(user)downloadAccess=(await db.query(`SELECT
   EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=$1 AND s.status='active' AND s.deleted_at IS NULL AND s.starts_at<=$2 AND (s.expires_at IS NULL OR s.expires_at>$2)) AS active,
   EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=$1 AND s.status='active' AND s.deleted_at IS NULL AND s.starts_at<=$2 AND (s.expires_at IS NULL OR s.expires_at>$2)
    AND NOT EXISTS(SELECT 1 FROM subscription_promotion_claims c WHERE c.user_id=s.user_id AND c.subscription_id=s.id)) AS allowed`,[user.id,Date.now()])).rows[0];
  const email=env.ADMIN_EMAIL.trim().toLowerCase();adminVersion=crypto.createHash('sha256').update(email+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
  const subject='admin:'+crypto.createHash('sha256').update(email).digest('hex');mfaVersion=Number((await db.query('SELECT version FROM auth_factors WHERE subject=$1',[subject])).rows[0]?.version||0);
 }finally{await db.end();}
 assert(user,'No eligible account for read-only verification');
 const jwt=require(path.join(modules,'jsonwebtoken'));
 const token=jwt.sign({id:user.id,authVersion:Number(user.version),mfaVersion:Number(user.mfa_version)},env.JWT_SECRET,{expiresIn:'2m'});
 const adminToken=jwt.sign({sub:'admin',role:'admin',adminVersion,mfaVersion},env.JWT_SECRET,{expiresIn:'2m'});
 const routes=[],base='http://127.0.0.1:3000';
 for(const route of ['/api/health/ready','/api/me','/api/subscription/plans','/api/subscription/overview','/api/mt5/accounts','/api/sandbox/status','/api/chat/unread-count','/api/admin/subscription-plans']){
  const response=await fetch(base+route,{headers:{Authorization:'Bearer '+(route.includes('/admin/')?adminToken:token)},signal:AbortSignal.timeout(10000)});assert.equal(response.status,200,'Smoke failed '+route);const data=await response.json();
  if(route==='/api/subscription/plans'){assert(Array.isArray(data.plans));assert(Object.hasOwn(data,'promotionClaim'));assert(data.plans.every(p=>typeof p.isPromotion==='boolean'&&typeof p.promotionClaimed==='boolean'));}
  if(route==='/api/admin/subscription-plans')assert(data.plans.every(p=>Object.hasOwn(p,'is_promotion')&&Object.hasOwn(p,'promotion_claim_count')));
  routes.push({route,status:response.status});
 }
 const downloads=await fetch(base+'/api/subscription/downloads',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)}),downloadData=await downloads.json();
 assert.equal(downloads.status,downloadAccess.active?200:403,'Unexpected protected download eligibility');
 if(downloadAccess.active){assert.equal(downloadData.canDownload,downloadAccess.allowed);if(!downloadAccess.allowed){assert.deepEqual(downloadData.versions,[]);assert.equal(downloadData.reason,'promotion');}}
 if(!downloadAccess.allowed){const direct=await fetch(base+'/api/subscription/download/2147483647',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});assert.equal(direct.status,403,'Direct protected download allowed');assert.equal((await direct.json()).code,'EA_DOWNLOAD_NOT_INCLUDED');}
 routes.push({route:'/api/subscription/downloads',status:downloads.status,downloadAllowed:downloadAccess.allowed});
 for(const route of ['/api/subscription/plans','/api/admin/subscription-plans','/api/subscription/promotions/claim']){
  const response=await fetch(base+route,{method:route.endsWith('/claim')?'POST':'GET',signal:AbortSignal.timeout(10000)});assert.equal(response.status,401,'Unauthenticated route allowed');
 }
 assert.equal((await fetch(base+'/api/admin/subscription-plans',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)})).status,403);
 return {phase:'verified',database,routes,unauthorizedRequestsRejected:true,productionClaimsCreated:0,productionOffersCreated:0,productionPaymentsAttempted:0};
}
async function publicSmoke(){
 const checks=[];
 for(const origin of ['http://127.0.0.1:8080','https://corngrid.com'])for(const name of ['admin.css','admin.js','admin.html','dashboard.js','dashboard.html']){
  const local=contained(backend,'public/'+name),response=await fetch(origin+'/'+name+'?v='+hash(local).slice(0,16),{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,'Public asset missing '+name);const bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),hash(local),'Stale public asset '+name);checks.push({origin,name,status:response.status});
 }
 return {phase:'public-smoke-passed',checks};
}
async function rollback(value){
 const plan=loadPlan(value);
 for(const item of [...plan.appliedFiles].reverse()){const to=contained(target,item.name);if(item.exists)fs.copyFileSync(contained(path.join(plan.backup,'files'),item.name),to);else if(fs.existsSync(to))fs.unlinkSync(to);}
 assert.equal(hash(path.join(backend,'.env')),plan.envHash);
 return {phase:'rolled-back',promotionTablesAndClaimHistoryPreserved:true};
}
const [mode='inspect',backup]=process.argv.slice(2),operations={inspect,prepare,apply,verify,public:publicSmoke,rollback};
Promise.resolve().then(()=>{assert(operations[mode],'Unknown operation');return operations[mode](backup);}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({phase:'failed',type:error.code||error.name,reason:error instanceof assert.AssertionError?error.message:'Deployment operation failed; inspect private state.'}));process.exitCode=1;});
