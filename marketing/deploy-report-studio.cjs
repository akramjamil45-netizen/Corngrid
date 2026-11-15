'use strict';
// Scoped rollout: existing database is read-only; only website files are copied.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const source = path.resolve(__dirname, '..'), target = path.resolve('C:/Website/Website');
const files = ['Corngrid-web/server.js','Corngrid-web/reports/report-service.js','Corngrid-web/reports/report-api.js','Corngrid-web/public/admin.html','Corngrid-web/public/dashboard.html','Corngrid-web/public/report-studio.css','Corngrid-web/public/report-studio.js','Corngrid-web/public/report-renderer.js','Corngrid-web/public/images/corngrid-report-logo.png','Corngrid-web/docs/REPORT-STUDIO.md','sw.js','web.config'];
const manifest = path.join(__dirname,'report-studio-deployment-result.json');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const normalized = data => String(data).replace(/\r\n/g,'\n');
function previousVersion(file, data) {
  if (file==='web.config') return normalized(data).replace('report-(?:studio|renderer)\\.js|report-studio\\.css|images/corngrid-report-logo\\.png|','');
  if (file==='sw.js') return normalized(data).replace('corngrid-static-v27','corngrid-static-v26').split('\n').filter(line=>!['report-studio','report-renderer'].some(part=>line.includes(part))).join('\n');
  return normalized(data).split('\n').filter(line=>!['report-studio','report-renderer','data-report-role','reports/report-api'].some(part=>line.includes(part))).join('\n');
}
function bounded(root,file) { const result=path.resolve(root,file); assert.ok(!path.relative(root,result).startsWith('..')&&!path.isAbsolute(path.relative(root,result)),'File must stay inside the website directory'); return result; }
async function main() {
  if(process.argv.includes('--rollback')) {
    const saved=JSON.parse(fs.readFileSync(manifest,'utf8'));
    assert.ok(path.resolve(saved.backup).startsWith(path.resolve(os.tmpdir())+path.sep));
    for(const file of saved.existingFiles) fs.copyFileSync(bounded(saved.backup,file),bounded(target,file));
    console.log(JSON.stringify({restored:saved.existingFiles.length,websiteRestartRequired:true,databaseModified:false})); return;
  }
  for(const file of files) assert.ok(fs.existsSync(bounded(source,file)),file);
  assert.equal(hash(fs.readFileSync(bounded(source,'Corngrid-web/public/images/corngrid-report-logo.png'))),'7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0');
  const env=require(path.join(source,'Corngrid-web/node_modules/dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env')));
  assert.ok(env.DATABASE_URL,'PostgreSQL connection is required for the deployed site');
  const db=require(path.join(source,'Corngrid-web/db-postgres'))(env.DATABASE_URL);
  const {dbRun,dbGet}=require(path.join(source,'Corngrid-web/db-async'));
  const service=require(path.join(source,'Corngrid-web/reports/report-service')).createReportService(db);
  const checks=[];
  try {
    await db.transaction(async()=>{
      await dbRun(db,'SET TRANSACTION READ ONLY');
      for(const type of ['growth','sandbox','funds','performance']) {
        const report=await service.generate('admin',undefined,{type,period:'weekly',timezone:'Asia/Kuala_Lumpur'});
        assert.equal(report.mode,'production');assert.equal(report.metrics.length,6);checks.push(type);
      }
      const owner=await dbGet(db,'SELECT a.user_id FROM mt5_accounts a WHERE NOT EXISTS (SELECT 1 FROM account_archives ar WHERE ar.user_id=a.user_id) ORDER BY a.id LIMIT 1');
      if(owner) { const report=await service.generate('user',Number(owner.user_id),{type:'account',period:'yearly',timezone:'Asia/Kuala_Lumpur'});assert.equal(report.scope,'user');checks.push('user-account'); }
    });
  } finally { await new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve())); }
  if(process.argv.includes('--verify')) {
    for(const file of files) assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
    const jwt=require(path.join(source,'Corngrid-web/node_modules/jsonwebtoken'));
    const adminVersion=hash(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`);
    const token=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
    for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']) {
      const publicRequest=await fetch(origin+'/api/admin/reports',{signal:AbortSignal.timeout(20000)});assert.equal(publicRequest.status,401);
      const authenticated=await fetch(origin+'/api/admin/reports?type=growth&period=weekly',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(authenticated.status,200);assert.equal((await authenticated.json()).scope,'admin');
      const userRejected=await fetch(origin+'/api/reports',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(userRejected.status,403);
      for(const asset of ['admin.html','dashboard.html','report-studio.css','report-studio.js','report-renderer.js','images/corngrid-report-logo.png']) {
        const response=await fetch(origin+'/'+asset+'?v=20261114-4',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,asset);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(bounded(target,'Corngrid-web/public/'+asset))),asset);
      }
      const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);
    }
    console.log(JSON.stringify({verified:true,files:files.length,postgresChecks:checks,publicAssetsCurrent:true,adminAuth:true,userEndpointRejectsAdmin:true,databaseModified:false,productionPostsCreated:0}));return;
  }
  // Refuse to replace unrelated differences introduced since the checkout.
  for(const file of ['Corngrid-web/server.js','Corngrid-web/public/admin.html','Corngrid-web/public/dashboard.html','sw.js','web.config']) {
    const a=fs.readFileSync(bounded(source,file),'utf8'), b=fs.readFileSync(bounded(target,file),'utf8');
    assert.ok(previousVersion(file,a)===normalized(b)||normalized(a)===normalized(b),'Live file differs beyond this feature: '+file);
  }
  if(!process.argv.includes('--apply')) { console.log(JSON.stringify({ready:true,postgresChecks:checks,files:files.length,databaseModified:false,migrationRequired:false,unrelatedDifferences:false}));return; }
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-report-studio-before-')),existingFiles=[];
  for(const file of files) {
    const destination=bounded(target,file);
    if(fs.existsSync(destination)) { const saved=bounded(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(destination,saved);existingFiles.push(file); }
  }
  fs.writeFileSync(manifest,JSON.stringify({backup,existingFiles,files,deployedAt:new Date().toISOString(),websiteRestartRequired:true,migrationRequired:false,databaseModified:false},null,2));
  for(const file of files) {const destination=bounded(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(bounded(source,file),destination);assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(destination)),file);}
  console.log(JSON.stringify({deployed:true,files:files.length,backup,websiteRestartRequired:true,migrationRequired:false,databaseModified:false,hostingAgentsRestarted:false}));
}
main().catch(error=>{console.error('Report Studio rollout failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
