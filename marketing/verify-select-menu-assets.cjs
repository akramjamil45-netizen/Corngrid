'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../Corngrid-web/public'),version='20261115-menus1';
async function main(){
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  for(const name of ['corngrid-select.css','corngrid-select.js']){
   const response=await fetch(origin+'/'+name+'?v='+version,{signal:AbortSignal.timeout(15000)});
   assert.equal(response.status,200,name);assert.match(response.headers.get('content-type'),name.endsWith('.css')?/text\/css/:/(?:text|application)\/javascript/);
   const actual=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(path.join(source,name));
   assert.equal(crypto.createHash('sha256').update(actual).digest('hex'),crypto.createHash('sha256').update(expected).digest('hex'),name);
  }
  for(const name of ['dashboard.html','admin.html']){
   const response=await fetch(origin+'/'+name,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,name);
   const html=await response.text();assert.ok(html.includes('corngrid-select.css?v='+version));assert.ok(html.includes('corngrid-select.js?v='+version));
   assert.equal((html.match(/src="corngrid-select\.js/g)||[]).length,1,'Duplicate component registration');
  }
  const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(15000)});assert.equal(health.status,200);
 }
 const sw=await(await fetch('https://corngrid.com/sw.js',{signal:AbortSignal.timeout(15000)})).text();
 for(const name of ['corngrid-select.css','corngrid-select.js'])assert.equal(sw.split("'/"+name+"'").length-1,2,'Worker asset registration');
 console.log(JSON.stringify({localAndLiveAssetsVerified:true,userAndAdminRegistered:true,serviceWorkerReady:true,backendHealthy:true,databaseAccessed:false}));
}
main().catch(e=>{console.error('Select menu assets verification failed:',e.code||e.name);process.exitCode=1;});
