'use strict';
// Visual admin report update only: no database access or website restart.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const previous={
  "Corngrid-web/public/report-renderer.js": "042874719ad63f3d1cee4d8c4f50acc4d27781527edc4f69abd99a225fb413cb",
  "Corngrid-web/public/admin.html": "a0c82679048764d853fb4a629276c4de6805f482827ae875406c1716df722ef3",
  "Corngrid-web/public/dashboard.html": "8bb899b089787e384b6c73ea1e45248a32363a4637bd56faab14707b472d440a",
  "Corngrid-web/docs/REPORT-STUDIO.md": "502e3ad644118eafe04222d749ce131836afc6200c96fbe2efba2683dc3ee5f1"
};
const files=Object.keys(previous),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function bounded(root,file){const result=path.resolve(root,file);assert.ok(!path.relative(root,result).startsWith('..')&&!path.isAbsolute(path.relative(root,result)));return result;}
async function verify(){
 for(const file of files)assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  for(const file of files.filter(f=>f.startsWith('Corngrid-web/public/'))){
   const asset=file.slice('Corngrid-web/public/'.length),response=await fetch(origin+'/'+asset+'?v=20261114-6',{signal:AbortSignal.timeout(20000)});
   assert.equal(response.status,200,asset);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(bounded(source,file))),asset);
  }
  const logo=await fetch(origin+'/images/corngrid-report-logo.png?v=20261114-6',{signal:AbortSignal.timeout(20000)});
  assert.equal(logo.status,200);assert.equal(hash(Buffer.from(await logo.arrayBuffer())),'7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0');
  const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);
 }
}
async function main(){
 if(process.argv.includes('--verify')){await verify();console.log(JSON.stringify({verified:true,files:files.length,originalLogoVerified:true,publicAssetsCurrent:true,databaseAccessed:false}));return;}
 for(const file of files){const expected=hash(fs.readFileSync(bounded(source,file))),actual=hash(fs.readFileSync(bounded(target,file)));assert.ok(actual===previous[file]||actual===expected,'Unrelated live change: '+file);}
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,files:files.length,websiteRestartRequired:false,databaseAccessed:false}));return;}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-editorial-reports-before-'));
 for(const file of files){const saved=bounded(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(bounded(target,file),saved);}
 try{for(const file of files)fs.copyFileSync(bounded(source,file),bounded(target,file));await verify();}
 catch(error){for(const file of files)fs.copyFileSync(bounded(backup,file),bounded(target,file));throw error;}
 const result={deployed:true,verified:true,files:files.length,backup,originalLogoVerified:true,websiteRestarted:false,databaseModified:false};
 fs.writeFileSync(path.join(__dirname,'report-editorial-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Report editorial deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
