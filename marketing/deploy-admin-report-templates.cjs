'use strict';
// Admin templates rollout: only existing website files; database checks are read-only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const previous={
  "Corngrid-web/reports/report-service.js": "d3905acbc2619770bb0c61ee3f5d049cf6663e8bd1dc5f519a294072983aa44c",
  "Corngrid-web/public/report-renderer.js": "bc6491a525ed1d55d8f22c878078238c9f02d1813e2f6bfb8a32da7bfde63eeb",
  "Corngrid-web/public/report-studio.js": "599152659c58e6d0605d33bb805c8d9f874540535f3f6e8fd84b1e4ba1136fef",
  "Corngrid-web/public/report-studio.css": "42423a208ff776bb0296f2c7ff678fcb6b714536f5f061822ac63ac6081116d3",
  "Corngrid-web/public/admin.html": "70ac6f115b24616d36a797d2c9354feed695669dfa18d66e3a84606cf71ebe2f",
  "Corngrid-web/public/dashboard.html": "553bf3ca758e2ff20e9d74307c78c9801dcfcb3ff18c3d06874f010a4cd0724e",
  "Corngrid-web/docs/REPORT-STUDIO.md": "bfdb92365384c1e795045b30e8999cb006e57f9242ad3209f1ff2eabbcedecae"
};
const files=Object.keys(previous),manifest=path.join(__dirname,'admin-report-templates-deployment-result.json');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function bounded(root,file){const result=path.resolve(root,file);assert.ok(!path.relative(root,result).startsWith('..')&&!path.isAbsolute(path.relative(root,result)));return result;}
async function main(){
 if(process.argv.includes('--rollback')){
  const saved=JSON.parse(fs.readFileSync(manifest,'utf8'));assert.ok(path.resolve(saved.backup).startsWith(path.resolve(os.tmpdir())+path.sep));
  for(const file of files)fs.copyFileSync(bounded(saved.backup,file),bounded(target,file));
  console.log(JSON.stringify({restored:files.length,websiteRestartRequired:true,databaseModified:false}));return;
 }
 const env=require(path.join(source,'Corngrid-web/node_modules/dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env')));
 const db=require(path.join(source,'Corngrid-web/db-postgres'))(env.DATABASE_URL);
 const {dbRun}=require(path.join(source,'Corngrid-web/db-async'));
 const service=require(path.join(source,'Corngrid-web/reports/report-service')).createReportService(db);
 const types=['growth','sandbox','funds','performance','subscription','milestone','blank'];
 try{
  await db.transaction(async()=>{
   await dbRun(db,'SET TRANSACTION READ ONLY');
   const admin=await service.options('admin'),user=await service.options('user',1);
   assert.deepEqual(admin.types.map(t=>t.value),types);assert.deepEqual(user.types.map(t=>t.value),['account','sandbox']);
   for(const type of types){
    const report=await service.generate('admin',undefined,{type,period:'weekly',timezone:'Asia/Kuala_Lumpur'});
    assert.equal(report.scope,'admin');assert.equal(report.metrics.length,type==='blank'?0:6);assert.equal(report.mode,type==='blank'?'manual':'production');
   }
  });
 }finally{await new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve()));}
 if(process.argv.includes('--verify')){
  for(const file of files)assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
  const jwt=require(path.join(source,'Corngrid-web/node_modules/jsonwebtoken'));
  const adminVersion=hash(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim());
  const token=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
  for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
   const read=async(route,authenticated=true)=>fetch(origin+route,{headers:authenticated?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(20000)});
   assert.equal((await read('/api/admin/reports',false)).status,401);
   assert.equal((await read('/api/reports')).status,403);
   const options=await read('/api/admin/reports/options');assert.equal(options.status,200);assert.deepEqual((await options.json()).types.map(t=>t.value),types);
   for(const type of ['subscription','milestone','blank']){const response=await read('/api/admin/reports?type='+type);assert.equal(response.status,200);assert.equal((await response.json()).type,type);}
   for(const asset of ['admin.html','dashboard.html','report-studio.css','report-studio.js','report-renderer.js']){
    const response=await read('/'+asset+'?v=20261114-5',false);assert.equal(response.status,200,asset);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(bounded(source,'Corngrid-web/public/'+asset))),asset);
   }
   assert.equal((await read('/api/health/ready',false)).status,200);
  }
  console.log(JSON.stringify({verified:true,templates:types,files:files.length,postgresReadOnly:true,adminOnly:true,userChoicesUnchanged:true,publicAssetsCurrent:true,productionPostsCreated:0}));return;
 }
 for(const file of files){const live=hash(fs.readFileSync(bounded(target,file)));assert.ok(live===previous[file]||live===hash(fs.readFileSync(bounded(source,file))),'Unrelated live change: '+file);}
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,templates:types,postgresReadOnly:true,files:files.length,migrationRequired:false}));return;}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-admin-templates-before-'));
 for(const file of files){const saved=bounded(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(bounded(target,file),saved);}
 fs.writeFileSync(manifest,JSON.stringify({backup,files,deployedAt:new Date().toISOString(),databaseModified:false,migrationRequired:false},null,2));
 try{for(const file of files)fs.copyFileSync(bounded(source,file),bounded(target,file));}
 catch(error){for(const file of files)fs.copyFileSync(bounded(backup,file),bounded(target,file));throw error;}
 console.log(JSON.stringify({deployed:true,files:files.length,backup,websiteRestartRequired:true,hostingAgentsRestarted:false,databaseModified:false}));
}
main().catch(error=>{console.error('Admin templates rollout failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
