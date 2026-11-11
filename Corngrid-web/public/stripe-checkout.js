(() => {
 'use strict';
 const ms=(localStorage.getItem('selectedLang')||document.documentElement.lang).startsWith('ms');
 const text=(en,bm)=>ms?bm:en;
 const $=s=>document.querySelector(s);let payment,orderId,timer;
 const select=$('#payment-provider'),panel=$('#stripe-checkout-panel'),button=$('#stripe-checkout-button');
 $('#payment-provider-label').textContent=text('Payment method','Kaedah pembayaran');
 select.options[1].text=text('Card / Stripe','Kad / Stripe');
 $('#stripe-checkout-help').textContent=text('One-time card payment. No automatic renewal.','Bayaran kad sekali sahaja. Tiada pembaharuan automatik.');
 button.textContent=text('Continue to Stripe','Teruskan ke Stripe');
 async function request(url,options={}){const r=await fetch('/api/subscription/'+url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});const data=await r.json();if(!r.ok)throw Error(data.error||text('Unable to check payment.','Tidak dapat menyemak bayaran.'));return data;}
 function render(){panel.hidden=select.value!=='stripe';$('#subscription-payment-section .subscription-payment-layout').hidden=select.value==='stripe';if(payment)$('#stripe-checkout-summary').textContent=payment.planName+' · '+new Intl.NumberFormat(ms?'ms-MY':'en',{style:'currency',currency:payment.currency}).format(payment.amount);}
 window.CornGridStripe={setPayment(value,provider){payment=value;select.value=provider==='stripe'?'stripe':'duitnow';if(provider==='stripe'){select.disabled=true;request('stripe/payment/'+value.id).then(o=>{orderId=o.id;}).catch(()=>{}).finally(()=>select.disabled=false);}render();}};
 request('payment-methods').then(v=>select.options[1].disabled=!v.stripe).catch(()=>{});
 select.addEventListener('change',async()=>{if(select.value==='duitnow'&&orderId){try{await request('stripe/orders/'+encodeURIComponent(orderId)+'/duitnow',{method:'POST',body:'{}'});orderId=null;}catch(e){select.value='stripe';alert(e.message);}}render();});
 button.addEventListener('click',async()=>{if(!payment)return;button.disabled=true;try{const r=await request('stripe/checkout',{method:'POST',body:JSON.stringify({paymentId:payment.id})});orderId=r.orderId;if(!r.url)throw Error(text('Checkout ended. Check payment status or select DuitNow.','Checkout tamat. Semak status atau pilih DuitNow.'));location.assign(r.url);}catch(e){$('#stripe-checkout-summary').textContent=e.message;}finally{button.disabled=false;}});
 const params=new URLSearchParams(location.search),id=params.get('order');
 if(id&&['success','cancel'].includes(params.get('stripe'))){
  orderId=id;const host=document.createElement('section');host.className='panel';host.style.cssText='padding:20px;margin-bottom:20px';
  const title=document.createElement('h2'),status=document.createElement('p'),retry=document.createElement('button'),back=document.createElement('button');
  status.setAttribute('role','status');retry.className='button button-primary';back.className='button button-secondary';back.style.margin='8px';
  title.textContent=text('Card payment','Pembayaran kad');retry.textContent=text('Check again','Semak semula');back.textContent=text('Retry / choose DuitNow','Cuba semula / pilih DuitNow');
  host.append(title,status,retry,back);$('#page-subscription .page-heading').after(host);
  back.onclick=()=>{host.hidden=true;$('#subscription-payment-section').scrollIntoView({behavior:'smooth'});};
  let count=0;async function check(){clearTimeout(timer);retry.disabled=true;try{const o=await request('stripe/orders/'+encodeURIComponent(id));
   status.textContent=o.activated_at?text('Payment confirmed. Subscription activated.','Bayaran disahkan. Langganan diaktifkan.'):(['expired','failed'].includes(o.status)?text('Payment not completed. You can retry or choose DuitNow.','Bayaran belum selesai. Cuba semula atau pilih DuitNow.'):(params.get('stripe')==='cancel'?text('Checkout closed. Check payment status, retry or choose DuitNow.','Checkout ditutup. Semak status bayaran, cuba semula atau pilih DuitNow.'):text('Payment is being verified.','Pembayaran sedang disahkan.')));
   if(o.activated_at){if(o.expires_at)status.textContent+=' '+text('Expires: ','Tamat: ')+new Date(Number(o.expires_at)).toLocaleDateString(ms?'ms-MY':'en');document.dispatchEvent(new Event('corngrid:payment-confirmed'));}
   if(!o.activated_at&&o.status==='pending'&&++count<12)timer=setTimeout(check,3000);
   else if(count>=12)status.textContent+=text(' Confirmation is taking longer. Check again shortly.',' Pengesahan mengambil masa. Semak semula sebentar lagi.');
  }catch(e){status.textContent=e.message;}finally{retry.disabled=false;}}
  retry.onclick=()=>{count=0;check();};check();window.addEventListener('pagehide',()=>clearTimeout(timer));
 }
})();
