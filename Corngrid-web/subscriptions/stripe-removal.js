'use strict';

// Network reconciliation happens before the subscription API takes database
// locks. The caller must recheck this proof against locked, current rows.
function createStripeRemovalReconciler({get,stripe,ready,liveMode}) {
  const blocked=message=>({http:409,body:{error:message}});
  const busy=()=>blocked('This Stripe payment is complete or processing. Wait for payment verification before removing the request.');
  function matches(session,order,payment) {
    return session.id===order.session_id && session.client_reference_id===order.id
      && session.metadata?.order_id===order.id && session.metadata?.user_id===String(order.user_id)
      && session.metadata?.payment_id===String(order.payment_id) && session.mode==='payment'
      && session.livemode===liveMode && session.amount_total===Number(order.amount_minor)
      && session.currency===order.currency && Number(order.user_id)===Number(payment.user_id)
      && Number(order.payment_id)===Number(payment.id)
      && Number(order.amount_minor)===Math.round(Number(payment.amount)*100)
      && order.currency===String(payment.currency).toLowerCase();
  }
  async function unpaid(session) {
    if(session.payment_status!=='unpaid')return false;
    if(!session.payment_intent)return true;
    const intent=typeof session.payment_intent==='string'
      ? await stripe.paymentIntents.retrieve(session.payment_intent) : session.payment_intent;
    return ['requires_payment_method','requires_confirmation','requires_action','canceled'].includes(intent?.status);
  }
  return async function reconcile(payment) {
    try {
      await ready();
      const order=await get('SELECT * FROM stripe_orders WHERE payment_id=?',[payment.id]);
      if(!order)return null;
      if(order.status==='paid'||order.paid_at!=null||order.activated_at!=null)return busy();
      if(['expired','failed'].includes(order.status))return null;
      if(!stripe)return {http:503,body:{error:'Stripe is not configured. Restore its configuration before removing this request.'}};
      if(!order.session_id)return blocked('This checkout has no saved Stripe session. It needs reconciliation before removal; no payment records were removed.');
      const retrieve=()=>stripe.checkout.sessions.retrieve(order.session_id,{expand:['payment_intent']});
      let session=await retrieve();
      if(!matches(session,order,payment))return blocked('Stripe checkout details do not match this payment. Review the order before removing it.');
      if(!await unpaid(session))return busy();
      if(session.status==='open') {
        // A competing Delete, customer payment or webhook may win this race.
        // Always retrieve again rather than treating an expiration error as success.
        try { await stripe.checkout.sessions.expire(order.session_id,{}, {idempotencyKey:'corngrid-remove-checkout-'+order.id}); }
        catch { /* the fresh Stripe status below decides whether removal is safe */ }
        session=await retrieve();
      }
      if(!matches(session,order,payment))return blocked('Stripe checkout changed during verification. Refresh and try again.');
      if(session.status==='open'&&await unpaid(session))return {http:503,body:{error:'Stripe could not close this unpaid checkout. The request was kept. Retry or check the Stripe API permissions.'}};
      if(session.status!=='expired'||!await unpaid(session))return busy();
      return {orderId:order.id,paymentId:Number(order.payment_id),userId:Number(order.user_id),sessionId:session.id,
        amountMinor:Number(order.amount_minor),currency:order.currency,status:'expired'};
    } catch(error) {
      console.error('Stripe removal reconciliation failed:',error.code||error.type||'request_failed');
      return {http:503,body:{error:'Unable to verify Stripe right now. The request was kept. Please retry.'}};
    }
  };
}
module.exports={createStripeRemovalReconciler};
