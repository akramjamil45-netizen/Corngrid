'use strict';
// All writes target a randomly named temporary schema, never customer tables.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../Corngrid-web');
const {Client}=require(path.join(source,'node_modules/pg'));
const express=require(path.join(source,'node_modules/express'));
const createDatabase=require(path.join(source,'db-postgres'));
const {dbGet}=require(path.join(source,'db-async'));
async function main(){
 const env=require(path.join(source,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
 const schema='payment_removal_check_'+crypto.randomBytes(8).toString('hex');
 const url=new URL(env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const control=new Client({connectionString:env.DATABASE_URL}),databases=[],servers=[];
 await control.connect();
 try{
  await control.query(`CREATE SCHEMA ${schema}`);await control.query(`SET search_path TO ${schema}`);
  await control.query('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT); CREATE TABLE mt5_accounts(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1,\'Preview\',\'preview@example.test\')');
  for(const file of ['0003_subscriptions.sql','0008_stripe.sql','0012_payment_request_archives.sql'])await control.query(fs.readFileSync(path.join(source,'migrations/postgres',file),'utf8'));
  await control.query("INSERT INTO subscription_payments(id,user_id,amount,currency,status,created_at,updated_at) VALUES(1,1,50,'MYR','cancelled',0,0),(2,1,50,'MYR','cancelled',0,0)");
  await control.query("INSERT INTO stripe_orders(id,payment_id,user_id,amount_minor,currency,status,created_at) VALUES('closed',1,1,5000,'myr','expired',0),('open',2,1,5000,'myr','pending',0)");
  await control.query("UPDATE stripe_orders SET session_id='cs_abandoned' WHERE id='open'");
  const session={id:'cs_abandoned',status:'open',payment_status:'unpaid',payment_intent:null,livemode:false,mode:'payment',amount_total:5000,currency:'myr',client_reference_id:'open',metadata:{order_id:'open',user_id:'1',payment_id:'2'}};
  const stripe={checkout:{sessions:{retrieve:async()=>structuredClone(session),expire:async()=>{session.status='expired';return structuredClone(session);}}}};
  await assert.rejects(control.query('DELETE FROM subscription_payments WHERE id=1'),error=>error.code==='23503');
  for(let n=0;n<2;n++){
   const db=createDatabase(url.toString());databases.push(db);const app=express();app.use(express.json());
   const auth=(req,_res,next)=>{req.admin={id:99};req.user={id:1};next();};
   const subscriptions=require(path.join(source,'subscriptions/subscription-api'))(app,db,auth,{verifyToken:auth},auth);await subscriptions.ready();
   subscriptions.setPaymentRemovalReconciler(require(path.join(source,'subscriptions/stripe-removal')).createStripeRemovalReconciler({get:(sql,params)=>dbGet(db,sql,params),stripe,ready:async()=>{},liveMode:false}));
   const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));servers.push(server);
  }
  const remove=(server,id)=>fetch(`http://127.0.0.1:${server.address().port}/api/admin/subscription-payments/${id}`,{method:'DELETE'});
  const replies=await Promise.all(servers.map(server=>remove(server,1)));assert.ok(replies.every(r=>r.status===200));
  const abandoned=await Promise.all(servers.map(server=>remove(server,2)));assert.ok(abandoned.every(r=>r.status===200));
  const db=databases[0];assert.ok(await dbGet(db,'SELECT id FROM subscription_payments WHERE id=1'));assert.ok(await dbGet(db,"SELECT id FROM stripe_orders WHERE id='closed'"));
  assert.equal((await dbGet(db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_deleted'")).n,2);
  assert.equal((await dbGet(db,"SELECT status FROM stripe_orders WHERE id='open'")).status,'expired');
  const list=await (await fetch(`http://127.0.0.1:${servers[0].address().port}/api/admin/subscription-payments`)).json();assert.deepEqual(list.payments,[]);
  console.log(JSON.stringify({postgresVerified:true,originalForeignKeyFailureReproduced:true,concurrentRemoval:true,stripeHistoryPreserved:true,abandonedCheckoutReconciled:true}));
 }finally{
  for(const server of servers)await new Promise(resolve=>server.close(resolve));
  for(const db of databases)await new Promise(resolve=>db.close(resolve));
  if(!/^payment_removal_check_[a-f0-9]{16}$/.test(schema))throw Error('Invalid test schema');
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();
 }
}
main().catch(error=>{console.error('Isolated payment removal verification failed:',error.code||error.message);process.exitCode=1;});
