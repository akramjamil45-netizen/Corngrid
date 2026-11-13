'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express'),sqlite=require('sqlite3'),Stripe=require('stripe');
const {dbGet,dbRun}=require('../db-async');
const createGateway=require('../subscriptions/stripe-payments');

async function fixture(t,{startupMs=5000}={}){
 const db=new sqlite.Database(':memory:');
 await new Promise((resolve,reject)=>db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT);INSERT INTO users VALUES(1,'Preview','preview@example.test'),(2,'Other','other@example.test');",e=>e?reject(e):resolve()));
 const app=express(),router=express.Router();let gateway,clock=Date.now(),retrieves=0,unavailable=false;
 const sdk=new Stripe('sk_test_fixture'),secret='whsec_recovery_fixture',sessions=new Map();
 app.post('/api/stripe/webhook',express.raw({type:'application/json'}),(q,r)=>gateway.webhook(q,r));app.use(express.json());app.use(router);
 const auth=(q,r,n)=>{if(!q.get('X-User'))return r.sendStatus(401);q.user={id:Number(q.get('X-User'))};n();};
 const admin={verifyToken(q,r,n){if(q.get('X-Admin')!=='1')return r.sendStatus(403);q.admin={id:99};n();}};
 const sub=require('../subscriptions/subscription-api')(app,db,auth,admin,auth);await sub.ready();
 const stripe={webhooks:sdk.webhooks,checkout:{sessions:{
  async create(input){const id='cs_'+(sessions.size+1),session={id,url:'https://checkout.stripe.com/test',status:'open',payment_status:'unpaid',payment_intent:null,mode:'payment',livemode:false,amount_total:input.line_items[0].price_data.unit_amount,currency:input.line_items[0].price_data.currency,metadata:input.metadata,client_reference_id:input.client_reference_id};sessions.set(id,session);return structuredClone(session);},
  async retrieve(id){retrieves++;if(unavailable)throw Object.assign(Error('Provider unavailable'),{code:'test_provider_unavailable'});return structuredClone(sessions.get(id));},
  async expire(id){const session=sessions.get(id);session.status='expired';return structuredClone(session);}
 }}};
 const env={STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:secret,APP_BASE_URL:'http://localhost:3000'};
 const options={stripe,env,now:()=>clock,recoveryStartupMs:startupMs,recoveryIntervalMs:60000};
 gateway=createGateway(router,db,auth,admin,sub,options);gateway.mountProtection();await gateway.ready();
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await gateway.stop();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port;
 const req=(route,{method='GET',user=1,body,headers={}}={})=>fetch(base+route,{method,headers:{'X-User':String(user),'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
 const planId=(await dbRun(db,"INSERT INTO subscription_plans(name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES('Recovery test',5,'MYR',30,1,1,0,0)")).lastID;
 async function purchase(){
  const response=await req('/api/subscription/subscribe',{method:'POST',body:{planId}});assert.equal(response.status,201);const p=await response.json();
  const checkout=await req('/api/subscription/stripe/checkout',{method:'POST',body:{paymentId:p.paymentId}});assert.equal(checkout.status,200);const o=await checkout.json();
  const order=await dbGet(db,'SELECT * FROM stripe_orders WHERE id=?',[o.orderId]);
  return {...p,orderId:o.orderId,session:sessions.get(order.session_id)};
 }
 function pay(p,at=Math.floor(Date.now()/1000)-30){
  const s=p.session;s.status='complete';s.payment_status='paid';
  s.payment_intent={id:'pi_'+s.id,status:'succeeded',currency:s.currency,amount_received:s.amount_total,latest_charge:{id:'ch_'+s.id,payment_intent:'pi_'+s.id,created:at,paid:true,amount:s.amount_total,currency:s.currency,amount_refunded:0,refunded:false,disputed:false}};
  return at*1000;
 }
 async function webhook(p,id='evt_recovery_late',valid=true){
  const payload=JSON.stringify({id,type:'checkout.session.completed',livemode:false,created:p.session.payment_intent.latest_charge.created,data:{object:{id:p.session.id}}});
  return fetch(base+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':valid?sdk.webhooks.generateTestHeaderString({payload,secret}):'bad'},body:payload});
 }
 const reconcile=(p,extra={})=>req('/api/subscription/stripe/orders/'+p.orderId+'/reconcile',{method:'POST',body:{amount:0,activated:true},...extra});
 async function restart(){await gateway.stop();gateway=createGateway(express.Router(),db,auth,admin,sub,options);await gateway.ready();return gateway;}
 return {db,req,purchase,pay,webhook,reconcile,restart,get gateway(){return gateway;},get retrieves(){return retrieves;},advance(ms){clock+=ms;},setUnavailable(value){unavailable=value;}};
}

test('missing webhook is recovered by the server without any return URL and late webhooks cannot extend twice',async t=>{
 const f=await fixture(t),p=await f.purchase(),paidAt=f.pay(p);
 const read=await f.req('/api/subscription/stripe/orders/'+p.orderId);assert.equal((await read.json()).activated_at,null);
 assert.equal((await dbGet(f.db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'pending_payment');
 assert.equal((await f.gateway.runRecoveryBatch()).checked,1);
 const active=await dbGet(f.db,'SELECT * FROM user_subscriptions WHERE id=?',[p.subscriptionId]);
 assert.equal(active.status,'active');assert.equal(active.starts_at,paidAt);assert.equal(active.expires_at,paidAt+30*86400000);assert.equal(active.max_activations,1);
 assert.equal((await dbGet(f.db,'SELECT status FROM subscription_payments WHERE id=?',[p.paymentId])).status,'approved');
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM stripe_events')).n,0,'API recovery must not fabricate webhook events');
 assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='stripe_payment_reconciled'")).n,1);
 const count=f.retrieves;await f.gateway.runRecoveryBatch();assert.equal(f.retrieves,count);
 assert.equal((await f.webhook(p)).status,200);assert.equal((await f.webhook(p,'evt_second')).status,200);
 assert.equal((await dbGet(f.db,'SELECT expires_at FROM user_subscriptions WHERE id=?',[p.subscriptionId])).expires_at,active.expires_at);
 const overview=await (await f.req('/api/subscription/overview')).json();assert.equal(overview.latestPayment.payment_method,'stripe');assert.equal(overview.subscription.status,'active');
});

test('owner checks, worker and signed webhook race through the same exactly-once activation',async t=>{
 const f=await fixture(t),p=await f.purchase();f.pay(p);
 const before=f.retrieves;
 assert.equal((await f.reconcile(p,{user:2})).status,404);assert.equal(f.retrieves,before);
 assert.equal((await f.reconcile(p,{headers:{'X-User':''}})).status,401);
 assert.equal((await f.reconcile(p,{headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await f.webhook(p,'evt_invalid',false)).status,400);
 const results=await Promise.all([f.reconcile(p),f.reconcile(p),f.gateway.runRecoveryBatch(),f.webhook(p,'evt_race')]);
 assert.ok(results.filter(r=>'status'in r).every(r=>r.status===200));
 assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_approved'")).n,1);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM user_notifications')).n,2);
});

test('unpaid, expired and processing sessions do not activate; unsafe paid proof is retained for retry/review',async t=>{
 for(const mutate of [null,s=>{s.status='expired';},s=>{s.status='complete';s.payment_status='unpaid';s.payment_intent={status:'processing'};},s=>{s.amount_total++;},s=>{s.currency='usd';},s=>{s.metadata.user_id='2';},s=>{s.livemode=true;},s=>{s.payment_intent.latest_charge.refunded=true;},s=>{s.payment_intent.latest_charge.disputed=true;},s=>{s.payment_intent.latest_charge=null;}]){
  await t.test('provider state remains authoritative',async child=>{
   const f=await fixture(child),p=await f.purchase();if(mutate){f.pay(p);mutate(p.session);}await f.gateway.runRecoveryBatch();
   assert.equal((await dbGet(f.db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'pending_payment');
   assert.equal((await dbGet(f.db,'SELECT activated_at FROM stripe_orders WHERE id=?',[p.orderId])).activated_at,null);
  });
 }
});

test('provider errors back off persistently and recover after restart; owner rechecks are throttled',async t=>{
 const f=await fixture(t),p=await f.purchase();f.pay(p);f.setUnavailable(true);
 await f.gateway.runRecoveryBatch();const row=await dbGet(f.db,'SELECT * FROM stripe_reconciliation WHERE order_id=?',[p.orderId]);
 assert.equal(row.last_error_code,'test_provider_unavailable');assert.equal(row.lease_until,0);
 const attempts=f.retrieves;await f.reconcile(p);assert.equal(f.retrieves,attempts,'polling must reuse recent verification');
 await f.restart();await f.gateway.runRecoveryBatch();assert.equal(f.retrieves,attempts);
 f.setUnavailable(false);f.advance(61000);await f.gateway.runRecoveryBatch();
 assert.equal((await dbGet(f.db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'active');
});

test('recovery resumes after an abandoned lease and preserves active-renewal and expired-renewal dates',async t=>{
 const f=await fixture(t),first=await f.purchase();f.pay(first);
 await dbRun(f.db,'INSERT INTO stripe_reconciliation(order_id,lease_until,lease_token) VALUES(?,?,?)',[first.orderId,Date.now()+120000,'old_process']);
 assert.equal((await f.gateway.runRecoveryBatch()).checked,0);f.advance(121000);await f.gateway.runRecoveryBatch();
 assert.equal((await dbGet(f.db,'SELECT status FROM user_subscriptions WHERE id=?',[first.subscriptionId])).status,'active');
 const current=await dbGet(f.db,'SELECT expires_at FROM user_subscriptions WHERE id=?',[first.subscriptionId]);
 const renewal=await f.purchase();f.pay(renewal);await f.gateway.runRecoveryBatch();
 const renewed=await dbGet(f.db,'SELECT starts_at,expires_at FROM user_subscriptions WHERE id=?',[renewal.subscriptionId]);
 assert.equal(renewed.starts_at,current.expires_at);assert.equal(renewed.expires_at,current.expires_at+30*86400000);
 await dbRun(f.db,"UPDATE user_subscriptions SET status='expired',expires_at=? WHERE user_id=1",[Date.now()-86400000]);
 const lapsed=await f.purchase(),paidAt=f.pay(lapsed);await f.gateway.runRecoveryBatch();
 assert.equal((await dbGet(f.db,'SELECT starts_at FROM user_subscriptions WHERE id=?',[lapsed.subscriptionId])).starts_at,paidAt);
});

test('reconciliation audit failure rolls back the payment, license period and notifications',async t=>{
 const f=await fixture(t),p=await f.purchase();f.pay(p);
 await new Promise((resolve,reject)=>f.db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON subscription_audit_logs WHEN NEW.action='stripe_payment_reconciled' BEGIN SELECT RAISE(ABORT,'Injected recovery failure'); END;",e=>e?reject(e):resolve()));
 await f.gateway.runRecoveryBatch();
 assert.equal((await dbGet(f.db,'SELECT status FROM subscription_payments WHERE id=?',[p.paymentId])).status,'pending_payment');
 assert.equal((await dbGet(f.db,'SELECT activated_at FROM stripe_orders WHERE id=?',[p.orderId])).activated_at,null);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM user_notifications')).n,0);
 await new Promise((resolve,reject)=>f.db.exec('DROP TRIGGER fail_recovery',e=>e?reject(e):resolve()));f.advance(11000);
 assert.equal((await f.reconcile(p)).status,200);assert.equal((await dbGet(f.db,'SELECT status FROM subscription_payments WHERE id=?',[p.paymentId])).status,'approved');
});

test('the started recovery scheduler fulfills paid orders without a browser',async t=>{
 const f=await fixture(t,{startupMs:10}),p=await f.purchase();f.pay(p);f.gateway.start();
 for(let i=0;i<100;i++){if((await dbGet(f.db,'SELECT activated_at FROM stripe_orders WHERE id=?',[p.orderId])).activated_at)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal((await dbGet(f.db,'SELECT status FROM subscription_payments WHERE id=?',[p.paymentId])).status,'approved');await f.gateway.stop();
});
