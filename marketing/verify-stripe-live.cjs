'use strict';
// Public routing/signature smoke check only. No order or Stripe charge is created.
const fs=require('node:fs'),path=require('node:path');
async function main(){
 const root='C:/Website/Website/Corngrid-web';
 const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync(path.join(root,'.env')));
 if(!/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY||''))throw Error('Live configuration missing.');
 const Stripe=require(path.join(root,'node_modules/stripe'));
 const stripe=new Stripe(env.STRIPE_SECRET_KEY);
 const payload=JSON.stringify({id:'evt_corngrid_deployment_'+Date.now(),type:'corngrid.deployment_check',created:Math.floor(Date.now()/1000),livemode:true,data:{object:{}}});
 const signature=stripe.webhooks.generateTestHeaderString({payload,secret:env.STRIPE_WEBHOOK_SECRET});
 const send=s=>fetch(env.APP_BASE_URL+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':s},body:payload,signal:AbortSignal.timeout(15000)});
 const invalid=await send('invalid');const valid=await send(signature);
 const readiness=await fetch('http://localhost:3000/api/health/ready',{signal:AbortSignal.timeout(8000)});
 const page=await fetch(env.APP_BASE_URL+'/dashboard.html?deploycheck='+Date.now(),{signal:AbortSignal.timeout(15000)});
 const html=await page.text();
 const asset=await fetch(env.APP_BASE_URL+'/stripe-checkout.js?v=deploy-'+Date.now(),{signal:AbortSignal.timeout(15000)});
 const js=await asset.text();
 const protectedStatus=await fetch(env.APP_BASE_URL+'/api/subscription/payment-methods',{signal:AbortSignal.timeout(10000)});
 const result={readiness:readiness.status,webhookInvalidSignature:invalid.status,webhookValidSignature:valid.status,dashboard:page.status,checkoutScript:asset.status,checkoutUI:html.includes('stripe-checkout.js')&&html.includes('payment-provider'),checkoutScriptValid:js.includes('CornGridStripe'),authenticationRequired:protectedStatus.status===401,checkedAt:new Date().toISOString()};
 if(readiness.status!==200||invalid.status!==400||valid.status!==200||!result.checkoutUI||!result.checkoutScriptValid||!result.authenticationRequired)throw Error('Public Stripe verification failed: '+JSON.stringify(result));
 fs.writeFileSync(path.join(__dirname,'stripe-live-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
