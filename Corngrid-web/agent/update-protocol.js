'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BUNDLE_BYTES=4*1024*1024,MAX_SOURCE_BYTES=2*1024*1024;
const REQUIRED=['agent.js','config.js','transport.js','package.json','package-lock.json','auto-update.js','update-protocol.js'];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function allowedName(name){return typeof name==='string'&&(name==='package.json'||name==='package-lock.json'||/^[a-z][a-z0-9-]{0,63}\.(?:js|py|ps1)$/.test(name))&&!['agent-launcher.js','install-service.ps1','uninstall-service.ps1'].includes(name);}
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.tmp-'+crypto.randomBytes(6).toString('hex');try{fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}}
function readJson(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return fallback;}}
function releaseId(version,files){return hash(JSON.stringify({version,files:files.map(({name,bytes,sha256})=>({name,bytes,sha256})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}));}
function verifyEnvelope(envelope,publicKey,expected={}){
 if(!envelope||typeof envelope.payload!=='string'||typeof envelope.signature!=='string'||envelope.payload.length>MAX_BUNDLE_BYTES*1.4)throw Error('UPDATE_ENVELOPE_INVALID');
 const raw=Buffer.from(envelope.payload,'base64');if(raw.length>MAX_BUNDLE_BYTES||raw.toString('base64')!==envelope.payload)throw Error('UPDATE_SIZE_INVALID');
 const key=publicKey?.type==='public'?publicKey:crypto.createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,raw,key,Buffer.from(envelope.signature,'base64')))throw Error('UPDATE_SIGNATURE_INVALID');
 const payload=JSON.parse(raw.toString('utf8'));
 if(payload.format!==1||payload.bootstrapVersion!==1||!Number.isSafeInteger(payload.sequence)||payload.sequence<1||!/^\d+\.\d+\.\d+$/.test(payload.version)||!Array.isArray(payload.files)||payload.files.length>80)throw Error('UPDATE_FORMAT_INVALID');
 const seen=new Set();let size=0;
 for(const file of payload.files){
  if(!allowedName(file.name)||seen.has(file.name)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_SOURCE_BYTES||! /^[a-f0-9]{64}$/.test(file.sha256)||typeof file.data!=='string')throw Error('UPDATE_FILE_INVALID');
  seen.add(file.name);const bytes=Buffer.from(file.data,'base64');size+=bytes.length;
  if(bytes.toString('base64')!==file.data||bytes.length!==file.bytes||hash(bytes)!==file.sha256||size>MAX_SOURCE_BYTES)throw Error('UPDATE_HASH_INVALID');
 }
 if(REQUIRED.some(name=>!seen.has(name))||releaseId(payload.version,payload.files)!==payload.id||expected.id&&expected.id!==payload.id||expected.sequence&&expected.sequence!==payload.sequence)throw Error('UPDATE_RELEASE_INVALID');
 const pkg=JSON.parse(Buffer.from(payload.files.find(f=>f.name==='package.json').data,'base64'));
 const lock=JSON.parse(Buffer.from(payload.files.find(f=>f.name==='package-lock.json').data,'base64'));
 if(pkg.version!==payload.version||lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version)throw Error('UPDATE_PACKAGE_INVALID');
 return payload;
}
function safeReleaseRoot(config){
 const root=path.resolve(config.agentDataDir,'node-releases');fs.mkdirSync(root,{recursive:true});
 const real=fs.realpathSync(root),same=process.platform==='win32'?real.toLowerCase()===root.toLowerCase():real===root;
 if(fs.lstatSync(root).isSymbolicLink()||!same)throw Error('UPDATE_DIRECTORY_UNSAFE');return root;
}
function releaseDirectory(root,id,sequence){if(!/^[a-f0-9]{64}$/.test(id)||!Number.isSafeInteger(sequence)||sequence<1)throw Error('UPDATE_ID_INVALID');const directory=path.resolve(root,id+'-'+sequence);if(path.dirname(directory)!==path.resolve(root))throw Error('UPDATE_DIRECTORY_UNSAFE');return directory;}
function validateInstalled(directory,payload){
 if(fs.lstatSync(directory).isSymbolicLink())throw Error('UPDATE_DIRECTORY_UNSAFE');
 for(const file of payload.files){const target=path.join(directory,file.name);if(fs.lstatSync(target).isSymbolicLink()||hash(fs.readFileSync(target))!==file.sha256)throw Error('UPDATE_INSTALLED_HASH_INVALID');}
}
module.exports={MAX_BUNDLE_BYTES,MAX_SOURCE_BYTES,REQUIRED,hash,allowedName,atomicJson,readJson,releaseId,verifyEnvelope,safeReleaseRoot,releaseDirectory,validateInstalled};
