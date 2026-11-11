(() => {
  // CornGrid Partner Program: EA developer portal.
  const API = '/api';

  const STATUS_LABELS = {
    pending_review: 'Pending Review', under_review: 'Under Review', testing: 'Testing',
    testing_failed: 'Testing Failed', testing_passed: 'Testing Passed',
    approved: 'Approved', rejected: 'Rejected', published: 'Published'
  };
  const STATUS_PILL = {
    pending_review: 'pill-delayed', under_review: 'pill-delayed', testing: 'pill-delayed',
    testing_failed: 'pill-stale', testing_passed: 'pill-live', approved: 'pill-live',
    rejected: 'pill-offline', published: 'pill-live'
  };

  const state = { pageOpen: false, partner: null, busy: false, payoutSummary: null, bankBusy: false, payoutBusy: false, payoutAttempt: null };
  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(message, type = '') {
    const region = $('toast-region');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `toast ${type ? `toast-${type}` : ''}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      credentials: 'same-origin',
      signal: options.signal || AbortSignal.timeout(60000),
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    let data = {};
    try { data = await response.json(); } catch { if (response.ok) throw new Error('The server returned an invalid response.'); }
    if (!response.ok) {
      const error = new Error(data.error || 'The request could not be completed.');
      error.code = data.code;
      error.field = data.field;
      throw error;
    }
    return data;
  }

  function fmtMoney(amount, currency = 'MYR') {
    return `${currency} ${(Number(amount) || 0).toFixed(2)}`;
  }

  function fmtTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function setPill(element, label, cls) {
    element.textContent = label;
    element.className = `pill ${cls || 'pill-muted'}`;
  }

  async function loadProfile() {
    const [data, applicationData] = await Promise.all([request('/partner/profile'), request('/partner/application')]);
    const application = applicationData.application;
    const active = data.partner && data.partner.status === 'active';
    const pending = !data.partner && application && application.status === 'pending';
    $('partner-error').hidden = !pending && !(application && application.status === 'rejected') && !(data.partner && !active);
    $('partner-error').textContent = pending ? 'Your partner application is awaiting administrator approval.' : data.partner && !active ? 'Your partner access is suspended. Contact support.' : application && application.status === 'rejected' ? 'Application declined: ' + (application.reviewNotes || 'Contact support.') + ' You may update your details and apply again.' : '';
    $('partner-register-form').hidden = Boolean(pending);
    state.partner = data.partner;
    $('partner-register-section').hidden = Boolean(state.partner);
    $('partner-dashboard-section').hidden = !active;
    if (active) {
      setPill($('partner-status-pill'), state.partner.status === 'active' ? 'Partner' : 'Suspended',
        state.partner.status === 'active' ? 'pill-live' : 'pill-offline');
      await Promise.all([loadOverview(), loadSubmissions(), loadTransactions(), loadPayouts(), loadPayoutSummary(true)]);
    } else {
      setPill($('partner-status-pill'), pending ? 'Awaiting approval' : data.partner ? 'Suspended' : 'Not registered', pending ? 'pill-delayed' : 'pill-muted');
    }
  }

  async function loadOverview() {
    const data = await request('/partner/overview');
    $('partner-stat-earnings').textContent = fmtMoney(data.earnings.approvedTotal, data.earnings.currency);
    $('partner-stat-pending').textContent = fmtMoney(data.earnings.pendingTotal, data.earnings.currency);
    $('partner-stat-paid').textContent = fmtMoney(data.payouts.paidTotal, data.earnings.currency);
    $('partner-stat-payouts').textContent = `${data.payouts.count} payout${data.payouts.count === 1 ? '' : 's'}`;
    $('partner-stat-submissions').textContent = String(data.submissions.total);
    $('partner-stat-published').textContent = `${data.submissions.published} published`;
  }

  async function loadSubmissions() {
    const data = await request('/partner/submissions');
    const list = $('partner-submissions-list');
    if (!data.submissions.length) {
      list.innerHTML = '<p class="muted small">No submissions yet. Submit your first EA above.</p>';
      return;
    }
    list.innerHTML = data.submissions.map(sub => `
      <div class="partner-submission-item">
        <div class="partner-item-body">
          <strong>${escapeHtml(sub.name)} <span class="muted">v${escapeHtml(sub.version)}</span></strong>
          <span class="muted small">${escapeHtml(sub.symbols || 'All symbols')} · submitted ${escapeHtml(fmtTime(sub.createdAt))}</span>
          ${(sub.presets || []).length ? '<span class="muted small">Presets: ' + sub.presets.map(preset => escapeHtml(preset.symbol + ' - ' + preset.name)).join(', ') + '</span>' : ''}
          ${sub.rejectionReason ? `<span class="muted small">Reason: ${escapeHtml(sub.rejectionReason)}</span>` : ''}
          ${sub.reviewNotes ? `<span class="muted small">Review notes: ${escapeHtml(sub.reviewNotes)}</span>` : ''}
        </div>
        <span class="pill ${STATUS_PILL[sub.status] || 'pill-muted'}">${STATUS_LABELS[sub.status] || sub.status}</span>
      </div>
    `).join('');
  }

  async function loadTransactions() {
    const data = await request('/partner/transactions');
    const list = $('partner-transactions-list');
    if (!data.transactions.length) {
      list.innerHTML = '<p class="muted small">No commission transactions yet.</p>';
      return;
    }
    list.innerHTML = data.transactions.map(tx => `
      <div class="partner-ledger-item">
        <div class="partner-item-body">
          <strong>${escapeHtml(tx.reference)}</strong>
          <span class="muted small">${escapeHtml(tx.strategyName || 'Strategy')} · ${escapeHtml(fmtTime(tx.createdAt))}</span>
        </div>
        <div class="partner-item-amount">
          <strong>${fmtMoney(tx.commissionAmount, tx.currency)}</strong>
          <span class="pill ${tx.status === 'paid' ? 'pill-live' : tx.status === 'approved' ? 'pill-delayed' : tx.status === 'rejected' ? 'pill-offline' : 'pill-muted'}">${escapeHtml(tx.status)}</span>
        </div>
      </div>
    `).join('');
  }

  async function loadPayouts() {
    const data = await request('/partner/payouts');
    const list = $('partner-payouts-list');
    if (!data.payouts.length) {
      list.innerHTML = '<p class="muted small">No payouts yet.</p>';
      return;
    }
    list.innerHTML = data.payouts.map(payout => `
      <div class="partner-ledger-item">
        <div class="partner-item-body">
          <strong>${escapeHtml(payout.payoutUid)}</strong>
          <span class="muted small">${escapeHtml(payout.method || 'manual')} · ${escapeHtml(fmtTime(payout.requestedAt))}</span>
          ${payout.recipient ? `<span class="muted small">${escapeHtml(payout.recipient.bankName)} · ${escapeHtml(payout.recipient.accountHolder)} · account ending ${escapeHtml(payout.recipient.accountLast4)}</span>` : ''}
          ${payout.reference ? `<span class="muted small">Transfer reference: ${escapeHtml(payout.reference)}</span>` : ''}
          ${payout.paidAt ? `<span class="muted small">Paid ${escapeHtml(fmtTime(payout.paidAt))}</span>` : ''}
          ${payout.reviewReason ? `<span class="muted small">Reason: ${escapeHtml(payout.reviewReason)}</span>` : ''}
        </div>
        <div class="partner-item-amount">
          <strong>${fmtMoney(payout.amount, payout.currency)}</strong>
          <span class="pill ${payout.status === 'paid' ? 'pill-live' : payout.status === 'approved' ? 'pill-delayed' : payout.status === 'rejected' ? 'pill-offline' : 'pill-muted'}">${escapeHtml(payout.status)}</span>
        </div>
      </div>
    `).join('');
  }

  async function loadPayoutSummary(fillBank = false) {
    const data = await request('/partner/payout-summary');
    state.payoutSummary = data;
    $('partner-payout-available').textContent = fmtMoney(data.availableBalance);
    $('partner-payout-reserved').textContent = fmtMoney(data.reservedBalance);
    $('partner-payout-minimum').textContent = fmtMoney(data.minimumPayout);
    const bank = data.bankDetails;
    $('partner-bank-saved').textContent = bank
      ? `${bank.bankName} · ${bank.accountHolder} · account ending ${bank.accountLast4}` : 'No bank account saved.';
    $('partner-account-number').required = !bank;
    $('partner-account-number-hint').textContent = bank
      ? 'Leave blank to keep your saved account, or enter a new number.'
      : 'Enter the account number exactly as shown by your bank.';
    if (fillBank && bank) {
      $('partner-bank-name').value = bank.bankName;
      $('partner-account-holder').value = bank.accountHolder;
      $('partner-account-number').value = '';
    }
    const amount = $('partner-payout-amount');
    amount.min = String(Math.max(0.01, data.minimumPayout));
    amount.max = String(data.availableBalance);
    const eligible = Boolean(bank) && !data.hasOpenRequest && data.availableBalance > 0 && data.availableBalance >= data.minimumPayout;
    $('partner-payout-request').disabled = !eligible || state.payoutBusy || state.bankBusy;
    $('partner-payout-hint').textContent = data.hasOpenRequest ? 'Your payout is awaiting admin transfer and confirmation. You can submit another request after it is completed or rejected.'
      : !bank ? 'Save your bank details above before requesting a payout.'
      : !eligible ? 'Your approved available balance must reach the minimum payout before you can request payment.'
      : `Payment will be sent to ${bank.bankName}, account ending ${bank.accountLast4}.`;
  }

  const bankFields = { bankName: 'partner-bank-name', accountHolder: 'partner-account-holder', accountNumber: 'partner-account-number', confirmOwnership: 'partner-bank-confirm' };
  function clearPayoutErrors(form, fields) {
    $(form).hidden = true;
    Object.values(fields).forEach(id => {
      $(id).removeAttribute('aria-invalid');
      $(id + '-error').hidden = true;
    });
  }

  function payoutError(summaryId, fields, error) {
    const summary = $(summaryId);
    summary.textContent = error.message;
    summary.hidden = false;
    if (fields[error.field]) {
      const id = fields[error.field];
      $(id).setAttribute('aria-invalid', 'true');
      $(id + '-error').textContent = error.message;
      $(id + '-error').hidden = false;
    }
    summary.focus();
  }

  async function saveBankDetails(event) {
    event.preventDefault();
    if (state.bankBusy) return;
    clearPayoutErrors('partner-bank-error', bankFields);
    state.bankBusy = true;
    $('partner-bank-save').disabled = true;
    $('partner-payout-request').disabled = true;
    $('partner-bank-save').textContent = 'Saving…';
    try {
      await request('/partner/bank-details', { method: 'PUT', body: JSON.stringify({
        bankName: $('partner-bank-name').value.trim(),
        accountHolder: $('partner-account-holder').value.trim(),
        accountNumber: $('partner-account-number').value.trim(),
        confirmOwnership: $('partner-bank-confirm').checked
      }) });
      $('partner-account-number').value = '';
      $('partner-bank-confirm').checked = false;
      toast('Bank details saved.', 'success');
    } catch (error) { payoutError('partner-bank-error', bankFields, error); }
    finally {
      state.bankBusy = false;
      $('partner-bank-save').disabled = false;
      $('partner-bank-save').textContent = 'Save bank details';
      await loadPayoutSummary().catch(error => payoutError('partner-bank-error', bankFields, error));
    }
  }

  async function requestPayout(event) {
    event.preventDefault();
    if (state.payoutBusy || state.bankBusy) return;
    clearPayoutErrors('partner-payout-error', { amount: 'partner-payout-amount' });
    const amount = Number($('partner-payout-amount').value);
    if (!state.payoutAttempt || state.payoutAttempt.amount !== amount) state.payoutAttempt = { amount, requestKey: crypto.randomUUID() };
    state.payoutBusy = true;
    $('partner-payout-request').disabled = true;
    $('partner-payout-request').textContent = 'Submitting…';
    try {
      const result = await request('/partner/payouts', { method: 'POST', body: JSON.stringify(state.payoutAttempt) });
      state.payoutAttempt = null;
      $('partner-payout-form').reset();
      toast(result.message, 'success');
      await Promise.all([loadPayouts(), loadOverview()]);
    } catch (error) { payoutError('partner-payout-error', { amount: 'partner-payout-amount' }, error); }
    finally {
      state.payoutBusy = false;
      $('partner-payout-request').textContent = 'Request payout';
      await loadPayoutSummary().catch(error => payoutError('partner-payout-error', {}, error));
    }
  }

  async function refreshPayouts() {
    await Promise.all([loadPayoutSummary(), loadPayouts(), loadOverview(), loadTransactions()]);
  }

  async function register(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    try {
      const agreement=await showPartnerAgreement();
      if(!agreement)return;
      await request('/partner/register', {
        method: 'POST',
        body: JSON.stringify({
          displayName: $('partner-display-name').value.trim(),
          company: $('partner-company').value.trim(),
          website: $('partner-website').value.trim(),
          agreement
        })
      });
      toast('Application submitted for administrator approval.', 'success');
      await loadProfile();
      await loadAgreements();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
    }
  }

  async function loadAgreements(){
    const data=await request('/partner/agreements');
    let host=$('partner-agreement-records');
    if(!host){host=document.createElement('section');host.id='partner-agreement-records';host.className='panel partner-agreement-records';$('page-partner').append(host);}
    host.hidden=!data.agreements.length;
    host.innerHTML='<h2>User agreements</h2><p class="muted small">Your saved electronic acceptance records / Rekod persetujuan elektronik anda.</p>'+data.agreements.map(row=>`<div class="partner-agreement-record"><div><strong>${escapeHtml(row.terms_version)}</strong><p class="muted small">${escapeHtml(row.signer_name)} · ${escapeHtml(fmtTime(row.accepted_at))} · ${escapeHtml(row.language.toUpperCase())}</p></div><a class="button button-secondary button-small" href="/api/partner/agreements/${encodeURIComponent(row.id)}/file">Download agreement</a></div>`).join('');
  }

  async function showPartnerAgreement(){
    const terms=await request('/partner/terms');
    const doc=terms.document;
    const dialog=document.createElement('dialog');dialog.className='partner-agreement-dialog';dialog.setAttribute('aria-labelledby','partner-agreement-title');
    dialog.innerHTML='<form method="dialog"><header class="partner-agreement-header"><div><p class="eyebrow">CORNGRID PARTNER PROGRAMME</p><h2 id="partner-agreement-title"></h2><p class="muted small">Version '+escapeHtml(doc.version)+' · '+escapeHtml(doc.effectiveDate)+'</p></div><button type="button" class="button button-secondary" data-agreement-close aria-label="Close agreement">✕</button></header><label class="partner-agreement-language">Language / Bahasa<select class="select-control" id="partner-agreement-language"><option value="ms">Bahasa Melayu</option><option value="en">English</option></select></label><div class="partner-agreement-content" tabindex="0" role="region" aria-label="Full partner terms"></div><div class="partner-agreement-footer"><label class="partner-agreement-name"><span data-signer-label></span><input class="input-control" id="partner-agreement-signer" maxlength="160" autocomplete="name" required></label><label class="partner-agreement-consent"><input type="checkbox" id="partner-agreement-accepted" required><span data-accept-label></span></label><label class="partner-agreement-consent"><input type="checkbox" id="partner-agreement-authority" required><span data-authority-label></span></label><p class="muted small" data-agreement-notice></p><div class="partner-agreement-actions"><button type="button" class="button button-secondary" data-agreement-cancel></button><button type="submit" class="button button-primary" data-agreement-submit disabled></button></div></div></form>';
    document.body.append(dialog);
    const language=dialog.querySelector('select');language.value=(localStorage.getItem('selectedLang')||document.documentElement.lang).startsWith('ms')?'ms':'en';
    const accepted=dialog.querySelector('#partner-agreement-accepted'),authority=dialog.querySelector('#partner-agreement-authority'),signer=dialog.querySelector('#partner-agreement-signer'),submit=dialog.querySelector('[data-agreement-submit]');
    function render(){const lang=language.value,ms=lang==='ms';dialog.querySelector('h2').textContent=doc.title[lang];dialog.querySelector('.partner-agreement-content').innerHTML=doc.sections.map((s,i)=>'<section><h3>'+(i+1)+'. '+escapeHtml(s.title[lang])+'</h3><p>'+escapeHtml(s.text[lang])+'</p></section>').join('');dialog.querySelector('[data-signer-label]').textContent=ms?'Nama penuh penandatangan':'Full name of signer';dialog.querySelector('[data-accept-label]').textContent=ms?'Saya telah membaca dan bersetuju dengan Terma & Syarat Program Partner versi ini.':'I have read and agree to this version of the Partner Programme Terms & Conditions.';dialog.querySelector('[data-authority-label]').textContent=ms?'Saya berumur 18 tahun ke atas dan berkuasa bertindak bagi diri sendiri atau organisasi yang dinyatakan.':'I am at least 18 and authorised to act for myself or the stated organisation.';dialog.querySelector('[data-agreement-notice]').textContent=ms?'CornGrid menyimpan nama, butiran akaun, teks dan versi terma, masa, IP dan pelayar sebagai rekod persetujuan. Anda boleh memuat turun salinan. Permohonan masih memerlukan kelulusan admin.':'CornGrid stores your name, account details, terms text/version, time, IP and browser as acceptance evidence. You can download a copy. Administrator approval is still required.';dialog.querySelector('[data-agreement-cancel]').textContent=ms?'Batal':'Cancel';submit.textContent=ms?'Setuju & hantar permohonan':'Accept & submit application';accepted.checked=false;authority.checked=false;submit.disabled=true;dialog.querySelector('.partner-agreement-content').scrollTop=0;}
    function validity(){submit.disabled=!(accepted.checked&&authority.checked&&signer.value.trim().length>=2);}
    render();language.addEventListener('change',render);accepted.addEventListener('change',validity);authority.addEventListener('change',validity);signer.addEventListener('input',validity);
    return new Promise(resolve=>{let result=null;dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();if(submit.disabled)return;result={accepted:true,authority:true,version:doc.version,termsHash:terms.termsHash,language:language.value,signerName:signer.value.trim()};dialog.close();});dialog.querySelectorAll('[data-agreement-close],[data-agreement-cancel]').forEach(b=>b.onclick=()=>dialog.close());dialog.addEventListener('close',()=>{dialog.remove();resolve(result);$('partner-register-form').querySelector('button[type="submit"]').focus();},{once:true});dialog.showModal();});
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function submitEa(event) {
    event.preventDefault();
    if (state.busy) return;
    const fileInput = $('ea-files');
    const files = [...fileInput.files];
    if (!files.length) {
      toast('Choose at least one source file (.mq5, .mqh, or .zip).', 'error');
      return;
    }
    state.busy = true;
    const button = $('ea-submit-btn');
    button.disabled = true;
    button.textContent = 'Uploading…';
    try {
      const encoded = [];
      for (const file of files) {
        encoded.push({ name: file.name, contentBase64: await readFileBase64(file) });
      }
      const presets = [];
      for (const symbol of ['XAUUSD','EURUSD','GBPUSD','USDJPY']) {
        const file = $('ea-preset-' + symbol).files[0];
        if (!file) continue;
        if (!/\.set$/i.test(file.name) || file.size > 128 * 1024) throw new Error('Each preset must be a .set file no larger than 128 KB.');
        presets.push({ symbol, name: file.name, contentBase64: await readFileBase64(file) });
      }
      if (!presets.length) throw new Error('Upload at least one .set preset for your EA.');
      const result = await request('/partner/submissions', {
        method: 'POST',
        body: JSON.stringify({
          name: $('ea-name').value.trim(),
          version: $('ea-version').value.trim(),
          description: $('ea-description').value.trim(),
          symbols: $('ea-symbols').value.trim(),
          strategyDescription: $('ea-strategy-desc').value.trim(),
          riskDescription: $('ea-risk-desc').value.trim(),
          documentation: $('ea-documentation').value.trim(),
          presets,
          files: encoded
        })
      });
      toast(result.message || 'Submission received.', 'success');
      $('partner-submit-form').reset();
      await Promise.all([loadSubmissions(), loadOverview()]);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
      button.disabled = false;
      button.textContent = 'Submit for review';
    }
  }

  function bind() {
    $('partner-register-form').addEventListener('submit', register);
    $('partner-submit-form').addEventListener('submit', submitEa);
    $('partner-bank-form').addEventListener('submit', saveBankDetails);
    $('partner-payout-form').addEventListener('submit', requestPayout);
    $('partner-payout-refresh').addEventListener('click', async () => {
      $('partner-payout-refresh').disabled = true;
      try { await refreshPayouts(); }
      catch (error) { payoutError('partner-payout-error', {}, error); }
      finally { $('partner-payout-refresh').disabled = false; }
    });
    for (const id of [...Object.values(bankFields), 'partner-payout-amount']) {
      $(id).addEventListener('invalid', () => {
        $(id).setAttribute('aria-invalid', 'true');
        $(id + '-error').textContent = $(id).validationMessage;
        $(id + '-error').hidden = false;
      });
      $(id).addEventListener('input', () => {
        $(id).removeAttribute('aria-invalid');
        $(id + '-error').hidden = true;
      });
    }
    window.setInterval(() => {
      if (state.pageOpen && state.partner?.status === 'active' && document.visibilityState === 'visible' && !state.bankBusy && !state.payoutBusy) refreshPayouts().catch(() => {});
    }, 30000);
  }

  window.CornGridPartner = {
    onOpen() {
      state.pageOpen = true;
      loadProfile().catch(error => {
        if (error.code !== 'NOT_A_PARTNER') toast(error.message, 'error');
        if (error.code === 'NOT_A_PARTNER') {
          $('partner-register-section').hidden = false;
          $('partner-dashboard-section').hidden = true;
        }
      });
      loadAgreements().catch(error=>toast(error.message,'error'));
    },
    onClose() {
      state.pageOpen = false;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
