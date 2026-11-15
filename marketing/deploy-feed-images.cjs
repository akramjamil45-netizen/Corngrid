'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const uiOnly=process.argv.includes('--ui-only');
const files=uiOnly?['Corngrid-web/public/dashboard.html','Corngrid-web/public/dashboard.css','Corngrid-web/docs/FEED_IMAGES.md','sw.js']:['Corngrid-web/feed-api.js','Corngrid-web/feed-images.js','Corngrid-web/announcement-images.js','Corngrid-web/server.js','Corngrid-web/public/feed.js','Corngrid-web/public/dashboard.html','Corngrid-web/public/dashboard.css','Corngrid-web/migrations/postgres/0018_feed_images.sql','Corngrid-web/migrations/sqlite/0018_feed_images.sql','Corngrid-web/docs/FEED_IMAGES.md','sw.js'];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function inside(root,file){const absolute=path.resolve(root,file),relative=path.relative(root,absolute);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));return absolute;}
async function main(){
 for(const file of files)assert.ok(fs.existsSync(inside(source,file)),file);
 const modules=path.join(source,'Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env'))),{Client}=require(path.join(modules,'pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  if(process.argv.includes('--verify')){
   for(const file of files)assert.equal(hash(fs.readFileSync(inside(source,file))),hash(fs.readFileSync(inside(target,file))),file);
   const jwt=require(path.join(modules,'jsonwebtoken')),adminVersion=hash(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`),adminToken=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
   const get=async(route,token,base='http://127.0.0.1:3000')=>{const response=await fetch(base+route,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(20000)});return {status:response.status,data:await response.json()};};
   assert.equal((await get('/api/health/ready')).status,200);assert.equal((await get('/api/feed')).status,401);
   const user=(await db.query('SELECT u.id,COALESCE(v.version,0) AS auth_version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN account_archives a ON a.user_id=u.id WHERE a.user_id IS NULL AND u.email_verified=TRUE ORDER BY u.id LIMIT 1')).rows[0];assert.ok(user);
   const token=jwt.sign({id:user.id,authVersion:Number(user.auth_version)},env.JWT_SECRET,{expiresIn:'2m'}),feed=await get('/api/feed',token);assert.equal(feed.status,200);
   for(const post of feed.data.posts){assert.ok(Array.isArray(post.imagePaths)&&post.imagePaths.length<=5);assert.equal(post.imagePath,post.imagePaths[0]||null);}
   assert.equal((await get('/api/feed/announcements',adminToken)).status,200);
   assert.equal((await get('/api/admin/account-deletion-requests',adminToken)).status,200);
   for(const route of ['/api/sandbox/status','/api/subscription/overview','/api/mt5/accounts'])assert.equal((await get(route,token)).status,200,route);
   const base='https://corngrid.com',assetVersion=fs.readFileSync(inside(source,'Corngrid-web/public/dashboard.html'),'utf8').match(/dashboard\.css\?v=([^" ]+)/)[1];
   for(const name of ['feed.js','dashboard.css']){const response=await fetch(base+'/'+name+'?v='+assetVersion,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);assert.equal(hash(await response.text()),hash(fs.readFileSync(path.join(target,'Corngrid-web/public',name),'utf8')),name);}
   const response=await fetch(base+'/dashboard.html',{signal:AbortSignal.timeout(20000)}),page=await response.text();assert.equal(response.status,200);assert.ok(page.includes(assetVersion)&&page.includes('feed-composer-images')&&page.includes('feed-lightbox-navigation'));
   assert.equal((await get('/api/feed',null,base)).status,401);assert.equal((await get('/api/feed',token,base)).status,200);
   const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('feed_post_images','feed_image_uploads') ORDER BY table_name")).rows.map(r=>r.table_name);assert.equal(tables.length,2);
   const sandboxes=(await db.query('SELECT status,COUNT(*)::integer AS count FROM sandbox_instances WHERE deleted_at IS NULL GROUP BY status')).rows;
   console.log(JSON.stringify({verified:true,matchingFiles:files.length,migrationTables:tables,readiness:200,feedImageArraysAvailable:true,existingAnnouncementsAndAccountRequests:true,existingSandboxSubscriptionMt5Apis:true,publicAssetsCurrent:true,productionPostsCreated:0,hostingAgentsRestarted:false,sandboxes}));return;
  }
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-feed-gallery-before-'));
  for(const file of files){const existing=inside(target,file);if(fs.existsSync(existing)){const saved=inside(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(existing,saved);}}
  if(!uiOnly){await db.query('BEGIN');try{await db.query("SET LOCAL lock_timeout='10s'");await db.query(fs.readFileSync(inside(source,'Corngrid-web/migrations/postgres/0018_feed_images.sql'),'utf8'));await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}}
  for(const file of files){const destination=inside(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(inside(source,file),destination);assert.equal(hash(fs.readFileSync(inside(source,file))),hash(fs.readFileSync(destination)),file);}
  const result={backup,files:files.length,migration:uiOnly?null:'0018_feed_images',websiteRestartRequired:!uiOnly,existingPostsUnchanged:true,hostingAgentsRestarted:false,deployedAt:new Date().toISOString()};fs.writeFileSync(path.join(__dirname,'feed-images-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Feed gallery deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
