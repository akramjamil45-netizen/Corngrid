'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const files=[
 'Corngrid-web/account-archive.js','Corngrid-web/account-deletion.js','Corngrid-web/server.js',
 'Corngrid-web/public/account-requests.js','Corngrid-web/public/account-requests.css',
 'Corngrid-web/public/dashboard.html','Corngrid-web/public/dashboard.js','Corngrid-web/public/admin.html','Corngrid-web/public/admin.js',
 'Corngrid-web/migrations/postgres/0017_account_deletion_requests.sql','Corngrid-web/migrations/sqlite/0017_account_deletion_requests.sql','Corngrid-web/migrations/rollback/0017_account_deletion_requests.sql',
 'Corngrid-web/docs/ACCOUNT_DELETION_REQUESTS.md','Corngrid-web/docs/ACCOUNT_ARCHIVE.md','web.config','web.config.xml','sw.js'
];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function inside(root,file){const resolved=path.resolve(root,file),relative=path.relative(root,resolved);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));return resolved;}
async function main(){
 for(const file of files)assert.ok(fs.existsSync(inside(source,file)),file);
 const modules=path.join(source,'Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env'))),{Client}=require(path.join(modules,'pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  if(process.argv.includes('--verify')){
   for(const file of files)assert.equal(hash(fs.readFileSync(inside(source,file))),hash(fs.readFileSync(inside(target,file))),file);
   const jwt=require(path.join(modules,'jsonwebtoken')),adminVersion=hash(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`),adminToken=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
   const get=async(route,token,base='http://127.0.0.1:3000')=>{const response=await fetch(base+route,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(20000)});return {status:response.status,data:await response.json()};};
   assert.equal((await get('/api/health/ready')).status,200);
   assert.equal((await get('/api/user/account-deletion-request')).status,401);
   assert.equal((await get('/api/admin/account-deletion-requests')).status,401);
   const admin=await get('/api/admin/account-deletion-requests',adminToken);assert.equal(admin.status,200);
   const user=(await db.query('SELECT u.id,COALESCE(v.version,0) AS auth_version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN account_archives a ON a.user_id=u.id WHERE a.user_id IS NULL AND u.email_verified=TRUE ORDER BY u.id LIMIT 1')).rows[0];assert.ok(user);
   const token=jwt.sign({id:user.id,authVersion:Number(user.auth_version)},env.JWT_SECRET,{expiresIn:'2m'});
   assert.equal((await get('/api/user/account-deletion-request',token)).status,200);
   assert.equal((await get('/api/admin/account-deletion-requests',token)).status,403);
   for(const route of ['/api/sandbox/status','/api/subscription/overview','/api/mt5/accounts'])assert.equal((await get(route,token)).status,200,route);
   const base='https://corngrid.com';
   for(const name of ['account-requests.js','account-requests.css','dashboard.js','admin.js']){const response=await fetch(base+'/'+name+'?v=20261113-account-requests1',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,name);assert.equal(hash(await response.text()),hash(fs.readFileSync(path.join(target,'Corngrid-web/public',name),'utf8')),name);}
   for(const name of ['admin.html','dashboard.html']){const response=await fetch(base+'/'+name,{signal:AbortSignal.timeout(20000)}),page=await response.text();assert.equal(response.status,200);assert.ok(page.includes('account-requests.js')&&page.includes('20261113-account-requests1'),name);}
   assert.equal((await get('/api/user/account-deletion-request',null,base)).status,401);
   assert.equal((await get('/api/admin/account-deletion-requests',adminToken,base)).status,200);
   const migrationTables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('account_deletion_requests','account_deletion_request_events') ORDER BY table_name")).rows.map(row=>row.table_name);assert.equal(migrationTables.length,2);
   const sandboxes=(await db.query('SELECT status,COUNT(*)::integer AS count FROM sandbox_instances WHERE deleted_at IS NULL GROUP BY status')).rows;
   console.log(JSON.stringify({verified:true,matchingFiles:files.length,readiness:200,requestApisAvailable:true,anonymousAndRoleRestrictions:true,existingSandboxSubscriptionMt5Apis:true,publicAssetsCurrent:true,migrationTables,pendingRequests:admin.data.pendingCount,productionTestRequestsCreated:0,productionAccountsArchived:0,hostingAgentsRestarted:false,sandboxes}));return;
  }
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-account-requests-before-'));
  for(const file of files){const existing=inside(target,file);if(fs.existsSync(existing)){const saved=inside(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(existing,saved);}}
  await db.query('BEGIN');
  try{await db.query("SET LOCAL lock_timeout='10s'");await db.query(fs.readFileSync(inside(source,'Corngrid-web/migrations/postgres/0017_account_deletion_requests.sql'),'utf8'));await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}
  for(const file of files){const destination=inside(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(inside(source,file),destination);assert.equal(hash(fs.readFileSync(inside(source,file))),hash(fs.readFileSync(destination)),file);}
  const result={backup,files:files.length,migration:'0017_account_deletion_requests',websiteRestartRequired:true,productionAccountsArchived:0,hostingAgentsRestarted:false,deployedAt:new Date().toISOString()};fs.writeFileSync(path.join(__dirname,'account-deletion-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Account request deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
