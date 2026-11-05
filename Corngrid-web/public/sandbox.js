(() => {
  // CornGrid Sandbox: user dashboard for the hosted MT5 environment.
  // Talks to /api/sandbox/* and polls status while the page is open.
  const API = '/api';
  const POLL_INTERVAL_MS = 5000;

  const STATUS_LABELS = {
    requested: 'Requested', allocating: 'Allocating', deploying: 'Deploying',
    starting: 'Starting', running: 'Running', stopping: 'Stopping',
    stopped: 'Stopped', failed: 'Failed', suspended: 'Suspended'
  };
  const STATUS_PILL = {
    running: 'pill-live', stopped: 'pill-offline', failed: 'pill-stale',
    suspended: 'pill-stale', deploying: 'pill-delayed', starting: 'pill-delayed',
    allocating: 'pill-delayed', requested: 'pill-delayed', stopping: 'pill-delayed'
  };

  const state = {
    pageOpen: false,
    pollTimer: null,
    status: null,
    strategies: [],
    busy: false
  };

  const $ = id => document.getElementById(id);

  let brokers = [];
  function syncServerMode() {
    const manual = $('sandbox-broker').value === 'manual' || $('sandbox-server-select').value === 'manual';
    $('sandbox-manual-server-label').hidden = !manual;
    $('sandbox-broker-server').required = manual;
    $('sandbox-server-select').required = !manual;
  }

  function filterServers() {
    const broker = brokers.find(item => item.id === $('sandbox-broker').value);
    const select = $('sandbox-server-select');
    const previous = select.value;
    const query = $('sandbox-server-search').value.trim().toLowerCase();
    const matches = (broker?.servers || []).filter(name => name.toLowerCase().includes(query));
    select.replaceChildren(new Option(matches.length ? 'Choose your MT5 server' : 'No matching servers', ''));
    for (const name of matches) select.add(new Option(name, name));
    select.add(new Option('Server not listed / enter manually', 'manual'));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    syncServerMode();
  }

  function changeBroker() {
    const manual = $('sandbox-broker').value === 'manual';
    $('sandbox-server-search-label').hidden = manual;
    $('sandbox-server-select-label').hidden = manual;
    $('sandbox-server-select').disabled = manual;
    $('sandbox-server-search').value = '';
    $('sandbox-broker-server').value = '';
    $('sandbox-server-select').replaceChildren();
    filterServers();
  }

  async function loadBrokers() {
    const select = $('sandbox-broker');
    try {
      const response = await fetch('/mt5-brokers.json?v=20261105-routefix2', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Catalogue unavailable');
      const data = await response.json();
      if (!Array.isArray(data.brokers) || !data.brokers.length) throw new Error('Invalid catalogue');
      brokers = data.brokers;
      select.replaceChildren(new Option('Choose broker', ''));
      for (const broker of brokers) select.add(new Option(broker.name, broker.id));
      select.add(new Option('Other / enter manually', 'manual'));
      select.required = true;
      $('sandbox-manual-server-label').hidden = true;
      $('sandbox-broker-server').required = false;
    } catch (_error) {
      select.replaceChildren(new Option('Other / enter manually', 'manual'));
      changeBroker();
      $('sandbox-server-hint').textContent = 'Server list unavailable. Enter the exact MT5 server from your broker account.';
    }
  }

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
      signal: options.signal || AbortSignal.timeout(30000),
      headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    let data = {};
    try { data = await response.json(); } catch { if (response.ok) throw new Error('The server returned an invalid response.'); }
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  function fmtTime(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString();
  }

  function fmtUptime(startedAt, stoppedAt, status) {
    if (!startedAt || status !== 'running') return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`;
  }

  function setPill(element, label, cls) {
    element.textContent = label;
    element.className = `pill ${cls || 'pill-muted'}`;
  }

  function render() {
    const { status } = state;
    const sandbox = status && status.sandbox;
    const errorBox = $('sandbox-error');

    if (!sandbox) {
      $('sandbox-activation-section').hidden = false;
      $('sandbox-live-section').hidden = true;
      setPill($('sandbox-status-pill'), 'No sandbox', 'pill-offline');
      if (status && status.subscription && status.subscription.status !== 'active') {
        errorBox.hidden = false;
        errorBox.textContent = 'An active CornGrid subscription is required to activate a sandbox. Visit the Subscription page first.';
      } else {
        errorBox.hidden = true;
      }
      return;
    }

    $('sandbox-activation-section').hidden = true;
    $('sandbox-live-section').hidden = false;
    errorBox.hidden = !sandbox.lastError;
    if (sandbox.lastError) errorBox.textContent = `Last error: ${sandbox.lastError}`;

    const statusLabel = STATUS_LABELS[sandbox.status] || sandbox.status;
    setPill($('sandbox-status-pill'), statusLabel, STATUS_PILL[sandbox.status]);
    setPill($('sandbox-ea-status'), `EA: ${sandbox.tradingPaused ? 'Paused' : (sandbox.status === 'running' ? 'Trading' : 'Idle')}`,
      sandbox.tradingPaused ? 'pill-delayed' : (sandbox.status === 'running' ? 'pill-live' : 'pill-muted'));

    $('sandbox-stat-status').textContent = statusLabel;
    $('sandbox-stat-subscription').textContent = `Subscription: ${(status.subscription && status.subscription.status) || '—'}`;
    $('sandbox-stat-connection').textContent = status.mt5Connection === 'connected' ? 'Connected' : status.mt5Connection === 'connecting' ? 'Connecting…' : 'Disconnected';
    $('sandbox-stat-account').textContent = `Account: ${sandbox.mt5AccountNumber || '—'}`;
    $('sandbox-stat-cpu').textContent = typeof sandbox.cpuPercent === 'number' ? `${sandbox.cpuPercent.toFixed(1)}%` : '—';
    $('sandbox-stat-node').textContent = `Node: ${(status.node && status.node.name) || '—'}${status.node ? (status.node.online ? ' (online)' : ' (offline)') : ''}`;
    $('sandbox-stat-memory').textContent = typeof sandbox.memoryMb === 'number' ? `${Math.round(sandbox.memoryMb)} MB` : '—';
    $('sandbox-stat-uptime').textContent = `Uptime: ${fmtUptime(sandbox.startedAt, sandbox.stoppedAt, sandbox.status)}`;

    $('sandbox-detail-strategy').textContent = sandbox.strategyName || '—';
    $('sandbox-detail-broker').textContent = sandbox.brokerServer || '—';
    $('sandbox-detail-account').textContent = sandbox.mt5AccountNumber || '—';
    $('sandbox-detail-node').textContent = (status.node && status.node.name) || 'Pending assignment';
    $('sandbox-detail-heartbeat').textContent = fmtTime(sandbox.lastHeartbeatAt);
    $('sandbox-detail-error').textContent = sandbox.lastError || 'None';

    // Control availability by state.
    const s = sandbox.status;
    $('sandbox-start-btn').disabled = !['stopped', 'failed'].includes(s);
    $('sandbox-stop-btn').disabled = !['running', 'starting', 'deploying', 'failed'].includes(s);
    $('sandbox-restart-btn').disabled = !['running', 'stopped', 'failed'].includes(s);
    $('sandbox-pause-btn').disabled = s !== 'running' || sandbox.tradingPaused;
    $('sandbox-pause-btn').hidden = sandbox.tradingPaused;
    $('sandbox-resume-btn').hidden = !sandbox.tradingPaused;
    $('sandbox-resume-btn').disabled = s !== 'running';
    $('sandbox-reconnect-btn').disabled = !['running', 'failed'].includes(s);
  }

  async function loadStatus() {
    try {
      state.status = await request('/sandbox/status');
      render();
    } catch (error) {
      if (state.pageOpen) toast(error.message, 'error');
    }
  }

  async function loadStrategies() {
    const select = $('sandbox-strategy');
    try {
      const data = await request('/sandbox/strategies');
      state.strategies = data.strategies || [];
      select.replaceChildren();
      if (!state.strategies.length) {
        select.add(new Option('No strategies available yet', ''));
        return;
      }
      for (const strategy of state.strategies) {
        select.add(new Option(`${strategy.name}${strategy.version ? ` v${strategy.version}` : ''}`, strategy.code));
      }
    } catch (_error) {
      select.replaceChildren();
      select.add(new Option('Unable to load strategies', ''));
    }
  }

  async function activate(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    const button = $('sandbox-activate-btn');
    button.disabled = true;
    button.textContent = 'Activating…';
    try {
      const result = await request('/sandbox/activate', {
        method: 'POST',
        body: JSON.stringify({
          strategyCode: $('sandbox-strategy').value,
          brokerServer: ($('sandbox-manual-server-label').hidden ? $('sandbox-server-select').value : $('sandbox-broker-server').value).trim(),
          accountNumber: $('sandbox-account-number').value.trim(),
          password: $('sandbox-password').value
        })
      });
      toast(result.message || 'Sandbox activation started.', 'success');
      $('sandbox-password').value = '';
      await loadStatus();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
      button.disabled = false;
      button.textContent = 'Activate Sandbox';
    }
  }

  async function control(action, { confirmDelete = false } = {}) {
    if (state.busy) return;
    if (confirmDelete) {
      const confirmed = window.confirm('Delete this sandbox? The MT5 environment on the server will be removed. Your subscription and trading account are unaffected. This cannot be undone.');
      if (!confirmed) return;
    }
    state.busy = true;
    try {
      const options = { method: action === 'delete' ? 'DELETE' : 'POST' };
      if (action === 'delete') options.body = JSON.stringify({ confirm: true });
      const result = await request(action === 'delete' ? '/sandbox' : `/sandbox/${action}`, options);
      toast(result.message || `Sandbox ${action} requested.`, 'success');
      await loadStatus();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = window.setInterval(loadStatus, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function bind() {
    $('sandbox-broker').addEventListener('change', changeBroker);
    $('sandbox-server-search').addEventListener('input', filterServers);
    $('sandbox-server-select').addEventListener('change', syncServerMode);
    loadBrokers();
    $('sandbox-activate-form').addEventListener('submit', activate);
    $('sandbox-start-btn').addEventListener('click', () => control('start'));
    $('sandbox-stop-btn').addEventListener('click', () => control('stop'));
    $('sandbox-restart-btn').addEventListener('click', () => control('restart'));
    $('sandbox-pause-btn').addEventListener('click', () => control('pause'));
    $('sandbox-resume-btn').addEventListener('click', () => control('resume'));
    $('sandbox-reconnect-btn').addEventListener('click', () => control('reconnect'));
    $('sandbox-delete-btn').addEventListener('click', () => control('delete', { confirmDelete: true }));
  }

  window.CornGridSandbox = {
    onOpen() {
      state.pageOpen = true;
      loadStrategies();
      loadStatus();
      startPolling();
    },
    onClose() {
      state.pageOpen = false;
      stopPolling();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
