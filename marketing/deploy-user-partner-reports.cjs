'use strict';
// Scoped user/partner Report Studio rollout; existing ledger reads only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const previous={
  "Corngrid-web/public/admin.html": "910f20f59850906de9d835f221f9643361f247d85e25c73479887b72ab31a3ac",
  "Corngrid-web/public/dashboard.html": "7c1abbccf1c3bb18c21b577c77715dec0135836702b19ca153aace0f71220729",
  "Corngrid-web/public/report-studio.js": "ec13c967a95173c8795954a30feb812b1553138b2b1bcd158a9515f3f5c13ff5",
  "Corngrid-web/reports/report-service.js": "b6fb52165e609540651dd12bd60fca31602da1704d3836e600f79bcb14f025e9",
  "Corngrid-web/public/report-renderer.js": "4c1ad97747b75603691d5ba06ad94d6f03f8b7d6f82cc47070da705d6014d12c",
  "Corngrid-web/docs/REPORT-STUDIO.md": "f29e10d67d70916cb4db0392b55dc945fb4c587d232356e1c2f8a7b5e80e7146"
};
const files=Object.keys(previous),manifest=path.join(__dirname,'user-partner-reports-deployment-result.json');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function bounded(root,file){const result=path.resolve(root,file),relative=path.relative(root,result);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));return result;}
async function main(){
 if(process.argv.includes('--rollback')){
  const saved=JSON.parse(fs.readFileSync(manifest,'utf8'));
  assert.ok(path.resolve(saved.backup).startsWith(path.resolve(os.tmpdir())+path.sep));
  for(const file of files){assert.equal(hash(fs.readFileSync(bounded(saved.backup,file))),saved.previous[file]);}
  for(const file of files)fs.copyFileSync(bounded(saved.backup,file),bounded(target,file));
  console.log(JSON.stringify({restored:files.length,databaseModified:false,websiteRestartRequired:true}));return;
 }
 const env=require(path.join(source,'Corngrid-web/node_modules/dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env')));
 const db=require(path.join(source,'Corngrid-web/db-postgres'))(env.DATABASE_URL);
 const {dbRun,dbGet,dbAll}=require(path.join(source,'Corngrid-web/db-async'));
 const service=require(path.join(source,'Corngrid-web/reports/report-service')).createReportService(db);
 const adminTypes=['growth','sandbox','funds','performance','subscription','milestone','blank'];
 let activeUser=null,ordinaryUser=null;
 try{
  await db.transaction(async()=>{
   await dbRun(db,'SET TRANSACTION READ ONLY');
   const eligible="u.email_verified = TRUE AND NOT EXISTS (SELECT 1 FROM account_archives ar WHERE ar.user_id=u.id) AND NOT EXISTS (SELECT 1 FROM user_account_access ac WHERE ac.user_id=u.id AND ac.suspended_until > ?)";
   activeUser=await dbGet(db,"SELECT u.id,COALESCE(v.version,0) AS version FROM users u JOIN partner_profiles p ON p.user_id=u.id LEFT JOIN user_auth_versions v ON v.user_id=u.id WHERE p.status='active' AND "+eligible+" ORDER BY u.id LIMIT 1",[Date.now()]);
   ordinaryUser=await dbGet(db,"SELECT u.id,COALESCE(v.version,0) AS version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id WHERE "+eligible+" AND NOT EXISTS (SELECT 1 FROM partner_profiles p WHERE p.user_id=u.id AND p.status='active') ORDER BY u.id LIMIT 1",[Date.now()]);
   assert.deepEqual((await service.options('admin')).types.map(t=>t.value),adminTypes);
   const partners=await dbAll(db,"SELECT p.user_id FROM partner_profiles p WHERE p.status='active' AND NOT EXISTS(SELECT 1 FROM account_archives ar WHERE ar.user_id=p.user_id) ORDER BY p.user_id LIMIT 5");
   for(const p of partners){
    const opts=await service.options('user',p.user_id);
    assert.deepEqual(opts.types.map(t=>t.value),['account','sandbox','partner']);
    for(const period of ['daily','weekly','monthly','yearly']){
     const report=await service.generate('user',p.user_id,{type:'partner',period,timezone:'Asia/Kuala_Lumpur',currency:opts.partnerCurrencies[0]});
     assert.equal(report.scope,'user');assert.equal(report.metrics.length,6);assert.equal(report.selectedAccountId,null);
    }
   }
   if(ordinaryUser){
    assert.deepEqual((await service.options('user',ordinaryUser.id)).types.map(t=>t.value),['account','sandbox']);
    await assert.rejects(service.generate('user',ordinaryUser.id,{type:'partner'}),{status:403});
   }
  });
 }finally{await new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve()));}
 if(process.argv.includes('--verify')){
  for(const file of files)assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
  const jwt=require(path.join(source,'Corngrid-web/node_modules/jsonwebtoken'));
  const adminVersion=hash(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim());
  const admin=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
  const sign=user=>user?jwt.sign({id:Number(user.id),authVersion:Number(user.version)},env.JWT_SECRET,{expiresIn:'2m'}):null;
  const active=sign(activeUser),ordinary=sign(ordinaryUser);
  for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
   const read=(route,token)=>fetch(origin+route,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(20000)});
   assert.equal((await read('/api/reports')).status,401);
   assert.equal((await read('/api/reports',admin)).status,403);
   const adminOpts=await read('/api/admin/reports/options',admin);assert.equal(adminOpts.status,200);assert.deepEqual((await adminOpts.json()).types.map(t=>t.value),adminTypes);
   for(const [token,partner] of [[active,true],[ordinary,false]]){
    if(!token)continue;
    const opts=await read('/api/reports/options',token);assert.equal(opts.status,200);assert.equal(opts.headers.get('cache-control'),'no-store');
    assert.deepEqual((await opts.json()).types.map(t=>t.value),partner?['account','sandbox','partner']:['account','sandbox']);
    for(const type of partner?['account','sandbox','partner']:['account','sandbox']){
     const response=await read('/api/reports?type='+type,token);assert.equal(response.status,200);const body=await response.json();assert.equal(body.type,type);assert.equal(body.scope,'user');
    }
    if(!partner)assert.equal((await read('/api/reports?type=partner',token)).status,403);
   }
   for(const file of files.filter(file=>file.startsWith('Corngrid-web/public/'))){
    const response=await read('/'+file.slice('Corngrid-web/public/'.length)+'?v=20261114-7');assert.equal(response.status,200,file);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(bounded(source,file))),file);
   }
   const logo=await read('/images/corngrid-report-logo.png?v=20261114-7');assert.equal(logo.status,200);assert.equal(hash(Buffer.from(await logo.arrayBuffer())),'7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0');
   assert.equal((await read('/api/health/ready')).status,200);
  }
  console.log(JSON.stringify({verified:true,files:files.length,postgresReadOnly:true,activePartnerLiveVerified:Boolean(activeUser),nonPartnerLiveVerified:Boolean(ordinaryUser),adminChoicesUnchanged:true,publicAssetsCurrent:true,productionPostsCreated:0}));return;
 }
 for(const file of files){const live=hash(fs.readFileSync(bounded(target,file)));assert.ok(live===previous[file]||live===hash(fs.readFileSync(bounded(source,file))),'Unrelated live change: '+file);}
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,files:files.length,postgresReadOnly:true,activePartnerChecked:Boolean(activeUser),migrationRequired:false}));return;}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-user-partner-before-')),savedHashes={};
 for(const file of files){const saved=bounded(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(bounded(target,file),saved);savedHashes[file]=hash(fs.readFileSync(saved));}
 fs.writeFileSync(manifest,JSON.stringify({backup,files,previous:savedHashes,deployedAt:new Date().toISOString(),databaseModified:false,migrationRequired:false},null,2));
 try{for(const file of files)fs.copyFileSync(bounded(source,file),bounded(target,file));}
 catch(error){for(const file of files)fs.copyFileSync(bounded(backup,file),bounded(target,file));throw error;}
 console.log(JSON.stringify({deployed:true,files:files.length,backup,websiteRestartRequired:true,hostingAgentsRestarted:false,databaseModified:false}));
}
main().catch(error=>{console.error('User/partner report rollout failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
