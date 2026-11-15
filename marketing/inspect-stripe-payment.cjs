'use strict';
// Read-only diagnosis of one existing payment. Never creates or mutates charges.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../Corngrid-web');
const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
async function main(){
 const paymentId=Number(process.argv[2]||19);if(!Number.isSafeInteger(paymentId)||paymentId<1)throw Error('Invalid payment');
 const {Client}=require(path.join(root,'node_modules/pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 let row,processed;
 try{
  row=(await db.query(`SELECT p.id AS payment_id,p.user_id,p.subscription_id,p.status AS payment_status,p.amount,p.currency,p.payment_method,
   s.status AS subscription_status,s.starts_at,s.expires_at,s.deleted_at,o.* FROM subscription_payments p
   LEFT JOIN user_subscriptions s ON s.id=p.subscription_id LEFT JOIN stripe_orders o ON o.payment_id=p.id WHERE p.id=$1`,[paymentId])).rows[0];
  processed=(await db.query('SELECT id,type,processed_at FROM stripe_events ORDER BY processed_at DESC LIMIT 8')).rows;
 }finally{await db.end();}
 if(!row)throw Error('Payment missing');
 const stripe=require(path.join(root,'subscriptions/stripe-client')).createStripeClient(env.STRIPE_SECRET_KEY);
 const result={paymentId,paymentStatus:row.payment_status,subscriptionStatus:row.subscription_status,orderStatus:row.status,amount:row.amount,currency:row.currency,provider:row.payment_method,hasSession:!!row.session_id,activated:row.activated_at!=null,startsAt:row.starts_at?new Date(Number(row.starts_at)).toISOString():null,expiresAt:row.expires_at?new Date(Number(row.expires_at)).toISOString():null,localEvents:processed};
 if(process.argv.includes('--verify-user-view')){
  const {Client}=require(path.join(root,'node_modules/pg')),check=new Client({connectionString:env.DATABASE_URL});await check.connect();let version;
  try{version=(await check.query('SELECT version FROM user_auth_versions WHERE user_id=$1',[row.user_id])).rows[0]?.version||0;}finally{await check.end();}
  const token=require(path.join(root,'node_modules/jsonwebtoken')).sign({id:Number(row.user_id),authVersion:Number(version)},env.JWT_SECRET,{expiresIn:'60s'});
  const response=await fetch('http://127.0.0.1:3000/api/subscription/overview',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}),view=await response.json();
  result.userView={http:response.status,subscriptionStatus:view.subscription?.status,paymentStatus:view.latestPayment?.status,daysRemaining:view.subscription?.daysRemaining??view.daysRemaining??null};
 }
 if(row.session_id){
  const session=await stripe.checkout.sessions.retrieve(row.session_id,{expand:['payment_intent.latest_charge']});
  if(session.status==='complete'&&session.payment_status==='paid'){
   try{result.apiRecoveryProofValid=true;result.verifiedPaidAt=new Date(require(path.join(root,'subscriptions/stripe-reconciliation')).verifiedPaymentTime(session)).toISOString();}
   catch(error){result.apiRecoveryProofValid=false;result.apiRecoveryProofError=error.code||error.name;}
  }
  result.stripe={status:session.status,paymentStatus:session.payment_status,live:session.livemode,amount:session.amount_total,currency:session.currency,metadataMatches:session.metadata?.order_id===row.id&&session.client_reference_id===row.id&&session.metadata?.payment_id===String(paymentId)&&session.metadata?.user_id===String(row.user_id),intentStatus:typeof session.payment_intent==='object'?session.payment_intent?.status:null};
  try{const events=await stripe.events.list({type:'checkout.session.completed',created:{gte:Math.floor(Number(row.created_at)/1000)-300},limit:100});result.stripeEvents=events.data.filter(event=>event.data.object.id===row.session_id).map(event=>({id:event.id,type:event.type,created:event.created,pendingWebhooks:event.pending_webhooks,live:event.livemode}));}catch(error){result.eventInspectionError=error.code||error.type;}
 }
 try{const endpoints=await stripe.webhookEndpoints.list({limit:20});result.webhooks=endpoints.data.map(endpoint=>({id:endpoint.id,url:endpoint.url,status:endpoint.status,live:endpoint.livemode,checkoutCompletedEnabled:endpoint.enabled_events.includes('*')||endpoint.enabled_events.includes('checkout.session.completed')}));}catch(error){result.webhookInspectionError=error.code||error.type;}
 console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Stripe payment inspection failed:',error.code||error.name);process.exitCode=1;});
