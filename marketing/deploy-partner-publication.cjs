'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const files=[
 'Corngrid-web/marketplace/schema.js','Corngrid-web/partner/publication.js','Corngrid-web/sandbox/strategy-artifact.js','Corngrid-web/agent/source-compiler.js',
 'Corngrid-web/partner/index.js','Corngrid-web/partner/partner-api.js','Corngrid-web/partner/partner-admin-api.js','Corngrid-web/marketplace/index.js',
 'Corngrid-web/sandbox/index.js','Corngrid-web/sandbox/sandbox-api.js','Corngrid-web/sandbox/sandbox-manager.js','Corngrid-web/sandbox/sandbox-node-api.js',
 'Corngrid-web/agent/ea-tester.js','Corngrid-web/agent/transport.js','Corngrid-web/server.js',
 'Corngrid-web/public/dashboard.html','Corngrid-web/public/admin.html','Corngrid-web/public/partner.js','Corngrid-web/public/admin-sandbox.js','Corngrid-web/public/marketplace-ui.js','Corngrid-web/public/marketplace.css',
 'Corngrid-web/migrations/postgres/0016_partner_publication.sql','Corngrid-web/migrations/sqlite/0016_partner_publication.sql','Corngrid-web/migrations/rollback/0016_partner_publication.sql',
 'Corngrid-web/docs/PARTNER_PUBLICATION.md','Corngrid-web/docs/MARKETPLACE.md','sw.js'
];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
async function main(){
 const backend=path.join(source,'Corngrid-web'),modules=path.join(backend,'node_modules');
 const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env')));
 const {Client}=require(path.join(modules,'pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  const snapshots=async()=>({marketplaceEnabled:(await db.query('SELECT marketplace_enabled FROM marketplace_settings WHERE id=1')).rows[0].marketplace_enabled,sandboxes:(await db.query('SELECT instance_uid,status,strategy_id,updated_at FROM sandbox_instances WHERE deleted_at IS NULL ORDER BY id')).rows});
  if(process.argv.includes('--inspect')){console.log(JSON.stringify({migrationPresent:Boolean((await db.query("SELECT to_regclass('ea_submission_links') AS table_name")).rows[0].table_name),changedFiles:files.filter(file=>!fs.existsSync(path.join(target,file))||hash(fs.readFileSync(path.join(source,file)))!==hash(fs.readFileSync(path.join(target,file)))),...(await snapshots())}));return;}
  if(process.argv.includes('--verify')){
   const jwt=require(path.join(modules,'jsonwebtoken')),adminVersion=hash(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`),adminToken=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
   const get=async(route,token)=>{const response=await fetch('http://127.0.0.1:3000'+route,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(15000)});return {status:response.status,data:await response.json()};};
   const settings=await get('/api/admin/marketplace/settings',adminToken);assert.equal(settings.status,200);
   const listings=await get('/api/admin/marketplace/eas',adminToken);assert.equal(listings.status,200);
   assert.equal((await get('/api/admin/ea-submissions',adminToken)).status,200);
   for(const item of listings.data.listings)assert.equal((await get('/api/admin/marketplace/eas/'+item.id,adminToken)).status,200);
   const user=(await db.query('SELECT u.id,COALESCE(v.version,0) AS auth_version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN account_archives a ON a.user_id=u.id WHERE a.user_id IS NULL ORDER BY u.id LIMIT 1')).rows[0];assert.ok(user);
   const token=jwt.sign({id:user.id,authVersion:Number(user.auth_version)},env.JWT_SECRET,{expiresIn:'2m'});
   for(const route of ['/api/sandbox/status','/api/sandbox/strategies','/api/subscription/overview','/api/mt5/accounts'])assert.equal((await get(route,token)).status,200,route);
   assert.equal((await get('/api/admin/ea-submissions',token)).status,403);
   assert.equal((await get('/api/marketplace/settings')).status,401);
   if(!settings.data.settings.marketplace_enabled)assert.equal((await get('/api/marketplace/eas',token)).status,403);
   const adapter=require(path.join(target,'Corngrid-web/db-postgres'))(env.DATABASE_URL);
   try{const publication=require(path.join(target,'Corngrid-web/partner/publication')).createPartnerPublication({db:adapter,storageDir:path.join(target,'Corngrid-web/storage/ea-submissions')});await publication.ready;assert.equal(publication.strategyRoot,path.join(target,'Corngrid-web/storage'));}finally{await new Promise(resolve=>adapter.close(resolve));}
   const base='https://corngrid.com';
   for(const name of ['marketplace-ui.js','marketplace.css','partner.js','admin-sandbox.js']){const response=await fetch(base+'/'+name+'?v=20261112-partner-release1',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,name);assert.equal(hash(await response.text()),hash(fs.readFileSync(path.join(target,'Corngrid-web/public',name),'utf8')),name);}
   assert.equal((await get('/api/health/ready')).status,200);
   console.log(JSON.stringify({verified:true,adminReviewAvailable:true,privateAnonymousAndRoleChecks:true,existingSandboxSubscriptionMt5Apis:true,artifactStorageMatchesSandbox:true,publicAssetsCurrent:true,migrationTables:(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('ea_submission_links','ea_submission_artifacts','ea_release_approvals') ORDER BY table_name")).rows.map(r=>r.table_name),...(await snapshots())}));return;
  }
  for(const file of files){assert.ok(!path.relative(source,path.resolve(source,file)).startsWith('..'));assert.ok(!path.relative(target,path.resolve(target,file)).startsWith('..'));assert.ok(fs.existsSync(path.join(source,file)),file);}
  const before=await snapshots(),backup=path.join(os.tmpdir(),'CornGrid-partner-publication-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
  for(const file of files){const existing=path.join(target,file);if(fs.existsSync(existing)){const saved=path.join(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(existing,saved);}}
  await db.query('BEGIN');
  try{await db.query("SET LOCAL lock_timeout='10s'");await db.query(fs.readFileSync(path.join(source,'Corngrid-web/migrations/postgres/0016_partner_publication.sql'),'utf8'));await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}
  for(const file of files){const destination=path.join(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(source,file),destination);assert.equal(hash(fs.readFileSync(path.join(source,file))),hash(fs.readFileSync(destination)),file);}
  const after=await snapshots();assert.equal(after.marketplaceEnabled,before.marketplaceEnabled);
  const result={backup,files:files.length,migration:'0016_partner_publication',marketplaceEnabled:after.marketplaceEnabled,hostingAgentsRestarted:false,restartWebsiteRequired:true,deployedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(__dirname,'partner-publication-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Partner publication deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
