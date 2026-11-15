'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const files=['Corngrid-web/announcement-images.js','Corngrid-web/feed-api.js','Corngrid-web/public/admin.js','Corngrid-web/public/admin.html','Corngrid-web/public/admin.css','Corngrid-web/docs/ANNOUNCEMENTS.md','sw.js'];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
async function main(){
 const modules=path.join(source,'Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env'))),{Client}=require(path.join(modules,'pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  await db.query('SELECT image_path FROM feed_posts LIMIT 0');require(path.join(target,'Corngrid-web/node_modules/sharp'));
  if(process.argv.includes('--verify')){
   for(const file of files)assert.equal(hash(fs.readFileSync(path.join(source,file))),hash(fs.readFileSync(path.join(target,file))),file);
   const jwt=require(path.join(modules,'jsonwebtoken')),adminVersion=hash(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`),token=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
   const get=async(route,auth)=>{const response=await fetch('http://127.0.0.1:3000'+route,{headers:auth?{Authorization:'Bearer '+auth}:{},signal:AbortSignal.timeout(15000)});return {status:response.status,data:await response.json()};};
   assert.equal((await get('/api/feed/announcements',token)).status,200);
   const rejected=await fetch('http://127.0.0.1:3000/api/feed/announcements/uploads',{method:'POST',signal:AbortSignal.timeout(10000)});assert.equal(rejected.status,401);
   const publicRejected=await fetch('https://corngrid.com/api/feed/announcements/uploads',{method:'POST',signal:AbortSignal.timeout(15000)});assert.equal(publicRejected.status,401,'Public proxy forwards the admin upload route');
   const page=await(await fetch('https://corngrid.com/admin.html',{signal:AbortSignal.timeout(20000)})).text();assert.ok(page.includes('admin-ann-image-pick')&&page.includes('20261113-announcement-image1'));
   for(const name of ['admin.js','admin.css']){const response=await fetch('https://corngrid.com/'+name+'?v=20261113-announcement-image1',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);assert.equal(hash(await response.text()),hash(fs.readFileSync(path.join(target,'Corngrid-web/public',name),'utf8')),name);}
   assert.equal((await get('/api/health/ready')).status,200);
   console.log(JSON.stringify({verified:true,matchingFiles:files.length,adminListAvailable:true,anonymousUploadRejected:true,publicAssetsCurrent:true,readiness:200,migrationRequired:false,productionAnnouncementsCreated:0,hostingAgentsRestarted:false}));return;
  }
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-announcement-images-before-'));
  for(const file of files){assert.ok(!path.relative(source,path.resolve(source,file)).startsWith('..'));assert.ok(!path.relative(target,path.resolve(target,file)).startsWith('..'));assert.ok(fs.existsSync(path.join(source,file)),file);const old=path.join(target,file);if(fs.existsSync(old)){const saved=path.join(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(old,saved);}}
  for(const file of files){const destination=path.join(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(source,file),destination);assert.equal(hash(fs.readFileSync(path.join(source,file))),hash(fs.readFileSync(destination)),file);}
  const result={backup,files:files.length,migrationRequired:false,websiteRestartRequired:true,hostingAgentsRestarted:false,deployedAt:new Date().toISOString()};fs.writeFileSync(path.join(__dirname,'announcement-images-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Announcement image deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
