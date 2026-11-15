'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),sqlite=require('sqlite3').verbose(),fs=require('node:fs'),path=require('node:path');
const {createSystemHealth,registerSystemHealth}=require('../system-health');
const STAMP=1800000000000;
function options(db,extra={}){return {db,now:()=>STAMP,host:{totalmem:()=>8*1024**3,freemem:()=>4*1024**3},processInfo:{memoryUsage:()=>({rss:64*1048576}),uptime:()=>120},files:{statfs:async()=>({bavail:10000,bsize:1048576})},...extra};}
function fakeDb(extra={}){let reads=0;return {get(sql,_params,callback){reads++;if(sql==='SELECT 1 AS ok')callback(null,{ok:1});else if(sql.includes('FROM sandbox_nodes'))callback(null,{total:2,active:2,online:1,offline:1,resourceWarnings:0});else if(sql.includes('FROM sandbox_instances'))callback(null,{total:1,running:1,failed:0,delayed:0});else if(sql.includes('FROM mt5_accounts'))callback(null,{linked:4,reporting:1,latest:STAMP});else if(sql.includes('FROM stripe_orders'))callback(null,{open:2,paid:0,retries:1,latest:STAMP});else if(sql.includes('FROM stripe_events'))callback(null,{latest:STAMP});else callback(null,{delayed:0});},get reads(){return reads;},...extra};}
test('health is read-only, cached and shared across concurrent requests; observed outages are actionable',async()=>{
 const db=fakeDb(),service=createSystemHealth(options(db,{stripeEnabled:true,stripeWebhookConfigured:true}));const [a,b]=await Promise.all([service.snapshot(),service.snapshot()]);assert.strictEqual(a,b);const reads=db.reads;assert.strictEqual(await service.snapshot(),a);assert.equal(db.reads,reads);assert.equal(a.status,'warning');assert.equal(a.checks.find(c=>c.id==='nodes').values.offline,1);assert.equal(a.checks.find(c=>c.id==='payments').values.retryOrders,1);assert.equal(a.checks.find(c=>c.id==='mt5').status,'ok','offline linked accounts are not claimed to be failed EAs');
});
test('database failure and timeout never expose raw SQL, credentials or a false healthy state',async()=>{
 for(const db of [fakeDb({get(_s,_p,cb){cb(Error('private-password database URL'));}}),fakeDb({get(){}})]){
  const service=createSystemHealth(options(db,{timeoutMs:5})),result=await service.snapshot();assert.equal(result.status,'critical');assert.equal(result.checks.find(c=>c.id==='nodes').status,'unknown');assert.equal(JSON.stringify(result).includes('private-password'),false);
 }
});
test('missing feature schema, low storage, local Stripe configuration and paused updates are represented honestly',async()=>{
 const db=fakeDb({get(sql,p,cb){if(sql==='SELECT 1 AS ok')cb(null,{ok:1});else cb(Error('missing schema with private details'));}});
 const result=await createSystemHealth(options(db,{files:{statfs:async()=>({bavail:200,bsize:1048576})},stripeEnabled:true})).snapshot();assert.equal(result.checks.find(c=>c.id==='storage').status,'critical');assert.equal(result.checks.find(c=>c.id==='payments').status,'unknown');assert.equal(JSON.stringify(result).includes('private details'),false);
 const normal=await createSystemHealth(options(fakeDb(),{stripeEnabled:true,stripeWebhookConfigured:false,updateStatus:()=>({configured:true,enabled:false,release:{version:'1.3.0'},signingKey:'private-key'})})).snapshot();assert.equal(normal.checks.find(c=>c.id==='payments').status,'warning');assert.equal(normal.checks.find(c=>c.id==='updates').values.enabled,false);assert.equal(JSON.stringify(normal).includes('private-key'),false);
});
test('health route requires administrator authorization before collecting and uses private no-store responses',async t=>{
 const app=express(),db=fakeDb();registerSystemHealth(app,{...options(db),verifyAdminToken:(req,res,next)=>req.headers.authorization==='Bearer fixture-admin'?next():res.sendStatus(403)});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/admin/system-health')).status,403);assert.equal(db.reads,0);
 const response=await fetch(base+'/api/admin/system-health',{headers:{authorization:'Bearer fixture-admin'}});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private, no-store/);assert.equal((await response.json()).checks.length,10);
});
test('health aggregates execute against SQLite and distinguish paid awaiting activation from abandoned checkouts',async t=>{
 const db=new sqlite.Database(':memory:');t.after(()=>new Promise(r=>db.close(r)));await new Promise((resolve,reject)=>db.exec(`
 CREATE TABLE sandbox_nodes(status TEXT,last_heartbeat_at INTEGER,disk_free_mb INTEGER,ram_mb INTEGER,memory_used_mb REAL,cpu_percent REAL);
 CREATE TABLE sandbox_instances(status TEXT,updated_at INTEGER,deleted_at INTEGER);
 CREATE TABLE mt5_accounts(last_heartbeat INTEGER);
 CREATE TABLE sandbox_deployments(status TEXT,created_at INTEGER);
 CREATE TABLE stripe_orders(id TEXT,payment_id INTEGER,status TEXT,activated_at INTEGER);
 CREATE TABLE stripe_reconciliation(order_id TEXT,last_error_code TEXT,last_checked_at INTEGER);
 CREATE TABLE subscription_payments(id INTEGER,subscription_id INTEGER,status TEXT);
 CREATE TABLE user_subscriptions(id INTEGER,status TEXT,deleted_at INTEGER);
 CREATE TABLE subscription_payment_archives(payment_id INTEGER);
 CREATE TABLE stripe_events(processed_at INTEGER);
 INSERT INTO sandbox_nodes VALUES('active',${STAMP},10000,8000,2000,10),('active',0,100,8000,7900,95),('disabled',0,0,0,0,0);
 INSERT INTO sandbox_instances VALUES('running',${STAMP},NULL),('starting',0,NULL),('failed',0,1);
 INSERT INTO mt5_accounts VALUES(${STAMP}), (0);
 INSERT INTO sandbox_deployments VALUES('queued',0),('completed',0);
 INSERT INTO user_subscriptions VALUES(1,'pending_payment',NULL);
 INSERT INTO subscription_payments VALUES(1,1,'pending_payment');
 INSERT INTO stripe_orders VALUES('paid',1,'paid',NULL),('cancelled',1,'cancelled',NULL);
 `,e=>e?reject(e):resolve()));
 const result=await createSystemHealth(options(db,{stripeEnabled:true,stripeWebhookConfigured:true})).snapshot();assert.equal(result.status,'critical');const by=id=>result.checks.find(c=>c.id===id);assert.equal(by('payments').values.paidAwaitingActivation,1);assert.equal(by('payments').values.openCheckouts,1);assert.equal(by('nodes').values.offline,1);assert.equal(by('nodes').values.resourceWarnings,0,'outdated metrics are excluded');assert.equal(by('sandboxes').values.delayed,1);assert.equal(by('commands').values.delayed,1);assert.equal(by('mt5').values.reporting,1);assert.ok(result.checks.every(c=>c.status!=='unknown'));
});
test('admin health is routable through IIS, page navigation and dedicated mobile layout',()=>{
 const root=path.resolve(__dirname,'../..'),html=fs.readFileSync(path.join(root,'Corngrid-web/public/admin.html'),'utf8'),js=fs.readFileSync(path.join(root,'Corngrid-web/public/admin.js'),'utf8');assert.match(html,/data-admin-page="system-health"/);assert.match(html,/admin-health\.js\?v=/);assert.match(js,/CornGridAdminHealth\?\.open/);
 for(const file of ['web.config','web.config.xml'])assert.match(fs.readFileSync(path.join(root,file),'utf8'),/admin-health\\\.js/);
});
