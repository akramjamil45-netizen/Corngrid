(() => {
  // CornGrid Admin: Sandbox Management, EA Submissions, Commissions.
  // Realtime updates arrive over /ws/admin/sandbox (cookie-authenticated).
  const state = {
    sandboxOpen: false,
    ws: null,
    wsRetry: 0,
    nodes: [],
    instances: { page: 1, pageSize: 20, total: 0, search: '', status: '' },
    logs: { page: 1, pageSize: 20, total: 0, level: '' },
    events: { page: 1, pageSize: 20, total: 0 },
    submissions: [],
    partners: [],
    strategies: [],
    commissions: { rules: [], transactions: [], payouts: [] }
  };

  const $ = id => document.getElementById(id);
  const $$ = selector => [...document.querySelectorAll(selector)];

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

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  function fmtTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function fmtMoney(value, currency = 'MYR') {
    return `${currency} ${(Number(value) || 0).toFixed(2)}`;
  }

  function pill(label, cls) {
    return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
  }

  const STATUS_PILL = {
    running: 'pill-live', active: 'pill-live', online: 'pill-live', published: 'pill-live', paid: 'pill-live', testing_passed: 'pill-live', approved: 'pill-live',
    stopped: 'pill-offline', offline: 'pill-offline', failed: 'pill-offline', rejected: 'pill-offline', disabled: 'pill-offline',
    deploying: 'pill-delayed', starting: 'pill-delayed', pending: 'pill-delayed', pending_review: 'pill-delayed', under_review: 'pill-delayed', testing: 'pill-delayed', requested: 'pill-delayed', allocating: 'pill-delayed', stopping: 'pill-delayed',
    suspended: 'pill-stale', testing_failed: 'pill-stale'
  };

  function statusPill(status) {
    return pill(status.replace(/_/g, ' '), STATUS_PILL[status] || 'pill-muted');
  }

  // =========================================================================
  // Sandbox Management
  // =========================================================================

  async function loadSandboxOverview() {
    try {
      const data = await api('/api/admin/sandbox/overview');
      $('sb-stat-nodes').textContent = data.nodes.total;
      $('sb-stat-nodes-online').textContent = data.nodes.online;
      $('sb-stat-nodes-offline').textContent = data.nodes.offline;
      $('sb-stat-instances').textContent = data.instances.total;
      $('sb-stat-running').textContent = data.instances.running;
      $('sb-stat-failed').textContent = data.instances.failed;
      $('sb-stat-users').textContent = data.activeUsers;
      $('sb-stat-capacity').textContent = `${data.capacity.availableSlots} / ${data.capacity.totalSlots}`;
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function loadNodes() {
    try {
      const data = await api('/api/admin/sandbox/nodes');
      state.nodes = data.nodes;
      renderNodes();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderNodes() {
    const body = $('sb-nodes-body');
    if (!state.nodes.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="6">No sandbox nodes registered. Add one to get started.</td></tr>';
      return;
    }
    body.innerHTML = state.nodes.map(node => `
      <tr>
        <td><strong>${escapeHtml(node.name)}</strong><br><small class="muted">${escapeHtml(node.nodeUid)}${node.isTestNode ? ' · test node' : ''}</small></td>
        <td>${statusPill(node.online ? 'online' : 'offline')} ${node.status === 'disabled' ? pill('disabled', 'pill-offline') : ''}</td>
        <td><small>${node.cpuPercent != null ? `${Number(node.cpuPercent).toFixed(0)}% CPU` : '—'} · ${node.memoryUsedMb != null && node.ramMb ? `${Math.round(node.memoryUsedMb / 1024)}/${Math.round(node.ramMb / 1024)} GB` : '—'}<br>${node.diskFreeMb != null ? `${Math.round(node.diskFreeMb / 1024)} GB free` : ''}</small></td>
        <td>${node.runningInstances} / ${node.maxInstances}</td>
        <td><small>${fmtTime(node.lastHeartbeatAt)}</small></td>
        <td class="admin-actions">
          ${node.status === 'active'
            ? `<button class="button button-small" data-node-disable="${node.id}">Disable</button>`
            : `<button class="button button-small" data-node-enable="${node.id}">Activate</button>`}
          <button class="button button-small" data-node-restart="${node.id}">Restart agent</button>
          <button class="button button-small" data-node-rotate="${node.id}">Rotate token</button>
          <button class="button button-small button-danger" data-node-delete="${node.id}">Remove</button>
        </td>
      </tr>
    `).join('');
  }

  async function loadInstances() {
    try {
      const params = new URLSearchParams({
        page: state.instances.page,
        pageSize: state.instances.pageSize,
        ...(state.instances.search ? { search: state.instances.search } : {}),
        ...(state.instances.status ? { status: state.instances.status } : {})
      });
      const data = await api(`/api/admin/sandbox/instances?${params}`);
      state.instances.total = data.total;
      renderInstances(data.instances);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderInstances(instances) {
    const body = $('sb-instances-body');
    if (!instances.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="6">No sandbox instances found.</td></tr>';
    } else {
      body.innerHTML = instances.map(instance => `
        <tr>
          <td><strong>${escapeHtml(instance.username || '')}</strong><br><small class="muted">${escapeHtml(instance.email || '')}</small></td>
          <td>${escapeHtml(instance.mt5AccountNumber || '—')}<br><small class="muted">${escapeHtml(instance.brokerServer || '')}</small></td>
          <td>${escapeHtml(instance.strategyName || '—')}</td>
          <td><small>${escapeHtml(instance.nodeName || 'Unassigned')}</small></td>
          <td>${statusPill(instance.status)}${instance.tradingPaused ? ' ' + pill('trading paused', 'pill-delayed') : ''}</td>
          <td class="admin-actions">
            ${['stopped', 'failed'].includes(instance.status) ? `<button class="button button-small" data-inst-start="${instance.id}">Start</button>` : ''}
            ${['running', 'starting', 'deploying'].includes(instance.status) ? `<button class="button button-small" data-inst-stop="${instance.id}">Stop</button>` : ''}
            ${['running', 'stopped', 'failed'].includes(instance.status) ? `<button class="button button-small" data-inst-restart="${instance.id}">Restart</button>` : ''}
            ${instance.status !== 'suspended'
              ? `<button class="button button-small" data-inst-suspend="${instance.id}">Suspend</button>`
              : `<button class="button button-small" data-inst-unsuspend="${instance.id}">Unsuspend</button>`}
            <button class="button button-small button-danger" data-inst-delete="${instance.id}">Delete</button>
          </td>
        </tr>
      `).join('');
    }
    const pages = Math.max(1, Math.ceil(state.instances.total / state.instances.pageSize));
    $('sb-instances-pagination').textContent = `Page ${state.instances.page} of ${pages} · ${state.instances.total} instances`;
    $('sb-instances-prev').disabled = state.instances.page <= 1;
    $('sb-instances-next').disabled = state.instances.page >= pages;
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-delete-all-records]');
    if (!button || button.disabled) return;
    const resource = button.dataset.deleteAllRecords;
    if (!['logs', 'events'].includes(resource)) return;
    const label = resource === 'logs' ? 'deployment logs' : 'system events';
    if (!window.confirm(`Permanently delete ALL ${label}, across every page and filter? This cannot be undone. New records may appear as the system continues running.`)) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/sandbox/${resource}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      state[resource].page = 1;
      await (resource === 'logs' ? loadLogs() : loadEvents());
      toast(`${result.deleted} ${label} deleted.`, 'success');
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });

  async function loadLogs() {
    try {
      const params = new URLSearchParams({
        page: state.logs.page, pageSize: state.logs.pageSize,
        ...(state.logs.level ? { level: state.logs.level } : {})
      });
      const data = await api(`/api/admin/sandbox/logs?${params}`);
      state.logs.total = data.total;
      const body = $('sb-logs-body');
      if (!data.logs.length) {
        body.innerHTML = '<tr><td class="table-empty" colspan="5">No logs recorded yet.</td></tr>';
      } else {
        body.innerHTML = data.logs.map(log => `
          <tr>
            <td><small>${fmtTime(log.created_at)}</small></td>
            <td>${pill(log.level, log.level === 'error' ? 'pill-offline' : log.level === 'warn' ? 'pill-delayed' : 'pill-muted')}</td>
            <td><small>${escapeHtml(log.source)}</small></td>
            <td><small>${escapeHtml(log.instance_uid || log.node_uid || '—')}</small></td>
            <td><small>${escapeHtml(log.message)}</small></td>
          </tr>
        `).join('');
      }
      const pages = Math.max(1, Math.ceil(state.logs.total / state.logs.pageSize));
      $('sb-logs-pagination').textContent = `Page ${state.logs.page} of ${pages}`;
      $('sb-logs-prev').disabled = state.logs.page <= 1;
      $('sb-logs-next').disabled = state.logs.page >= pages;
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function loadEvents() {
    try {
      const params = new URLSearchParams({ page: state.events.page, pageSize: state.events.pageSize });
      const data = await api(`/api/admin/sandbox/events?${params}`);
      state.events.total = data.total;
      const body = $('sb-events-body');
      if (!data.events.length) {
        body.innerHTML = '<tr><td class="table-empty" colspan="4">No events recorded yet.</td></tr>';
      } else {
        body.innerHTML = data.events.map(event => `
          <tr>
            <td><small>${fmtTime(event.created_at)}</small></td>
            <td>${pill(event.event_type, 'pill-muted')}</td>
            <td><small>${escapeHtml(event.actor_type || 'system')}</small></td>
            <td><small>${escapeHtml(event.payload_json || '')}</small></td>
          </tr>
        `).join('');
      }
      const pages = Math.max(1, Math.ceil(state.events.total / state.events.pageSize));
      $('sb-events-pagination').textContent = `Page ${state.events.page} of ${pages}`;
      $('sb-events-prev').disabled = state.events.page <= 1;
      $('sb-events-next').disabled = state.events.page >= pages;
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // Realtime connection: live node/instance updates without polling.
  function connectWs() {
    if (state.ws || !state.sandboxOpen) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/admin/sandbox`);
    state.ws = socket;

    socket.addEventListener('open', () => {
      state.wsRetry = 0;
      const pillEl = $('sandbox-admin-live-pill');
      pillEl.textContent = 'Live';
      pillEl.className = 'pill pill-live';
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'snapshot') {
        applySnapshot(message);
      } else if (message.type === 'event') {
        // Refresh the visible tab on relevant events.
        if (!$('sandbox-tab-events').hidden) loadEvents();
        if (!$('sandbox-tab-instances').hidden) loadInstances();
        loadSandboxOverview();
      }
    });
    socket.addEventListener('close', () => {
      state.ws = null;
      const pillEl = $('sandbox-admin-live-pill');
      pillEl.textContent = 'Reconnecting…';
      pillEl.className = 'pill pill-delayed';
      if (state.sandboxOpen) {
        const delay = Math.min(30000, 1000 * 2 ** state.wsRetry++);
        window.setTimeout(connectWs, delay);
      }
    });
    socket.addEventListener('error', () => socket.close());
  }

  function applySnapshot(snapshot) {
    if (snapshot.stats) {
      $('sb-stat-nodes').textContent = snapshot.stats.nodes.total;
      $('sb-stat-nodes-online').textContent = snapshot.stats.nodes.online;
      $('sb-stat-nodes-offline').textContent = snapshot.stats.nodes.offline;
      $('sb-stat-instances').textContent = snapshot.stats.instances.total;
      $('sb-stat-running').textContent = snapshot.stats.instances.running;
      $('sb-stat-failed').textContent = snapshot.stats.instances.failed;
    }
    if (Array.isArray(snapshot.nodes)) {
      state.nodes = snapshot.nodes.map(node => ({
        id: node.id, nodeUid: node.node_uid, name: node.name, status: node.status,
        isTestNode: Boolean(node.is_test_node), maxInstances: node.max_instances,
        cpuPercent: node.cpu_percent, memoryUsedMb: node.memory_used_mb, ramMb: node.ram_mb,
        diskFreeMb: node.disk_free_mb, runningInstances: node.running_instances,
        lastHeartbeatAt: node.last_heartbeat_at, online: node.online
      }));
      renderNodes();
    }
  }

  function disconnectWs() {
    state.sandboxOpen = false;
    if (state.ws) {
      const socket = state.ws;
      state.ws = null;
      socket.close();
    }
  }

  // =========================================================================
  // EA Submissions
  // =========================================================================

  async function loadPartnerApplications() {
    const data = await api('/api/admin/partner-applications');
    $('partner-applications-body').innerHTML = data.applications.map(application => `<tr>
      <td>${escapeHtml(application.displayName)}</td><td>${escapeHtml(application.email)}</td>
      <td>${statusPill(application.status)}</td><td>${escapeHtml(application.reviewNotes || '')}</td>
      <td>${application.status === 'pending' ? '<button type="button" class="button button-small" data-partner-review="approved" data-partner-id="' + application.userId + '">Approve</button> <button type="button" class="button button-small" data-partner-review="rejected" data-partner-id="' + application.userId + '">Reject</button>' : application.status === 'rejected' ? '<button type="button" class="button button-small button-danger" data-partner-delete="' + application.userId + '" data-partner-name="' + escapeHtml(application.displayName) + '">Delete record</button>' : 'Reviewed'}</td></tr>`).join('') || '<tr><td colspan="5" class="table-empty">No partner applications.</td></tr>';
  }

  async function loadSubmissions() {
    await loadPartnerApplications().catch(error => toast(error.message, 'error'));
    try {
      const status = $('ea-filter-status').value;
      const data = await api(`/api/admin/ea-submissions${status ? `?status=${encodeURIComponent(status)}` : ''}`);
      state.submissions = data.submissions;
      renderSubmissions();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderSubmissions() {
    const body = $('ea-submissions-body');
    if (!state.submissions.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="6">No submissions found.</td></tr>';
      return;
    }
    body.innerHTML = state.submissions.map(sub => `
      <tr>
        <td><strong>${escapeHtml(sub.name)}</strong><br><small class="muted">${escapeHtml((sub.symbols || 'All symbols'))}</small></td>
        <td>${escapeHtml(sub.partnerName || '')}<br><small class="muted">${escapeHtml(sub.partnerEmail || '')}</small></td>
        <td>v${escapeHtml(sub.version)}</td>
        <td>${statusPill(sub.status)}</td>
        <td><small>${fmtTime(sub.createdAt)}</small></td>
        <td class="admin-actions"><button class="button button-small" data-ea-view="${sub.id}">Review</button></td>
      </tr>
    `).join('');
  }

  async function openSubmission(id) {
    try {
      const data = await api(`/api/admin/ea-submissions/${id}`);
      const sub = data.submission;
      $('ea-detail-panel').hidden = false;
      $('ea-detail-title').textContent = `${sub.name} v${sub.version}`;
      const files = (data.files || []).map(file =>
        `<li><a href="/api/admin/ea-submissions/${sub.id}/files/${encodeURIComponent(file.name)}" target="_blank" rel="noopener">${escapeHtml(file.name)}</a> <small class="muted">(${Math.round(file.size / 1024)} KB)</small></li>`
      ).join('');
      const reports = (data.testReports || []).map(report => `
        <tr><td><small>${fmtTime(report.created_at)}</small></td><td>${escapeHtml(report.kind)}</td>
        <td>${statusPill(report.status)}</td><td><small>${report.error_count} errors · ${report.cpu_avg != null ? `${Number(report.cpu_avg).toFixed(0)}% CPU` : '—'} · ${report.memory_peak_mb != null ? `${Math.round(report.memory_peak_mb)} MB` : '—'}</small></td></tr>
      `).join('');

      $('ea-detail-content').innerHTML = `
        <dl class="sandbox-detail-grid">
          <div><dt>Partner</dt><dd>${escapeHtml(sub.partnerName)} (${escapeHtml(sub.partnerEmail)})</dd></div>
          <div><dt>Status</dt><dd>${statusPill(sub.status)}</dd></div>
          <div><dt>Symbols</dt><dd>${escapeHtml(sub.symbols || 'All')}</dd></div>
          <div><dt>Submitted</dt><dd>${fmtTime(sub.createdAt)}</dd></div>
        </dl>
        <h3>Description</h3><p class="muted small">${escapeHtml(sub.description || '')}</p>
        <h3>Strategy</h3><p class="muted small">${escapeHtml(sub.strategyDescription || '—')}</p>
        <h3>Risk management</h3><p class="muted small">${escapeHtml(sub.riskDescription || '—')}</p>
        ${sub.reviewNotes ? `<h3>Review notes</h3><p class="muted small">${escapeHtml(sub.reviewNotes)}</p>` : ''}
        <h3>Source files</h3><ul class="admin-file-list">${files || '<li class="muted">No files</li>'}</ul>
        <h3>Test reports</h3>
        <div class="table-scroll"><table><thead><tr><th>Time</th><th>Kind</th><th>Status</th><th>Result</th></tr></thead><tbody>${reports || '<tr><td class="table-empty" colspan="4">No tests run yet.</td></tr>'}</tbody></table></div>
        <div class="sandbox-controls">
          ${sub.status === 'pending_review' ? `<button class="button button-primary" data-ea-action="review" data-ea-id="${sub.id}">Start review</button>` : ''}
          ${['under_review', 'testing_failed', 'testing_passed'].includes(sub.status) ? `<button class="button button-secondary" data-ea-action="test" data-ea-id="${sub.id}">Run sandbox test</button>` : ''}
          ${['testing_passed', 'under_review'].includes(sub.status) ? `<button class="button button-primary" data-ea-action="approve" data-ea-id="${sub.id}">Approve</button>` : ''}
          ${sub.status === 'approved' ? `<button class="button button-primary" data-ea-action="publish" data-ea-id="${sub.id}">Publish</button>` : ''}
          ${!['rejected', 'published'].includes(sub.status) ? `<button class="button button-danger" data-ea-action="reject" data-ea-id="${sub.id}">Reject</button>` : ''}
        </div>
      `;
      $('ea-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function submissionAction(id, action) {
    try {
      let body;
      if (action === 'reject') {
        const reason = window.prompt('Rejection reason (shown to the partner):');
        if (!reason || reason.trim().length < 5) {
          toast('A rejection reason of at least 5 characters is required.', 'error');
          return;
        }
        body = { reason: reason.trim() };
      }
      const result = await api(`/api/admin/ea-submissions/${id}/${action}`, {
        method: 'POST', body: body ? JSON.stringify(body) : undefined
      });
      toast(result.message || `Submission ${action} done.`, 'success');
      $('ea-detail-panel').hidden = true;
      await loadSubmissions();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // =========================================================================
  // Commissions
  // =========================================================================

  async function loadCommissions() {
    try {
      const [rules, partners] = await Promise.all([
        api('/api/admin/commissions'),
        api('/api/admin/partners')
      ]);
      state.commissions.rules = rules.commissions;
      state.partners = partners.partners;
      renderRules();
      await Promise.all([loadLedger(), loadPayouts()]);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderRules() {
    const body = $('cm-rules-body');
    if (!state.commissions.rules.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="8">No commission rules configured.</td></tr>';
      return;
    }
    body.innerHTML = state.commissions.rules.map(rule => `
      <tr>
        <td>${escapeHtml(rule.partnerName)}</td>
        <td>${escapeHtml(rule.strategyName || 'All partner EAs')}</td>
        <td>${escapeHtml(rule.model)}</td>
        <td>${rule.model === 'percent' ? `${rule.percent}%` : fmtMoney(rule.fixedAmount, rule.currency)}</td>
        <td>${escapeHtml(rule.appliesTo)}</td>
        <td>${fmtMoney(rule.minPayoutThreshold, rule.currency)}</td>
        <td>${rule.isActive ? pill('active', 'pill-live') : pill('inactive', 'pill-offline')}</td>
        <td class="admin-actions">
          <button class="button button-small" data-rule-edit="${rule.id}">Edit</button>
          <button class="button button-small" data-rule-toggle="${rule.id}" data-rule-active="${rule.isActive ? 1 : 0}">${rule.isActive ? 'Disable' : 'Enable'}</button>
        </td>
      </tr>
    `).join('');
  }

  async function loadLedger() {
    const status = $('cm-ledger-status').value;
    const data = await api(`/api/admin/commissions/transactions${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    state.commissions.transactions = data.transactions;
    const body = $('cm-ledger-body');
    if (!data.transactions.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="7">No commission transactions.</td></tr>';
      return;
    }
    body.innerHTML = data.transactions.map(tx => `
      <tr>
        <td><small>${escapeHtml(tx.reference)}</small></td>
        <td>${escapeHtml(tx.partnerName)}</td>
        <td>${escapeHtml(tx.strategyName || '—')}</td>
        <td>${fmtMoney(tx.grossAmount, tx.currency)}</td>
        <td><strong>${fmtMoney(tx.commissionAmount, tx.currency)}</strong></td>
        <td>${statusPill(tx.status)}</td>
        <td class="admin-actions">
          ${tx.status === 'pending' ? `
            <button class="button button-small" data-tx-approve="${tx.id}">Approve</button>
            <button class="button button-small button-danger" data-tx-reject="${tx.id}">Reject</button>` : ''}
        </td>
      </tr>
    `).join('');
  }

  async function loadPayouts() {
    const data = await api('/api/admin/payouts');
    state.commissions.payouts = data.payouts;
    const body = $('cm-payouts-body');
    if (!data.payouts.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="7">No payouts recorded.</td></tr>';
      return;
    }
    body.innerHTML = data.payouts.map(payout => `
      <tr>
        <td><small>${escapeHtml(payout.payoutUid)}</small></td>
        <td>${escapeHtml(payout.partnerName)}<br><small class="muted">${escapeHtml(payout.partnerEmail)}</small></td>
        <td><strong>${fmtMoney(payout.amount, payout.currency)}</strong></td>
        <td>${escapeHtml(payout.method || '—')}</td>
        <td>${statusPill(payout.status)}</td>
        <td><small>${fmtTime(payout.requestedAt)}</small></td>
        <td class="admin-actions">
          ${payout.status === 'pending' ? `<button class="button button-small" data-payout-approve="${payout.id}">Approve</button>` : ''}
          ${['pending', 'approved'].includes(payout.status) ? `<button class="button button-small" data-payout-paid="${payout.id}">Mark paid</button>` : ''}
          ${payout.status !== 'rejected' && payout.status !== 'paid' ? `<button class="button button-small button-danger" data-payout-reject="${payout.id}">Reject</button>` : ''}
        </td>
      </tr>
    `).join('');
  }

  function fillPartnerSelect(select, partners) {
    select.replaceChildren();
    for (const partner of partners) {
      select.add(new Option(`${partner.displayName} (${partner.email})`, partner.userId));
    }
  }

  async function openRuleDialog(rule) {
    const data = await api('/api/admin/partners');
    fillPartnerSelect($('cm-rule-partner'), data.partners);
    const strategiesData = await api('/api/admin/ea-submissions?status=published').catch(() => ({ submissions: [] }));
    const strategySelect = $('cm-rule-strategy');
    strategySelect.replaceChildren();
    strategySelect.add(new Option('All partner EAs', ''));
    for (const sub of strategiesData.submissions) {
      if (sub.strategyId) strategySelect.add(new Option(sub.name, sub.strategyId));
    }

    $('cm-rule-id').value = rule ? rule.id : '';
    $('cm-rule-title').textContent = rule ? 'Edit commission rule' : 'New commission rule';
    if (rule) {
      $('cm-rule-partner').value = rule.partnerId;
      $('cm-rule-strategy').value = rule.strategyId || '';
      $('cm-rule-model').value = rule.model;
      $('cm-rule-percent').value = rule.percent ?? 40;
      $('cm-rule-fixed').value = rule.fixedAmount ?? 40;
      $('cm-rule-applies').value = rule.appliesTo;
      $('cm-rule-threshold').value = rule.minPayoutThreshold;
    } else {
      $('cm-rule-form').reset();
      $('cm-rule-percent').value = 40;
      $('cm-rule-threshold').value = 100;
    }
    syncRuleModel();
    $('cm-rule-dialog').showModal();
  }

  function syncRuleModel() {
    const model = $('cm-rule-model').value;
    $('cm-rule-percent-wrap').hidden = model !== 'percent';
    $('cm-rule-fixed-wrap').hidden = model !== 'fixed';
  }

  async function saveRule(event) {
    event.preventDefault();
    const id = $('cm-rule-id').value;
    const model = $('cm-rule-model').value;
    const payload = {
      partnerId: Number($('cm-rule-partner').value),
      strategyId: $('cm-rule-strategy').value ? Number($('cm-rule-strategy').value) : null,
      model,
      percent: model === 'percent' ? Number($('cm-rule-percent').value) : undefined,
      fixedAmount: model === 'fixed' ? Number($('cm-rule-fixed').value) : undefined,
      appliesTo: $('cm-rule-applies').value,
      minPayoutThreshold: Number($('cm-rule-threshold').value)
    };
    try {
      if (id) {
        await api(`/api/admin/commissions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/admin/commissions', { method: 'POST', body: JSON.stringify(payload) });
      }
      $('cm-rule-dialog').close();
      toast('Commission rule saved.', 'success');
      await loadCommissions();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function openPayoutDialog() {
    const data = await api('/api/admin/partners');
    fillPartnerSelect($('cm-payout-partner'), data.partners);
    $('cm-payout-form').reset();
    updatePayoutBalance();
    $('cm-payout-dialog').showModal();
  }

  async function updatePayoutBalance() {
    const partnerId = Number($('cm-payout-partner').value);
    if (!partnerId) return;
    try {
      // Available balance = approved, unsettled commissions for the partner.
      const data = await api('/api/admin/commissions/transactions?status=approved');
      const balance = data.transactions
        .filter(tx => tx.partnerId === partnerId)
        .reduce((sum, tx) => sum + Number(tx.commissionAmount), 0);
      $('cm-payout-balance').textContent = `Available approved balance: ${fmtMoney(balance)}`;
    } catch { /* non-fatal */ }
  }

  async function savePayout(event) {
    event.preventDefault();
    try {
      const result = await api('/api/admin/payouts', {
        method: 'POST',
        body: JSON.stringify({
          partnerId: Number($('cm-payout-partner').value),
          amount: Number($('cm-payout-amount').value),
          method: $('cm-payout-method').value.trim(),
          reference: $('cm-payout-reference').value.trim()
        })
      });
      $('cm-payout-dialog').close();
      toast(result.message || 'Payout recorded.', 'success');
      await loadCommissions();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // =========================================================================
  // Wiring
  // =========================================================================

  function switchTab(group, name) {
    $$(`[data-${group}-tab]`).forEach(tab => tab.classList.toggle('is-active', tab.dataset[`${group}Tab`] === name));
    $$(`[id^="${group === 'sandbox' ? 'sandbox' : 'commission'}-tab-"]`).forEach(panel => {
      panel.hidden = panel.id !== `${group === 'sandbox' ? 'sandbox' : 'commission'}-tab-${name}`;
    });
  }

  function bind() {
    // Sandbox tabs
    $$('[data-sandbox-tab]').forEach(tab => tab.addEventListener('click', () => {
      switchTab('sandbox', tab.dataset.sandboxTab);
      if (tab.dataset.sandboxTab === 'nodes') loadNodes();
      if (tab.dataset.sandboxTab === 'instances') loadInstances();
      if (tab.dataset.sandboxTab === 'logs') loadLogs();
      if (tab.dataset.sandboxTab === 'events') loadEvents();
    }));
    $$('[data-commission-tab]').forEach(tab => tab.addEventListener('click', () => switchTab('commission', tab.dataset.commissionTab)));

    // Node actions
    $('sb-add-node').addEventListener('click', () => $('sb-node-dialog').showModal());
    $('sb-node-form').addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const result = await api('/api/admin/sandbox/nodes', {
          method: 'POST',
          body: JSON.stringify({
            name: $('sb-node-name').value.trim(),
            maxInstances: Number($('sb-node-max').value) || 10,
            isTestNode: $('sb-node-test').checked
          })
        });
        $('sb-node-dialog').close();
        $('sb-node-form').reset();
        $('sb-token-node-uid').value = result.node.nodeUid;
        $('sb-token-value').value = result.token;
        $('sb-token-dialog').showModal();
        await loadNodes();
        await loadSandboxOverview();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('sb-nodes-body').addEventListener('click', async event => {
      const target = event.target.closest('button');
      if (!target) return;
      try {
        if (target.dataset.nodeDisable) {
          await api(`/api/admin/sandbox/nodes/${target.dataset.nodeDisable}/status`, { method: 'POST', body: JSON.stringify({ status: 'disabled' }) });
          toast('Node disabled.', 'success');
        } else if (target.dataset.nodeEnable) {
          await api(`/api/admin/sandbox/nodes/${target.dataset.nodeEnable}/status`, { method: 'POST', body: JSON.stringify({ status: 'active' }) });
          toast('Node activated.', 'success');
        } else if (target.dataset.nodeRestart) {
          await api(`/api/admin/sandbox/nodes/${target.dataset.nodeRestart}/restart-agent`, { method: 'POST' });
          toast('Agent restart queued.', 'success');
        } else if (target.dataset.nodeRotate) {
          if (!window.confirm('Rotate the node token? The agent on that node must be updated with the new token.')) return;
          const result = await api(`/api/admin/sandbox/nodes/${target.dataset.nodeRotate}/rotate-token`, { method: 'POST' });
          $('sb-token-node-uid').value = '';
          $('sb-token-value').value = result.token;
          $('sb-token-dialog').showModal();
        } else if (target.dataset.nodeDelete) {
          if (!window.confirm('Remove this node? It must not host any sandboxes.')) return;
          await api(`/api/admin/sandbox/nodes/${target.dataset.nodeDelete}`, { method: 'DELETE' });
          toast('Node removed.', 'success');
        }
        await loadNodes();
        await loadSandboxOverview();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    // Instance actions
    let searchTimer = null;
    $('sb-instance-search').addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.instances.search = $('sb-instance-search').value.trim();
        state.instances.page = 1;
        loadInstances();
      }, 350);
    });
    $('sb-instance-status').addEventListener('change', () => {
      state.instances.status = $('sb-instance-status').value;
      state.instances.page = 1;
      loadInstances();
    });
    $('sb-instances-prev').addEventListener('click', () => { state.instances.page -= 1; loadInstances(); });
    $('sb-instances-next').addEventListener('click', () => { state.instances.page += 1; loadInstances(); });
    $('sb-instances-body').addEventListener('click', async event => {
      const target = event.target.closest('button');
      if (!target) return;
      const map = {
        instStart: 'start', instStop: 'stop', instRestart: 'restart',
        instSuspend: 'suspend', instUnsuspend: 'unsuspend'
      };
      try {
        for (const [key, action] of Object.entries(map)) {
          if (target.dataset[key]) {
            await api(`/api/admin/sandbox/instances/${target.dataset[key]}/control`, { method: 'POST', body: JSON.stringify({ action }) });
            toast(`Sandbox ${action} done.`, 'success');
            break;
          }
        }
        if (target.dataset.instDelete) {
          if (!window.confirm('Delete this sandbox instance? The MT5 environment is removed from the node.')) return;
          await api(`/api/admin/sandbox/instances/${target.dataset.instDelete}`, { method: 'DELETE' });
          toast('Sandbox deleted.', 'success');
        }
        await loadInstances();
        await loadSandboxOverview();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    // Logs / events pagination
    $('sb-log-level').addEventListener('change', () => { state.logs.level = $('sb-log-level').value; state.logs.page = 1; loadLogs(); });
    $('sb-logs-prev').addEventListener('click', () => { state.logs.page -= 1; loadLogs(); });
    $('sb-logs-next').addEventListener('click', () => { state.logs.page += 1; loadLogs(); });
    $('sb-events-prev').addEventListener('click', () => { state.events.page -= 1; loadEvents(); });
    $('sb-events-next').addEventListener('click', () => { state.events.page += 1; loadEvents(); });

    // EA submissions
    $('partner-applications-body').addEventListener('click', async event => {
      const button = event.target.closest('button[data-partner-delete]');
      if (!button || button.disabled) return;
      if (!window.confirm(`Permanently delete the rejected partner application for ${button.dataset.partnerName}? This removes the application record. The user account is preserved and can apply again.`)) return;
      button.disabled = true;
      try {
        const result = await api(`/api/admin/partner-applications/${encodeURIComponent(button.dataset.partnerDelete)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
        toast(result.message, 'success');
        await loadPartnerApplications();
      } catch (error) {
        toast(error.message, 'error');
        await loadPartnerApplications().catch(() => {});
      } finally { button.disabled = false; }
    });
    $('partner-applications-body').addEventListener('click', async event => {
      const button = event.target.closest('button[data-partner-review]');
      if (!button) return;
      const status = button.dataset.partnerReview;
      const reviewNotes = status === 'rejected' ? window.prompt('Reason for declining this application:') : '';
      if (status === 'rejected' && !reviewNotes) return;
      button.disabled = true;
      try {
        const result = await api(`/api/admin/partner-applications/${button.dataset.partnerId}/review`, { method: 'POST', body: JSON.stringify({ status, reviewNotes }) });
        toast(result.message, 'success'); await loadPartnerApplications();
      } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    });
    $('ea-filter-status').addEventListener('change', loadSubmissions);
    $('ea-submissions-body').addEventListener('click', event => {
      const target = event.target.closest('button[data-ea-view]');
      if (target) openSubmission(target.dataset.eaView);
    });
    $('ea-detail-close').addEventListener('click', () => { $('ea-detail-panel').hidden = true; });
    $('ea-detail-content').addEventListener('click', event => {
      const target = event.target.closest('button[data-ea-action]');
      if (target) submissionAction(target.dataset.eaId, target.dataset.eaAction);
    });

    // Commissions
    $('cm-add-rule').addEventListener('click', () => openRuleDialog(null));
    $('cm-rule-model').addEventListener('change', syncRuleModel);
    $('cm-rule-form').addEventListener('submit', saveRule);
    $('cm-record-payout').addEventListener('click', openPayoutDialog);
    $('cm-payout-form').addEventListener('submit', savePayout);
    $('cm-payout-partner').addEventListener('change', updatePayoutBalance);
    $('cm-ledger-status').addEventListener('change', loadLedger);
    $('cm-rules-body').addEventListener('click', async event => {
      const target = event.target.closest('button');
      if (!target) return;
      try {
        if (target.dataset.ruleEdit) {
          const rule = state.commissions.rules.find(r => String(r.id) === target.dataset.ruleEdit);
          if (rule) openRuleDialog(rule);
        } else if (target.dataset.ruleToggle) {
          await api(`/api/admin/commissions/${target.dataset.ruleToggle}`, {
            method: 'PUT', body: JSON.stringify({ isActive: target.dataset.ruleActive !== '1' })
          });
          toast('Rule updated.', 'success');
          await loadCommissions();
        }
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('cm-ledger-body').addEventListener('click', async event => {
      const target = event.target.closest('button');
      if (!target) return;
      try {
        if (target.dataset.txApprove) {
          await api(`/api/admin/commissions/transactions/${target.dataset.txApprove}/status`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) });
          toast('Commission approved.', 'success');
        } else if (target.dataset.txReject) {
          await api(`/api/admin/commissions/transactions/${target.dataset.txReject}/status`, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
          toast('Commission rejected.', 'success');
        }
        await loadLedger();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('cm-payouts-body').addEventListener('click', async event => {
      const target = event.target.closest('button');
      if (!target) return;
      try {
        if (target.dataset.payoutApprove) {
          await api(`/api/admin/payouts/${target.dataset.payoutApprove}/status`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) });
        } else if (target.dataset.payoutPaid) {
          await api(`/api/admin/payouts/${target.dataset.payoutPaid}/status`, { method: 'POST', body: JSON.stringify({ status: 'paid' }) });
        } else if (target.dataset.payoutReject) {
          await api(`/api/admin/payouts/${target.dataset.payoutReject}/status`, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
        }
        toast('Payout updated.', 'success');
        await loadPayouts();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    // Generic dialog close buttons.
    $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => {
      const dialog = $(button.dataset.closeDialog);
      if (dialog) dialog.close();
    }));
  }

  window.CornGridAdminSandbox = {
    openSandbox() {
      state.sandboxOpen = true;
      loadSandboxOverview();
      loadNodes();
      connectWs();
    },
    closeSandbox() {
      disconnectWs();
    },
    loadSubmissions,
    loadCommissions
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
