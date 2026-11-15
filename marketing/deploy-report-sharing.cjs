'use strict';
// Sharing UI only: no database access, public image upload or service restart.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const previous={
 'Corngrid-web/public/admin.html':'5cf244f598cc593a8f8ca74f786b92195e5349c6995e7b8e9d716655f78268ca',
 'Corngrid-web/public/dashboard.html':'7c3cbf447951f09672292e99b44cce244477f64dcc2e39f78b10d51256230abf',
 'Corngrid-web/public/report-studio.js':'e5e0d063ed8ff2ed3f62523cca34535b4c0bd8b48bb210536257340cc35ce3a2',
 'Corngrid-web/public/report-studio.css':'9412e6f20526cdc31d1cf7d1800b79e402557392fca648b8162e288b19dcc7fd',
 'Corngrid-web/docs/REPORT-STUDIO.md':'2e150f9e522329f74f6d4f9526c4ba455f7ee206b5ef60e4b812eedadbec963b'
};
const files=Object.keys(previous),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function bounded(root,file){const result=path.resolve(root,file);assert.ok(!path.relative(root,result).startsWith('..')&&!path.isAbsolute(path.relative(root,result)));return result;}
async function verify(){
 for(const file of files)assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  for(const file of files.filter(f=>f.startsWith('Corngrid-web/public/'))){
   const asset=file.slice('Corngrid-web/public/'.length),response=await fetch(origin+'/'+asset+'?v=20261114-4',{signal:AbortSignal.timeout(20000)});
   assert.equal(response.status,200,asset);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(bounded(source,file))),asset);
  }
  const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);
 }
}
async function main(){
 if(process.argv.includes('--verify')){await verify();console.log(JSON.stringify({verified:true,files:files.length,publicAssetsCurrent:true,websiteRestarted:false,databaseModified:false}));return;}
 for(const file of files){const expected=hash(fs.readFileSync(bounded(source,file))),actual=hash(fs.readFileSync(bounded(target,file)));assert.ok(actual===previous[file]||actual===expected,'Unrelated live change: '+file);}
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,files:files.length,websiteRestartRequired:false,databaseAccessed:false}));return;}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-report-sharing-before-'));
 for(const file of files){const saved=bounded(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(bounded(target,file),saved);}
 try{
  for(const file of files)fs.copyFileSync(bounded(source,file),bounded(target,file));
  await verify();
 }catch(error){for(const file of files)fs.copyFileSync(bounded(backup,file),bounded(target,file));throw error;}
 const result={deployed:true,verified:true,files:files.length,backup,websiteRestarted:false,databaseModified:false,productionPostsCreated:0};
 fs.writeFileSync(path.join(__dirname,'report-sharing-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Report sharing deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
