(() => {
  'use strict';
  const UI = window.CornGridUI, model = window.CornGridExperienceModel, host = document.getElementById('overview-attention');
  if (!UI || !model || !host) return;
  const API = '/api', { el, action } = UI;
  let userId = null, page = 'overview', pins = [], accounts = null, subscription = null, sandbox = null, checkedAt = null, attentionError = false, pending, timer, ended = false;
  let checkout = {}, order = null, provider = null;
  const nav = document.querySelector('.main-nav'), sourceButtons = () => [...nav.querySelectorAll('.nav-item[data-page]')].filter(button => !button.hidden && button.style.display !== 'none');
  const available = id => sourceButtons().find(button => button.dataset.page === id);
  const labelOf = source => { const copy = source.cloneNode(true); copy.querySelectorAll('.nav-chat-badge').forEach(node => node.remove()); return copy.textContent.trim().replace(/\s+/g, ' '); };
  const pinRoot = el('section', null, 'cg-pinned'); pinRoot.hidden = true;
  const pinHeading = el('div', null, 'cg-pinned-heading'), pinList = el('div', null, 'cg-pinned-list'), editPins = action('Edit shortcuts', choosePins);
  pinHeading.append(el('strong', 'Pinned'), editPins); pinRoot.append(pinHeading, pinList); nav.prepend(pinRoot);
  function renderPins() {
    pinRoot.hidden = !userId; pinList.replaceChildren();
    for (const id of pins) { const source = available(id); if (!source) continue; const button = action(labelOf(source), () => UI.navigate(id), 'cg-shortcut'); if (page === id) button.setAttribute('aria-current', 'page'); pinList.append(button); }
    if (!pinList.children.length) pinList.append(el('span', 'Choose up to three shortcuts.', 'muted small'));
  }
  function choosePins() {
    if (!userId) return;
    const current = new Set(pins), options = sourceButtons();
    UI.dialog('Pinned shortcuts', dialog => {
      dialog.append(el('p', 'Choose up to three menus. Shortcuts are saved on this device for your account.'));
      const group = el('fieldset'); group.style.cssText = 'border:0;padding:0;margin:0;min-width:0'; group.append(el('legend', 'Menus', 'sr-only'));
      const inputs = [];
      for (const source of options) {
        const label = el('label', null, 'cg-pin-option'), input = el('input'); input.type = 'checkbox'; input.value = source.dataset.page; input.checked = current.has(input.value); inputs.push(input);
        label.append(input, el('span', labelOf(source))); group.append(label);
      }
      const constrain = () => { const count = inputs.filter(input => input.checked).length; inputs.forEach(input => { input.disabled = count >= 3 && !input.checked; }); };
      group.onchange = constrain; constrain();
      const feedback = el('p'); feedback.setAttribute('role', 'status');
      const actions = el('div', null, 'cg-dialog-actions');
      actions.append(action('Clear selection', () => { inputs.forEach(input => { input.checked = false; }); constrain(); }), action('Cancel', () => dialog.close()), action('Save shortcuts', () => {
        const selected = inputs.filter(input => input.checked).map(input => input.value);
        try { localStorage.setItem('corngrid_menu_pins:' + userId, JSON.stringify(selected)); pins = selected; renderPins(); dialog.close(); }
        catch { feedback.textContent = 'Your browser could not save shortcuts. Check device storage and try again.'; }
      }, 'button button-primary'));
      dialog.append(group, feedback, actions);
    });
  }
  const bottom = el('nav', null, 'cg-mobile-nav'); bottom.setAttribute('aria-label', 'Mobile workspace navigation');
  const icons = { feed: '<path d="M4 6h16M4 12h16M4 18h10"/>', overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', sandbox: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', more: '<path d="M4 6h16M4 12h16M4 18h16"/>' };
  for (const [id, label] of [['feed', 'Community'], ['overview', 'Overview'], ['sandbox', 'Sandbox'], ['more', 'More']]) {
    const button = action('', () => id === 'more' ? document.getElementById('mobile-menu').click() : UI.navigate(id), ''); button.dataset.destination = id;
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' + icons[id] + '</svg>'; button.append(el('span', label));
    if (id === 'more') { button.setAttribute('aria-controls', 'sidebar'); button.setAttribute('aria-expanded', 'false'); } bottom.append(button);
  }
  document.body.append(bottom); document.body.classList.add('cg-has-mobile-nav');
  function syncNavigation() {
    renderPins();
    for (const source of sourceButtons()) { if (source.dataset.page === page) source.setAttribute('aria-current', 'page'); else source.removeAttribute('aria-current'); }
    for (const button of bottom.querySelectorAll('button')) {
      const id = button.dataset.destination, group = ['feed', 'chat', 'notifications'].includes(page) ? 'feed' : ['overview', 'monitoring', 'positions', 'history'].includes(page) ? 'overview' : page === 'sandbox' ? 'sandbox' : 'more';
      button.dataset.active = String(id === group); if (id === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      if (id === 'more') button.setAttribute('aria-expanded', String(document.getElementById('sidebar').classList.contains('is-open')));
    }
  }
  new MutationObserver(syncNavigation).observe(document.getElementById('sidebar'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(records => { if (records.some(record => record.target.matches('.nav-item[data-page]'))) syncNavigation(); }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
  let viewportHeight = innerHeight;
  function keyboard() {
    const editing = document.activeElement?.matches('input,textarea,[contenteditable=true]'), height = window.visualViewport?.height || innerHeight;
    if (!editing) viewportHeight = innerHeight;
    document.body.classList.toggle('cg-keyboard-open', !!editing && height < Math.max(viewportHeight, innerHeight) * .78);
  }
  window.visualViewport?.addEventListener('resize', keyboard); document.addEventListener('focusin', keyboard); document.addEventListener('focusout', () => setTimeout(keyboard, 80));
  const summary = el('section', null, 'panel cg-attention'), heading = el('div', null, 'cg-attention-heading'), title = el('h2', 'Needs your attention'), stamp = el('time', 'Checking status…', 'cg-meta'); heading.append(title, stamp);
  const attentionFeedback = el('div'), items = el('div', null, 'cg-attention-items'), checklist = el('ol', null, 'cg-checklist'); summary.append(heading, attentionFeedback, items, checklist); host.append(summary);
  function renderAttention() {
    items.replaceChildren(); checklist.replaceChildren(); attentionFeedback.hidden = true;
    stamp.textContent = UI.checked(checkedAt); if (checkedAt) stamp.dateTime = new Date(checkedAt).toISOString();
    if (accounts === null || !subscription || !sandbox) {
      UI.empty(items, attentionError ? 'Status could not be loaded' : 'Checking your setup', 'Account, subscription and Sandbox checks use your actual platform records.', attentionError ? 'Try again' : null, refreshAttention);
    } else {
      const updates = model.attentionItems({ accounts, subscription, sandbox });
      if (!updates.length) UI.empty(items, 'No setup issues detected', 'Check the account-specific heartbeat and connection information below when monitoring your EA.');
      for (const update of updates) { const card = el('article', null, 'cg-attention-item'); card.append(el('h3', update.title), el('p', update.body), action(update.label, () => UI.navigate(update.page))); items.append(card); }
      for (const [complete, label] of [[subscription.subscription?.status === 'active', 'Subscription active'], [accounts.length > 0, 'MT5 account linked'], [(sandbox.sandboxes || []).length > 0, 'Sandbox set up'], [accounts.some(account => account.status === 'Online'), 'EA reporting']]) {
        const item = el('li', (complete ? '✓ ' : '○ ') + label); item.dataset.complete = String(complete); item.setAttribute('aria-label', (complete ? 'Complete: ' : 'Incomplete: ') + label); checklist.append(item);
      }
    }
    if (attentionError) UI.feedback(attentionFeedback, { title: 'Some status checks could not refresh', body: 'Previously received information is kept where available. Check again before acting on an old status.', label: 'Retry checks', onClick: refreshAttention });
  }
  async function request(path) { const response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error('Status unavailable'); return response.json(); }
  async function refreshAttention() {
    if (pending || ended || document.hidden || page !== 'overview') return pending;
    summary.setAttribute('aria-busy', 'true');
    pending = (async () => {
      const results = await Promise.allSettled([request('/subscription/overview'), request('/sandbox/status')]);
      if (ended) return;
      attentionError = results.some(result => result.status === 'rejected');
      if (results[0].status === 'fulfilled') subscription = results[0].value;
      if (results[1].status === 'fulfilled') sandbox = results[1].value;
      if (!attentionError) checkedAt = Date.now(); renderAttention();
    })().finally(() => { pending = null; summary.removeAttribute('aria-busy'); });
    return pending;
  }
  const progress = document.getElementById('checkout-progress');
  function renderCheckout() {
    if (!progress) return;
    const state = model.checkoutState({ ...checkout, order, provider }); progress.replaceChildren(); progress.className = 'panel cg-checkout'; progress.dataset.state = state.state;
    const steps = el('ol'); steps.setAttribute('aria-label', 'Subscription checkout progress');
    ['Choose plan', 'Payment', 'Verification', 'Active'].forEach((label, index) => { const item = el('li'); item.dataset.complete = String(index < state.step || state.complete); if (index === state.step) item.setAttribute('aria-current', 'step'); item.append(el('strong', String(index + 1) + '. ' + label), el('small', index < state.step || state.complete ? 'Complete' : index === state.step ? 'Current step' : 'Not started')); steps.append(item); });
    progress.append(steps, el('h2', state.title), el('p', state.detail));
    if (state.action && window.CornGridStripe?.checkPayment) progress.append(action(state.action, async event => {
      const control = event.currentTarget; control.disabled = true;
      try { await window.CornGridStripe.checkPayment(); }
      catch (error) { const feedback = el('div'); UI.feedback(feedback, { title: 'Could not refresh payment status', body: error.message, tone: 'error' }); progress.append(feedback); }
      finally { control.disabled = false; }
    }));
  }
  function onPage(value) {
    page = value; syncNavigation(); clearInterval(timer);
    if (page === 'overview' && !document.hidden) { void refreshAttention(); timer = setInterval(refreshAttention, 60000); }
    document.dispatchEvent(new CustomEvent('corngrid:page-changed', { detail: { page } }));
  }
  window.CornGridExperience = {
    onPage, refresh: refreshAttention,
    setUser(profile) { const id = Number(profile?.id); if (!Number.isSafeInteger(id) || id < 1) return; userId = id; try { const value = JSON.parse(localStorage.getItem('corngrid_menu_pins:' + id) || '["feed","sandbox","overview"]'); pins = [...new Set(Array.isArray(value) ? value.filter(id => available(id)) : [])].slice(0, 3); } catch { pins = ['feed', 'sandbox', 'overview']; } renderPins(); },
    setAccounts(value) { accounts = Array.isArray(value) ? value : null; renderAttention(); },
    setSubscription(value) { const changed = value?.latestPayment?.id !== checkout.latestPayment?.id; checkout = value || {}; if (changed) order = null; provider = checkout.latestPayment?.payment_method || null; renderCheckout(); subscription = value; renderAttention(); },
    setPayment(value, method) { if (value?.id !== checkout.latestPayment?.id || provider !== method) order = null; checkout = { ...checkout, latestPayment: value }; provider = method; renderCheckout(); },
    setOrder(value) { if (provider === 'duitnow' || value?.payment_id && Number(value.payment_id) !== Number(checkout.latestPayment?.id)) return; order = value; renderCheckout(); },
    setSandbox(value) { sandbox = value; renderAttention(); }
  };
  document.addEventListener('visibilitychange', () => onPage(page));
  window.addEventListener('pagehide', () => { ended = true; clearInterval(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { ended = false; onPage(page); } });
  renderAttention(); renderCheckout(); onPage(document.querySelector('.page.is-visible')?.id.replace('page-', '') || 'overview');
})();
