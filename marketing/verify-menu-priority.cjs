'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../Corngrid-web/public');
function menu(html,attribute){
 const nav=html.match(/<nav class="main-nav"[^>]*>[\s\S]*?<\/nav>/);assert.ok(nav);
 return [...nav[0].matchAll(new RegExp(attribute+'="([^"]+)"','g'))].map(m=>m[1]);
}
async function main(){
 const cssReference=fs.readFileSync(path.join(source,'dashboard.html'),'utf8').match(/href="(dashboard\.css\?v=[^"]+)"/)[1];
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  for(const [file,attribute] of [['dashboard.html','data-page'],['admin.html','data-admin-page']]){
   const response=await fetch(origin+'/'+file+'?verifyMenu=20261115',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,file);
   const html=await response.text(),expected=fs.readFileSync(path.join(source,file),'utf8');
   assert.deepEqual(menu(html,attribute),menu(expected,attribute),file);
   assert.ok(html.includes(cssReference),file);
   assert.equal((html.match(/class="nav-section-label"/g)||[]).length,file==='dashboard.html'?4:3,file);
   if(file==='dashboard.html')assert.match(html,/data-page="marketplace" data-marketplace-nav hidden/);
  }
  const css=await fetch(origin+'/'+cssReference,{signal:AbortSignal.timeout(20000)});assert.equal(css.status,200);
  assert.ok((await css.text()).includes('.nav-section-label {'));
  const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(15000)});assert.equal(health.status,200);
 }
 console.log(JSON.stringify({verified:true,liveUserMenu:true,liveAdminMenu:true,groupStyles:true,marketplaceVisibilityPreserved:true,backendHealthy:true,databaseAccessed:false}));
}
main().catch(error=>{console.error('Menu verification failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
