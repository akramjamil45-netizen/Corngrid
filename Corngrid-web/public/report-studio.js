(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Unable to complete this request. Please retry.');
    return result;
  }
  let logoPromise;
  function loadLogo() {
    if (!logoPromise) logoPromise = new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = () => { logoPromise = null; reject(Error('Official CornGrid logo could not be loaded. Please retry.')); }; image.src = '/images/corngrid-report-logo.png?v=20261114-2';
    });
    return logoPromise;
  }
  function mount(root) {
    const role = root.dataset.reportRole, base = role === 'admin' ? '/api/admin/reports' : '/api/reports';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const state = { report: null, canvas: null, busy: false, ticket: 0, dirty: true, options: null, blob: null, shareFile: null, uploaded: null, published: false, visible: false, expanded: false, blankBase: null, manualQueued: false };
    const bodyId = `report-studio-body-${role}`;
    root.className = 'report-studio';
    root.innerHTML = `<button class="rs-toggle" type="button" data-rs="toggle" aria-expanded="false" aria-controls="${bodyId}" aria-label="Open Report Studio"><span class="rs-toggle-copy"><span class="rs-eyebrow">CORNGRID REPORTS</span><span class="rs-toggle-title">Report Studio</span></span><span class="rs-toggle-action"><span data-rs="toggle-label">Open studio</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span></button>
      <div class="rs-body" id="${bodyId}" data-rs="body" hidden><div class="rs-heading"><div><p class="rs-eyebrow">CORNGRID REPORT STUDIO</p><h2>Your data. Ready to share.</h2><p>Generate a branded report from ${role === 'admin' ? 'platform' : 'your account'} records.</p></div><span class="rs-live">Live data on refresh</span></div>
      <div class="rs-controls"><label>${role === 'admin' ? 'Template' : 'Report'}<select data-rs="type" disabled></select></label><label data-rs="period-label">Period<select data-rs="period"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><label><span data-rs="date-caption">Date within reporting period</span><input data-rs="date" type="date" required></label><label data-rs="account-label">MT5 account<select data-rs="account"><option value="all">All available accounts</option></select></label><label data-rs="currency-label">Account currency<select data-rs="currency"><option value="">No currency available</option></select></label><label>Image layout<select data-rs="size"><option value="1080x1350">Portrait · 1080 × 1350</option><option value="1080x1920">Story · 1080 × 1920</option><option value="1920x1080">Landscape · 1920 × 1080</option></select></label><label>Reporting timezone<select data-rs="timezone"></select></label>${role === 'admin' ? '<label data-rs="milestone-label" hidden>Highlight metric<select data-rs="milestone"><option value="registered-users">Registered users</option><option value="new-registrations">New registrations in period</option><option value="linked-accounts">Linked MT5 accounts</option><option value="active-subscribers">Active subscribers</option><option value="sandboxes">Total sandboxes</option></select></label>' : ''}</div>
      ${role === 'admin' ? '<p class="rs-template-hint" data-rs="template-hint"></p><fieldset class="rs-manual" data-rs="manual-editor" hidden><legend>Write your own content</legend><p>The CornGrid header, footer and theme stay fixed. Text you enter is admin-authored content.</p><div class="rs-manual-fields"><label>Title<input data-custom="title" maxlength="100" placeholder="Optional title"></label><label>Subtitle<input data-custom="subtitle" maxlength="180" placeholder="Optional supporting line"></label><label>Highlighted text<input data-custom="highlight" maxlength="80" placeholder="Optional key message"></label><label>Byline<input data-custom="byline" maxlength="64" placeholder="Optional author or team"></label><label class="rs-manual-body">Content<textarea data-custom="body" rows="7" maxlength="2000" placeholder="Write your announcement here. Leave all fields empty to export a blank body."></textarea></label></div><small>Preview updates as you type. Long content must fit the chosen image; use Story for more space.</small></fieldset>' : ''}
      <div class="rs-toolbar"><button class="button button-primary" type="button" data-rs="generate">Generate report</button><label class="rs-auto"><input data-rs="auto" type="checkbox" checked>Refresh preview every 60 seconds</label></div>
      <p class="rs-status" data-rs="status" role="status" aria-live="polite">Loading report options…</p><div class="rs-actions"><button class="button button-secondary" type="button" data-rs="download" disabled>Download PNG</button><button class="button button-secondary" type="button" data-rs="share" disabled>Share image</button><button class="button button-secondary" type="button" data-rs="feed" disabled>Share to live feed</button><button class="button button-secondary" type="button" data-rs="json" disabled>Export data</button></div>
      <div class="rs-empty" data-rs="empty">Choose a report and generate your preview. Missing data appears as N/A.</div><div class="rs-result" data-rs="result" hidden><div class="rs-preview" data-rs="preview" aria-label="CornGrid report image preview"></div><div class="rs-data" data-rs="data"></div></div></div>`;
    const $ = name => root.querySelector(`[data-rs="${name}"]`);
    const dialog = document.createElement('dialog'); dialog.className = 'rs-share';
    dialog.setAttribute('aria-labelledby', 'rs-share-title');
    dialog.innerHTML = '<h2 id="rs-share-title">Share to live feed</h2><p>Your preview and caption will be visible to the CornGrid community. Review the account values before publishing.</p><label>Caption<textarea rows="4" maxlength="4000" aria-label="Report caption"></textarea></label><p class="rs-share-message" role="status" aria-live="polite"></p><div class="rs-share-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button class="button button-primary" type="button" data-publish>Publish report</button></div>';
    document.body.append(dialog);
    const social = document.createElement('dialog'); social.className = 'rs-share rs-social';
    social.setAttribute('aria-labelledby', `${bodyId}-share-title`);
    social.setAttribute('aria-describedby', `${bodyId}-share-help`);
    social.innerHTML = `<div class="rs-social-heading"><h2 id="${bodyId}-share-title">Share report</h2><button class="button button-secondary" type="button" data-social-close aria-label="Close sharing options">Close</button></div><div class="rs-social-content"><p id="${bodyId}-share-help">Share your CornGrid report image and caption to social media.</p><div class="rs-social-preview"><img alt="Report image to share"></div><label>Caption<textarea rows="3" maxlength="4000" aria-label="Social media caption"></textarea></label><p data-social-hint></p><p class="rs-share-message" data-social-message role="status" aria-live="polite"></p></div><div class="rs-social-actions"><button class="button button-primary" type="button" data-social-native>Share to apps</button><button class="button button-secondary" type="button" data-social-download>Download image</button><button class="button button-secondary" type="button" data-social-copy>Copy caption</button></div>`;
    document.body.append(social);
    let socialPreviewUrl = null;
    const socialMessage = text => { social.querySelector('[data-social-message]').textContent = text; };
    function canShareImage() {
      try { return Boolean(state.shareFile && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [state.shareFile] })); }
      catch { return false; }
    }
    const status = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
    function buttons() { for (const name of ['download', 'share', 'feed', 'json']) $(name).disabled = !state.report || state.busy || name === 'feed' && state.published; $('generate').disabled = state.busy; for (const input of root.querySelectorAll('.rs-controls input,.rs-controls select')) input.disabled = state.busy || input === $('type') && !state.options; }
    function invalidate() { state.ticket++; state.dirty = true; state.report = null; state.canvas = null; state.blob = null; state.shareFile = null; state.uploaded = null; state.published = false; $('result').hidden = true; $('empty').hidden = false; status('Filters changed. Generate a report to use the new selection.'); buttons(); }
    function syncScope() {
      const relevant = ['account', 'funds', 'performance'].includes($('type').value), partner = $('type').value === 'partner';
      $('account-label').hidden = !relevant; $('currency-label').hidden = !relevant && !partner;
      $('currency-label').firstChild.textContent = partner ? 'Partner currency' : 'Account currency';
      if (role === 'admin') {
        const manual = $('type').value === 'blank';
        $('manual-editor').hidden = !manual; $('milestone-label').hidden = $('type').value !== 'milestone';
        $('period-label').hidden = manual; $('auto').closest('label').hidden = manual;
        $('date-caption').textContent = manual ? 'Document date' : 'Date within reporting period';
        $('generate').textContent = manual ? 'Update preview' : 'Generate report';
        $('template-hint').textContent = state.options?.types.find(t => t.value === $('type').value)?.description || '';
      }
      const selected = state.options?.accounts.find(a => String(a.id) === $('account').value);
      const currencies = partner ? state.options?.partnerCurrencies || [] : selected ? [selected.currency] : state.options?.currencies || [];
      const old = $('currency').value;
      $('currency').replaceChildren(...(currencies.length ? currencies.map(c => new Option(c, c)) : [new Option('No currency available', '')]));
      if (currencies.includes(old)) $('currency').value = old;
    }
    const timezones = [...new Set([tz, 'Asia/Kuala_Lumpur', 'UTC', 'America/New_York', 'Europe/London'])];
    $('timezone').replaceChildren(...timezones.map(zone => new Option(zone, zone)));
    function today() { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: $('timezone').value, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
    $('date').value = $('date').max = today();
    async function options() {
      state.options = await api(base + '/options');
      $('type').replaceChildren(...state.options.types.map(t => new Option(t.label, t.value)));
      $('account').replaceChildren(new Option('All available accounts', 'all'), ...state.options.accounts.map(a => new Option(a.label, a.id)));
      syncScope();
    }
    async function generate() {
      if (!state.expanded || state.busy || dialog.open || social.open) return;
      const ticket = ++state.ticket;
      state.busy = true; state.report = null; buttons(); status('Reading current records and rendering your report…');
      try {
        if (!state.options) await options();
        if (!$('date').value) throw Error('Choose a reporting date.');
        const manual = role === 'admin' && $('type').value === 'blank';
        const query = new URLSearchParams({ type: $('type').value, period: manual ? 'daily' : $('period').value, date: $('date').value, timezone: $('timezone').value });
        if (['account', 'funds', 'performance'].includes($('type').value)) {
          query.set('accountId', $('account').value);
          if ($('currency').value) query.set('currency', $('currency').value);
        }
        if ($('type').value === 'partner' && $('currency').value) query.set('currency', $('currency').value);
        if (role === 'admin' && $('type').value === 'milestone') query.set('milestoneMetric', $('milestone').value);
        const key = query.toString();
        const [received, logo] = await Promise.all([manual && state.blankBase?.key === key ? Promise.resolve(state.blankBase.report) : api(base + '?' + query), loadLogo()]);
        let report = received;
        if (manual) {
          state.blankBase = { key, report: received };
          const content = Object.fromEntries([...root.querySelectorAll('[data-custom]')].map(input => [input.dataset.custom, input.value]));
          report = { ...received, title: content.title.trim() || received.title, content };
        }
        const canvas = await window.CornGridReportRenderer.render(report, $('size').value, logo);
        // Encode before enabling sharing: native share must run directly in a click.
        const png = await new Promise((resolve, reject) => canvas.toBlob(image => image ? resolve(image) : reject(Error('PNG export failed. Please retry.')), 'image/png'));
        if (ticket !== state.ticket) return;
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${report.title}, ${report.period.start} to ${report.period.end}. Exact values follow the preview.`);
        $('preview').replaceChildren(canvas); state.canvas = canvas; state.report = report; state.blob = png; state.shareFile = new File([png], fileName('png'), { type: 'image/png' }); state.uploaded = null; state.published = false; state.dirty = false;
        const fmt = window.CornGridReportRenderer.format;
        const customDetails = manual ? `<p class="rs-authorship">Admin-authored content</p>${Object.entries(report.content).filter(([,value]) => value.trim()).map(([key,value]) => `<div class="rs-custom-detail"><strong>${esc(key)}</strong><p>${esc(value)}</p></div>`).join('') || '<p>Blank body. Only the CornGrid header and footer are included.</p>'}` : '';
        const chartDetails = report.chart ? `<details><summary>View exact chart data</summary><table><thead><tr><th scope="col">${report.chart.kind === 'comparison' ? 'Metric' : 'Period'}</th><th scope="col">${esc(report.chart.currency || report.chart.unit)}</th></tr></thead><tbody>${report.chart.points.map(p => `<tr><th scope="row">${esc(p.label)}</th><td>${esc(fmt({ ...report.chart, value: p.value }))}</td></tr>`).join('')}</tbody></table></details>` : '';
        $('data').innerHTML = `<h3>${manual ? 'Your content' : 'Report details'}</h3>${customDetails}<dl class="rs-metrics">${report.metrics.map(m => `<div><dt>${esc(m.label)}</dt><dd>${esc(fmt(m))}</dd></div>`).join('')}</dl><p class="rs-source">${esc(report.period.start)} – ${esc(report.period.end)}${report.period.partial ? ' · period to date' : ''}<br>${esc(report.timezone)}<br>${manual ? 'Prepared' : 'Generated'} ${esc(new Date(report.generatedAt).toLocaleString())}${report.sourceAsOf ? '<br>Oldest included observation: ' + esc(new Date(report.sourceAsOf).toLocaleString()) : ''}</p><ul>${report.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>${chartDetails}`;
        $('result').hidden = false; $('empty').hidden = true;
        status(`Report ready · ${canvas.width} × ${canvas.height} · ${manual ? 'admin-authored' : 'sourced ' + new Date(report.generatedAt).toLocaleTimeString()}`);
      } catch (error) { if (ticket === state.ticket) { state.report = null; state.dirty = true; $('result').hidden = true; $('empty').hidden = false; status(error.message, true); } }
      finally { state.busy = false; buttons(); if (state.manualQueued) { state.manualQueued = false; if ($('type').value === 'blank' && state.expanded) setTimeout(generate, 0); } }
    }
    function fileName(extension) { return `corngrid-${state.report.type}-${state.report.period.kind}-${state.report.period.end}.${extension}`; }
    async function blob() {
      if (!state.canvas || !state.report) throw Error('Generate the report first.');
      if (!state.blob) state.blob = await new Promise((resolve, reject) => state.canvas.toBlob(b => b ? resolve(b) : reject(Error('PNG export failed. Please retry.')), 'image/png'));
      return state.blob;
    }
    function download(content, name) { const url = URL.createObjectURL(content), link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
    async function guard(task) { if (state.busy || !state.report) return; state.busy = true; buttons(); try { await task(); } catch (error) { if (error.name !== 'AbortError') status(error.message, true); } finally { state.busy = false; buttons(); } }
    $('generate').addEventListener('click', generate);
    for (const select of root.querySelectorAll('.rs-controls select, .rs-controls input')) select.addEventListener('change', () => { if (select === $('timezone')) { $('date').max = today(); if ($('date').value > today()) $('date').value = today(); } syncScope(); invalidate(); });
    let customTimer;
    if (role === 'admin') root.querySelectorAll('[data-custom]').forEach(input => input.addEventListener('input', () => {
      state.ticket++; state.dirty = true; state.report = null; state.shareFile = null; state.blob = null; state.uploaded = null; state.published = false;
      status('Updating your content preview…'); buttons();
      clearTimeout(customTimer);
      customTimer = setTimeout(() => { if ($('type').value !== 'blank') return; if (state.busy) state.manualQueued = true; else generate(); }, 500);
    }));
    function shareCaption() {
      if (state.report.type === 'blank') return [state.report.content.title, state.report.content.subtitle, state.report.content.highlight, state.report.content.body, state.report.content.byline, 'CornGrid Infrastructure · corngrid.com'].filter(Boolean).join('\n');
      return `${state.report.title} · ${state.report.period.start} to ${state.report.period.end}\nCornGrid Infrastructure · corngrid.com`;
    }
    $('download').addEventListener('click', () => guard(async () => download(await blob(), fileName('png'))));
    $('json').addEventListener('click', () => { if (state.report) download(new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' }), fileName('json')); });
    $('share').addEventListener('click', () => {
      if (state.busy || !state.report || !state.shareFile || social.open) return;
      const supported = canShareImage();
      social.querySelector('textarea').value = shareCaption();
      social.querySelector('[data-social-native]').disabled = !supported;
      social.querySelector('[data-social-native]').hidden = !supported;
      social.querySelector('[data-social-hint]').textContent = supported
        ? 'Tap Share to apps, then choose an available social app from your device’s sharing menu.'
        : 'Direct image sharing is unavailable in this browser. Download the image and copy the caption, then attach them in your social media app.';
      socialMessage('');
      if (socialPreviewUrl) URL.revokeObjectURL(socialPreviewUrl);
      socialPreviewUrl = URL.createObjectURL(state.shareFile);
      social.querySelector('img').src = socialPreviewUrl;
      social.showModal();
    });
    social.querySelector('[data-social-close]').addEventListener('click', () => { if (!state.busy) social.close(); });
    social.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
    social.addEventListener('close', () => { if (social.open) return; if (socialPreviewUrl) URL.revokeObjectURL(socialPreviewUrl); socialPreviewUrl = null; social.querySelector('img').removeAttribute('src'); });
    social.querySelector('[data-social-native]').addEventListener('click', async () => {
      if (state.busy || !state.shareFile) return;
      if (!canShareImage()) { socialMessage('Use Download image and Copy caption to share this report in your social app.'); return; }
      state.busy = true; buttons();
      for (const button of social.querySelectorAll('button')) button.disabled = true;
      try {
        // No encoding, fetch, clipboard operation or await before this invocation.
        await navigator.share({ files: [state.shareFile], title: 'CornGrid report', text: social.querySelector('textarea').value });
        social.close(); status('Sharing menu opened for your report.');
      } catch (error) {
        socialMessage(error.name === 'AbortError' ? 'Sharing cancelled. You can try again or download the image.' : 'Your device could not open image sharing. Try again, or download the image and copy the caption.');
      } finally {
        state.busy = false; buttons();
        for (const button of social.querySelectorAll('button')) button.disabled = false;
        social.querySelector('[data-social-native]').disabled = !canShareImage();
      }
    });
    social.querySelector('[data-social-download]').addEventListener('click', () => {
      if (state.busy || !state.shareFile) return;
      download(state.shareFile, state.shareFile.name);
      socialMessage('Image download started. Attach the PNG in your social media app.');
    });
    social.querySelector('[data-social-copy]').addEventListener('click', async () => {
      const caption = social.querySelector('textarea');
      try {
        if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
        await navigator.clipboard.writeText(caption.value); socialMessage('Caption copied. Paste it alongside your report image.');
      } catch { caption.focus(); caption.select(); socialMessage('Caption selected. Use your device’s Copy command, then paste it in your social app.'); }
    });
    $('feed').addEventListener('click', () => { if (!state.report) return; dialog.querySelector('textarea').value = shareCaption(); dialog.querySelector('.rs-share-message').textContent = ''; dialog.showModal(); });
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
    dialog.querySelector('[data-publish]').addEventListener('click', async () => {
      if (state.busy || !state.report || state.published) return;
      const caption = dialog.querySelector('textarea').value.trim(), message = dialog.querySelector('.rs-share-message');
      if (!caption) { message.textContent = 'Add a caption before publishing.'; dialog.querySelector('textarea').focus(); return; }
      state.busy = true; buttons(); for (const button of dialog.querySelectorAll('button')) button.disabled = true;
      try {
        if (!state.uploaded) { const uploaded = await api(role === 'admin' ? '/api/feed/announcements/uploads' : '/api/feed/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await blob() }); state.uploaded = uploaded.url; }
        const body = role === 'admin' ? { title: state.report.type === 'blank' && !state.report.content.title.trim() ? 'CornGrid update' : state.report.title, content: caption, imagePath: state.uploaded, isPinned: false } : { content: caption, imagePaths: [state.uploaded] };
        await api(role === 'admin' ? '/api/feed/announcements' : '/api/feed/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        state.published = true; dialog.close(); status('Your report was published to the live feed.'); window.CornGridFeed?.refresh?.();
      } catch (error) { message.textContent = error.message; }
      finally { state.busy = false; buttons(); for (const button of dialog.querySelectorAll('button')) button.disabled = false; }
    });
    let loaded = false;
    $('toggle').addEventListener('click', () => {
      state.expanded = !state.expanded;
      $('toggle').setAttribute('aria-expanded', String(state.expanded));
      $('toggle').setAttribute('aria-label', `${state.expanded ? 'Close' : 'Open'} Report Studio`);
      $('toggle-label').textContent = state.expanded ? 'Close studio' : 'Open studio';
      $('body').hidden = !state.expanded;
      if (state.expanded && (!loaded || $('type').value === 'blank' && state.dirty)) { loaded = true; generate(); }
    });
    const observer = new IntersectionObserver(entries => { state.visible = entries.some(e => e.isIntersecting); if (state.visible && state.expanded && !loaded) { loaded = true; generate(); } }); observer.observe(root);
    const timer = setInterval(() => { if (!root.isConnected) { clearInterval(timer); observer.disconnect(); return; } if ($('type').value !== 'blank' && state.expanded && state.visible && !document.hidden && $('auto').checked && !state.dirty && !dialog.open && !social.open) generate(); }, 60000);
  }
  const init = () => document.querySelectorAll('[data-report-role]').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
