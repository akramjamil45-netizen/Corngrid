'use strict';
// Redeliver one existing Stripe event; no Checkout, PaymentIntent or charge creation.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../Corngrid-web');
const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
async function main(){
 const stripe=require(path.join(root,'subscriptions/stripe-client')).createStripeClient(env.STRIPE_SECRET_KEY);
 const eventId='evt_1UajTBDiY6QdZFzMamLwI2J0',endpointId='we_1UaPvEDiY6QdZFzMrhFOsDhB';
 const event=await stripe.events.retrieve(eventId),endpoint=await stripe.webhookEndpoints.retrieve(endpointId);
 if(!event.livemode||event.type!=='checkout.session.completed'||event.data.object.metadata?.payment_id!=='19'||endpoint.url!=='https://corngrid.com/api/stripe/webhook'||!endpoint.livemode)throw Error('Unexpected event or destination');
 const result=spawnSync(path.join(root,'storage/stripe-test/cli/stripe.exe'),['events','resend',eventId,'--webhook-endpoint',endpointId,'--live','--confirm','--color','off'],{encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,STRIPE_API_KEY:env.STRIPE_SECRET_KEY}});
 let data;try{data=JSON.parse(result.stdout);}catch{}
 console.log(JSON.stringify({exit:result.status,eventId:data?.id||null,type:data?.type||null,pendingWebhooks:data?.pending_webhooks??null,errorType:data?.error?.type||null,errorCode:data?.error?.code||result.error?.code||null,parseable:Boolean(data)}));
}
main().catch(error=>{console.error('Existing event redelivery failed:',error.code||error.name);process.exitCode=1;});
