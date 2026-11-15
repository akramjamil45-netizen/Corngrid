'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const files=[
 'Corngrid-web/server.js','Corngrid-web/package.json','Corngrid-web/package-lock.json',
 'Corngrid-web/marketplace/index.js','Corngrid-web/marketplace/validation.js','Corngrid-web/marketplace/media.js',
 'Corngrid-web/public/marketplace-ui.js','Corngrid-web/public/marketplace.js','Corngrid-web/public/marketplace.css','Corngrid-web/public/admin-marketplace.js',
 'Corngrid-web/public/dashboard.html','Corngrid-web/public/dashboard.js','Corngrid-web/public/admin.html','Corngrid-web/public/admin.js','Corngrid-web/public/sandbox.js',
 'Corngrid-web/migrations/postgres/0015_marketplace.sql','Corngrid-web/migrations/sqlite/0015_marketplace.sql','Corngrid-web/migrations/rollback/0015_marketplace.sql',
 'Corngrid-web/docs/MARKETPLACE.md','web.config','web.config.xml','sw.js'
];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(){
 const modules=path.join(source,'Corngrid-web/node_modules');
 const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env')));
 const {Client}=require(path.join(modules,'pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  if(process.argv.includes('--verify')){
   const jwt=require(path.join(modules,'jsonwebtoken'));
   const adminVersion=hash(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`);
   const adminToken=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
   const get=async(route,token)=>{const response=await fetch('http://127.0.0.1:3000'+route,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(15000)});return {status:response.status,data:await response.json()};};
   const config=await get('/api/admin/marketplace/settings',adminToken);assert.equal(config.status,200);
   const listings=await get('/api/admin/marketplace/eas',adminToken);assert.equal(listings.status,200);assert.ok(listings.data.listings.some(row=>row.id==='corngrid-official'));
   const user=(await db.query('SELECT u.id,COALESCE(v.version,0) AS auth_version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN account_archives a ON a.user_id=u.id WHERE a.user_id IS NULL ORDER BY u.id LIMIT 1')).rows[0];assert.ok(user);
   const userToken=jwt.sign({id:user.id,authVersion:Number(user.auth_version)},env.JWT_SECRET,{expiresIn:'2m'});
   assert.equal((await get('/api/marketplace/settings')).status,401);
   assert.equal((await get('/api/admin/marketplace/settings',userToken)).status,403);
   if(!config.data.settings.marketplace_enabled){assert.equal((await get('/api/marketplace/eas',userToken)).status,403);assert.equal((await get('/api/partner/marketplace/eas',userToken)).status,403);}
   assert.equal((await get('/api/sandbox/status',userToken)).status,200);assert.equal((await get('/api/subscription/overview',userToken)).status,200);
   assert.equal((await get('/api/mt5/accounts',userToken)).status,200);
   const base='https://corngrid.com';
   for(const asset of ['marketplace.css','marketplace-ui.js','marketplace.js','admin-marketplace.js']){const response=await fetch(`${base}/${asset}?v=20261112-marketplace1`,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,asset);assert.ok((await response.text()).length>100);}
   const dashboard=await(await fetch(base+'/dashboard.html',{signal:AbortSignal.timeout(20000)})).text();assert.ok(dashboard.includes('marketplace-root')&&dashboard.includes('marketplace-ui.js?v=20261112-marketplace1'));
   const adminPage=await(await fetch(base+'/admin.html',{signal:AbortSignal.timeout(20000)})).text();assert.ok(adminPage.includes('admin-marketplace-root'));
   assert.equal((await get('/api/health/ready')).status,200);
   const running=(await db.query('SELECT status,COUNT(*) AS count FROM sandbox_instances WHERE deleted_at IS NULL GROUP BY status')).rows;
   console.log(JSON.stringify({verified:true,adminManagement:true,marketplaceEnabled:config.data.settings.marketplace_enabled,regularAdminAccessRejected:true,anonymousRejected:true,existingSandboxSubscriptionAndMt5Apis:true,publicAssets:true,readiness:200,sandboxes:running}));return;
  }
  for(const file of files)assert.ok(fs.existsSync(path.join(source,file)),'Source file missing: '+file);
  require(path.join(target,'Corngrid-web/node_modules/sharp'));require(path.join(target,'Corngrid-web/node_modules/sqlite3'));
  const backup=path.join(os.tmpdir(),'CornGrid-marketplace-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
  for(const file of files){const old=path.join(target,file);if(!fs.existsSync(old))continue;const saved=path.join(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(old,saved);}
  await db.query('BEGIN');
  try{
   await db.query("SET LOCAL lock_timeout='10s'");
   await db.query(fs.readFileSync(path.join(source,'Corngrid-web/migrations/postgres/0015_marketplace.sql'),'utf8'));
   await db.query('SELECT marketplace_enabled FROM marketplace_settings WHERE id=1');
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
  for(const file of files){const from=path.join(source,file),to=path.join(target,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);assert.equal(hash(fs.readFileSync(from)),hash(fs.readFileSync(to)),file);}
  const result={backup,files:files.length,migration:'0015_marketplace',restartRequired:true,initialAccess:'OFF for first installation',deployedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(__dirname,'marketplace-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Marketplace deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
