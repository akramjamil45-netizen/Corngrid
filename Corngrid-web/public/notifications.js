(() => {
  'use strict';
  const prefix = '/api/notifications';
  const host = document.getElementById('notification-center'), settings = document.getElementById('notification-settings');
  if (!host || !settings) return;
  const categories = ['sandbox_offline', 'ea_disconnected', 'subscription_expiry', 'payment_status'];
  const copy = {
    en: { title: 'Notifications', intro: 'Your sandbox, EA, subscription and payment updates in one place.', settings: 'Alert settings', all: 'All alerts', unread: 'Unread only', refresh: 'Refresh', mark: 'Mark all read', clear: 'Clear all', more: 'Load more', open: 'View details', read: 'Mark read', remove: 'Delete', empty: 'No notifications to show.', error: 'Unable to load notifications. Please retry.', loading: 'Loading notifications…', saved: 'Alert preferences saved.', saving: 'Saving…', save: 'Save preferences', unsaved: 'You have unsaved changes.', delivery: 'Alerts appear inside CornGrid. These settings apply across your devices. Changing a preference affects future alerts; existing history stays available.', lead: 'Start expiry reminders', days: 'days before expiry', clearTitle: 'Clear notification history?', clearNote: 'This removes your notifications. Your subscriptions, payments and trading activity remain available in their own pages.', cancel: 'Cancel', confirm: 'Clear notifications', preferencesError: 'Unable to load alert preferences. Select Refresh to try again.',
      sandbox_offline: 'Sandbox offline', ea_disconnected: 'EA disconnected', subscription_expiry: 'Subscription alerts', payment_status: 'Payment status',
      sandbox_offline_help: 'When a running sandbox stops reporting or fails.', ea_disconnected_help: 'When a linked EA stops reporting or reports an authentication problem.', subscription_expiry_help: 'Expiry reminders and subscription status changes.', payment_status_help: 'DuitNow and Stripe payment updates, including activation.',
      sandboxTitle: 'Sandbox needs attention', eaTitle: 'EA connection interrupted', expiryTitle: 'Subscription expiring soon', paymentTitle: 'Payment status updated', status: { pending_payment: 'Awaiting payment', pending_approval: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired', paid: 'Paid' } },
    ms: { title: 'Notifikasi', intro: 'Kemas kini sandbox, EA, langganan dan pembayaran di satu tempat.', settings: 'Tetapan amaran', all: 'Semua amaran', unread: 'Belum dibaca sahaja', refresh: 'Muat semula', mark: 'Tandakan semua dibaca', clear: 'Padam semua', more: 'Muat lagi', open: 'Lihat butiran', read: 'Tandakan dibaca', remove: 'Padam', empty: 'Tiada notifikasi untuk dipaparkan.', error: 'Notifikasi tidak dapat dimuatkan. Sila cuba lagi.', loading: 'Memuatkan notifikasi…', saved: 'Tetapan amaran disimpan.', saving: 'Menyimpan…', save: 'Simpan tetapan', unsaved: 'Perubahan belum disimpan.', delivery: 'Amaran dipaparkan dalam CornGrid. Tetapan ini digunakan pada semua peranti anda. Perubahan jenis amaran terpakai untuk amaran baharu; sejarah sedia ada kekal tersedia.', lead: 'Mulakan peringatan tamat tempoh', days: 'hari sebelum tamat', clearTitle: 'Padam sejarah notifikasi?', clearNote: 'Ini memadam notifikasi anda. Langganan, pembayaran dan aktiviti dagangan kekal tersedia di halaman masing-masing.', cancel: 'Batal', confirm: 'Padam notifikasi', preferencesError: 'Tetapan tidak dapat dimuatkan. Tekan Muat semula untuk mencuba lagi.',
      sandbox_offline: 'Sandbox offline', ea_disconnected: 'EA terputus', subscription_expiry: 'Amaran langganan', payment_status: 'Status pembayaran',
      sandbox_offline_help: 'Apabila sandbox yang berjalan berhenti melapor atau gagal.', ea_disconnected_help: 'Apabila EA berhenti melapor atau mengalami masalah pengesahan.', subscription_expiry_help: 'Peringatan tamat tempoh dan perubahan status langganan.', payment_status_help: 'Kemas kini DuitNow dan Stripe, termasuk pengaktifan.',
      sandboxTitle: 'Sandbox memerlukan perhatian', eaTitle: 'Sambungan EA terputus', expiryTitle: 'Langganan hampir tamat', paymentTitle: 'Status pembayaran dikemas kini', status: { pending_payment: 'Menunggu pembayaran', pending_approval: 'Menunggu semakan', approved: 'Diluluskan', rejected: 'Ditolak', cancelled: 'Dibatalkan', failed: 'Gagal', expired: 'Tamat tempoh', paid: 'Dibayar' } }
  };
  // Match the English Workplace interface, including when the marketing site
  // previously saved a different language on this device.
  function locale() { return 'en'; }
  const t = key => copy[locale()][key];
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, handler, className = 'button button-small button-secondary') => { const node = el('button', text, className); node.type = 'button'; node.onclick = handler; return node; };
  const go = page => { document.querySelector(`.nav-item[data-page="${page}"]`)?.click(); };
  let active = false, next = null, generation = 0, timer, ended = false, preferencesLoaded = false;
  const requests = new Set();
  async function api(path = '', options = {}) {
    const controller = new AbortController(); requests.add(controller); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(prefix + path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
      const data = await response.json(); if (!response.ok) throw Error(t('error')); return data;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  const badge = el('span', '', 'nc-badge'); badge.hidden = true;
  const bell = button('', () => go('notifications'), 'icon-button nc-bell');
  bell.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
  bell.append(badge); document.querySelector('.topbar-actions')?.prepend(bell);
  function updateBadge(count) { badge.hidden = !count; badge.textContent = count > 99 ? '99+' : String(count); bell.setAttribute('aria-label', t('title') + (count ? ': ' + count : '')); bell.title = t('title'); const nav = document.querySelector('[data-notification-nav]'); if (nav) nav.textContent = t('title'); }
  const heading = el('div', null, 'page-heading'), headingText = el('div'), title = el('h1', t('title')), intro = el('p', t('intro'), 'muted'); headingText.append(title, intro);
  const openSettings = () => { go('settings'); document.querySelector('[data-setting="notifications"]')?.click(); };
  const settingsButton = button(t('settings'), openSettings); heading.append(headingText, settingsButton);
  const panel = el('section', null, 'panel nc-panel'), toolbar = el('div', null, 'nc-toolbar'), filter = el('select', null, 'select-control'), tabs = el('div', null, 'nc-tabs');
  let unreadOnly = false;
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Notification view');
  const allTab = button('All', () => changeTab(false), 'nc-tab'), unreadTab = button('Unread', () => changeTab(true), 'nc-tab');
  for (const [tab, id] of [[allTab, 'nc-tab-all'], [unreadTab, 'nc-tab-unread']]) { tab.id = id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'nc-notifications-list'); }
  tabs.append(allTab, unreadTab);
  const refreshButton = button(t('refresh'), () => refresh()), markButton = button(t('mark'), event => mutate('/read', 'POST', event.currentTarget)), clearButton = button(t('clear'), async event => {
    const control = event.currentTarget; control.disabled = true;
    try { if (await confirmClear()) await mutate('', 'DELETE', control); } finally { control.disabled = false; }
  });
  refreshButton.classList.add('nc-refresh'); refreshButton.setAttribute('aria-label', 'Refresh notifications'); refreshButton.title = 'Refresh notifications';
  refreshButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/></svg>';
  const menu = el('details', null, 'cg-menu'), menuTitle = el('summary', 'More', 'button button-small button-secondary'), menuContent = el('div', null, 'cg-menu-content');
  menu.dataset.cgMenu = 'true'; menuTitle.setAttribute('role', 'button'); menuTitle.setAttribute('aria-label', 'More notification actions'); clearButton.classList.add('button-danger'); menuContent.append(markButton, clearButton); menu.append(menuTitle, menuContent); menuContent.addEventListener('click', event => { if (event.target.closest('button')) menu.open = false; });
  toolbar.append(tabs, filter, refreshButton, menu);
  const status = el('p', t('loading'), 'nc-status muted'), list = el('div', null, 'nc-list'), more = button(t('more'), () => refresh(true)); more.hidden = true; status.setAttribute('role', 'status'); list.setAttribute('aria-label', t('title'));
  list.id = 'nc-notifications-list'; list.setAttribute('role', 'tabpanel');
  const stamp = el('time', 'Not checked yet', 'cg-meta');
  panel.append(toolbar, status, list, more, stamp); host.append(heading, panel);
  function changeTab(value, load = true) { unreadOnly = value; allTab.setAttribute('aria-selected', String(!value)); unreadTab.setAttribute('aria-selected', String(value)); allTab.tabIndex = value ? -1 : 0; unreadTab.tabIndex = value ? 0 : -1; list.setAttribute('aria-labelledby', value ? unreadTab.id : allTab.id); if (load) refresh(); }
  tabs.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const target = event.key === 'Home' ? false : event.key === 'End' ? true : !unreadOnly; changeTab(target); (target ? unreadTab : allTab).focus(); });
  changeTab(false, false);
  function options() { const selected = filter.value; filter.replaceChildren(); for (const value of ['', ...categories]) { const option = el('option', value ? t(value) : t('all')); option.value = value; filter.append(option); } filter.value = selected; filter.setAttribute('aria-label', t('all')); }
  filter.onchange = () => refresh();
  function message(item) {
    const p = item.payload || {};
    if (item.kind === 'sandbox_offline') return [t('sandboxTitle'), locale() === 'ms' ? `Sandbox #${p.instanceId} tidak melapor seperti biasa. Semak status di halaman Sandbox.` : `Sandbox #${p.instanceId} is not reporting normally. Check its status in Sandbox.`];
    if (item.kind === 'ea_disconnected') return [t('eaTitle'), locale() === 'ms' ? `Akaun MT5 ${p.account} berhenti melapor. Semak terminal, EA dan sambungan.` : `MT5 account ${p.account} stopped reporting. Check the terminal, EA and connection.`];
    if (item.kind === 'subscription_expiring') return [t('expiryTitle'), (locale() === 'ms' ? 'Langganan tamat pada ' : 'Your subscription expires on ') + new Date(p.expiresAt).toLocaleDateString(locale() === 'ms' ? 'ms-MY' : 'en-GB') + '.'];
    if (item.kind === 'payment_status') return [t('paymentTitle'), `#${p.paymentId} · ${p.provider} · ${Number(p.amount).toFixed(2)} ${p.currency} · ${copy[locale()].status[p.status] || p.status}`];
    return [item.title, item.body];
  }
  function render(item) {
    const row = el('article', null, 'nc-item' + (!item.read_at ? ' is-unread' : '')), [name, body] = message(item), line = el('div', null, 'nc-item-heading'), time = el('time', new Date(item.created_at).toLocaleString(locale() === 'ms' ? 'ms-MY' : 'en-GB'), 'muted small'); time.dateTime = new Date(item.created_at).toISOString();
    line.append(el('h2', name), time); row.append(line, el('p', body, 'muted'), el('span', t(item.category), 'nc-category'));
    const actions = el('div', null, 'nc-item-actions');
    actions.append(button(t('open'), async event => { if (!item.read_at && !await mutate('/' + item.id + '/read', 'POST', event.currentTarget)) return; go(['sandbox', 'monitoring', 'subscription'].includes(item.target) ? item.target : 'subscription'); }));
    const itemMenu = el('details', null, 'cg-menu'), itemTitle = el('summary', 'Actions', 'button button-small button-secondary'), itemActions = el('div', null, 'cg-menu-content'); itemMenu.dataset.cgMenu = 'true'; itemTitle.setAttribute('role', 'button'); itemTitle.setAttribute('aria-label', 'More actions for ' + name);
    if (!item.read_at) itemActions.append(button(t('read'), event => mutate('/' + item.id + '/read', 'POST', event.currentTarget)));
    itemActions.append(button(t('remove'), event => mutate('/' + item.id, 'DELETE', event.currentTarget), 'button button-small button-danger')); itemMenu.append(itemTitle, itemActions); itemActions.addEventListener('click', event => { if (event.target.closest('button')) itemMenu.open = false; }); actions.append(itemMenu); row.append(actions); list.append(row);
  }
  async function refresh(append = false, passive = false) {
    if (ended || document.hidden) return;
    const preserveReading = active && passive && (list.contains(document.activeElement) || window.scrollY > 160);
    const request = ++generation;
    const query = new URLSearchParams({ limit: active && !preserveReading ? '30' : '1' });
    if (active && !preserveReading && filter.value) query.set('category', filter.value); if (active && !preserveReading && unreadOnly) query.set('unread', '1'); if (append && next) query.set('before', next);
    refreshButton.disabled = more.disabled = true; if (active && !preserveReading) { panel.setAttribute('aria-busy', 'true'); if (!passive) status.textContent = t('loading'); }
    try {
      const data = await api('?' + query); if (request !== generation || ended) return;
      updateBadge(data.unread);
      if (active && !preserveReading) {
        if (!append) list.replaceChildren(); data.notifications.forEach(render); next = data.nextBefore; more.hidden = !next; status.textContent = '';
        if (!list.querySelector('.nc-item')) window.CornGridUI?.empty(list, unreadOnly ? 'No unread notifications' : filter.value ? 'No alerts in this category' : 'You’re all caught up', 'Your next sandbox, EA, subscription or payment update will appear here.', t('settings'), openSettings);
        stamp.textContent = window.CornGridUI?.checked(Date.now()) || 'Just checked'; stamp.dateTime = new Date().toISOString();
      }
    } catch { if (active && request === generation) status.textContent = t('error'); }
    finally { if (request === generation) { refreshButton.disabled = more.disabled = false; panel.removeAttribute('aria-busy'); } }
  }
  async function mutate(suffix, method, control) {
    if (control) control.disabled = true;
    try { await api(suffix, { method }); window.dispatchEvent(new Event('corngrid:notifications-changed')); return true; }
    catch { status.textContent = t('error'); return false; } finally { if (control) control.disabled = false; }
  }
  function confirmClear() {
    return new Promise(resolve => {
      const dialog = el('dialog', null, 'nc-dialog'), name = el('h2', t('clearTitle')); name.id = 'nc-clear-title'; dialog.setAttribute('aria-labelledby', name.id);
      let accepted = false; const cancel = button(t('cancel'), () => dialog.close()), yes = button(t('confirm'), () => { accepted = true; dialog.close(); }, 'button button-primary');
      const actions = el('div', null, 'nc-item-actions'); actions.append(cancel, yes); dialog.append(name, el('p', t('clearNote'), 'muted'), actions); document.body.append(dialog);
      dialog.onclose = () => { dialog.remove(); resolve(accepted); }; dialog.showModal(); cancel.focus();
    });
  }
  const settingsHeading = el('h2', t('settings')), delivery = el('p', t('delivery'), 'muted'), form = el('form', null, 'nc-preferences'), fields = el('fieldset'), feedback = el('p', '', 'nc-status muted'), save = el('button', t('save'), 'button button-primary'), retry = button(t('refresh'), () => loadSettings());
  fields.append(el('legend', t('title'), 'sr-only')); const inputs = {};
  for (const category of categories) {
    const label = el('label', null, 'nc-toggle'), input = el('input'), text = el('span'); input.type = 'checkbox'; input.name = category; inputs[category] = input;
    text.append(el('strong', t(category)), el('small', t(category + '_help'), 'muted')); label.append(input, text); fields.append(label);
  }
  const lead = el('label', null, 'nc-lead'), days = el('input'); days.type = 'number'; days.name = 'expiry_days'; days.min = '1'; days.max = '30'; days.required = true; lead.append(el('span', t('lead')), days, el('small', t('days'), 'muted')); fields.append(lead);
  save.type = 'submit'; save.disabled = true; fields.disabled = true; feedback.setAttribute('role', 'status'); form.append(fields, feedback, save, retry); settings.append(settingsHeading, delivery, form);
  form.onchange = () => { feedback.textContent = t('unsaved'); };
  async function loadSettings() {
    fields.disabled = save.disabled = true; retry.disabled = true;
    try { const data = await api('/preferences'); for (const key of categories) inputs[key].checked = data.preferences[key]; days.value = data.preferences.expiry_days; preferencesLoaded = true; fields.disabled = save.disabled = false; feedback.textContent = ''; }
    catch { preferencesLoaded = false; feedback.textContent = t('preferencesError'); } finally { retry.disabled = false; }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (!preferencesLoaded) return;
    const values = { ...Object.fromEntries(categories.map(key => [key, inputs[key].checked])), expiry_days: Number(days.value) };
    fields.disabled = save.disabled = retry.disabled = true; feedback.textContent = t('saving');
    try { await api('/preferences', { method: 'PATCH', body: JSON.stringify(values) }); feedback.textContent = t('saved'); }
    catch { feedback.textContent = t('error'); } finally { fields.disabled = save.disabled = retry.disabled = false; }
  };
  function schedule() { clearInterval(timer); if (!ended && !document.hidden) { void refresh(false, true); timer = setInterval(() => refresh(false, true), 30000); } }
  window.CornGridNotifications = { onOpen() { active = true; document.getElementById('page-title').textContent = t('title'); void refresh(); }, onClose() { active = false; generation++; }, openSettings: loadSettings };
  window.addEventListener('corngrid:notifications-changed', () => refresh());
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => { ended = true; clearInterval(timer); for (const controller of requests) controller.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { ended = false; schedule(); } });
  options(); updateBadge(0); schedule();
})();
