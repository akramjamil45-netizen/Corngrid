const {test}=require('node:test');const assert=require('node:assert/strict');
const express=require('express'),sqlite=require('sqlite3'),Stripe=require('stripe');
const {dbGet,dbRun}=require('../db-async');
test('Stripe signed webhooks fulfill existing subscriptions exactly once; failures, ownership and DuitNow remain safe',async t=>{
 const db=new sqlite.Database(':memory:');
 await new Promise((resolve,reject)=>db.exec('PRAGMA foreign_keys=ON',error=>error?reject(error):resolve()));
 await new Promise((r,j)=>db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT); INSERT INTO users VALUES(1,\'Alice\',\'a@example.test\'),(2,\'Bob\',\'b@example.test\');',e=>e?j(e):r()));
 const app=express();let gateway;app.post('/api/stripe/webhook',express.raw({type:'application/json'}),(q,r)=>gateway.webhook(q,r));app.use(express.json());
 const auth=(q,r,n)=>{if(!q.get('X-User'))return r.sendStatus(401);q.user={id:Number(q.get('X-User'))};n();};
 const admin={verifyToken:(q,r,n)=>{q.admin={id:99};n();}};
 const router=express.Router();app.use(router);
 const sub=require('../subscriptions/subscription-api')(app,db,auth,admin,auth);await sub.ready();
 const sdk=new Stripe('sk_test_placeholder'),secret='whsec_test_only';let session,creates=0;
 const fake={webhooks:sdk.webhooks,checkout:{sessions:{create:async(input,opt)=>{creates++;assert.ok(opt.idempotencyKey);assert.equal(Object.hasOwn(input, 'payment_method_types'), false, 'current Stripe API uses Dashboard payment methods');session={id:'cs_test_'+creates,url:'https://checkout.stripe.com/test',status:'open',payment_status:'unpaid',amount_total:input.line_items[0].price_data.unit_amount,currency:input.line_items[0].price_data.currency,metadata:input.metadata,client_reference_id:input.client_reference_id,mode:'payment',livemode:false,payment_intent:'pi_test_'+creates};return session;},retrieve:async()=>session,expire:async()=>({...session,status:'expired'})}}};
 gateway=require('../subscriptions/stripe-payments')(router,db,auth,admin,sub,{stripe:fake,env:{STRIPE_SECRET_KEY:'sk_test_placeholder',STRIPE_WEBHOOK_SECRET:secret,APP_BASE_URL:'http://localhost:3000'}});gateway.mountProtection();await gateway.ready();
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});const base='http://127.0.0.1:'+server.address().port;
 const req=(url,body,user=1)=>fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-User':String(user)},body:body?JSON.stringify(body):undefined});
 await dbRun(db,"INSERT INTO subscription_plans(name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES('Test',99,'MYR',30,5,1,0,0)");
 const plan=await dbGet(db,'SELECT * FROM subscription_plans LIMIT 1');
 const purchase=async()=>{const r=await req('/api/subscription/subscribe',{planId:plan.id});assert.equal(r.status,201);return r.json();};
 const webhook=async(id,type='checkout.session.completed',signature=true)=>{const payload=JSON.stringify({id,type,created:Math.floor(Date.now()/1000),livemode:false,data:{object:{...session}}});return fetch(base+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature?sdk.webhooks.generateTestHeaderString({payload,secret}):'bad'},body:payload});};
 let p=await purchase();let r=await req('/api/subscription/stripe/checkout',{paymentId:p.paymentId,amount:1,currency:'USD'});assert.equal(r.status,200);const order=await r.json();assert.equal(session.amount_total,Math.round(plan.price*100));assert.equal(session.currency,plan.currency.toLowerCase());
 assert.equal((await fetch(base+'/api/subscription/stripe/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch(base+'/api/subscription/stripe/checkout',{method:'POST',headers:{'Content-Type':'application/json','X-User':'1',Origin:'https://evil.example'},body:JSON.stringify({paymentId:p.paymentId})})).status,403);
 assert.equal((await req('/api/subscription/cancel',{paymentId:p.paymentId})).status,409);
 assert.equal((await req('/api/admin/subscription-payments/'+p.paymentId+'/approve',{})).status,409);
 await req('/api/subscription/stripe/checkout',{paymentId:p.paymentId});assert.equal(creates,1);
 assert.equal((await req('/api/subscription/stripe/orders/'+order.orderId,null,2)).status,404);
 assert.equal((await req('/api/subscription/stripe/orders/'+order.orderId)).status,200);
 assert.equal((await dbGet(db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'pending_payment'); // A manually opened success status cannot fulfill.
 assert.equal((await webhook('evt_bad','checkout.session.completed',false)).status,400);
 session={...session,status:'complete',payment_status:'paid'};
 session.amount_total++;assert.equal((await webhook('evt_mismatch')).status,500);session.amount_total--;
 const currency=session.currency;session.currency='jpy';assert.equal((await webhook('evt_currency')).status,500);session.currency=currency;
 assert.equal((await dbGet(db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'pending_payment');
 const delivered=await Promise.all([webhook('evt_ok'),webhook('evt_ok'),webhook('evt_other')]);assert.ok(delivered.every(r=>r.status===200));
 const active=await dbGet(db,'SELECT * FROM user_subscriptions WHERE id=?',[p.subscriptionId]);assert.equal(active.status,'active');assert.equal((await dbGet(db,'SELECT status FROM subscription_payments WHERE id=?',[p.paymentId])).status,'approved');
 await webhook('evt_again');assert.equal((await dbGet(db,'SELECT expires_at FROM user_subscriptions WHERE id=?',[p.subscriptionId])).expires_at,active.expires_at);
 // Renewal extends current expiry exactly once.
 p=await purchase();await req('/api/subscription/stripe/checkout',{paymentId:p.paymentId});session={...session,status:'complete',payment_status:'paid'};assert.equal((await webhook('evt_renew')).status,200);
 const renewal=await dbGet(db,'SELECT * FROM user_subscriptions WHERE id=?',[p.subscriptionId]);assert.equal(renewal.starts_at,active.expires_at);assert.equal(renewal.expires_at,active.expires_at+plan.duration_days*86400000);
 // Pending, failed and expired sessions never activate; cancel URL is read-only.
 p=await purchase();await req('/api/subscription/stripe/checkout',{paymentId:p.paymentId});await webhook('evt_unpaid');await webhook('evt_failed','checkout.session.async_payment_failed');session.status='expired';await webhook('evt_expired','checkout.session.expired');assert.equal((await dbGet(db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'pending_payment');
 await req('/api/subscription/stripe/orders/'+session.metadata.order_id+'/duitnow',{});assert.equal((await dbGet(db,'SELECT payment_method FROM subscription_payments WHERE id=?',[p.paymentId])).payment_method,'duitnow');
 const cancel=await req('/api/subscription/cancel',{paymentId:p.paymentId});assert.equal(cancel.status,200);
 // Regression: a switched/cancelled request still has a Stripe foreign key.
 const removedId=p.paymentId,removedOrder=session.metadata.order_id;
 const remove=()=>fetch(base+'/api/admin/subscription-payments/'+removedId,{method:'DELETE'});
 assert.ok((await Promise.all([remove(),remove()])).every(response=>response.status===200));
 assert.ok(!(await (await req('/api/admin/subscription-payments')).json()).payments.some(payment=>payment.id===removedId));
 assert.ok(await dbGet(db,'SELECT id FROM subscription_payments WHERE id=?',[removedId]));
 assert.equal((await dbGet(db,'SELECT payment_id FROM stripe_orders WHERE id=?',[removedOrder])).payment_id,removedId);
 assert.equal((await dbGet(db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_deleted' AND affected_id=?",[removedId])).n,1);
 assert.equal((await webhook('evt_expired_after_removal','checkout.session.expired')).status,200);
 assert.equal((await dbGet(db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'cancelled');
 // DuitNow purchase and manual approval still use the same activation function.
 p=await purchase();await dbRun(db,"UPDATE subscription_payments SET status='pending_approval' WHERE id=?",[p.paymentId]);await dbRun(db,"UPDATE user_subscriptions SET status='pending_approval' WHERE id=?",[p.subscriptionId]);
 assert.equal((await req('/api/admin/subscription-payments/'+p.paymentId+'/approve',{})).status,200);
 await dbRun(db,"UPDATE user_subscriptions SET status='expired',expires_at=? WHERE user_id=1 AND status='active'",[Date.now()-86400000]);
 p=await purchase();await req('/api/subscription/stripe/checkout',{paymentId:p.paymentId});session={...session,status:'complete',payment_status:'paid'};const before=Math.floor(Date.now()/1000)*1000;await webhook('evt_lapsed');
 const lapsed=await dbGet(db,'SELECT * FROM user_subscriptions WHERE id=?',[p.subscriptionId]);assert.ok(lapsed.starts_at>=before&&lapsed.starts_at<=Date.now());
 await webhook('evt_refund','charge.refunded');
 assert.equal((await dbGet(db,'SELECT status FROM user_subscriptions WHERE id=?',[p.subscriptionId])).status,'active');
});
