/* CornGrid popup menus. The native select remains the form's source of truth. */
(() => {
  'use strict';
  if (window.CornGridSelect || typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) return;
  let popup, title, search, list, empty, active, observer, removalObserver, syncTimer;
  let sequence = 0;
  const locale = () => document.documentElement.lang.startsWith('ms') ? 'ms' : 'en';
  const words = () => locale() === 'ms'
    ? { choose:'Pilih pilihan', search:'Cari pilihan', close:'Tutup', empty:'Tiada pilihan dijumpai.', none:'Tiada' }
    : { choose:'Choose an option', search:'Search options', close:'Close', empty:'No matching options.', none:'None' };
  const eligible = node => node instanceof HTMLSelectElement && !node.multiple && node.size <= 1 && !node.matches(':disabled') && !node.hasAttribute('data-native-select');
  const visible = option => !option.hidden && !option.parentElement?.hidden && option.style.display !== 'none';
  const enabled = option => !option.disabled && !option.closest('optgroup')?.disabled;

  function labelFor(select) {
    const labelled = select.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (text) return text;
    }
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    for (const label of select.labels || []) {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('select,input,button,textarea,small').forEach(node => node.remove());
      const text = copy.textContent.replace(/\s+/g,' ').trim();
      if (text) return text;
    }
    return select.title || words().choose;
  }

  function createPopup() {
    if (popup) return;
    popup = document.createElement('dialog');
    popup.className = 'cg-select-popup';
    popup.setAttribute('aria-labelledby','cg-select-title');
    popup.innerHTML = '<header class="cg-select-header"><div><span class="cg-select-brand">CORNGRID</span><h2 id="cg-select-title"></h2></div><button type="button" class="cg-select-close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="cg-select-search-wrap"><input type="search" class="cg-select-search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cg-select-options"></div><div id="cg-select-options" class="cg-select-options" role="listbox" tabindex="0" aria-labelledby="cg-select-title"></div><p class="cg-select-empty" role="status" hidden></p>';
    title = popup.querySelector('h2');
    search = popup.querySelector('input');
    list = popup.querySelector('[role="listbox"]');
    empty = popup.querySelector('[role="status"]');
    popup.querySelector('button').addEventListener('click',close);
    popup.addEventListener('close',() => { if (!popup.open) cleanup(); });
    popup.addEventListener('click',event => {
      if (event.target !== popup) return;
      const rect = popup.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    list.addEventListener('pointerdown',event => event.preventDefault());
    list.addEventListener('click',event => {
      const item = event.target.closest('[data-cg-option]');
      if (item && list.contains(item)) choose(Number(item.dataset.cgOption));
    });
    search.addEventListener('input',render);
    popup.addEventListener('keydown',onKey);
    document.body.append(popup);
  }

  function position() {
    if (!active || !popup.open) return;
    const small = window.matchMedia('(max-width:600px)').matches;
    popup.classList.toggle('cg-select-mobile',small);
    for (const property of ['left','top','bottom','width','max-height']) popup.style.removeProperty(property);
    if (small) {
      const viewport = window.visualViewport;
      if (viewport) {
        const keyboard = Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop);
        popup.style.bottom = `calc(${keyboard}px + max(12px, env(safe-area-inset-bottom, 0px)))`;
        popup.style.maxHeight = Math.max(120,Math.min(560,viewport.height*.75))+'px';
      }
      return;
    }
    const rect = active.select.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width,280),440,window.innerWidth-24);
    popup.style.width = width+'px';
    popup.style.maxHeight = Math.max(100,window.innerHeight-24)+'px';
    const height = popup.getBoundingClientRect().height;
    const below = window.innerHeight-rect.bottom-12, above = rect.top-12;
    let top = below >= height || below >= above ? rect.bottom+6 : rect.top-height-6;
    top = Math.max(12,Math.min(top,window.innerHeight-height-12));
    popup.style.left = Math.max(12,Math.min(rect.left,window.innerWidth-width-12))+'px';
    popup.style.top = top+'px';
  }

  function highlight(index,scroll=true) {
    if (!active) return;
    active.highlight = index;
    let target;
    list.querySelectorAll('[data-cg-option]').forEach(item => {
      const current = Number(item.dataset.cgOption) === index;
      item.classList.toggle('is-current',current);
      if (current) target = item;
    });
    for (const control of [list,search]) {
      if (target) control.setAttribute('aria-activedescendant',target.id);
      else control.removeAttribute('aria-activedescendant');
    }
    if (scroll && target) target.scrollIntoView({block:'nearest',behavior:'instant'});
  }

  function render() {
    if (!active) return;
    if (!active.select.isConnected || !eligible(active.select) || !active.select.getClientRects().length) { close(); return; }
    const select = active.select, text = search.value.trim().toLocaleLowerCase();
    active.selection = select.selectedIndex;
    const options = Array.from(select.options).filter(option => visible(option) && (!text || option.textContent.toLocaleLowerCase().includes(text) || (option.closest('optgroup')?.label || '').toLocaleLowerCase().includes(text)));
    const fragment = document.createDocumentFragment();
    let previousGroup;
    active.choices = [];
    for (const option of options) {
      const group = option.closest('optgroup');
      if (group && group !== previousGroup) {
        const heading = document.createElement('div');heading.className='cg-select-group';heading.setAttribute('role','presentation');heading.textContent=group.label;fragment.append(heading);
      }
      previousGroup = group;
      const item = document.createElement('div'), allowed = enabled(option);
      item.className = 'cg-select-option';item.id = 'cg-select-option-'+active.sequence+'-'+option.index;
      item.dataset.cgOption = String(option.index);item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));
      item.classList.toggle('is-selected',option.selected);
      if (!allowed) item.setAttribute('aria-disabled','true');
      else active.choices.push(option.index);
      const label = document.createElement('span');label.textContent = option.label || words().none;
      const check = document.createElement('span');check.className='cg-select-check';check.setAttribute('aria-hidden','true');check.textContent='\u2713';
      item.append(label,check);fragment.append(item);
    }
    list.replaceChildren(fragment);empty.hidden = options.length > 0;empty.textContent = words().empty;
    const current = active.choices.includes(active.highlight) ? active.highlight : active.choices.includes(select.selectedIndex) ? select.selectedIndex : active.choices[0];
    highlight(current,false);
    if (popup.open) { position();highlight(current); }
  }

  function open(select,initial='') {
    if (!eligible(select) || !select.getClientRects().length) return;
    if (active) { if (active.select === select && popup.open) return;close(); }
    createPopup();
    const copy = words();
    active = { select,sequence:++sequence,choices:[],highlight:select.selectedIndex,expanded:select.getAttribute('aria-expanded'),controls:select.getAttribute('aria-controls'),typeahead:'',typedAt:0 };
    title.textContent = labelFor(select);popup.querySelector('button').setAttribute('aria-label',copy.close);
    search.placeholder = copy.search;search.setAttribute('aria-label',copy.search);search.value = initial;
    const searchable = Array.from(select.options).filter(visible).length > 9;
    search.value = searchable ? initial : '';
    search.parentElement.hidden = !searchable;
    select.setAttribute('aria-expanded','true');select.setAttribute('aria-controls','cg-select-options');select.classList.add('cg-select-active');
    render();
    document.body.classList.add('cg-select-open');
    try { popup.showModal(); }
    catch { cleanup();return; }
    position();
    // Opening a mobile menu must not summon the keyboard until search is tapped.
    list.focus({preventScroll:true});highlight(active.highlight);
    if (initial && !searchable) typeahead(initial);
    observer = new MutationObserver(render);
    observer.observe(select,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['selected','disabled','hidden','label','value']});
    removalObserver = new MutationObserver(() => {
      if (active && (!select.isConnected || !eligible(select) || !select.getClientRects().length)) close();
    });
    removalObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','disabled']});
    // Setting select.value/selectedIndex does not emit a DOM mutation. Check
    // only while the menu is open, so existing application assignments stay in sync.
    syncTimer = window.setInterval(() => {
      if (active && active.select.selectedIndex !== active.selection) render();
    },150);
  }

  function close() { if (popup?.open) popup.close();cleanup(); }
  function cleanup() {
    if (!active) return;
    observer?.disconnect();removalObserver?.disconnect();observer=removalObserver=null;
    window.clearInterval(syncTimer);syncTimer=null;
    const {select,expanded,controls} = active;active=null;
    select.classList.remove('cg-select-active');
    for (const [name,value] of [['aria-expanded',expanded],['aria-controls',controls]]) {
      if (value === null) select.removeAttribute(name);else select.setAttribute(name,value);
    }
    document.body.classList.remove('cg-select-open');
    list.replaceChildren();search.value='';
    if (select.isConnected && !select.matches(':disabled') && select.getClientRects().length) select.focus({preventScroll:true});
  }

  function choose(index) {
    if (!active) return;
    const select = active.select, option = select.options[index];
    if (!option || !visible(option) || !enabled(option) || !eligible(select)) return;
    const previous = select.selectedIndex;
    select.selectedIndex = index;
    close();cleanup();
    if (previous !== index) {
      select.dispatchEvent(new Event('input',{bubbles:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }

  function typeahead(value) {
    if (!active) return;
    const now = Date.now();
    active.typeahead = now-active.typedAt > 700 ? value : active.typeahead+value;active.typedAt=now;
    const prefix = active.typeahead.toLocaleLowerCase();
    const index = active.choices.find(index => active.select.options[index].label.toLocaleLowerCase().startsWith(prefix));
    if (index !== undefined) highlight(index);
  }

  function onKey(event) {
    if (!active || event.isComposing) return;
    const typing = event.target === search;
    if (event.key === 'Escape') { event.preventDefault();event.stopPropagation();close();return; }
    if (event.key === 'Tab') {
      event.preventDefault();event.stopPropagation();
      const focusable = Array.from(popup.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(node=>node.getClientRects().length&&!node.closest('[hidden]'));
      const current = focusable.indexOf(document.activeElement);
      const next = (current+(event.shiftKey?-1:1)+focusable.length)%focusable.length;
      focusable[next]?.focus({preventScroll:true});return;
    }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && (!typing || event.key.startsWith('Arrow'))) {
      event.preventDefault();
      const choices = active.choices, current = choices.indexOf(active.highlight);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length-1 : Math.max(0,Math.min(choices.length-1,current+(event.key==='ArrowDown'?1:-1)));
      list.focus({preventScroll:true});highlight(choices[next]);
    } else if (event.key === 'Enter' || (!typing && event.key === ' ')) {
      if (event.target.closest('button')) return;
      event.preventDefault();choose(active.highlight);
    } else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();typeahead(event.key);
    }
  }

  // Intercept only popup opening. Original select nodes, values, option updates,
  // form validation, reset and application change listeners remain untouched.
  for (const name of ['pointerdown','mousedown']) document.addEventListener(name,event => {
    if (eligible(event.target) && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();event.target.focus({preventScroll:true});
    }
  },true);
  document.addEventListener('click',event => {
    if (!eligible(event.target) || event.ctrlKey || event.metaKey) return;
    event.preventDefault();open(event.target);
  },true);
  document.addEventListener('keydown',event => {
    if (!eligible(event.target) || active || event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.altKey && !['ArrowDown','ArrowUp'].includes(event.key)) return;
    if (['ArrowDown','ArrowUp','Enter',' ','F4'].includes(event.key) || (!event.altKey && event.key.length===1)) {
      event.preventDefault();open(event.target,event.key.length===1 && event.key!==' '?event.key:'');
    }
  },true);
  document.addEventListener('change',event => {if (active?.select === event.target) render();},true);
  document.addEventListener('reset',event => {if (active?.select.form === event.target) close();},true);
  window.addEventListener('hashchange',close);
  window.addEventListener('resize',position);
  window.visualViewport?.addEventListener('resize',position);
  window.CornGridSelect = {open,close};
})();
