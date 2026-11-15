'use strict';
// Read-only inspection; no Checkout creation, expiration or payment mutation.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../Corngrid-web');
const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
async function main(){
 const {Client}=require(path.join(root,'node_modules/pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 let rows;
 try{rows=(await db.query(`SELECT p.id,p.status,p.payment_method,o.* FROM subscription_payments p
  JOIN stripe_orders o ON o.payment_id=p.id WHERE p.status IN ('cancelled','rejected')
  AND NOT EXISTS (SELECT 1 FROM subscription_payment_archives a WHERE a.payment_id=p.id)
  ORDER BY p.id DESC LIMIT 10`)).rows;}finally{await db.end();}
 const stripe=require(path.join(root,'subscriptions/stripe-client')).createStripeClient(env.STRIPE_SECRET_KEY);
 const results=[];
 for(const row of rows){
  const result={paymentId:row.payment_id,orderStatus:row.status,hasSession:Boolean(row.session_id),hasIntent:Boolean(row.payment_intent_id),paid:row.paid_at!=null,activated:row.activated_at!=null};
  if(row.session_id){
   try{const session=await stripe.checkout.sessions.retrieve(row.session_id);result.stripeStatus=session.status;result.paymentStatus=session.payment_status;result.orderMetadataMatches=session.metadata?.order_id===row.id&&session.client_reference_id===row.id;result.amountMatches=session.amount_total===Number(row.amount_minor)&&session.currency===row.currency;
    if(session.payment_intent){const intent=typeof session.payment_intent==='string'?await stripe.paymentIntents.retrieve(session.payment_intent):session.payment_intent;result.intentStatus=intent.status;}
   }catch(error){result.stripeError=error.code||error.type||'request_failed';}
  }
  results.push(result);
 }
 console.log(JSON.stringify(results));
}
main().catch(error=>{console.error('Checkout inspection failed:',error.code||error.name);process.exitCode=1;});
