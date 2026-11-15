'use strict';
// Static UI update only. No database access or website process restart.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const previous={
 'Corngrid-web/public/admin.html':'80f9aa54d12192d33c38754c8dbf130fe21d8015710597e7f55818c5b37fd6d0',
 'Corngrid-web/public/dashboard.html':'4ac3757910d34f2ac7b65a7fa877bbe9522478b2011a8201925caf92f08b5650',
 'Corngrid-web/public/report-studio.js':'57927c9403e2bd0e72ebe6fb5adf777ac741ea5b386c264399edb67dca8cd39f',
 'Corngrid-web/public/report-studio.css':'1b37765ef9129cb7563cf5e57cc97915704184718495fd32c9d594cd4e7d7dde',
 'Corngrid-web/docs/REPORT-STUDIO.md':'d490c1eb13087c1348b4c7856de133081e9607fc6418c9440b8fbe1e72b8ae48'
};
const files=Object.keys(previous),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function bounded(root,file){const result=path.resolve(root,file);assert.ok(!path.relative(root,result).startsWith('..')&&!path.isAbsolute(path.relative(root,result)));return result;}
async function verify(){
 for(const file of files)assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  for(const file of files.filter(f=>f.startsWith('Corngrid-web/public/'))){
   const asset=file.slice('Corngrid-web/public/'.length),response=await fetch(origin+'/'+asset+'?v=20261114-3',{signal:AbortSignal.timeout(20000)});
   assert.equal(response.status,200,asset);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(bounded(source,file))),asset);
  }
  const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);
 }
}
async function main(){
 if(process.argv.includes('--verify')){await verify();console.log(JSON.stringify({verified:true,files:files.length,publicAssetsCurrent:true,websiteRestarted:false,databaseModified:false}));return;}
 for(const file of files){const expected=hash(fs.readFileSync(bounded(source,file))),actual=hash(fs.readFileSync(bounded(target,file)));assert.ok(actual===previous[file]||actual===expected,'Unrelated live change: '+file);}
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,files:files.length,websiteRestartRequired:false,databaseAccessed:false}));return;}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-report-toggle-before-'));
 for(const file of files){const saved=bounded(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(bounded(target,file),saved);}
 try{
  for(const file of files)fs.copyFileSync(bounded(source,file),bounded(target,file));
  await verify();
 }catch(error){for(const file of files)fs.copyFileSync(bounded(backup,file),bounded(target,file));throw error;}
 const result={deployed:true,verified:true,files:files.length,backup,websiteRestarted:false,databaseModified:false};
 fs.writeFileSync(path.join(__dirname,'report-studio-toggle-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Report Studio dropdown deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
