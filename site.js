/* Shared CornGrid public header, original support widget and public language preference. */
(() => {
  'use strict';
  const header=document.getElementById('mainHeader');
  const menu=document.getElementById('navMenu');
  const toggle=document.getElementById('menuToggle');
  const support=document.querySelector('.cg-contact');
  const supportButton=document.getElementById('cgContactButton');
  let language=document.documentElement.lang==='en'?'en':'ms';
  let requestVersion=0;
  const cache=new Map();
  // Progressive disclosure keeps the mobile homepage short; desktop retains its full layout.
  const mobileDetails=document.querySelectorAll('.infra-page .infra-mobile-details');
  if(mobileDetails.length){
    const compact=matchMedia('(max-width:639px)');
    const revealAnchor=()=>{
      const target=document.getElementById(location.hash.slice(1));
      const details=target?.matches('.infra-fold-section')?target.querySelector('details'):target?.closest('.infra-mobile-details');
      if(details)details.open=true;
    };
    const syncDetails=()=>{mobileDetails.forEach(details=>{details.open=!compact.matches;});revealAnchor();};
    syncDetails();
    compact.addEventListener('change',syncDetails);
    addEventListener('hashchange',revealAnchor);
  }
  const readPreference=()=>{try{return localStorage.getItem('selectedLang');}catch{return null;}};
  const closeMenu=()=>{if(!menu||!toggle)return;menu.classList.remove('active');menu.inert=matchMedia('(max-width:1280px)').matches;document.body.classList.remove('public-nav-open');toggle.classList.remove('active');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label',language==='ms'?'Buka navigasi':'Open navigation');};
  if(toggle&&menu){
    closeMenu();
    toggle.addEventListener('click',()=>{const open=menu.classList.toggle('active');menu.inert=!open;document.body.classList.toggle('public-nav-open',open);toggle.classList.toggle('active',open);toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',language==='ms'?(open?'Tutup navigasi':'Buka navigasi'):(open?'Close navigation':'Open navigation'));});
    menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',closeMenu));
    document.addEventListener('click',e=>{if(!menu.contains(e.target)&&!toggle.contains(e.target))closeMenu();});
    addEventListener('resize',()=>{if(!matchMedia('(max-width:1280px)').matches)closeMenu();else menu.inert=!menu.classList.contains('active');});
  }
  if(header){const updateHeader=()=>header.classList.toggle('header-scrolled',scrollY>50);addEventListener('scroll',updateHeader,{passive:true});updateHeader();}
  const setSupport=open=>{if(!support||!supportButton)return;support.classList.toggle('open',open);supportButton.setAttribute('aria-expanded',String(open));supportButton.setAttribute('aria-label',language==='ms'?(open?'Tutup sokongan CornGrid':'Buka sokongan CornGrid'):(open?'Close CornGrid Support':'Open CornGrid Support'));const panel=document.getElementById('cgContactMenu');if(panel)panel.inert=!open;};
  if(support&&supportButton){
    supportButton.setAttribute('aria-controls','cgContactMenu');setSupport(false);
    supportButton.addEventListener('click',()=>setSupport(!support.classList.contains('open')));
    document.addEventListener('click',e=>{if(!support.contains(e.target))setSupport(false);});
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(menu?.classList.contains('active')){closeMenu();toggle.focus();}if(support?.classList.contains('open')){setSupport(false);supportButton.focus();}}});
  const descriptions={ms:'Mudahkan automated trading MT5 dengan CornGrid Infrastructure. Sambungkan akaun broker, pilih strategi dan urus persekitaran trading melalui satu platform.',en:'Simplify MT5 automated trading with CornGrid Infrastructure. Connect your broker account, select a strategy, and manage your trading environment through a centralized platform.'};
  async function applyLanguage(next,{persist=true,closeNavigation=false}={}){
    if(!['ms','en'].includes(next))return;
    const version=++requestVersion;
    try{
      if(!cache.has(next)){const response=await fetch('/locales/'+next+'.json?v=20261111-simple-home1');if(!response.ok)throw new Error('Language unavailable');cache.set(next,await response.json());}
      if(version!==requestVersion)return;
      const dictionary=cache.get(next);language=next;
      if(document.body.dataset.publicPage==='ea'&&typeof window.switchLanguage==='function')window.switchLanguage(next==='ms'?'bm':'en');
      if(document.body.dataset.publicPage==='apps'&&window.PromoI18n)window.PromoI18n.applyLanguage(next==='ms'?'bm':'en');
      document.querySelectorAll('[data-site-i18n]').forEach(el=>{const value=dictionary[el.dataset.siteI18n];if(typeof value==='string')el.textContent=value;});
      document.documentElement.lang=next;
      document.querySelectorAll('[data-language]').forEach(button=>{const selected=button.dataset.language===next;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
      if(persist)try{localStorage.setItem('selectedLang',next==='ms'?'bm':'en');}catch{}
      const home=next==='en'?'/en/':'/';
      document.querySelectorAll('[data-home]').forEach(a=>a.href=home);
      document.querySelectorAll('#navMenu a[href*="#"],.infra-footer a[href*="#"]').forEach(a=>{const hash=new URL(a.href).hash;a.href=home+hash;});
      header?.querySelector('nav')?.setAttribute('aria-label',next==='ms'?'Navigasi utama':'Main navigation');
      if(document.body.dataset.publicPage==='infrastructure'){
        document.querySelector('meta[name="description"]').content=descriptions[next];
        document.querySelector('meta[property="og:description"]').content=descriptions[next];
        document.querySelector('meta[property="og:locale"]').content=next==='ms'?'ms_MY':'en_US';
        document.querySelector('meta[property="og:url"]').content='https://corngrid.com'+home;
        document.querySelector('link[rel="canonical"]').href='https://corngrid.com'+home;
        history.replaceState(null,'',home+location.hash);
      }
      if(closeNavigation)closeMenu();
      document.querySelectorAll('#navMenu a').forEach(a=>{
        const url=new URL(a.href);
        const current=(url.pathname===location.pathname||(url.pathname==='/portfolios'&&location.pathname.startsWith('/portfolio/')))&&!url.hash&&url.pathname!=='/login';
        if(current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
      });
      document.documentElement.dataset.siteReady='true';
      setSupport(support?.classList.contains('open')||false);
    }catch(error){console.error('Unable to load public language:',error.message);}
  }
  document.querySelectorAll('[data-language]').forEach(button=>button.addEventListener('click',()=>applyLanguage(button.dataset.language,{closeNavigation:true})));
  // Explicit English URL wins; otherwise honour the existing BM/EN preference.
  const saved=readPreference();
  const initial=location.pathname==='/en/'||location.pathname==='/en'?'en':saved==='en'?'en':saved==='bm'||saved==='ms'?'ms':document.body.dataset.publicPage==='ea'?'ms':language;
  applyLanguage(initial);
  // Reuse the EA motion vocabulary, limited to the Infrastructure content.
  if(document.body.dataset.publicPage==='infrastructure'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const items=document.querySelectorAll('.infra-heading,.infra-feature,.infra-steps li,.infra-architecture li,.strategy-product,.strategy-future,.sandbox-preview,.terminal-preview,.infra-pricing,.infra-final');
    if('IntersectionObserver' in window){
      const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('infra-visible');observer.unobserve(entry.target);}}),{threshold:.08});
      items.forEach((item,index)=>{item.classList.add('infra-reveal');item.style.setProperty('--reveal-delay',Math.min(index%4,3)*70+'ms');observer.observe(item);});
    }
    document.body.classList.add('infra-motion');
  }
  // Preserve incoming anchors that belonged to the former EA homepage.
  if(document.body.dataset.publicPage==='infrastructure'&&['#features','#setup','#installation','#setfiles','#broker','#dashboard','#testimonial','#testimonials','#portfolio'].includes(location.hash))location.replace('/corngrid-ea'+location.hash);
})();
