(() => {
  'use strict';
  const UI=window.CornGridMarketplaceUI;
  const state={enabled:false,partner:false,open:false,search:'',provider:'all',strategy:'all',page:1,request:0};
  let manager;
  const root=()=>document.getElementById('marketplace-root');
  async function refreshAccess(){
    try{
      const data=await UI.api('/api/marketplace/settings');state.enabled=data.enabled;state.partner=data.partner;state.promotion=data.promotion;
      document.querySelectorAll('[data-marketplace-nav]').forEach(e=>e.hidden=!data.enabled);
      document.querySelectorAll('[data-marketplace-partner]').forEach(e=>e.hidden=!data.partner);
      if(state.open&&!data.enabled){state.request++;window.CornGridMarketplaceUI.closeGallery();UI.notice(root(),{code:'MARKETPLACE_DISABLED',message:'Marketplace is currently disabled by CornGrid. Your existing terminals and EAs continue operating.'});root().querySelector('[data-mp-retry]').onclick=open;}
      if(!data.partner && document.getElementById('page-partner-marketplace')?.classList.contains('is-visible')){
        const box=document.getElementById('partner-marketplace-root');UI.notice(box,{code:!data.enabled?'MARKETPLACE_DISABLED':'PARTNER_REQUIRED',message:'Marketplace management requires enabled Marketplace access and an approved, active partner account.'});box.querySelector('[data-mp-retry]').onclick=()=>window.CornGridMarketplace.onManageOpen();
      }
      return data;
    }catch{document.querySelectorAll('[data-marketplace-nav],[data-marketplace-partner]').forEach(e=>e.hidden=true);return null;}
  }
  function navigate(id){window.location.hash=id?'marketplace/'+encodeURIComponent(id):'marketplace';}
  function filters(categories){
    const count=Number(state.provider!=='all')+Number(state.strategy!=='all');
    return `<form class="mp-browse-search" data-marketplace-filter>
      <div class="mp-search-row">
        <label class="sr-only" for="mp-search">Search Expert Advisors</label>
        <input id="mp-search" name="search" class="input-control" type="search" enterkeyhint="search" maxlength="100" placeholder="Search EAs" value="${UI.esc(state.search)}">
        <button type="submit" class="button button-primary mp-search-submit" aria-label="Search Marketplace"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg></button>
        <button type="button" class="button button-secondary mp-filter-toggle" data-filter-toggle aria-expanded="false" aria-controls="mp-filter-panel">Filters${count?` (${count})`:''}</button>
      </div>
      <div id="mp-filter-panel" class="mp-filter-panel" hidden>
        <label for="mp-provider">Provider<select id="mp-provider" class="select-control" name="provider">${[['all','All providers'],['official','CornGrid Official'],['partner','Partner EAs']].map(([v,t])=>`<option value="${v}" ${state.provider===v?'selected':''}>${t}</option>`).join('')}</select></label>
        <label for="mp-strategy">Strategy<select id="mp-strategy" class="select-control" name="strategy"><option value="all">All strategies</option>${categories.map(v=>`<option value="${v}" ${state.strategy===v?'selected':''}>${UI.label(v)}</option>`).join('')}</select></label>
        <div class="mp-inline"><button type="submit" class="button button-primary button-small">Apply filters</button><button type="button" class="button button-secondary button-small" data-reset-filters>Reset</button></div>
      </div>
    </form>`;
  }
  async function list(){
    const seq=++state.request,box=root();box.innerHTML='<p class="mp-loading" role="status">Loading trading strategies…</p>';
    try{
      const data=await UI.api(`/api/marketplace/eas?search=${encodeURIComponent(state.search)}&provider=${state.provider}&strategy=${state.strategy}&page=${state.page}`);
      if(seq!==state.request||!state.open)return;
      const section=(title,items)=>items.length?`<section class="mp-section"><div class="mp-section-heading"><h2>${title}</h2><span class="mp-small">${items.length} ${items.length===1?'EA':'EAs'}</span></div><div class="mp-grid">${items.map(UI.card).join('')}</div></section>`:'';
      const promo=state.promotion;
      box.innerHTML=`<div class="mp-heading"><div><p class="eyebrow">CORNGRID INFRASTRUCTURE</p><h1>CornGrid EA Marketplace</h1><p class="muted">Discover automated trading strategies available on CornGrid Infrastructure.</p></div></div>${promo?`<section class="mp-promotion">${promo.image?`<img src="${UI.esc(promo.image)}" alt="" loading="lazy" decoding="async">`:''}<div><p class="eyebrow">EXPLORE A STRATEGY</p><h2>${UI.esc(promo.title)}</h2><p>${UI.esc(promo.description)}</p><button type="button" class="button button-primary button-small" data-mp-detail="${UI.esc(promo.eaId)}">Explore EA →</button></div></section>`:''}${filters(data.categories)}<p class="mp-small" role="status">${data.total} ${data.total===1?'strategy':'strategies'} found</p>${section('Featured EAs',data.listings.filter(e=>e.featured))}${section('CornGrid Official',data.listings.filter(e=>e.provider_type==='official'))}${section('Partner EAs',data.listings.filter(e=>e.provider_type==='partner'))}${!data.listings.length?'<div class="mp-message"><h2>No strategies found</h2><p>Try another search or check back for newly approved EAs.</p></div>':''}<div class="mp-pagination"><button type="button" class="button button-secondary button-small" data-prev ${state.page<=1?'disabled':''}>← Previous</button><span>Page ${state.page} of ${Math.max(1,data.pages)}</span><button type="button" class="button button-secondary button-small" data-next ${state.page>=data.pages?'disabled':''}>Next →</button></div>`;
      box.querySelector('[data-marketplace-filter]').onsubmit=event=>{event.preventDefault();const f=new FormData(event.target);state.search=f.get('search');state.provider=f.get('provider');state.strategy=f.get('strategy');state.page=1;list();};
      box.querySelector('[data-filter-toggle]').onclick=event=>{
        const panel=box.querySelector('#mp-filter-panel'),open=panel.hidden;
        panel.hidden=!open;event.currentTarget.setAttribute('aria-expanded',String(open));
      };
      box.querySelector('[data-reset-filters]').onclick=()=>{
        state.search=box.querySelector('#mp-search').value;
        state.provider='all';state.strategy='all';state.page=1;list();
      };
      box.querySelectorAll('[data-mp-detail]').forEach(b=>b.onclick=()=>navigate(b.dataset.mpDetail));
      box.querySelector('[data-prev]').onclick=()=>{state.page--;list();};box.querySelector('[data-next]').onclick=()=>{state.page++;list();};
    }catch(error){if(seq===state.request){UI.notice(box,error);box.querySelector('[data-mp-retry]').onclick=list;}}
  }
  async function detail(id){
    const seq=++state.request,box=root();box.innerHTML='<p class="mp-loading" role="status">Loading EA details…</p>';
    try{
      const {listing}=await UI.api('/api/marketplace/eas/'+encodeURIComponent(id));if(seq!==state.request||!state.open)return;
      box.innerHTML=UI.detail(listing);box.querySelector('[data-mp-back]').onclick=()=>navigate(null);UI.gallery(box,listing);
      box.querySelector('[data-mp-deploy]')?.addEventListener('click',async event=>{
        const button=event.currentTarget;button.disabled=true;
        try{
          const result=await UI.api(`/api/marketplace/eas/${encodeURIComponent(id)}/deployment`,{method:'POST',body:'{}'});
          window.CornGridSandbox.prepareSetup(result.strategyCode,result.symbols[0]);
          window.location.hash='sandbox';
        }catch(error){let status=box.querySelector('[data-deployment-error]');if(!status){status=document.createElement('p');status.className='mp-small';status.dataset.deploymentError='';status.setAttribute('role','status');button.after(status);}status.textContent=error.message;}finally{button.disabled=false;}
      });
    }catch(error){if(seq===state.request){UI.notice(box,error);const back=document.createElement('button');back.type='button';back.className='button button-secondary button-small';back.textContent='← All EAs';back.onclick=()=>navigate(null);box.append(back);box.querySelector('[data-mp-retry]').onclick=()=>detail(id);}}
  }
  async function open(){
    UI.closeGallery();
    state.open=true;const access=await refreshAccess();if(!state.open)return;
    if(!access){UI.notice(root(),{message:'Access settings could not be loaded. Please retry.'});root().querySelector('[data-mp-retry]').onclick=open;return;}
    if(!access.enabled)return;
    const hash=location.hash.slice(1),id=hash.startsWith('marketplace/')?decodeURIComponent(hash.slice(12)):null;
    if(!hash.startsWith('marketplace'))history.replaceState(null,'','#marketplace');
    if(id)await detail(id);else await list();
  }
  window.CornGridMarketplace={onOpen:open,onClose(){state.open=false;state.request++;UI.closeGallery();},onManageOpen(){manager ||= UI.createManager(document.getElementById('partner-marketplace-root'),'partner');manager.open();},refreshAccess};
  const init=()=>{refreshAccess();setInterval(()=>{if(!document.hidden)refreshAccess();},30000);window.addEventListener('focus',refreshAccess);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
