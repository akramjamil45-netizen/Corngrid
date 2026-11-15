'use strict';
// Public social-preview assets only. No app restart, secrets, database, or publication.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {staticChecks,verifyOrigin,hash}=require('./verify-social-preview.cjs');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const previous={
  "marketing/SOCIAL-PREVIEW.md": "40705d5c9196b9f1a7a4fe19ab065b451e167e76af2ffd79c1363a9c51c857c0",
  "index.html": "59c2fce0d9692e0980c95c09c56c283116d034319069bd1e64e65ee5cedc91c3",
  "marketing/social-preview.cjs": "f0b85fa15653889f644399b647d024b1db011d93905b4c1b1c63df1ca956fe9e",
  "site.js": "d104aba3e953f86c59064bc829ecafe244e189672a7c74008d64932aa8b4a238",
  "marketing/build.js": "2817e90c95f85800dfa451853df965c1bbf87dc65684e6e40182737294f82541",
  "en/index.html": "6d30168569c02acaaa305ac9e175da7d9bad6a3534629d265da9d4628dd301f4",
  "marketing/verify-social-preview.cjs": "83eb76ff24c1a1ff752212a24e7dbae7c225130f8bf84f989a582cd65d873824"
};
const files=['marketing/social-preview.cjs','marketing/verify-social-preview.cjs','marketing/SOCIAL-PREVIEW.md','marketing/build.js','site.js','en/index.html','index.html'];
const manifest=path.join(__dirname,'social-preview-main-en-v4-deployment-result.json');
function bounded(root,file){const resolved=path.resolve(root,file),relative=path.relative(root,resolved);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));return resolved;}
function stripSocial(html){const end=html.indexOf('</head>');assert.ok(end>0);return html.slice(0,end).replace(/<meta\b[^>]*(?:property|name)="(?:og:|twitter:)[^"]*"[^>]*>/g,'').replace(/site\.js\?v=(?:20261111-simple-home1|20261114-share-en4)/g,'site.js?v=SHARE_CACHE_VERSION')+html.slice(end);}
function restore(saved,changed){
 assert.ok(path.resolve(saved.backup).startsWith(path.resolve(os.tmpdir())+path.sep));
 for(const file of [...changed].reverse()){
  const live=bounded(target,file);
  if(saved.previous[file]===null){if(fs.existsSync(live))fs.unlinkSync(live);}
  else{const backup=bounded(saved.backup,file);assert.equal(hash(fs.readFileSync(backup)),saved.previous[file],file);fs.copyFileSync(backup,live);}
 }
}
async function liveChecks(){
 for(const file of files)assert.equal(hash(fs.readFileSync(bounded(source,file))),hash(fs.readFileSync(bounded(target,file))),file);
 const requests=[];
 for(const origin of ['https://corngrid.com','http://corngrid.com']){
  requests.push(await verifyOrigin(origin));
  const script=await fetch(origin+'/site.js?v=20261114-share-en4',{signal:AbortSignal.timeout(20000)});assert.equal(script.status,200);assert.equal(hash(Buffer.from(await script.arrayBuffer())),hash(fs.readFileSync(bounded(source,'site.js'))),'Public site.js');
 }
 const ready=await fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(10000)});assert.equal(ready.status,200);
 return requests;
}
async function main(){
 await staticChecks();
 if(process.argv.includes('--verify')){console.log(JSON.stringify({verified:true,requests:await liveChecks(),databaseModified:false,websiteRestarted:false}));return;}
 if(process.argv.includes('--rollback')){restore(JSON.parse(fs.readFileSync(manifest,'utf8')),files);console.log(JSON.stringify({restored:true}));return;}
 for(const file of files){
  const live=bounded(target,file),liveHash=fs.existsSync(live)?hash(fs.readFileSync(live)):null,newHash=hash(fs.readFileSync(bounded(source,file)));
  assert.ok(liveHash===previous[file]||liveHash===newHash,'Unrelated live change: '+file);
 }
 for(const file of ['index.html','en/index.html'])assert.equal(stripSocial(fs.readFileSync(bounded(source,file),'utf8')),stripSocial(fs.readFileSync(bounded(target,file),'utf8')),'Non-social page content changed: '+file);
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,files:files.length,pageContentPreserved:true,databaseModified:false,websiteRestartRequired:false}));return;}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-social-main-en-v4-before-'));
 const saved={backup,previous:{},files,startedAt:new Date().toISOString(),databaseModified:false,websiteRestarted:false};
 for(const file of files){
  const live=bounded(target,file),copy=bounded(backup,file);
  saved.previous[file]=fs.existsSync(live)?hash(fs.readFileSync(live)):null;
  if(saved.previous[file]!==null){fs.mkdirSync(path.dirname(copy),{recursive:true});fs.copyFileSync(live,copy);}
 }
 fs.writeFileSync(manifest,JSON.stringify(saved,null,2));
 const changed=[];
 try{
  for(const file of files){const live=bounded(target,file);fs.mkdirSync(path.dirname(live),{recursive:true});changed.push(file);fs.copyFileSync(bounded(source,file),live);}
  saved.requests=await liveChecks();saved.verified=true;saved.completedAt=new Date().toISOString();fs.writeFileSync(manifest,JSON.stringify(saved,null,2));
  console.log(JSON.stringify({deployed:true,verified:true,files:files.length,requests:saved.requests,databaseModified:false,websiteRestarted:false,backup}));
 }catch(error){restore(saved,changed);saved.rolledBack=true;fs.writeFileSync(manifest,JSON.stringify(saved,null,2));throw error;}
}
main().catch(error=>{console.error('Social preview rollout failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
