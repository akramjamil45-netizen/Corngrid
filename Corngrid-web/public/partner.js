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

  const state = { pageOpen: false, partner: null, busy: false };
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
    const data = await request('/partner/profile');
    state.partner = data.partner;
    $('partner-register-section').hidden = Boolean(state.partner);
    $('partner-dashboard-section').hidden = !state.partner;
    if (state.partner) {
      setPill($('partner-status-pill'), state.partner.status === 'active' ? 'Partner' : 'Suspended',
        state.partner.status === 'active' ? 'pill-live' : 'pill-offline');
      await Promise.all([loadOverview(), loadSubmissions(), loadTransactions(), loadPayouts()]);
    } else {
      setPill($('partner-status-pill'), 'Not registered', 'pill-muted');
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
        </div>
        <div class="partner-item-amount">
          <strong>${fmtMoney(payout.amount, payout.currency)}</strong>
          <span class="pill ${payout.status === 'paid' ? 'pill-live' : payout.status === 'approved' ? 'pill-delayed' : payout.status === 'rejected' ? 'pill-offline' : 'pill-muted'}">${escapeHtml(payout.status)}</span>
        </div>
      </div>
    `).join('');
  }

  async function register(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    try {
      await request('/partner/register', {
        method: 'POST',
        body: JSON.stringify({
          displayName: $('partner-display-name').value.trim(),
          company: $('partner-company').value.trim(),
          website: $('partner-website').value.trim()
        })
      });
      toast('Partner registration complete.', 'success');
      await loadProfile();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
    }
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
