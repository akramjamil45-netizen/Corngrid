'use strict';
// Operator-only encrypted logical backups. Never imported by a public route.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises'),{execFile}=require('node:child_process');
const MAGIC=Buffer.from('CGB1'),MAX_PLAIN=256*1024**3;
const fail=code=>Object.assign(Error(code),{code});
const within=(parent,child)=>{const rel=path.relative(path.resolve(parent),path.resolve(child));return !rel||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
function keyBuffer(key){if(!/^[a-fA-F0-9]{64}$/.test(key||''))throw fail('BACKUP_KEY_REQUIRED');return Buffer.from(key,'hex');}
function member(name){return typeof name==='string'&&name.length<1024&&!/[:\\\0\r\n]/.test(name)&&!name.startsWith('/')&&path.posix.normalize(name)===name&&!name.split('/').some(p=>!p||p==='.'||p==='..');}
async function hashFile(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function temporary(parent=os.tmpdir()){const root=await fsp.realpath(parent),dir=await fsp.mkdtemp(path.join(root,'.corngrid-backup-'));await fsp.chmod(dir,0o700);return {dir,root};}
async function cleanup(temp){const dir=path.resolve(temp.dir);if(path.dirname(dir)!==path.resolve(temp.root)||!/^\.corngrid-backup-[a-zA-Z0-9]+$/.test(path.basename(dir))||(await fsp.lstat(dir)).isSymbolicLink())throw fail('UNSAFE_BACKUP_CLEANUP');await fsp.rm(dir,{recursive:true,force:true});}
function tool(file,args,{env=process.env}={}){return new Promise((resolve,reject)=>execFile(file,args,{env,timeout:3600000,maxBuffer:1024*1024,windowsHide:true},(error,stdout,stderr)=>{if(error||stderr?.trim())reject(fail('BACKUP_TOOL_FAILED'));else resolve(stdout);}));}
function pgEnvironment(raw){
 const url=new URL(raw);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash)throw fail('INVALID_POSTGRES_URL');
 const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGCONNECT_TIMEOUT:'10'};
 if(!env.PGDATABASE||!env.PGHOST)throw fail('INVALID_POSTGRES_URL');
 const allowed={sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',channel_binding:'PGCHANNELBINDING',options:'PGOPTIONS',application_name:'PGAPPNAME'};
 for(const[key,value]of url.searchParams){if(!allowed[key])throw fail('UNSUPPORTED_POSTGRES_PARAMETER');env[allowed[key]]=value;}
 return env;
}
async function listFiles(sources){const result=[];async function visit(file,name){if(!member(name))throw fail('UNSAFE_BACKUP_MEMBER');const stat=await fsp.lstat(file);if(stat.isSymbolicLink())throw fail('BACKUP_SYMLINK_REFUSED');if(stat.isDirectory()){for(const item of (await fsp.readdir(file)).sort())await visit(path.join(file,item),name+'/'+item);}else if(stat.isFile()){if(result.length>=100000)throw fail('BACKUP_FILE_LIMIT');result.push({source:file,path:name,size:stat.size,sha256:await hashFile(file)});}else throw fail('UNSUPPORTED_BACKUP_FILE');}for(const source of sources)await visit(path.resolve(source.file),source.name);if(new Set(result.map(f=>f.path)).size!==result.length)throw fail('DUPLICATE_BACKUP_MEMBER');return result;}
async function pack({sources,output,key,engine,createdAt=Date.now(),temporaryRoot}){
 const encryptionKey=keyBuffer(key),entries=await listFiles(sources),manifest={format:1,createdAt,engine,files:entries.map(({source,...entry})=>entry)},json=Buffer.from(JSON.stringify(manifest));
 if(json.length>2*1024*1024)throw fail('BACKUP_MANIFEST_TOO_LARGE');if(entries.reduce((sum,e)=>sum+e.size,0)>MAX_PLAIN)throw fail('BACKUP_TOO_LARGE');
 output=path.resolve(output);for(const source of sources)if(within(source.file,output))throw fail('BACKUP_OUTPUT_INSIDE_SOURCE');
 const temp=await temporary(temporaryRoot||path.dirname(output)),archive=path.join(temp.dir,'archive.cgb'),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv);cipher.setAAD(MAGIC);
 try{
  await fsp.writeFile(archive,Buffer.concat([MAGIC,iv,Buffer.alloc(16)]),{flag:'wx',mode:0o600});
  async function* content(){const size=Buffer.alloc(4);size.writeUInt32BE(json.length);yield size;yield json;for(const entry of entries){let count=0;const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(entry.source)){count+=chunk.length;hash.update(chunk);yield chunk;}if(count!==entry.size||hash.digest('hex')!==entry.sha256)throw fail('BACKUP_SOURCE_CHANGED');}}
  await pipeline(Readable.from(content()),zlib.createGzip(),cipher,fs.createWriteStream(archive,{flags:'a'}));
  const handle=await fsp.open(archive,'r+');try{await handle.write(cipher.getAuthTag(),0,16,16);await handle.sync();}finally{await handle.close();}
  // Exclusive publication never overwrites an existing backup.
  await fsp.copyFile(archive,output,fs.constants.COPYFILE_EXCL);await fsp.chmod(output,0o600);
  return {format:1,createdAt,engine,files:entries.length,bytes:(await fsp.stat(output)).size};
 }finally{await cleanup(temp);}
}
async function unpack({input,key,temporaryRoot,maxPlainBytes=MAX_PLAIN}){
 const encryptionKey=keyBuffer(key),temp=await temporary(temporaryRoot),plain=path.join(temp.dir,'bundle.plain');
 try{
  const disk=await fsp.statfs(temp.dir);const available=Number(disk.bavail)*Number(disk.bsize)-64*1024**2;maxPlainBytes=Math.min(maxPlainBytes,available);if(!Number.isSafeInteger(Math.floor(maxPlainBytes))||maxPlainBytes<=0)throw fail('INSUFFICIENT_RESTORE_SPACE');
  const header=Buffer.alloc(32),source=await fsp.open(input,'r');try{const result=await source.read(header,0,32,0);if(result.bytesRead!==32||!header.subarray(0,4).equals(MAGIC))throw fail('INVALID_BACKUP_FORMAT');}finally{await source.close();}
  const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,header.subarray(4,16));decipher.setAAD(MAGIC);decipher.setAuthTag(header.subarray(16));let expanded=0;
  const limit=new Transform({transform(chunk,_encoding,done){expanded+=chunk.length;done(expanded>maxPlainBytes?fail('BACKUP_EXPANSION_LIMIT'):null,chunk);}});
  await pipeline(fs.createReadStream(input,{start:32}),decipher,zlib.createGunzip(),limit,fs.createWriteStream(plain,{flags:'wx',mode:0o600}));
  const handle=await fsp.open(plain,'r');let manifest,offset;
  try{const length=Buffer.alloc(4);if((await handle.read(length,0,4,0)).bytesRead!==4)throw fail('INVALID_BACKUP_MANIFEST');const size=length.readUInt32BE();if(size<1||size>2*1024*1024)throw fail('INVALID_BACKUP_MANIFEST');const json=Buffer.alloc(size);if((await handle.read(json,0,size,4)).bytesRead!==size)throw fail('INVALID_BACKUP_MANIFEST');manifest=JSON.parse(json.toString('utf8'));offset=4+size;}finally{await handle.close();}
  if(manifest.format!==1||!['sqlite','postgresql'].includes(manifest.engine)||!Array.isArray(manifest.files)||manifest.files.length>100000)throw fail('INVALID_BACKUP_MANIFEST');const seen=new Set();
  for(const entry of manifest.files){if(!member(entry.path)||seen.has(entry.path)||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256)||offset+entry.size>expanded)throw fail('INVALID_BACKUP_MEMBER');seen.add(entry.path);const destination=path.resolve(temp.dir,'extracted',...entry.path.split('/'));if(!within(path.join(temp.dir,'extracted'),destination))throw fail('INVALID_BACKUP_MEMBER');await fsp.mkdir(path.dirname(destination),{recursive:true,mode:0o700});if(entry.size)await pipeline(fs.createReadStream(plain,{start:offset,end:offset+entry.size-1}),fs.createWriteStream(destination,{flags:'wx',mode:0o600}));else await fsp.writeFile(destination,'',{flag:'wx',mode:0o600});if(await hashFile(destination)!==entry.sha256)throw fail('BACKUP_HASH_MISMATCH');offset+=entry.size;}
  if(offset!==expanded)throw fail('BACKUP_TRAILING_DATA');await fsp.unlink(plain);return {manifest,directory:path.join(temp.dir,'extracted'),dispose:()=>cleanup(temp)};
 }catch{await cleanup(temp);throw fail('BACKUP_VERIFICATION_FAILED');}
}
async function sqliteSnapshot(source,target){const sqlite=require('sqlite3');await new Promise((resolve,reject)=>{const db=new sqlite.Database(source,sqlite.OPEN_READONLY,error=>{if(error)return reject(fail('SQLITE_BACKUP_FAILED'));db.run('VACUUM INTO ?',[target],error=>db.close(()=>error?reject(fail('SQLITE_BACKUP_FAILED')):resolve()));});});}
async function createBackup({sourceRoot,databaseUrl,databasePath,output,key,signingKeyDirectory,run=tool,temporaryRoot}={}){
 sourceRoot=path.resolve(sourceRoot);if(within(sourceRoot,output))throw fail('BACKUP_OUTPUT_INSIDE_WEBSITE');const backend=path.join(sourceRoot,'Corngrid-web'),temp=await temporary(temporaryRoot),engine=databaseUrl?'postgresql':'sqlite';
 try{
  const databaseFile=path.join(temp.dir,databaseUrl?'snapshot.dump':'snapshot.sqlite');
  if(databaseUrl)await run(process.env.PG_DUMP_BIN||'pg_dump',['--format=custom','--no-password','--file='+databaseFile],{env:pgEnvironment(databaseUrl)});
  else{const source=path.resolve(databasePath||path.join(backend,'database.sqlite'));if(!(await fsp.lstat(source)).isFile()||(await fsp.lstat(source)).isSymbolicLink())throw fail('INVALID_SQLITE_SOURCE');await sqliteSnapshot(source,databaseFile);}
  const sources=[{file:databaseFile,name:'database/'+path.basename(databaseFile)}];
  for(const[file,name]of [[path.join(backend,'.env'),'config/backend.env'],[path.join(backend,'storage'),'runtime/storage'],[path.join(backend,'public/uploads'),'runtime/uploads'],[path.join(sourceRoot,'files'),'runtime/files']]){if(fs.existsSync(file))sources.push({file,name});}
  if(signingKeyDirectory)for(const name of ['signing-key.pem','public-key.pem']){const file=path.join(signingKeyDirectory,name);if(!fs.existsSync(file))throw fail('NODE_SIGNING_KEY_MISSING');sources.push({file,name:'config/node-updates/'+name});}
  return await pack({sources,output,key,engine,temporaryRoot});
 }finally{await cleanup(temp);}
}
async function verifyBackup({input,key,restoreControlUrl,run=tool,temporaryRoot}={}){
 const unpacked=await unpack({input,key,temporaryRoot});
 try{
  const {manifest,directory}=unpacked,required=manifest.engine==='sqlite'?'database/snapshot.sqlite':'database/snapshot.dump';if(!manifest.files.some(f=>f.path===required))throw fail('BACKUP_DATABASE_MISSING');const databaseFile=path.join(directory,...required.split('/'));let counts={};
  if(manifest.engine==='sqlite'){
   const sqlite=require('sqlite3'),db=await new Promise((resolve,reject)=>{const connection=new sqlite.Database(databaseFile,sqlite.OPEN_READONLY,error=>error?reject(fail('RESTORE_DATABASE_FAILED')):resolve(connection));});
   const query=sql=>new Promise((resolve,reject)=>db.all(sql,[],(error,rows)=>error?reject(fail('RESTORE_DATABASE_FAILED')):resolve(rows)));
   try{if((await query('PRAGMA integrity_check')).some(row=>Object.values(row)[0]!=='ok')||(await query('PRAGMA foreign_key_check')).length)throw fail('RESTORE_DATABASE_FAILED');counts.users=(await query('SELECT COUNT(*) AS count FROM users'))[0].count;}finally{await new Promise(resolve=>db.close(resolve));}
  }else{
   if(!restoreControlUrl)throw fail('RESTORE_CONTROL_URL_REQUIRED');const {Client}=require('pg'),name='corngrid_restore_check_'+crypto.randomBytes(8).toString('hex'),control=new Client({connectionString:restoreControlUrl,connectionTimeoutMillis:10000});let created=false;
   await control.connect();try{
    await control.query('CREATE DATABASE "'+name+'" TEMPLATE template0');created=true;const target=new URL(restoreControlUrl);target.pathname='/'+name;target.searchParams.delete('options');
    await run(process.env.PG_RESTORE_BIN||'pg_restore',['--no-password','--dbname='+name,'--exit-on-error','--single-transaction','--no-owner','--no-privileges',databaseFile],{env:pgEnvironment(target.toString())});
    const restored=new Client({connectionString:target.toString(),connectionTimeoutMillis:10000});await restored.connect();try{counts.users=Number((await restored.query('SELECT COUNT(*) AS count FROM users')).rows[0].count);}finally{await restored.end();}
   }finally{try{if(created&&/^corngrid_restore_check_[a-f0-9]{16}$/.test(name))await control.query('DROP DATABASE "'+name+'" WITH (FORCE)');}finally{await control.end();}}
  }
  return {verified:true,checkedAt:Date.now(),createdAt:manifest.createdAt,engine:manifest.engine,files:manifest.files.length,counts,privateConfigIncluded:manifest.files.some(f=>f.path==='config/backend.env'),nodeSigningKeyIncluded:manifest.files.some(f=>f.path==='config/node-updates/signing-key.pem')};
 }finally{await unpacked.dispose();}
}
module.exports={pack,unpack,createBackup,verifyBackup,pgEnvironment,member};
