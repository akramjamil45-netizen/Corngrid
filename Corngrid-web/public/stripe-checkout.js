(() => {
 'use strict';
 const ms=false; // Workplace checkout uses English consistently.
 const text=(en,bm)=>ms?bm:en;
 const $=s=>document.querySelector(s);let payment,orderId,timer;
 const select=$('#payment-provider'),panel=$('#stripe-checkout-panel'),button=$('#stripe-checkout-button');
 $('#payment-provider-label').textContent=text('Payment method','Kaedah pembayaran');
 select.options[1].text=text('Card / Stripe','Kad / Stripe');
 $('#stripe-checkout-help').textContent=text('One-time card payment. No automatic renewal.','Bayaran kad sekali sahaja. Tiada pembaharuan automatik.');
 button.textContent=text('Continue to Stripe','Teruskan ke Stripe');
 async function request(url,options={}){const r=await fetch('/api/subscription/'+url,{credentials:'same-origin',signal:options.signal||AbortSignal.timeout(45000),...options,headers:{'Content-Type':'application/json',...options.headers}});const data=await r.json();if(!r.ok)throw Error(data.error||text('Unable to check payment.','Tidak dapat menyemak bayaran.'));return data;}
 function render(){panel.hidden=select.value!=='stripe';$('#subscription-payment-section .subscription-payment-layout').hidden=select.value==='stripe';if(payment){$('#stripe-checkout-summary').textContent=payment.planName+' · '+new Intl.NumberFormat(ms?'ms-MY':'en',{style:'currency',currency:payment.currency}).format(payment.amount);window.CornGridExperience?.setPayment({...payment,payment_method:select.value},select.value);}}
 const checkedPayments=new Set();
 let checking;
 async function checkPayment(){
  if(checking)return checking;
  checking=(async()=>{if(!orderId&&payment){const o=await request('stripe/payment/'+payment.id);orderId=o.id;}if(!orderId)throw Error('Start a card checkout before checking its status.');const value=await request('stripe/orders/'+encodeURIComponent(orderId)+'/reconcile',{method:'POST',body:'{}'});window.CornGridExperience?.setOrder(value);if(value.activated_at)document.dispatchEvent(new Event('corngrid:payment-confirmed'));return value;})().finally(()=>{checking=null;});return checking;
 }
 window.CornGridStripe={checkPayment,setPayment(value,provider){if(payment?.id!==value.id)orderId=null;payment=value;select.value=provider==='stripe'?'stripe':'duitnow';if(provider==='stripe'){select.disabled=true;request('stripe/payment/'+value.id).then(async o=>{if(payment?.id!==value.id||select.value!=='stripe')return;orderId=o.id;window.CornGridExperience?.setOrder(o);if(['pending','paid'].includes(o.status)&&!checkedPayments.has(value.id)){checkedPayments.add(value.id);await checkPayment();}}).catch(()=>{}).finally(()=>select.disabled=false);}render();}};
 request('payment-methods').then(v=>select.options[1].disabled=!v.stripe).catch(()=>{});
 select.addEventListener('change',async()=>{let failure;if(select.value==='duitnow'&&orderId){try{await request('stripe/orders/'+encodeURIComponent(orderId)+'/duitnow',{method:'POST',body:'{}'});orderId=null;}catch(e){select.value='stripe';failure=e.message;}}render();if(failure){$('#stripe-checkout-summary').textContent=failure;$('#stripe-checkout-summary').setAttribute('role','alert');}});
 button.addEventListener('click',async()=>{if(!payment)return;button.disabled=true;try{const r=await request('stripe/checkout',{method:'POST',body:JSON.stringify({paymentId:payment.id})});orderId=r.orderId;if(!r.url)throw Error(text('Checkout ended. Check payment status or select DuitNow.','Checkout tamat. Semak status atau pilih DuitNow.'));location.assign(r.url);}catch(e){$('#stripe-checkout-summary').textContent=e.message;}finally{button.disabled=false;}});
 const params=new URLSearchParams(location.search),id=params.get('order');
 if(id&&['success','cancel'].includes(params.get('stripe'))){
  orderId=id;const host=document.createElement('section');host.className='panel';host.style.cssText='padding:20px;margin-bottom:20px';
  const title=document.createElement('h2'),status=document.createElement('p'),retry=document.createElement('button'),back=document.createElement('button');
  status.setAttribute('role','status');retry.className='button button-primary';back.className='button button-secondary';back.style.margin='8px';
  title.textContent=text('Card payment','Pembayaran kad');retry.textContent=text('Check again','Semak semula');back.textContent=text('Retry / choose DuitNow','Cuba semula / pilih DuitNow');
  host.append(title,status,retry,back);$('#page-subscription .page-heading').after(host);
  back.onclick=()=>{host.hidden=true;$('#subscription-payment-section').scrollIntoView({behavior:'smooth'});};
  let count=0;async function check(){clearTimeout(timer);retry.disabled=true;count++;let again=false;try{const o=await request('stripe/orders/'+encodeURIComponent(id)+'/reconcile',{method:'POST',body:'{}'});
   status.textContent=o.activated_at?text('Payment confirmed. Subscription activated.','Bayaran disahkan. Langganan diaktifkan.'):(['expired','failed'].includes(o.status)?text('Payment not completed. You can retry or choose DuitNow.','Bayaran belum selesai. Cuba semula atau pilih DuitNow.'):(params.get('stripe')==='cancel'?text('Checkout closed. Check payment status, retry or choose DuitNow.','Checkout ditutup. Semak status bayaran, cuba semula atau pilih DuitNow.'):text('Payment is being verified.','Pembayaran sedang disahkan.')));
   window.CornGridExperience?.setOrder(o);
   if(o.activated_at){if(o.expires_at)status.textContent+=' '+text('Expires: ','Tamat: ')+new Date(Number(o.expires_at)).toLocaleDateString(ms?'ms-MY':'en');document.dispatchEvent(new Event('corngrid:payment-confirmed'));}
   if(!o.activated_at&&o.status==='pending'&&count<12)again=true;
   else if(count>=12)status.textContent+=text(' Confirmation is taking longer. Check again shortly.',' Pengesahan mengambil masa. Semak semula sebentar lagi.');
  }catch(e){status.textContent=e.message;again=count<12;}finally{retry.disabled=false;if(again)timer=setTimeout(check,5000);}}
  retry.onclick=()=>{count=0;check();};check();window.addEventListener('pagehide',()=>clearTimeout(timer));
 }
})();
