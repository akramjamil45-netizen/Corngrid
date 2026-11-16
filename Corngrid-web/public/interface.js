(() => {
  'use strict';
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const action = (label, onClick, cls = 'button button-secondary button-small') => { const node = el('button', label, cls); node.type = 'button'; node.onclick = onClick; return node; };
  function navigate(page) { const node = document.querySelector(`.main-nav .nav-item[data-page="${page}"]`); if (node && !node.hidden && node.style.display !== 'none') node.click(); }
  function skeleton(host, label = 'Loading…', rows = 3) {
    if (!host) return; host.setAttribute('aria-busy', 'true');
    const root = el('div', null, 'cg-skeleton'); root.setAttribute('role', 'status'); root.append(el('span', label, 'sr-only'));
    for (let n = 0; n < rows; n++) { const line = el('span'); line.setAttribute('aria-hidden', 'true'); root.append(line); }
    host.replaceChildren(root);
  }
  function empty(host, title, body, label, onClick) {
    const root = el('div', null, 'cg-empty'); root.append(el('h3', title), el('p', body)); if (label) root.append(action(label, onClick)); host.replaceChildren(root); host.removeAttribute('aria-busy');
  }
  function feedback(host, { title, body = '', label, onClick, tone = 'warning' }) {
    host.replaceChildren(); host.classList.add('cg-feedback'); host.dataset.tone = tone; host.hidden = false; host.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    const content = el('div'); content.append(el('strong', title), el('p', body)); host.append(content); if (label) host.append(action(label, onClick));
  }
  function pending(host, label) { if (!host) return; if (host.dataset.loaded !== 'true') skeleton(host, label); else host.setAttribute('aria-busy', 'true'); }
  function loaded(host) {
    if (!host) return; host.dataset.loaded = 'true'; host.removeAttribute('aria-busy'); const error = document.getElementById(host.id + '-feedback'); if (error) error.hidden = true;
    let stamp = document.getElementById(host.id + '-checked'); if (!stamp) { stamp = el('time', '', 'cg-meta'); stamp.id = host.id + '-checked'; host.after(stamp); }
    const now = Date.now(); stamp.hidden = false; stamp.textContent = checked(now); stamp.dateTime = new Date(now).toISOString();
  }
  function failed(host, title, body, retry, keepStructure = false) {
    if (!host) return; host.removeAttribute('aria-busy');
    if (host.dataset.loaded !== 'true' && !keepStructure) empty(host, title, 'Please try loading this information again.');
    let error = document.getElementById(host.id + '-feedback'); if (!error) { error = el('div'); error.id = host.id + '-feedback'; host.before(error); }
    feedback(error, { title, body: body + (host.dataset.loaded === 'true' ? ' Previously received information is still shown.' : ''), label: 'Try again', onClick: retry, tone: 'error' });
  }
  const checked = time => Number(time) ? 'Last checked: ' + new Date(Number(time)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not checked yet';
  function signals(host, health) {
    host.replaceChildren(); host.className = 'cg-status-grid';
    for (const [key, title] of [['host', 'Hosting node'], ['mt5', 'MT5 connection'], ['ea', 'EA heartbeat']]) {
      const signal = health?.[key] || { status: 'unknown', label: 'Not available' }, card = el('article', null, 'cg-status-card'); card.dataset.state = signal.status;
      card.append(el('h3', title), el('strong', signal.label));
      if (signal.lastSeenAt) { const time = el('time', 'Last report: ' + new Date(Number(signal.lastSeenAt)).toLocaleString('en-GB')); time.dateTime = new Date(Number(signal.lastSeenAt)).toISOString(); card.append(time); }
      if (signal.detail) card.append(el('p', signal.detail)); host.append(card);
    }
  }
  function dialog(title, build) { const root = el('dialog', null, 'cg-dialog'), name = el('h2', title); name.id = 'cg-dialog-' + Math.random().toString(36).slice(2); root.setAttribute('aria-labelledby', name.id); root.append(name); build(root); root.addEventListener('close', () => root.remove(), { once: true }); document.body.append(root); root.showModal(); return root; }
  function init() {
    const main = document.querySelector('.page-wrap') || document.querySelector('main');
    if (main) { if (!main.id) main.id = 'cg-main-content'; main.tabIndex = -1; const link = el('a', 'Skip to content', 'cg-skip-link'); link.href = '#' + main.id; link.onclick = event => { event.preventDefault(); main.focus(); }; document.body.prepend(link); }
    const region = document.getElementById('toast-region'); if (region) { region.setAttribute('aria-live', 'polite'); region.setAttribute('aria-relevant', 'additions'); }
    document.addEventListener('click', event => document.querySelectorAll('details[data-cg-menu][open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelectorAll('details[data-cg-menu][open]').forEach(menu => { menu.open = false; menu.querySelector('summary')?.focus(); }); });
  }
  window.CornGridUI = { el, action, navigate, skeleton, empty, feedback, signals, checked, dialog, pending, loaded, failed };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
