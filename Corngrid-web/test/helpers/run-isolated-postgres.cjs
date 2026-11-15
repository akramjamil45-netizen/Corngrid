'use strict';
// Developer test harness: creates its OWN disposable loopback cluster. Never
// reads .env, existing PGDATA, production ports or a Windows service registry.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{execFileSync}=require('node:child_process');
async function main(){
 const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'corngrid-pg-cluster-test-')),data=path.join(root,'data'),bin=process.env.PG_TEST_BIN_DIR||'C:/Program Files/PostgreSQL/16/bin',suffix=process.platform==='win32'?'.exe':'';
 const exe=name=>path.join(bin,name+suffix),run=(name,args)=>execFileSync(exe(name),args,{windowsHide:true,timeout:90000,stdio:'ignore'});let canRemove=true;
 try{
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const number=server.address().port;server.close(error=>error?reject(error):resolve(number));});});
  run('initdb',['-D',data,'-U','corngrid_fixture','-A','trust','--encoding=UTF8','--no-locale','-N']);
  run('pg_ctl',['-D',data,'-l',path.join(root,'server.log'),'-o','-h 127.0.0.1 -p '+port+' -c fsync=off -c synchronous_commit=off -c full_page_writes=off','-w','start']);
  const env={...process.env,DATABASE_URL:'',TEST_POSTGRES_URL:'postgresql://corngrid_fixture@127.0.0.1:'+port+'/postgres',PG_DUMP_BIN:exe('pg_dump'),PG_RESTORE_BIN:exe('pg_restore')};
  for(const name of ['test/postgres-availability.test.js','test/platform-postgres.test.js']){
   const output=execFileSync(process.execPath,['--test',name],{cwd:path.resolve(__dirname,'../..'),env,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024,encoding:'utf8'});process.stdout.write(output);
  }
 }finally{
  if(path.dirname(path.resolve(root))!==path.resolve(parent)||!/^corngrid-pg-cluster-test-[a-zA-Z0-9]+$/.test(path.basename(root))||fs.lstatSync(root).isSymbolicLink())throw Error('Unsafe test-cluster cleanup path.');
  if(fs.existsSync(path.join(data,'postmaster.pid'))){try{run('pg_ctl',['-D',data,'-m','fast','-w','stop']);}catch{canRemove=false;}}
  if(canRemove)fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});else throw Error('Disposable cluster did not stop; its data was preserved.');
 }
}
main().catch(error=>{if(error.stdout)process.stderr.write(String(error.stdout));if(error.stderr)process.stderr.write(String(error.stderr));console.error('Isolated PostgreSQL test failed ('+(error.code||error.status||'test')+'); production services were not accessed.');process.exitCode=1;});
