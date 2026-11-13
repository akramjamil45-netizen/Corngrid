'use strict';
const crypto=require('node:crypto');
const {dbGet,dbAll,dbRun,withTransaction}=require('../db-async');

function failure(code){return Object.assign(new Error(code),{code});}
function verifiedPaymentTime(session){
  const intent=session.payment_intent,charge=intent&&typeof intent==='object'?intent.latest_charge:null;
  if(!intent||typeof intent!=='object'||intent.status!=='succeeded'||intent.currency!==session.currency
    ||intent.amount_received!==session.amount_total||!charge||typeof charge!=='object'
    ||charge.payment_intent!==intent.id||!charge.paid||charge.amount!==session.amount_total||charge.currency!==session.currency
    ||!Number.isSafeInteger(charge.created)||charge.created<=0||charge.created*1000>Date.now()+300000)throw failure('STRIPE_PAYMENT_PROOF_UNAVAILABLE');
  if(charge.refunded||charge.amount_refunded>0||charge.disputed)throw failure('STRIPE_PAYMENT_REVIEW_REQUIRED');
  return charge.created*1000;
}

function createStripeReconciliation({db,stripe,ready,applySession,enabled,now=()=>Date.now(),intervalMs=60000,startupMs=5000}){
  let timer=null,closed=false,batch=null;
  async function reconcile(orderId,{userId,force=false}={}){
    await ready();
    const order=await dbGet(db,'SELECT * FROM stripe_orders WHERE id=?'+(userId==null?'':' AND user_id=?'),userId==null?[orderId]:[orderId,userId]);
    if(!order)return {missing:true};
    if(!enabled||order.activated_at||!order.session_id||!['pending','paid'].includes(order.status))return {checked:false};
    const timestamp=now(),token=crypto.randomUUID();
    const claimed=await withTransaction(db,async()=>{
      await dbRun(db,'INSERT INTO stripe_reconciliation(order_id) VALUES(?) ON CONFLICT(order_id) DO NOTHING',[order.id]);
      return dbRun(db,`UPDATE stripe_reconciliation SET lease_until=?,lease_token=?,attempts=CASE WHEN attempts<30 THEN attempts+1 ELSE 30 END
        WHERE order_id=? AND lease_until<=? AND (next_check_at<=? OR (?=1 AND (last_checked_at IS NULL OR last_checked_at<=?)))`,
      [timestamp+120000,token,order.id,timestamp,timestamp,force?1:0,timestamp-10000]);
    });
    if(!claimed.changes)return {checked:false};
    let errorCode=null;
    try{
      const session=await stripe.checkout.sessions.retrieve(order.session_id,{expand:['payment_intent.latest_charge']});
      const paidAt=session.status==='complete'&&session.payment_status==='paid'?verifiedPaymentTime(session):null;
      await applySession(session,{paidAt,reconciliation:true,expectedOrderId:order.id});
      return {checked:true};
    }catch(error){
      const raw=String(error.code||'STRIPE_RECONCILIATION_FAILED');errorCode=/^[A-Za-z0-9_-]{1,64}$/.test(raw)?raw:'STRIPE_RECONCILIATION_FAILED';
      console.error('Stripe recovery will retry:',order.id,errorCode);
      return {checked:true,errorCode};
    }finally{
      const row=await dbGet(db,'SELECT attempts FROM stripe_reconciliation WHERE order_id=?',[order.id]);
      const delay=Math.min(900000,60000*2**Math.min(4,Math.max(0,Number(row?.attempts||1)-1)));
      await dbRun(db,`UPDATE stripe_reconciliation SET lease_until=0,lease_token=NULL,last_checked_at=?,last_error_code=?,next_check_at=?
        WHERE order_id=? AND lease_token=?`,[now(),errorCode,now()+delay,order.id,token]);
    }
  }
  async function runBatch(){
    if(!enabled||closed)return {checked:0};
    if(batch)return batch;
    batch=(async()=>{
      await ready();
      const orders=await dbAll(db,`SELECT o.id FROM stripe_orders o JOIN subscription_payments p ON p.id=o.payment_id
        JOIN user_subscriptions s ON s.id=p.subscription_id LEFT JOIN stripe_reconciliation r ON r.order_id=o.id
        WHERE o.activated_at IS NULL AND o.session_id IS NOT NULL AND o.status IN ('pending','paid')
        AND p.payment_method='stripe' AND p.status IN ('pending_payment','pending_approval')
        AND s.deleted_at IS NULL AND s.status IN ('pending_payment','pending_approval')
        AND NOT EXISTS(SELECT 1 FROM subscription_payment_archives a WHERE a.payment_id=p.id)
        AND COALESCE(r.next_check_at,0)<=? AND COALESCE(r.lease_until,0)<=?
        ORDER BY COALESCE(r.next_check_at,0),o.created_at LIMIT 20`,[now(),now()]);
      let checked=0;
      for(let i=0;i<orders.length&&!closed;i+=2){
        const results=await Promise.all(orders.slice(i,i+2).map(order=>reconcile(order.id)));
        checked+=results.filter(result=>result.checked).length;
      }
      return {checked};
    })();
    try{return await batch;}finally{batch=null;}
  }
  function schedule(delay){
    if(closed||!enabled)return;
    timer=setTimeout(async()=>{timer=null;try{await runBatch();}catch(error){console.error('Stripe recovery scan failed:',error.code||'scan_failed');}finally{schedule(intervalMs);}},delay);
    timer.unref?.();
  }
  function start(){if(!timer&&!batch&&!closed)schedule(startupMs);}
  async function stop(){closed=true;clearTimeout(timer);timer=null;if(batch)await batch.catch(()=>{});}
  return {reconcile,runBatch,start,stop};
}
module.exports={createStripeReconciliation,verifiedPaymentTime};
