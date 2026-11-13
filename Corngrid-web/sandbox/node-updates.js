'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
const {hash,allowedName,REQUIRED,MAX_SOURCE_BYTES,MAX_BUNDLE_BYTES,atomicJson,readJson,releaseId,verifyEnvelope}=require('../agent/update-protocol');
function sourceManifest(sourceDir){
 const files=fs.readdirSync(sourceDir).filter(allowedName).sort().map(name=>{const file=path.join(sourceDir,name);if(fs.lstatSync(file).isSymbolicLink())throw Error('Source links are not allowed.');const data=fs.readFileSync(file);return {name,bytes:data.length,sha256:hash(data)};});
 if(REQUIRED.some(name=>!files.some(f=>f.name===name))||files.reduce((n,f)=>n+f.bytes,0)>MAX_SOURCE_BYTES)throw Error('Incomplete or oversized agent source.');
 const version=JSON.parse(fs.readFileSync(path.join(sourceDir,'package.json'),'utf8')).version;
 return {format:1,version,id:releaseId(version,files),files};
}
async function publishRelease({sourceDir,storageDir}){
 const expected=readJson(path.join(sourceDir,'RELEASE.json'));if(!expected)throw Error('Build the agent package before publishing.');
 const current=sourceManifest(sourceDir);if(current.id!==expected.id||JSON.stringify(current.files)!==JSON.stringify(expected.files))throw Error('Source deployment is incomplete; release was not published.');
 fs.mkdirSync(storageDir,{recursive:true,mode:0o700});
 const lock=path.join(storageDir,'publish.lock');let fd;
 try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST'){const stat=fs.statSync(lock);if(Date.now()-stat.mtimeMs>10*60*1000)fs.unlinkSync(lock);else return {busy:true};return publishRelease({sourceDir,storageDir});}throw error;}
 try{
  const keyFile=path.join(storageDir,'signing-key.pem');
  if(!fs.existsSync(keyFile)){const pair=crypto.generateKeyPairSync('ed25519');fs.writeFileSync(keyFile,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});}
  const privateKey=crypto.createPrivateKey(fs.readFileSync(keyFile)),publicKey=crypto.createPublicKey(privateKey).export({format:'pem',type:'spki'});
  fs.writeFileSync(path.join(storageDir,'public-key.pem'),publicKey,{mode:0o644});
  const previous=readJson(path.join(storageDir,'channel.json'),{});
  if(previous.release?.id===current.id)return {unchanged:true,release:previous.release};
  // Validate outside the web process. No downloaded code is executed here.
  for(const file of current.files.filter(f=>f.name.endsWith('.js')))await run(process.execPath,['--check',path.join(sourceDir,file.name)],{windowsHide:true,timeout:15000,maxBuffer:65536});
  const files=current.files.map(file=>({...file,data:fs.readFileSync(path.join(sourceDir,file.name)).toString('base64')}));
  const payload={format:1,bootstrapVersion:1,id:current.id,sequence:(previous.release?.sequence||0)+1,version:current.version,publishedAt:new Date().toISOString(),files};
  const raw=Buffer.from(JSON.stringify(payload)),envelope={payload:raw.toString('base64'),signature:crypto.sign(null,raw,privateKey).toString('base64')};
  verifyEnvelope(envelope,publicKey);if(sourceManifest(sourceDir).id!==current.id)throw Error('Source changed during publication.');
  const directory=path.join(storageDir,'releases');fs.mkdirSync(directory,{recursive:true});
  const bytes=Buffer.from(JSON.stringify(envelope));if(bytes.length>MAX_BUNDLE_BYTES)throw Error('Release envelope is too large.');
  fs.writeFileSync(path.join(directory,current.id+'.json'),bytes,{mode:0o600,flag:'w'});
  const release={id:current.id,sequence:payload.sequence,version:payload.version,publishedAt:payload.publishedAt,bytes:bytes.length};
  atomicJson(path.join(storageDir,'channel.json'),{enabled:previous.enabled!==false,release});return {published:true,release};
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
function createNodeUpdates({storageDir=process.env.SANDBOX_NODE_UPDATE_DIR,enabled=process.env.SANDBOX_NODE_AUTO_UPDATE==='true'}={}){
 const configured=Boolean(storageDir);if(configured)storageDir=path.resolve(storageDir);
 if(configured){const webRoot=path.resolve(__dirname,'../..'),relative=path.relative(webRoot,storageDir);if(!relative||!relative.startsWith('..')&&!path.isAbsolute(relative))throw Error('Node signing storage must be outside the website.');}
 function status(){const channel=configured?readJson(path.join(storageDir,'channel.json'),{}):{};return {configured,enabled:configured&&enabled&&channel.enabled!==false,release:channel.release||null,publisher:configured?readJson(path.join(storageDir,'publisher-status.json')):null};}
 function publicKey(){return configured?fs.readFileSync(path.join(storageDir,'public-key.pem'),'utf8'):null;}
 function releaseFile(id){if(!configured||! /^[a-f0-9]{64}$/.test(id))return null;const file=path.join(storageDir,'releases',id+'.json');return fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()?file:null;}
 function setEnabled(value){if(!configured)throw Error('Updates are not configured.');const old=readJson(path.join(storageDir,'channel.json'),{});atomicJson(path.join(storageDir,'channel.json'),{...old,enabled:value});return status();}
 return {status,publicKey,releaseFile,setEnabled};
}
function startAutoPublisher({sourceDir=path.join(__dirname,'../agent'),storageDir=process.env.SANDBOX_NODE_UPDATE_DIR,enabled=process.env.SANDBOX_NODE_AUTO_UPDATE==='true',intervalMs=60000}={}){
 if(!enabled||!storageDir)return ()=>{};let child=null;
 const tick=()=>{if(child)return;child=execFile(process.execPath,[path.join(__dirname,'../scripts/publish-node-release.js')],{windowsHide:true,timeout:180000,maxBuffer:65536,env:{...process.env,SANDBOX_NODE_UPDATE_DIR:storageDir,CORNGRID_RELEASE_SOURCE:sourceDir}},error=>{child=null;if(error)console.warn('Node release publisher deferred; inspect the deployment manifest and publisher log.');});};
 tick();const timer=setInterval(tick,intervalMs);timer.unref();return ()=>{clearInterval(timer);};
}
module.exports={sourceManifest,publishRelease,createNodeUpdates,startAutoPublisher};
