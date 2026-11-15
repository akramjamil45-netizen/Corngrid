'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website');
const files=['README.md','TUTORIAL SETUP NODE.MD','CornGrid-Node-Agent.zip','Corngrid-web/README.md',
 'Corngrid-web/agent/check-installation.js','Corngrid-web/agent/install-service.ps1','Corngrid-web/scripts/build-node-agent.ps1',
 'Corngrid-web/docs/VPS_NODE_INSTALLATION.md','Corngrid-web/docs/WINDOWS_AGENT_SETUP.md','Corngrid-web/docs/SANDBOX_SERVER_SETUP.md','Corngrid-web/docs/SANDBOX_ARCHITECTURE.md','Corngrid-web/docs/SANDBOX_API_DOCUMENTATION.md'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(){
 if(process.argv.includes('--verify')){
  for(const file of files)assert.equal(hash(fs.readFileSync(path.join(source,file))),hash(fs.readFileSync(path.join(target,file))),file);
  const health=await fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(10000)});assert.equal(health.status,200);
  console.log(JSON.stringify({verified:true,matchingFiles:files.length,readiness:200,agentNotRestarted:true,taskRegistrationNotChanged:true}));return;
 }
 for(const file of files){assert.ok(!path.relative(source,path.resolve(source,file)).startsWith('..'));assert.ok(!path.relative(target,path.resolve(target,file)).startsWith('..'));assert.ok(fs.existsSync(path.join(source,file)),file);}
 const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-node-installation-before-'));
 for(const file of files){const old=path.join(target,file);if(fs.existsSync(old)){const saved=path.join(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(old,saved);}}
 for(const file of files){const destination=path.join(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(source,file),destination);assert.equal(hash(fs.readFileSync(path.join(source,file))),hash(fs.readFileSync(destination)),file);}
 const result={copied:files.length,backup,zipSha256:hash(fs.readFileSync(path.join(source,'CornGrid-Node-Agent.zip'))),agentNotRestarted:true,taskRegistrationNotChanged:true,deployedAt:new Date().toISOString()};fs.writeFileSync(path.join(__dirname,'node-installation-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Node installation deployment failed:',error.code||error.name);process.exitCode=1;});
