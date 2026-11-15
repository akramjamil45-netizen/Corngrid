'use strict';
// Two real PostgreSQL connections; fake Stripe only; all writes are isolated.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web');
const {Client}=require(path.join(root,'node_modules/pg')),express=require(path.join(root,'node_modules/express')),Stripe=require(path.join(root,'node_modules/stripe'));
const createDb=require(path.join(root,'db-postgres')),{dbGet}=require(path.join(root,'db-async'));
async function main(){
 const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
 const schema='stripe_recovery_check_'+crypto.randomBytes(8).toString('hex'),url=new URL(env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const control=new Client({connectionString:env.DATABASE_URL}),databases=[],servers=[],gateways=[];await control.connect();
 const sdk=new Stripe('sk_test_fixture'),secret='whsec_pg_fixture',at=Math.floor(Date.now()/1000)-30;
 const session={id:'cs_pg_recovery',mode:'payment',livemode:false,status:'complete',payment_status:'paid',amount_total:500,currency:'myr',client_reference_id:'pg_order',metadata:{order_id:'pg_order',payment_id:'1',user_id:'1'},payment_intent:{id:'pi_pg',status:'succeeded',currency:'myr',amount_received:500,latest_charge:{id:'ch_pg',created:at,paid:true,payment_intent:'pi_pg',amount:500,currency:'myr',amount_refunded:0,disputed:false,refunded:false}}};
 const stripe={webhooks:sdk.webhooks,checkout:{sessions:{retrieve:async()=>structuredClone(session)}}};
 try{
  await control.query(`CREATE SCHEMA ${schema}`);await control.query(`SET search_path TO ${schema}`);
  await control.query("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT);CREATE TABLE mt5_accounts(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1,'Preview','preview@example.test')");
  for(const file of ['0003_subscriptions.sql','0008_stripe.sql','0012_payment_request_archives.sql','0013_stripe_reconciliation.sql'])await control.query(fs.readFileSync(path.join(root,'migrations/postgres',file),'utf8'));
  await control.query("INSERT INTO subscription_plans(id,name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES(1,'Preview',5,'MYR',30,1,TRUE,0,0)");
  await control.query("INSERT INTO user_subscriptions(id,user_id,plan_id,status,purchase_price,currency,duration_days,max_activations,created_at,updated_at) VALUES(1,1,1,'pending_payment',5,'MYR',30,1,0,0)");
  await control.query("INSERT INTO subscription_payments(id,user_id,subscription_id,plan_id,amount,currency,payment_method,status,created_at,updated_at) VALUES(1,1,1,1,5,'MYR','stripe','pending_payment',0,0)");
  await control.query("INSERT INTO stripe_orders(id,payment_id,user_id,amount_minor,currency,session_id,status,created_at) VALUES('pg_order',1,1,500,'myr','cs_pg_recovery','pending',0)");
  for(let i=0;i<2;i++){
   const db=createDb(url.toString());databases.push(db);const app=express(),router=express.Router();let gateway;
   app.post('/api/stripe/webhook',express.raw({type:'application/json'}),(req,res)=>gateway.webhook(req,res));app.use(express.json());app.use(router);
   const auth=(req,_res,next)=>{req.user={id:1};next();},admin={verifyToken:(req,_res,next)=>{req.admin={id:99};next();}};
   const subscriptions=require(path.join(root,'subscriptions/subscription-api'))(app,db,auth,admin,auth);await subscriptions.ready();
   gateway=require(path.join(root,'subscriptions/stripe-payments'))(router,db,auth,admin,subscriptions,{stripe,env:{STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:secret,APP_BASE_URL:'http://localhost:3000'}});await gateway.ready();gateways.push(gateway);
   const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));servers.push(server);
  }
  const origin=index=>'http://127.0.0.1:'+servers[index].address().port;
  const payload=JSON.stringify({id:'evt_pg_recovery',type:'checkout.session.completed',created:at,livemode:false,data:{object:{id:session.id}}});
  const webhook=()=>fetch(origin(1)+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':sdk.webhooks.generateTestHeaderString({payload,secret})},body:payload});
  const responses=await Promise.all([gateways[0].runRecoveryBatch(),gateways[1].runRecoveryBatch(),fetch(origin(0)+'/api/subscription/stripe/orders/pg_order/reconcile',{method:'POST'}),webhook()]);
  assert.ok(responses.filter(result=>'status'in result).every(result=>result.status===200));
  const db=databases[0],subscription=await dbGet(db,'SELECT * FROM user_subscriptions WHERE id=1');
  assert.equal(subscription.status,'active');assert.equal(subscription.starts_at,at*1000);assert.equal(subscription.expires_at,at*1000+30*86400000);assert.equal(subscription.max_activations,1);
  assert.equal((await dbGet(db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_approved'")).n,1);
  await webhook();await gateways[0].runRecoveryBatch();assert.equal((await dbGet(db,'SELECT expires_at FROM user_subscriptions WHERE id=1')).expires_at,subscription.expires_at);
  console.log(JSON.stringify({postgresVerified:true,twoWorkersAndWebhook:true,activationExactlyOnce:true,lateWebhookSafe:true,renewalLimitPreserved:true}));
 }finally{
  for(const gateway of gateways)await gateway.stop();
  for(const server of servers)await new Promise(resolve=>server.close(resolve));
  for(const db of databases)await new Promise(resolve=>db.close(resolve));
  if(!/^stripe_recovery_check_[a-f0-9]{16}$/.test(schema))throw Error('Unexpected test schema');
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();
 }
}
main().catch(error=>{console.error('Stripe recovery PostgreSQL check failed:',error.code||error.name);process.exitCode=1;});
