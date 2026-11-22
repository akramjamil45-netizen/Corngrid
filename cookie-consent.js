/* CornGrid optional tracking consent. Add trackers through register() or inert scripts only. */
(() => {
  'use strict';
  const KEY='cg_cookie_consent_v1', VERSION=1, MAX_AGE=180*24*60*60*1000;
  const categories=['analytics','marketing'], integrations=new Map();
  const configured=new Set(['analytics']);
  const activeScripts=new Set();
  let saved=null, previousFocus=null;
  const copy={
    en:{title:'Your privacy choices',intro:'Essential storage keeps CornGrid working. Optional analytics stay off unless you allow them.',accept:'Accept all',reject:'Reject all',manage:'Manage cookies',settings:'Cookie settings',close:'Close settings',save:'Save my choices',notice:'Cookie notice',essential:'Essential — always on',essentialText:'Sign-in, security and remembering your cookie choices. Your selected language is also stored on this device.',analytics:'Analytics',analyticsText:'Cloudflare Web Analytics helps measure visits and website performance. It loads only with your permission.',marketing:'Advertising',marketingText:'No advertising pixels are configured. This option is reserved for optional campaign measurement.',none:'No advertising pixels are currently configured on these pages.',retention:'Your choice is saved on this browser for up to 180 days. You can change it at any time using Cookie settings.',third:'This notice covers optional visitor tracking. Hosting/security logs and external font or icon providers may still process connection information as part of delivering the site.',contact:'Privacy questions: support@corngrid.com',unsaved:'Your browser could not save this choice. It applies to this page only.'},
    ms:{title:'Pilihan privasi anda',intro:'Storan penting memastikan CornGrid berfungsi. Analitik pilihan kekal dimatikan sehingga anda membenarkannya.',accept:'Terima semua',reject:'Tolak semua',manage:'Urus kuki',settings:'Tetapan kuki',close:'Tutup tetapan',save:'Simpan pilihan saya',notice:'Notis kuki',essential:'Penting — sentiasa aktif',essentialText:'Log masuk, keselamatan dan mengingati pilihan kuki. Bahasa pilihan anda turut disimpan pada peranti ini.',analytics:'Analitik',analyticsText:'Cloudflare Web Analytics mengukur lawatan dan prestasi laman. Ia hanya dimuatkan dengan izin anda.',marketing:'Pengiklanan',marketingText:'Tiada piksel iklan dikonfigurasi. Pilihan ini dikhaskan untuk pengukuran kempen pilihan.',none:'Tiada piksel iklan dikonfigurasi pada halaman ini buat masa ini.',retention:'Pilihan disimpan pada pelayar ini sehingga 180 hari. Anda boleh mengubahnya pada bila-bila masa melalui Tetapan kuki.',third:'Notis ini meliputi penjejakan pelawat pilihan. Log hosting/keselamatan serta penyedia fon atau ikon luaran mungkin masih memproses maklumat sambungan untuk menyediakan laman ini.',contact:'Pertanyaan privasi: support@corngrid.com',unsaved:'Pelayar tidak dapat menyimpan pilihan ini. Pilihan hanya terpakai pada halaman semasa.'}
  };
  const language=()=>document.documentElement.lang==='ms'?'ms':'en';
  const text=key=>copy[language()][key];
  try{
    const candidate=JSON.parse(localStorage.getItem(KEY));
    if(candidate?.version===VERSION && typeof candidate.analytics==='boolean' && typeof candidate.marketing==='boolean' &&
      Number.isFinite(candidate.updatedAt) && candidate.updatedAt<=Date.now()+300000 && Date.now()-candidate.updatedAt<MAX_AGE) saved=candidate;
  }catch{}
  const allowed=category=>category==='essential'||(configured.has(category)&&saved?.[category]===true);
  const get=()=>({essential:true,analytics:allowed('analytics'),marketing:allowed('marketing'),version:VERSION,updatedAt:saved?.updatedAt||null});
  function activate(){
    for(const entry of integrations.values()){
      if(allowed(entry.category)&&!entry.active){entry.active=true;try{entry.enable();}catch{entry.active=false;}}
      else if(!allowed(entry.category)&&entry.active){entry.active=false;try{entry.disable?.();}catch{}}
    }
    document.querySelectorAll('script[type="text/plain"][data-cg-consent]').forEach(source=>{
      if(!allowed(source.dataset.cgConsent)||activeScripts.has(source))return;
      const script=document.createElement('script');
      if(source.dataset.src)script.src=source.dataset.src;else script.textContent=source.textContent;
      if(source.nonce)script.nonce=source.nonce;
      if(source.dataset.cfBeacon)script.dataset.cfBeacon=source.dataset.cfBeacon;
      if(source.dataset.scriptType==='module')script.type='module';
      activeScripts.add(source);source.after(script);
    });
  }
  // No tracker may start before this API grants its category.
  window.CornGridConsent={get,allowed,open:()=>openSettings(),register(entry){
    if(!entry||typeof entry.id!=='string'||!categories.includes(entry.category)||typeof entry.enable!=='function')throw new Error('Invalid consent integration');
    if(integrations.has(entry.id))throw new Error('Consent integration already registered');
    configured.add(entry.category);
    const control=document.getElementById('cg-cookie-'+entry.category);if(control)control.disabled=false;
    integrations.set(entry.id,{...entry,active:false});activate();
  }};
  let banner,dialog,status;
  function translated(){
    document.querySelectorAll('[data-cookie-text]').forEach(element=>{element.textContent=text(element.dataset.cookieText);});
    dialog?.setAttribute('aria-label',text('settings'));
    banner?.setAttribute('aria-label',text('title'));
  }
  function openSettings(){
    if(!dialog)return;
    previousFocus=document.activeElement;
    for(const category of categories)document.getElementById('cg-cookie-'+category).checked=allowed(category);
    if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');}
    document.getElementById('cg-cookie-close').focus();
  }
  function closeSettings(){
    if(dialog.open){if(dialog.close)dialog.close();else dialog.removeAttribute('open');}
    if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
  }
  function clearOptionalCookies(){
    const domains=[null,location.hostname];
    const parts=location.hostname.split('.');for(let i=1;i<parts.length-1;i++)domains.push('.'+parts.slice(i).join('.'));
    for(const cookie of document.cookie.split(';')){
      const name=cookie.split('=')[0].trim();
      const analyticsCookie=/^(?:_ga(?:_|$)|_gid$|_gat(?:_|$))/.test(name);
      const marketingCookie=/^(?:_gcl_|_fbp$|_fbc$|_ttp$)/.test(name);
      if(!((!allowed('analytics')&&analyticsCookie)||(!allowed('marketing')&&marketingCookie)))continue;
      for(const domain of domains)document.cookie=name+'=; Max-Age=0; Path=/; SameSite=Lax'+(domain?'; Domain='+domain:'');
    }
  }
  function choose(analytics,marketing){
    const revoked=(allowed('analytics')&&!analytics)||(allowed('marketing')&&!marketing);
    saved={version:VERSION,analytics:configured.has('analytics')&&!!analytics,marketing:configured.has('marketing')&&!!marketing,updatedAt:Date.now()};
    let persisted=true;try{localStorage.setItem(KEY,JSON.stringify(saved));}catch{persisted=false;}
    banner.hidden=true;closeSettings();
    if(!analytics||!marketing)clearOptionalCookies();
    activate();window.dispatchEvent(new CustomEvent('corngrid:consentchange',{detail:get()}));
    if(!persisted){status.textContent=text('unsaved');status.hidden=false;}
    // Reload after withdrawal to stop already-running vendor scripts/timers.
    if(revoked){
      if(!persisted)try{localStorage.removeItem(KEY);}catch{}
      location.reload();
    }
  }
  function init(){
    const host=document.createElement('div');host.id='cg-cookie-controls';
    host.innerHTML=`<section id="cg-cookie-banner" class="cg-cookie-banner" aria-labelledby="cg-cookie-title"><div class="cg-cookie-copy"><h2 id="cg-cookie-title" data-cookie-text="title"></h2><p data-cookie-text="intro"></p></div><div class="cg-cookie-actions"><button type="button" data-cookie-action="reject" data-cookie-text="reject"></button><button type="button" data-cookie-action="accept" data-cookie-text="accept"></button><button type="button" data-cookie-action="manage" data-cookie-text="manage"></button></div></section>
    <dialog id="cg-cookie-dialog" class="cg-cookie-dialog" aria-labelledby="cg-cookie-settings-title"><div class="cg-cookie-dialog-head"><h2 id="cg-cookie-settings-title" data-cookie-text="settings"></h2><button id="cg-cookie-close" type="button" data-cookie-text="close"></button></div><p class="cg-cookie-intro" data-cookie-text="intro"></p><div class="cg-cookie-option"><strong data-cookie-text="essential"></strong><p data-cookie-text="essentialText"></p></div><label class="cg-cookie-option cg-cookie-toggle"><span><strong data-cookie-text="analytics"></strong><span data-cookie-text="analyticsText"></span></span><input id="cg-cookie-analytics" type="checkbox"></label><label class="cg-cookie-option cg-cookie-toggle"><span><strong data-cookie-text="marketing"></strong><span data-cookie-text="marketingText"></span></span><input id="cg-cookie-marketing" type="checkbox"></label><p class="cg-cookie-note" data-cookie-text="none"></p><details class="cg-cookie-notice"><summary data-cookie-text="notice"></summary><p data-cookie-text="retention"></p><p data-cookie-text="third"></p><a href="mailto:support@corngrid.com" data-cookie-text="contact"></a></details><div class="cg-cookie-actions"><button type="button" data-cookie-action="reject" data-cookie-text="reject"></button><button type="button" data-cookie-action="accept" data-cookie-text="accept"></button><button type="button" data-cookie-action="save" data-cookie-text="save"></button></div></dialog><p id="cg-cookie-status" class="cg-cookie-status" role="status" hidden></p>`;
    document.body.append(host);
    banner=document.getElementById('cg-cookie-banner');dialog=document.getElementById('cg-cookie-dialog');status=document.getElementById('cg-cookie-status');
    document.querySelectorAll('script[type="text/plain"][data-cg-consent]').forEach(script=>{if(categories.includes(script.dataset.cgConsent))configured.add(script.dataset.cgConsent);});
    for(const category of categories)document.getElementById('cg-cookie-'+category).disabled=!configured.has(category);
    banner.hidden=!!saved;
    const settings=document.createElement('button');settings.type='button';settings.className='cg-cookie-settings';settings.dataset.cookieText='settings';
    const footer=document.querySelector('footer');const slot=footer?[...footer.querySelectorAll('ul.footer-links')].pop():null;
    if(slot){const item=document.createElement('li');item.className='footer-cookie-item';item.append(settings);slot.append(item);}else{(footer||host).append(settings);}
    settings.addEventListener('click',openSettings);
    document.getElementById('cg-cookie-close').addEventListener('click',closeSettings);
    host.addEventListener('click',event=>{
      const action=event.target.closest('[data-cookie-action]')?.dataset.cookieAction;
      if(action==='manage')openSettings();
      if(action==='accept')choose(true,true);
      if(action==='reject')choose(false,false);
      if(action==='save')choose(document.getElementById('cg-cookie-analytics').checked,document.getElementById('cg-cookie-marketing').checked);
    });
    dialog.addEventListener('close',()=>{if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});});
    new MutationObserver(translated).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    addEventListener('storage',event=>{if(event.key===KEY)location.reload();});
    translated();activate();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
