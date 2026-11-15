'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),bcrypt=require('bcryptjs');
test('a separate staging checkout boots the real backend, protects admin health and blocks email/agents',{timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-staging-startup-test-')),backend=path.join(root,'Website/Corngrid-web'),source=path.resolve(__dirname,'..');let child;
 t.after(async()=>{if(child&&child.exitCode==null){const closed=new Promise(r=>child.once('exit',r));child.kill();await closed;}assert.match(path.relative(os.tmpdir(),root),/^corngrid-staging-startup-test-[a-z0-9]+$/i);await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});});
 await fs.mkdir(backend,{recursive:true});
 const skip=new Set(['node_modules','storage','uploads','android','.git','agent-config.json','update-trust.pem']);
 for(const entry of await fs.readdir(source,{withFileTypes:true})){
  if(entry.isFile()&&/\.(?:js|json)$/.test(entry.name))await fs.copyFile(path.join(source,entry.name),path.join(backend,entry.name));
  else if(entry.isDirectory()&&['public','scripts','migrations','partner','sandbox','marketplace','subscriptions','reports','ops','service','agent'].includes(entry.name))await fs.cp(path.join(source,entry.name),path.join(backend,entry.name),{recursive:true,filter:file=>!skip.has(path.basename(file))&&!path.basename(file).startsWith('.env')});
 }
 const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}),hash=await bcrypt.hash('fixture-password',4),config=path.join(backend,'.env.staging');
 await fs.writeFile(config,['PORT='+port,'DATABASE_PATH=platform.staging.sqlite','JWT_SECRET=isolated-staging-fixture-key-longer-than-32-characters','SANDBOX_ENCRYPTION_KEY='+'e'.repeat(64),'ADMIN_EMAIL=admin@example.test','ADMIN_PASSWORD_HASH='+hash,'MARKET_FALLBACK_PROVIDER=disabled'].join('\n'),{mode:0o600});
 child=spawn(process.execPath,[path.join(backend,'scripts/start-staging.js'),'--config',config],{cwd:backend,env:{...process.env,NODE_PATH:path.join(source,'node_modules'),DATABASE_URL:'',CORNGRID_STAGING:'true'},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const base='http://127.0.0.1:'+port;let ready=false;const end=Date.now()+20000;while(Date.now()<end&&!ready){if(child.exitCode!=null)throw Error('Isolated staging backend exited before startup: '+output.slice(-1500));try{ready=(await fetch(base+'/api/health/ready')).ok;}catch{}if(!ready)await new Promise(r=>setTimeout(r,100));}assert.equal(ready,true,'Staging backend starts after all additive schemas');
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',origin:base},body:JSON.stringify({email:'admin@example.test',password:'fixture-password'})});assert.equal(login.status,200);assert.equal(login.headers.get('x-corngrid-environment'),'staging');const token=(await login.json()).token;assert.ok(token);
 const health=await fetch(base+'/api/admin/system-health',{headers:{Authorization:'Bearer '+token}});assert.equal(health.status,200);assert.equal((await health.json()).checks.find(c=>c.id==='database').status,'ok');
 assert.equal((await fetch(base+'/api/admin/security/mfa',{headers:{Authorization:'Bearer '+token}})).status,200);
 assert.equal((await fetch(base+'/api/sandbox/node/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/admin/email/settings',{headers:{Authorization:'Bearer '+token}})).status,404);
 assert.equal(output.includes('STRIPE_SECRET_KEY='),false);assert.equal(output.includes('Received SIGTERM'),false);
});
