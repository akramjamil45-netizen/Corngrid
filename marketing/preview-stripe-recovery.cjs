'use strict';
// Isolated UI preview: fake Stripe, in-memory database, no production env.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../Corngrid-web');
const express=require(path.join(root,'node_modules/express')),sqlite=require(path.join(root,'node_modules/sqlite3')),Stripe=require(path.join(root,'node_modules/stripe'));
const {dbGet,dbRun}=require(path.join(root,'db-async'));
async function main(){
 const db=new sqlite.Database(':memory:');await new Promise((resolve,reject)=>db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT);INSERT INTO users VALUES(1,'Preview','preview@example.test');",e=>e?reject(e):resolve()));
 const app=express(),router=express.Router();app.use(express.json());app.use(router);
 const auth=(req,_res,next)=>{req.user={id:1};next();},admin={verifyToken:(req,_res,next)=>{req.admin={id:99};next();}};
 const sub=require(path.join(root,'subscriptions/subscription-api'))(app,db,auth,admin,auth);await sub.ready();
 let session,clock=Date.now();const sdk=new Stripe('sk_test_fixture');
 const stripe={webhooks:sdk.webhooks,checkout:{sessions:{create:async input=>{session={id:'cs_preview',url:'https://checkout.stripe.com/test',status:'open',payment_status:'unpaid',payment_intent:null,mode:'payment',livemode:false,amount_total:500,currency:'myr',client_reference_id:input.client_reference_id,metadata:input.metadata};return structuredClone(session);},retrieve:async()=>structuredClone(session)}}};
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const gateway=require(path.join(root,'subscriptions/stripe-payments'))(router,db,auth,admin,sub,{stripe,now:()=>clock,env:{STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',APP_BASE_URL:origin}});await gateway.ready();
 const plan=(await dbRun(db,"INSERT INTO subscription_plans(name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES('Preview plan',5,'MYR',30,1,1,0,0)")).lastID;
 const purchase=await (await fetch(origin+'/api/subscription/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:plan})})).json();
 const order=await (await fetch(origin+'/api/subscription/stripe/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paymentId:purchase.paymentId})})).json();
 app.get('/preview',(_req,res)=>{
  let html=fs.readFileSync(path.join(root,'public/dashboard.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace('</body>','<script src="stripe-checkout.js"></script><script src="dashboard.js"></script><script>document.querySelector("[data-page=subscription]").click();</script></body>');res.type('html').send(html);
 });
 app.get('/api/me',(_req,res)=>res.json({id:1,username:'Preview',email:'preview@example.test'}));
 app.get('/api/user/portfolio-sharing',(_req,res)=>res.json({isPublic:false,accounts:[]}));
 app.get('/api/chat/unread-count',(_req,res)=>res.json({count:0}));
 app.get('/preview-state',async(_req,res)=>res.json({payment:await dbGet(db,'SELECT status FROM subscription_payments LIMIT 1'),subscription:await dbGet(db,'SELECT status FROM user_subscriptions LIMIT 1'),events:await dbGet(db,'SELECT COUNT(*) AS n FROM stripe_events'),approvals:await dbGet(db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_approved'")}));
 app.post('/preview-pay',(_req,res)=>{
  session.status='complete';session.payment_status='paid';session.payment_intent={id:'pi_preview',status:'succeeded',currency:'myr',amount_received:500,latest_charge:{id:'ch_preview',created:Math.floor(Date.now()/1000),payment_intent:'pi_preview',paid:true,amount:500,currency:'myr',amount_refunded:0,refunded:false,disputed:false}};
  clock+=11000;res.json({fakePaymentMarkedPaid:true});
 });
 app.use(express.static(path.join(root,'public')));
 console.log(JSON.stringify({url:origin+'/preview?stripe=success&order='+order.orderId+'#subscription',origin}));
 process.on('SIGINT',async()=>{await gateway.stop();server.close(()=>db.close(()=>process.exit(0)));});
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
