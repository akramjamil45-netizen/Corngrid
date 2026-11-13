'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express'),sqlite=require('sqlite3');
const {dbGet,dbRun}=require('../db-async');

async function fixture(t){
 const db=new sqlite.Database(':memory:');
 await new Promise((resolve,reject)=>db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT);INSERT INTO users VALUES(1,'Preview','preview@example.test');",e=>e?reject(e):resolve()));
 const app=express();app.use(express.json());
 const user=(req,_res,next)=>{req.user={id:1};next();};
 const admin={verifyToken(req,res,next){if(req.get('X-Admin')!=='1')return res.sendStatus(403);req.admin={id:99};next();}};
 const subscriptions=require('../subscriptions/subscription-api')(app,db,user,admin,user);await subscriptions.ready();
 const router=express.Router();app.use(router);
 let session,expires=0,retrieves=0,expireBehavior=null,retrieveBehavior=null;
 const stripe={checkout:{sessions:{
  async retrieve(){retrieves++;if(retrieveBehavior)return retrieveBehavior(session);return structuredClone(session);},
  async expire(id,_params,options){expires++;assert.equal(id,session.id);assert.ok(options.idempotencyKey);if(expireBehavior)return expireBehavior(session);session.status='expired';return structuredClone(session);}
 }},paymentIntents:{async retrieve(){throw Error('All test intents should be expanded');}}};
 const gateway=require('../subscriptions/stripe-payments')(router,db,user,admin,subscriptions,{stripe,env:{STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',APP_BASE_URL:'http://localhost:3000'}});await gateway.ready();
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port;
 const request=(route,method='GET',headers={'X-Admin':'1'})=>fetch(base+route,{method,headers});
 async function add(){
  const sub=(await dbRun(db,"INSERT INTO user_subscriptions(user_id,status,purchase_price,created_at,updated_at) VALUES(1,'cancelled',50,0,0)")).lastID;
  const id=(await dbRun(db,"INSERT INTO subscription_payments(user_id,subscription_id,amount,currency,payment_method,status,created_at,updated_at) VALUES(1,?,50,'MYR','stripe','cancelled',0,0)",[sub])).lastID;
  const order='order_'+id;
  await dbRun(db,"INSERT INTO stripe_orders(id,payment_id,user_id,amount_minor,currency,session_id,status,created_at) VALUES(?,?,1,5000,'myr',?,'pending',0)",[order,id,'cs_'+id]);
  session={id:'cs_'+id,status:'open',payment_status:'unpaid',payment_intent:null,livemode:false,mode:'payment',amount_total:5000,currency:'myr',client_reference_id:order,metadata:{order_id:order,user_id:'1',payment_id:String(id)}};
  return {id,sub,order};
 }
 const remove=(id,headers)=>request('/api/admin/subscription-payments/'+id,'DELETE',headers);
 return {db,add,remove,request,gateway,stripe,get session(){return session;},get expires(){return expires;},get retrieves(){return retrieves;},setExpire(fn){expireBehavior=fn;},setRetrieve(fn){retrieveBehavior=fn;}};
}

test('admin Delete expires an abandoned checkout, archives once, and accepts late expired webhooks',async t=>{
 const f=await fixture(t),{id,sub,order}=await f.add();
 assert.equal((await f.remove(id,{})).status,403);assert.equal(f.retrieves,0);
 const results=await Promise.all([f.remove(id),f.remove(id)]);assert.ok(results.every(r=>r.status===200));
 assert.equal((await dbGet(f.db,'SELECT status FROM stripe_orders WHERE id=?',[order])).status,'expired');
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM subscription_payment_archives')).n,1);
 assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_deleted'")).n,1);
 assert.deepEqual((await (await f.request('/api/admin/subscription-payments')).json()).payments,[]);
 const expirations=f.expires;assert.equal((await f.remove(id)).status,200);assert.equal(f.expires,expirations);
 await f.gateway.processEvent({id:'evt_late_expired',type:'checkout.session.expired',created:Math.floor(Date.now()/1000),data:{object:{id:f.session.id}}});
 assert.equal((await dbGet(f.db,'SELECT status FROM user_subscriptions WHERE id=?',[sub])).status,'cancelled');
 assert.ok(await dbGet(f.db,'SELECT id FROM subscription_payments WHERE id=?',[id]));
});

test('paid, processing, metadata-mismatched and missing-session requests are retained',async t=>{
 const f=await fixture(t);
 for(const mutate of [s=>{s.payment_status='paid';s.status='complete';},s=>{s.status='complete';s.payment_intent={status:'processing'};},s=>{s.payment_intent={status:'requires_capture'};},s=>{s.metadata.user_id='2';},s=>{s.amount_total++;},s=>{s.currency='usd';},s=>{s.livemode=true;},s=>{s.payment_intent={status:'unknown'};}]){
  const {id}=await f.add();mutate(f.session);const before=f.expires;
  assert.equal((await f.remove(id)).status,409);assert.equal(f.expires,before);
  assert.equal(await dbGet(f.db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[id]),undefined);
 }
 const {id}=await f.add();await dbRun(f.db,'UPDATE stripe_orders SET session_id=NULL WHERE payment_id=?',[id]);assert.equal((await f.remove(id)).status,409);
});

test('expiration races re-read Stripe; completed payments and provider outages cannot be removed',async t=>{
 const f=await fixture(t);
 let item=await f.add();
 f.setExpire(s=>{s.status='expired';throw Error('Another request expired it');});assert.equal((await f.remove(item.id)).status,200);
 item=await f.add();
 f.setExpire(s=>{s.status='complete';s.payment_status='paid';throw Error('Customer paid first');});assert.equal((await f.remove(item.id)).status,409);
 assert.equal(await dbGet(f.db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[item.id]),undefined);
 item=await f.add();f.setExpire(()=>{throw Error('Network failed');});assert.equal((await f.remove(item.id)).status,503);
 f.setRetrieve(()=>{throw Object.assign(Error('Unavailable'),{code:'test_network_failure'});});assert.equal((await f.remove(item.id)).status,503);
 assert.equal(await dbGet(f.db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[item.id]),undefined);
});

test('local payment changes and audit failures roll back queue removal after remote expiration',async t=>{
 const f=await fixture(t);let item=await f.add();
 f.setExpire(async s=>{s.status='expired';await dbRun(f.db,"UPDATE subscription_payments SET status='approved' WHERE id=?",[item.id]);return structuredClone(s);});
 assert.equal((await f.remove(item.id)).status,409);
 assert.equal(await dbGet(f.db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[item.id]),undefined);
 item=await f.add();f.setExpire(s=>{s.status='expired';return structuredClone(s);});
 await new Promise((resolve,reject)=>f.db.exec("CREATE TRIGGER fail_delete_audit BEFORE INSERT ON subscription_audit_logs WHEN NEW.action='payment_deleted' BEGIN SELECT RAISE(ABORT,'Injected audit error'); END;",e=>e?reject(e):resolve()));
 assert.equal((await f.remove(item.id)).status,500);
 assert.equal((await dbGet(f.db,'SELECT status FROM stripe_orders WHERE payment_id=?',[item.id])).status,'pending');
 assert.equal(await dbGet(f.db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[item.id]),undefined);
 await new Promise((resolve,reject)=>f.db.exec('DROP TRIGGER fail_delete_audit',e=>e?reject(e):resolve()));
 assert.equal((await f.remove(item.id)).status,200);
});
