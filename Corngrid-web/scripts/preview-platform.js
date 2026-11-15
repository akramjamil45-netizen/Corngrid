'use strict';
// Loopback-only UI acceptance fixture. In-memory records, fixture credentials,
// no dotenv, SMTP, Stripe SDK, node connections or production database.
const express=require('express'),sqlite=require('sqlite3').verbose(),bcrypt=require('bcryptjs'),path=require('node:path'),fs=require('node:fs');
const {createMfa}=require('../mfa'),registerMfa=require('../mfa-api'),createAdmin=require('../admin-auth'),login=require('../login-handler'),{setAuthCookie,isSameOriginRequest}=require('../session-cookie'),{registerSystemHealth}=require('../system-health');
async function main(){
 const app=express(),db=new sqlite.Database(':memory:'),secret='isolated-preview-jwt-at-least-32-characters',mfa=createMfa({db,encryptionKey:'e'.repeat(64)});app.use(express.json());await mfa.ready();
 await new Promise((resolve,reject)=>db.exec(`CREATE TABLE partner_profiles(user_id INTEGER,status TEXT);
 CREATE TABLE sandbox_nodes(status TEXT,last_heartbeat_at INTEGER,disk_free_mb INTEGER,ram_mb INTEGER,memory_used_mb REAL,cpu_percent REAL);
 CREATE TABLE sandbox_instances(status TEXT,updated_at INTEGER,deleted_at INTEGER);
 CREATE TABLE mt5_accounts(last_heartbeat INTEGER);CREATE TABLE sandbox_deployments(status TEXT,created_at INTEGER);
 INSERT INTO sandbox_nodes VALUES('active',${Date.now()},20000,8192,2048,10);
 `,e=>e?reject(e):resolve()));
 const admin=createAdmin({email:'admin@example.test',passwordHash:await bcrypt.hash('fixture-password',4),jwtSecret:secret,mfa:()=>mfa}),verifyToken=(_req,res)=>res.sendStatus(403),rateLimit=()=>((_req,_res,next)=>next());
 registerMfa(app,{db,mfa,adminAuth:admin,verifyToken,jwtSecret:secret,rateLimit});
 app.post('/api/login',login({db,jwtSecret:secret,adminAuth:admin,mfa,setAuthCookie,isSameOriginRequest}));registerSystemHealth(app,{db,verifyAdminToken:admin.verifyToken,rateLimit});
 app.post('/fixture/reset',async(_req,res)=>{await new Promise((resolve,reject)=>db.exec('DELETE FROM auth_factors;DELETE FROM auth_factor_events;',e=>e?reject(e):resolve()));res.json({ok:true});});
 app.get('/fixture',(_req,res)=>{
  let html=fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace('</body>','<script src="/admin-health.js"></script><script src="/security.js"></script><script>document.querySelectorAll("main .page").forEach(e=>{e.hidden=true;e.classList.remove("is-visible")});const root=document.getElementById("system-health");root.hidden=false;root.classList.add("is-visible");CornGridAdminHealth.open();</script></body>');res.type('html').send(html);
 });
 app.use(express.static(path.join(__dirname,'../public')));const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/fixture',isolated:true})));
 process.on('SIGINT',()=>server.close(()=>db.close(()=>process.exit(0))));process.on('SIGTERM',()=>server.close(()=>db.close(()=>process.exit(0))));
}
main().catch(()=>{console.error('Isolated platform preview could not start.');process.exitCode=1;});
