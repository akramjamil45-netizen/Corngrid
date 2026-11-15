'use strict';
// Portable allowlisted USTAR+gzip builder: works on Windows and Linux, without
// dependencies, credentials, installed packages or a running backend.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {sourceManifest}=require('../sandbox/node-updates');
const {hash}=require('../agent/update-protocol');
function tar(entries){
 const buffers=[];
 for(const {name,bytes,mode=0o644}of entries){
  if(!/^[A-Za-z0-9._ /-]{1,99}$/.test(name)||name.startsWith('/')||name.split('/').includes('..'))throw Error('Unsafe package member');
  const header=Buffer.alloc(512),field=(start,length,value)=>header.write(value,start,length,'ascii');
  field(0,100,name);field(100,8,mode.toString(8).padStart(7,'0')+'\0');field(108,8,'0000000\0');field(116,8,'0000000\0');
  field(124,12,bytes.length.toString(8).padStart(11,'0')+'\0');field(136,12,'00000000000\0');header.fill(32,148,156);field(156,1,'0');field(257,6,'ustar\0');field(263,2,'00');
  field(148,8,header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ');
  buffers.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
 }
 return Buffer.concat([...buffers,Buffer.alloc(1024)]);
}
function build({output=path.resolve(__dirname,'../../CornGrid-Node-Agent-Linux.tar.gz')}={}){
 const root=path.resolve(__dirname,'..'),agent=path.join(root,'agent'),release=sourceManifest(agent);
 const names=[...release.files.map(file=>file.name),'agent-launcher.js','install-service.sh','uninstall-service.sh','agent-config.linux.example.json'];
 const entries=[...new Set(names)].map(name=>{
  const file=path.join(agent,name);if(fs.lstatSync(file).isSymbolicLink())throw Error('Package source links are not allowed');
  let bytes=fs.readFileSync(file);if(name.endsWith('.sh'))bytes=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
  return {name:'agent/'+name,bytes,mode:name.endsWith('.sh')?0o755:0o644};
 });
 entries.push({name:'agent/RELEASE.json',bytes:Buffer.from(JSON.stringify(release,null,2)+'\n')});
 for(const name of ['VPS_NODE_INSTALLATION.md','VPS_NODE_INSTALLATION_WINDOWS.md','VPS_NODE_INSTALLATION_LINUX.md','NODE_AUTO_UPDATES.md'])entries.push({name,bytes:fs.readFileSync(path.join(root,'docs',name))});
 const manifest={format:1,platform:'linux-x64-wine',agentVersion:release.version,releaseId:release.id,files:entries.map(entry=>({path:entry.name,bytes:entry.bytes.length,sha256:hash(entry.bytes),mode:entry.mode||0o644}))};
 entries.push({name:'MANIFEST.json',bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')});
 const bytes=zlib.gzipSync(tar(entries),{level:9});
 output=path.resolve(output);if(!fs.statSync(path.dirname(output)).isDirectory())throw Error('Output parent must exist');
 const temporary=output+'.tmp-'+process.pid;
 try{fs.writeFileSync(temporary,bytes);fs.renameSync(temporary,output);}finally{fs.rmSync(temporary,{force:true});}
 fs.writeFileSync(output+'.sha256',hash(bytes)+'  '+path.basename(output)+'\n');
 return {output,files:manifest.files.length,agentVersion:release.version,sha256:hash(bytes)};
}
if(require.main===module){try{
 const args=process.argv.slice(2);if(args.length&&!((args.length===2)&&args[0]==='--output'))throw Error('Usage: node build-linux-node-agent.js [--output path]');
 console.log(JSON.stringify(build(args.length?{output:args[1]}:{})));
}catch(error){console.error('Linux agent package build failed:',error.message);process.exitCode=1;}}
module.exports={build,tar};
