(() => {
 'use strict';
 const root=document.getElementById('system-health');if(!root)return;
 const labels={backend:'Website backend',database:'Database',memory:'Server memory',storage:'Server storage',nodes:'Sandbox nodes',sandboxes:'Sandbox instances',mt5:'MT5 reporting',payments:'Stripe verification',commands:'Sandbox commands',updates:'Agent updates'};
 const statuses={ok:'Healthy',warning:'Needs attention',critical:'Critical',unknown:'Unavailable',disabled:'Not configured'};
 const fields={uptimeSeconds:'Uptime (seconds)',processMemoryMb:'Backend memory (MB)',engine:'Database',latencyMs:'Response (ms)',usedPercent:'Used (%)',totalMb:'Total (MB)',freeMb:'Free (MB)',total:'Total',active:'Active',online:'Online',offline:'Offline',resourceWarnings:'Resource warnings',running:'Running',failed:'Failed',delayed:'Delayed over 10 minutes',linked:'Linked accounts',reporting:'Recent heartbeats',lastHeartbeatAt:'Latest heartbeat',configured:'Configured locally',webhookConfigured:'Webhook configured locally',openCheckouts:'Open checkouts',paidAwaitingActivation:'Paid awaiting activation',retryOrders:'Checks requiring retry',lastCheckedAt:'Latest reconciliation',lastWebhookAt:'Latest processed webhook',enabled:'Automatic updates',version:'Published version'};
 const titles=root.querySelector('[data-health-cards]'),summary=root.querySelector('[data-health-summary]'),stamp=root.querySelector('[data-health-time]');
 let active=false,timer=null,controller=null;
 const el=(tag,text,className)=>{const item=document.createElement(tag);if(text!=null)item.textContent=text;if(className)item.className=className;return item;};
 function format(key,value){if(value==null)return 'Not observed';if(typeof value==='boolean')return value?'Yes':'No';if(key.endsWith('At'))return new Date(value).toLocaleString();return String(value);}
 function render(data){
  summary.textContent=statuses[data.status]||'Unavailable';summary.dataset.healthState=data.status;
  stamp.textContent='Checked '+new Date(data.checkedAt).toLocaleTimeString();titles.replaceChildren();
  for(const check of data.checks){
   const card=el('article',null,'panel health-card'),header=el('div',null,'health-card-title');
   header.append(el('h2',labels[check.id]||check.id),el('span',statuses[check.status]||'Unavailable','health-state'));header.lastChild.dataset.healthState=check.status;card.append(header);
   if(check.message)card.append(el('p',check.message==='DATABASE_UNAVAILABLE'?'Waiting for the database.':'Check could not be completed. Refresh after checking the service.','muted'));
   const list=el('dl');for(const[key,value]of Object.entries(check.values||{})){const row=el('div');row.append(el('dt',fields[key]||key),el('dd',format(key,value)));list.append(row);}card.append(list);titles.append(card);
  }
 }
 async function refresh(){
  if(!active||document.hidden||controller)return;
  const request=new AbortController();controller=request;
  const timeout=setTimeout(()=>request.abort(),10000);root.setAttribute('aria-busy','true');
  try{const response=await fetch('/api/admin/system-health',{credentials:'same-origin',cache:'no-store',signal:request.signal});if(!response.ok)throw Error();const data=await response.json();if(active&&!request.signal.aborted)render(data);}
  catch{if(active){summary.textContent='Unable to refresh. Displayed values may be out of date.';summary.dataset.healthState='unknown';}}
  finally{clearTimeout(timeout);if(controller===request)controller=null;root.removeAttribute('aria-busy');}
 }
 function close(){active=false;clearInterval(timer);timer=null;controller?.abort();controller=null;}
 function open(){close();active=true;refresh();timer=setInterval(refresh,30000);}
 document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)refresh();});
 window.addEventListener('pagehide',close);
 window.CornGridAdminHealth={open,close,refresh};
})();
