(() => {
  const API = '/api';
  const pageNames = { overview: 'Overview', accounts: 'MT5 Accounts', positions: 'Open Positions', history: 'Trade History', monitoring: 'EA Monitoring', downloads: 'Downloads', settings: 'Settings' };
  const state = { page: 'overview', period: '30d', positions: [], trades: [], positionTotal: 0, tradeTotal: 0, positionPage: 0, tradePage: 0, pageSize: 20, profile: null, accounts: [], overviewAccountId: localStorage.getItem('corngrid_overview_account_id') || '', pairingTimer: null, sharing: { isPublic: false, shareUrl: null }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', dateFormat: 'locale', positionSearchTimer: null, tradeSearchTimer: null };

  function renderOverviewAccountSelector() {
    const select = $('#overview-account-select');
    select.replaceChildren();
    if (!state.accounts.length) {
      select.add(new Option('No linked MT5 accounts — link one in MT5 Accounts', ''));
      select.disabled = true;
      state.overviewAccountId = '';
      localStorage.removeItem('corngrid_overview_account_id');
      $('#overview-account-help').textContent = 'Link an account from the MT5 Accounts page to see its performance.';
      $('#retry-overview-accounts').hidden = true;
      return;
    }
    state.accounts.forEach(account => {
      const identity = account.maskedAccount || `Account ${account.id}`;
      const name = account.accountName || 'CornGrid EA';
      const currency = account.currency || 'N/A';
      select.add(new Option(`${name} · ${identity} · ${currency} · ${account.status}`, String(account.id)));
    });
    select.disabled = false;
    $('#overview-account-help').textContent = `${state.accounts.length} linked ${state.accounts.length === 1 ? 'account' : 'accounts'} · Summary shows one account at a time.`;
    $('#retry-overview-accounts').hidden = true;
    if (!state.accounts.some(account => String(account.id) === state.overviewAccountId)) {
      state.overviewAccountId = String(state.accounts[0].id);
      localStorage.setItem('corngrid_overview_account_id', state.overviewAccountId);
    }
    select.value = state.overviewAccountId;
  }

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      credentials: 'same-origin',
      signal: options.signal || AbortSignal.timeout(15000),
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    let data = {};
    try { data = await response.json(); } catch { if (response.ok) throw new Error('The server returned an invalid response.'); }
    if (response.status === 401 || response.status === 403) {
      void expireSession();
      throw new Error('Your session has expired. Please sign in again.');
    }
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  async function downloadResource(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      const response = await fetch(`${API}/downloads/${encodeURIComponent(button.dataset.downloadId)}`, {
        credentials: 'same-origin'
      });
      if (!response.ok) {
        let data = {};
        try { data = await response.json(); } catch {}
        if (response.status === 401 || response.status === 403) {
          void expireSession();
          throw new Error('Your session has expired. Please sign in again.');
        }
        throw new Error(data.error || 'The download could not be completed.');
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = button.dataset.downloadName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast(`${button.dataset.downloadName} downloaded.`, 'success');
    } catch (error) {
      toast(error.message || 'The download could not be completed.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function toast(message, type = '') {
    const item = document.createElement('div');
    item.className = `toast ${type ? `toast-${type}` : ''}`;
    item.textContent = message;
    $('#toast-region').append(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  async function expireSession() {
    try {
      const response = await fetch(`${API}/logout`, { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Session cleanup failed (${response.status}).`);
    } catch (error) {
      console.error('Unable to clear the expired CornGrid session:', error);
    }
    window.location.replace('/login');
  }

  async function signOut() {
    const button = $('#logout-btn');
    button.disabled = true;
    try {
      const response = await fetch(`${API}/logout`, { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('The server could not end this session.');
      window.location.replace('/login');
    } catch (error) {
      toast(error.message || 'Unable to sign out. Please try again.', 'error');
      button.disabled = false;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function money(value, currency = '') {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
    const formatted = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
    return currency ? `${formatted} ${currency}` : formatted;
  }

  function dateTime(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'N/A';
    if (state.dateFormat === 'iso') return date.toISOString();
    const options = { timeZone: state.timezone || 'UTC' };
    return date.toLocaleString(state.dateFormat === 'en-US' || state.dateFormat === 'en-GB' ? state.dateFormat : undefined, options);
  }

  function dateLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return state.dateFormat === 'iso'
      ? date.toISOString().slice(0, 10)
      : date.toLocaleDateString(state.dateFormat === 'en-US' || state.dateFormat === 'en-GB' ? state.dateFormat : undefined, { timeZone: state.timezone || 'UTC' });
  }

  function safeStatus(status) {
    if (status === 'Online') return '<span class="pill pill-online">Online</span>';
    if (status === 'Offline') return '<span class="pill pill-offline">Offline</span>';
    if (status === 'Authentication error') return '<span class="pill pill-offline">Authentication error</span>';
    return '<span class="pill pill-muted">Waiting for data</span>';
  }

  function setStat(name, value, tone = '') {
    const element = $(`[data-stat="${name}"]`);
    if (!element) return;
    element.textContent = value;
    element.classList.remove('positive', 'negative');
    if (tone) element.classList.add(tone);
  }

  function showPage(name) {
    if (!pageNames[name]) return;
    state.page = name;
    $$('.page').forEach(page => page.classList.toggle('is-visible', page.id === `page-${name}`));
    $$('.nav-item[data-page]').forEach(item => item.classList.toggle('is-active', item.dataset.page === name));
    $('#page-title').textContent = pageNames[name];
    setSidebarOpen(false);
    if (name === 'accounts') loadAccounts(true);
    if (name === 'positions') loadPositions();
    if (name === 'history') loadTrades();
    if (name === 'monitoring') loadMonitoring();
  }

  function setSidebarOpen(open) {
    const sidebar = $('#sidebar');
    const mobile = window.matchMedia('(max-width: 850px)').matches;
    sidebar.classList.toggle('is-open', open);
    sidebar.inert = mobile && !open;
    sidebar.setAttribute('aria-hidden', String(mobile && !open));
    $('#mobile-menu').setAttribute('aria-expanded', String(open));
    $('#mobile-menu').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    $('#overlay').hidden = !open;
  }

  function periodLabel(period) {
    if (period === 'custom' && $('#period-from').value && $('#period-to').value) return `${$('#period-from').value} – ${$('#period-to').value}`;
    return ({ today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'All time', custom: 'Custom range' })[period] || '30 days';
  }

  async function loadOverview() {
    let accountsLoaded = false;
    $$('.stat-value').forEach(element => element.classList.add('is-loading'));
    try {
      const accountList = await request('/mt5/accounts');
      state.accounts = accountList.accounts || [];
      accountsLoaded = true;
      renderOverviewAccountSelector();
      if (!state.accounts.length) {
        $$('.stat-value').forEach(element => element.classList.remove('is-loading'));
        $('#data-notice').hidden = true;
        $('#connection-summary').hidden = false;
        $('#connection-summary').innerHTML = '<div class="connection-symbol">▣</div><strong>No MT5 account linked</strong><p>Link an account to see balance, performance and trade activity here.</p><button class="button button-primary" data-go="accounts">Link an MT5 account</button>';
        $('#connection-details').hidden = true;
        $('#ea-status').textContent = 'No account';
        $('#ea-status').className = 'pill pill-muted';
        $('#overview-positions').innerHTML = '<tr><td colspan="7" class="table-empty">Link an MT5 account to view positions.</td></tr>';
        return;
      }
      const performanceParams = new URLSearchParams({ period: state.period });
      const accountParams = new URLSearchParams();
      if (state.overviewAccountId) {
        performanceParams.set('accountId', state.overviewAccountId);
        accountParams.set('accountId', state.overviewAccountId);
      }
      if (state.period === 'custom') {
        const from = $('#period-from').value;
        const to = $('#period-to').value;
        if (!from || !to) {
          $$('.stat-value').forEach(element => element.classList.remove('is-loading'));
          return;
        }
        if (from > to) {
          $$('.stat-value').forEach(element => element.classList.remove('is-loading'));
          return toast('The custom start date must be on or before the end date.', 'error');
        }
        performanceParams.set('from', from);
        performanceParams.set('to', to);
      }
      const [portfolio, performance, positions] = await Promise.all([
        request(`/portfolio${accountParams.size ? `?${accountParams}` : ''}`),
        request(`/portfolio/performance?${performanceParams}`),
        request(`/portfolio/positions?page=1&limit=5${accountParams.size ? `&${accountParams}` : ''}`)
      ]);
      $$('.stat-value').forEach(element => element.classList.remove('is-loading'));
      const selectedAccount = state.overviewAccountId
        ? (portfolio.accounts || []).find(account => String(account.id) === state.overviewAccountId)
        : null;
      const currency = portfolio.currency || '';
      setStat('balance', portfolio.balanceAvailable ? money(portfolio.balance, currency) : 'N/A');
      setStat('equity', portfolio.equityAvailable ? money(portfolio.equity, currency) : 'N/A');
      setStat('floating', portfolio.floatingAvailable ? money(portfolio.floatingProfit, currency) : 'N/A', portfolio.floatingAvailable ? tone(portfolio.floatingProfit) : '');
      setStat('netProfit', performance.netProfitAvailable ? money(performance.netProfit, currency) : 'N/A', performance.netProfitAvailable ? tone(performance.netProfit) : '');
      setStat('dailyProfit', performance.dailyProfitAvailable ? money(performance.dailyProfit, currency) : 'N/A', performance.dailyProfitAvailable ? tone(performance.dailyProfit) : '');
      setStat('monthlyProfit', performance.monthlyProfitAvailable ? money(performance.monthlyProfit, currency) : 'N/A', performance.monthlyProfitAvailable ? tone(performance.monthlyProfit) : '');
      setStat('closedTrades', performance.closedDealsAvailable ? Number(performance.closedDeals).toLocaleString() : 'N/A');
      setStat('winRate', performance.winRateAvailable ? `${Number(performance.winRate).toFixed(1)}%` : 'N/A');
      setStat('profitFactor', performance.profitFactorAvailable ? Number(performance.profitFactor).toFixed(2) : 'N/A');
      setStat('maxDrawdown', performance.maxDrawdownAvailable ? `${money(performance.maxDrawdown, currency)}${performance.maxDrawdownPercentAvailable ? ` (${Number(performance.maxDrawdownPercent).toFixed(2)}%)` : ''}` : 'N/A');
      setStat('currentDrawdown', performance.currentDrawdownAvailable ? `${money(performance.currentDrawdown, currency)}${performance.currentDrawdownPercentAvailable ? ` (${Number(performance.currentDrawdownPercent).toFixed(2)}%)` : ''}` : 'N/A');
      setStat('activeAccounts', selectedAccount?.status || 'No account', selectedAccount?.status === 'Online' ? 'positive' : selectedAccount?.status === 'Offline' || selectedAccount?.status === 'Authentication error' ? 'negative' : '');
      setStat('grossProfit', performance.grossProfitAvailable ? money(performance.grossProfit, currency) : 'N/A', performance.grossProfitAvailable ? 'positive' : '');
      setStat('grossLoss', performance.grossLossAvailable ? money(performance.grossLoss, currency) : 'N/A', performance.grossLossAvailable ? 'negative' : '');
      setStat('avgWin', performance.averageWinAvailable ? money(performance.averageWin, currency) : 'N/A');
      setStat('avgLoss', performance.averageLossAvailable ? money(performance.averageLoss, currency) : 'N/A');
      setStat('largestWin', performance.largestWinAvailable ? money(performance.largestWin, currency) : 'N/A');
      setStat('largestLoss', performance.largestLossAvailable ? money(performance.largestLoss, currency) : 'N/A');
      setStat('recoveryFactor', performance.recoveryFactorAvailable ? Number(performance.recoveryFactor).toFixed(2) : 'N/A');
      setStat('avgDuration', performance.averageDurationAvailable ? formatDuration(performance.averageDurationSeconds) : 'N/A');
      $$('.stat-period').forEach(item => { item.textContent = `Closed deals · ${periodLabel(state.period)}`; });
      $('[data-stat-deals]').textContent = `${performance.closedDealsAvailable ? performance.closedDeals.toLocaleString() : 'N/A'} closed deals`;
      renderChart(performance.snapshots || [], currency, performance.snapshotUnavailableReason);
      renderOverviewPositions(positions.items || []);
      renderConnection(selectedAccount ? [selectedAccount] : []);
      const update = portfolio.lastUpdate ? dateTime(portfolio.lastUpdate) : 'N/A';
      $('#last-update').textContent = `Last update: ${update}`;
      $('#sidebar-connection').textContent = selectedAccount?.status === 'Online' ? 'Selected EA online' : selectedAccount?.status || 'No selected account';
      $('.sidebar-status .status-dot').classList.toggle('status-dot-muted', selectedAccount?.status !== 'Online');
      $('#live-label').textContent = selectedAccount?.status === 'Online' ? 'LIVE MONITORING' : 'NO LIVE FEED';
      $('#live-indicator').classList.toggle('is-live', selectedAccount?.status === 'Online');
      $('#data-notice').className = 'notice notice-info';
      $('#data-notice').innerHTML = '<span class="notice-icon">i</span><span>Overview metrics, chart, EA status, and open positions are scoped to the selected MT5 account. No demo or estimated trading figures are used.</span>';
      $('#data-notice').hidden = true;
    } catch (error) {
      $$('.stat-value').forEach(element => element.classList.remove('is-loading'));
      $$('[data-stat]').forEach(element => {
        element.textContent = 'N/A';
        element.classList.remove('positive', 'negative');
      });
      $('#last-update').textContent = 'Last update: unavailable';
      if (!accountsLoaded) {
        const accountSelect = $('#overview-account-select');
        accountSelect.replaceChildren(new Option('Could not load accounts — retry', ''));
        accountSelect.disabled = true;
        $('#overview-account-help').textContent = error.message;
        $('#retry-overview-accounts').hidden = false;
      }
      $('#equity-chart').innerHTML = `<div class="chart-empty"><span class="empty-chart-icon">!</span><strong>Unable to load account history</strong><span>${escapeHtml(error.message)}</span></div>`;
      $('#ea-status').textContent = 'Unknown';
      $('#ea-status').className = 'pill pill-muted';
      $('#connection-summary').hidden = false;
      $('#connection-summary').innerHTML = `<div class="connection-symbol">!</div><strong>Connection status unavailable</strong><p>${escapeHtml(error.message)}</p>`;
      $('#connection-details').hidden = true;
      $('#data-notice').className = 'notice notice-warning';
      $('#data-notice').innerHTML = `<span class="notice-icon">!</span><span>${escapeHtml(error.message)} Account metrics could not be refreshed.</span>`;
      $('#data-notice').hidden = false;
      $('#live-label').textContent = 'STATUS UNKNOWN';
      $('#live-indicator').classList.remove('is-live');
      $('#sidebar-connection').textContent = 'Status unavailable';
      $('.sidebar-status .status-dot').classList.add('status-dot-muted');
      toast(error.message, 'error');
    }
  }

  function tone(value) {
    return Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : '';
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return 'N/A';
    if (value < 3600) return `${Math.round(value / 60)} min`;
    if (value < 86400) return `${(value / 3600).toFixed(1)} hr`;
    return `${(value / 86400).toFixed(1)} days`;
  }

  function renderChart(snapshots, currency, unavailableReason) {
    const chart = $('#equity-chart');
    if (!snapshots.length) {
      chart.innerHTML = `<div class="chart-empty"><span class="empty-chart-icon">⌁</span><strong>No equity history available</strong><span>${escapeHtml(unavailableReason || 'Historical chart data will appear after the selected EA sends account snapshots.')}</span></div>`;
      return;
    }
    const width = 800, height = 220, pad = 28;
    const values = snapshots.flatMap(point => [Number(point.equity), Number(point.balance)]).filter(Number.isFinite);
    if (!values.length) return;
    const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    const x = index => pad + index * (width - pad * 2) / Math.max(snapshots.length - 1, 1);
    const y = value => height - pad - (value - min) * (height - pad * 2) / range;
    const pathFor = key => snapshots.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(Number(point[key])).toFixed(1)}`).join(' ');
    const equity = pathFor('equity');
    const balance = pathFor('balance');
    const labels = snapshots.filter((_, index) => index === 0 || index === snapshots.length - 1);
    chart.innerHTML = `<svg class="equity-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historical balance and equity chart"><defs><linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".2"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><path d="${equity} L ${x(snapshots.length - 1)} ${height - pad} L ${pad} ${height - pad} Z" fill="url(#equity-fill)"/><path d="${balance}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="5 5"/><path d="${equity}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>${snapshots.map(point => `<circle cx="${x(snapshots.indexOf(point)).toFixed(1)}" cy="${y(Number(point.equity)).toFixed(1)}" r="3" fill="var(--accent)"><title>${escapeHtml(dateTime(point.capturedAt))} · Equity ${escapeHtml(money(point.equity, currency))} · Balance ${escapeHtml(money(point.balance, currency))}</title></circle>`).join('')}<text x="${pad}" y="${height - 4}" fill="currentColor" font-size="10">${escapeHtml(labels[0] ? dateLabel(labels[0].capturedAt) : '')}</text><text x="${width - pad}" y="${height - 4}" fill="currentColor" font-size="10" text-anchor="end">${escapeHtml(labels[labels.length - 1] ? dateLabel(labels[labels.length - 1].capturedAt) : '')}</text></svg>`;
  }

  function renderConnection(accounts) {
    const online = accounts.filter(account => account.status === 'Online');
    const summary = $('#connection-summary');
    const details = $('#connection-details');
    const pill = $('#ea-status');
    if (!accounts.length) {
      summary.hidden = false;
      details.hidden = true;
      pill.textContent = 'No data';
      pill.className = 'pill pill-muted';
      return;
    }
    summary.hidden = true;
    details.hidden = false;
    pill.textContent = online.length ? 'Online' : accounts.some(account => account.status === 'Offline') ? 'Offline' : 'Waiting for data';
    pill.className = `pill ${online.length ? 'pill-online' : accounts.some(account => account.status === 'Offline') ? 'pill-offline' : 'pill-muted'}`;
    const account = accounts[0];
    details.innerHTML = [
      ['Selected MT5 account', `${account.maskedAccount || `Account ${account.id}`} · ${account.accountName || 'CornGrid EA'}`],
      ['Account status', account.status],
      ['EA version', account.eaVersion || 'N/A'],
      ['Last heartbeat', dateTime(account.lastHeartbeat)],
      ['Last synchronization', dateTime(account.lastSync)]
    ].map(([label, value]) => `<div class="connection-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  function renderOverviewPositions(items) {
    const body = $('#overview-positions');
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="7" class="table-empty">No open positions reported by the selected account.</td></tr>';
      return;
    }
    body.innerHTML = items.map(item => `<tr><td><strong>${escapeHtml(item.symbol)}</strong></td><td>${escapeHtml(item.direction)}</td><td>${escapeHtml(item.volume)}</td><td>${escapeHtml(item.entryPrice ?? 'N/A')}</td><td>${escapeHtml(item.currentPrice ?? 'N/A')}</td><td class="${tone(item.profit)}">${escapeHtml(money(item.profit, item.currency))}</td><td>${escapeHtml(dateTime(item.openedAt))}</td></tr>`).join('');
  }

  async function loadAccounts(showLoading = false) {
    const host = $('#account-list');
    if (state.page === 'accounts' && (showLoading || host.dataset.loaded !== 'true')) {
      host.innerHTML = '<div class="panel empty-state" role="status"><span class="empty-icon">◌</span><h2>Loading your accounts</h2><p>Checking your secure MT5 account links…</p></div>';
    }
    try {
      const result = await request('/mt5/accounts');
      state.accounts = result.accounts || [];
      renderOverviewAccountSelector();
      renderAccounts(state.accounts);
      await loadPortfolioSharing();
      return true;
    } catch (error) {
      if (state.page === 'accounts') {
        host.dataset.loaded = 'false';
        host.innerHTML = `<div class="panel empty-state" role="alert"><span class="empty-icon">!</span><h2>Unable to load MT5 accounts</h2><p>${escapeHtml(error.message)}</p><button class="button button-primary" type="button" data-retry-accounts>Try again</button></div>`;
      }
      if (state.page === 'monitoring') $('#monitor-summary').innerHTML = `<div class="panel empty-state"><span class="empty-icon">!</span><h2>Unable to load monitoring data</h2><p>${escapeHtml(error.message)}</p></div>`;
      toast(error.message, 'error');
      return false;
    }
  }

  function renderAccounts(accounts) {
    const host = $('#account-list');
    host.dataset.loaded = 'true';
    if (!accounts.length) {
      host.innerHTML = '<div class="panel empty-state"><span class="empty-icon">▣</span><h2>No MT5 accounts linked</h2><p>Generate a pairing code, then enter it in the CornGrid EA on your trading terminal. Account data will appear here after the first heartbeat.</p><button class="button button-primary" data-create-pairing>Generate pairing code</button></div>';
      return;
    }
    host.innerHTML = accounts.map(account => `<article class="account-card"><div class="account-card-top"><div><p class="eyebrow">${escapeHtml(account.brokerServer || 'MT5 ACCOUNT')}</p><h2 class="account-id">${escapeHtml(account.maskedAccount || '••••••')}</h2><span class="account-server">${escapeHtml(account.accountName || 'CornGrid EA')} · ${escapeHtml(account.currency || 'Currency N/A')}</span></div>${safeStatus(account.status)}</div><div class="account-stats"><div><span>Balance</span><strong>${escapeHtml(money(account.balance, account.currency))}</strong></div><div><span>Equity</span><strong>${escapeHtml(money(account.equity, account.currency))}</strong></div><div><span>Floating P/L</span><strong class="${tone(account.floatingProfit)}">${escapeHtml(money(account.floatingProfit, account.currency))}</strong></div></div><div class="account-meta"><div>EA version<strong>${escapeHtml(account.eaVersion || 'N/A')}</strong></div><div>Last heartbeat<strong>${escapeHtml(dateTime(account.lastHeartbeat))}</strong></div><div>Linked<strong>${escapeHtml(dateTime(account.linkedAt))}</strong></div><div>Last sync<strong>${escapeHtml(dateTime(account.lastSync))}</strong></div></div><div class="account-actions"><button class="button button-small rename-account" data-id="${escapeHtml(account.id)}" data-name="${escapeHtml(account.accountName || '')}">Rename</button><button class="button button-small unlink-account" data-id="${escapeHtml(account.id)}">Unlink account</button></div></article>`).join('');
  }

  async function renameAccount(id, currentName) {
    const accountName = window.prompt('Enter a name for this MT5 account:', currentName);
    if (accountName === null) return;
    if (!accountName.trim() || accountName.trim().length > 64) return toast('Account name must be between 1 and 64 characters.', 'error');
    try {
      await request(`/mt5/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ accountName: accountName.trim() }) });
      toast('Account name updated.', 'success');
      await loadAccounts();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function createPairingCode() {
    try {
      const result = await request('/mt5/pairing-code', { method: 'POST', body: '{}' });
      $('#pairing-card').hidden = false;
      $('#pairing-code').textContent = result.code;
      const expires = new Date(result.expiresAt);
      $('#pairing-expiry').textContent = `Expires at ${expires.toLocaleTimeString()}`;
      if (state.pairingTimer) window.clearTimeout(state.pairingTimer);
      state.pairingTimer = window.setTimeout(() => {
        $('#pairing-card').hidden = true;
        toast('The pairing code has expired. Generate a new one to continue.');
      }, Math.max(0, new Date(result.expiresAt).getTime() - Date.now()));
      toast('One-time pairing code generated.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async function unlinkAccount(id) {
    if (!window.confirm('Unlink this MT5 account? Its stored snapshots, positions, and imported deals will also be deleted.')) return;
    try {
      await request(`/mt5/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('MT5 account unlinked and its data removed.', 'success');
      await loadAccounts();
      await loadOverview();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function loadPositions() {
    const body = $('#positions-body');
    body.innerHTML = '<tr><td colspan="12" class="table-empty">Loading verified position data…</td></tr>';
    try {
      const params = new URLSearchParams({ page: String(state.positionPage + 1), limit: String(state.pageSize), sort: $('#position-sort').value });
      if ($('#position-search').value.trim()) params.set('search', $('#position-search').value.trim());
      if ($('#position-direction').value) params.set('direction', $('#position-direction').value);
      const result = await request(`/portfolio/positions?${params}`);
      state.positions = result.items || [];
      state.positionTotal = result.total || 0;
      renderPositions();
    } catch (error) {
      state.positionTotal = 0;
      state.positions = [];
      $('#positions-count').textContent = 'Position data unavailable';
      $('#positions-prev').disabled = true;
      $('#positions-next').disabled = true;
      body.innerHTML = `<tr><td colspan="12" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function renderPositions() {
    const items = state.positions;
    const body = $('#positions-body');
    body.innerHTML = items.length ? items.map(item => `<tr><td>${escapeHtml(item.symbol)}</td><td>${escapeHtml(item.direction)}</td><td>${escapeHtml(item.ticket)}</td><td>${escapeHtml(item.volume)}</td><td>${escapeHtml(item.entryPrice ?? 'N/A')}</td><td>${escapeHtml(item.currentPrice ?? 'N/A')}</td><td>${escapeHtml(item.stopLoss ?? 'N/A')}</td><td>${escapeHtml(item.takeProfit ?? 'N/A')}</td><td class="${tone(item.profit)}">${escapeHtml(money(item.profit, item.currency))}</td><td>${escapeHtml(money(item.swap, item.currency))}</td><td>${escapeHtml(money(item.commission, item.currency))}</td><td>${escapeHtml(dateTime(item.openedAt))}</td></tr>`).join('') : '<tr><td colspan="12" class="table-empty">No matching open positions are available.</td></tr>';
    $('#positions-count').textContent = `${state.positionTotal} matching positions · Page ${state.positionPage + 1}`;
    $('#positions-prev').disabled = state.positionPage === 0;
    $('#positions-next').disabled = (state.positionPage + 1) * state.pageSize >= state.positionTotal;
  }

  async function loadTrades() {
    const body = $('#trades-body');
    body.innerHTML = '<tr><td colspan="16" class="table-empty">Loading verified trade data…</td></tr>';
    const params = new URLSearchParams({ page: String(state.tradePage + 1), limit: String(state.pageSize) });
    if ($('#trade-from').value) params.set('from', $('#trade-from').value);
    if ($('#trade-to').value) params.set('to', $('#trade-to').value);
    if ($('#trade-search').value.trim()) params.set('search', $('#trade-search').value.trim());
    if ($('#trade-symbol').value) params.set('symbol', $('#trade-symbol').value);
    if ($('#trade-result').value) params.set('result', $('#trade-result').value);
    params.set('sort', $('#trade-sort').value);
    try {
      const result = await request(`/portfolio/trades?${params}`);
      state.trades = result.items || [];
      state.tradeTotal = result.total || 0;
      const selectedSymbol = $('#trade-symbol').value;
      $('#trade-symbol').replaceChildren(new Option('All symbols', ''), ...(result.symbols || []).map(symbol => new Option(symbol, symbol)));
      if ((result.symbols || []).includes(selectedSymbol)) $('#trade-symbol').value = selectedSymbol;
      renderTrades();
    } catch (error) {
      state.tradeTotal = 0;
      state.trades = [];
      $('#trades-count').textContent = 'Trade data unavailable';
      $('#trades-prev').disabled = true;
      $('#trades-next').disabled = true;
      body.innerHTML = `<tr><td colspan="16" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function renderTrades() {
    const items = state.trades;
    $('#trades-body').innerHTML = items.length ? items.map(item => {
      const hasNetCosts = item.commission != null && item.swap != null;
      const net = hasNetCosts ? Number(item.profit) + Number(item.commission) + Number(item.swap) : null;
      return `<tr><td>${escapeHtml(dateTime(item.closedAt))}</td><td>${escapeHtml(item.symbol)}</td><td>${escapeHtml(item.direction)}</td><td>${escapeHtml(item.volume)}</td><td>${escapeHtml(item.entryPrice ?? 'N/A')}</td><td>${escapeHtml(item.exitPrice ?? 'N/A')}</td><td>${escapeHtml(item.stopLoss ?? 'N/A')}</td><td>${escapeHtml(item.takeProfit ?? 'N/A')}</td><td>${escapeHtml(money(item.profit, item.currency))}</td><td>${escapeHtml(money(item.commission, item.currency))}</td><td>${escapeHtml(money(item.swap, item.currency))}</td><td class="${tone(net)}">${escapeHtml(money(net, item.currency))}</td><td>${escapeHtml(item.durationSeconds == null ? 'N/A' : formatDuration(item.durationSeconds))}</td><td>${escapeHtml(item.magicNumber ?? 'N/A')}</td><td>${escapeHtml(item.eaVersion ?? 'N/A')}</td><td>${escapeHtml(item.dealId)}</td></tr>`;
    }).join('') : '<tr><td colspan="16" class="table-empty">No matching imported deal records are available.</td></tr>';
    $('#trades-count').textContent = `${state.tradeTotal} matching deal records · Page ${state.tradePage + 1}`;
    $('#trades-prev').disabled = state.tradePage === 0;
    $('#trades-next').disabled = (state.tradePage + 1) * state.pageSize >= state.tradeTotal;
  }

  async function exportTrades() {
    if (!state.tradeTotal) return toast('There are no trade records to export.');
    if (state.tradeTotal > 10000) return toast('This export exceeds 10,000 records. Apply a date or symbol filter and try again.', 'error');
    const allTrades = [];
    try {
      const exportPageSize = 100;
      const pageCount = Math.ceil(state.tradeTotal / exportPageSize);
      for (let page = 1; page <= pageCount; page += 1) {
        const params = new URLSearchParams({ page: String(page), limit: String(exportPageSize), sort: $('#trade-sort').value });
        if ($('#trade-from').value) params.set('from', $('#trade-from').value);
        if ($('#trade-to').value) params.set('to', $('#trade-to').value);
        if ($('#trade-search').value.trim()) params.set('search', $('#trade-search').value.trim());
        if ($('#trade-symbol').value) params.set('symbol', $('#trade-symbol').value);
        if ($('#trade-result').value) params.set('result', $('#trade-result').value);
        const result = await request(`/portfolio/trades?${params}`);
        allTrades.push(...(result.items || []));
      }
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const columns = ['closedAt', 'symbol', 'direction', 'volume', 'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'profit', 'commission', 'swap', 'netProfit', 'durationSeconds', 'magicNumber', 'eaVersion', 'dealId', 'currency'];
    const csvCell = value => {
      const text = String(value ?? '');
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [columns.join(','), ...allTrades.map(row => columns.map(key => {
      if (key === 'netProfit') return csvCell(row.commission != null && row.swap != null ? Number(row.profit) + Number(row.commission) + Number(row.swap) : null);
      return csvCell(row[key]);
    }).join(','))].join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = 'corngrid-trade-history.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function loadMonitoring() {
    if (!await loadAccounts()) return;
    const host = $('#monitor-summary');
    if (!state.accounts.length) {
      host.innerHTML = '<div class="panel empty-state"><span class="empty-icon">⌁</span><h2>Waiting for EA data</h2><p>When an EA is linked, its heartbeat, last synchronization, and current positions will be shown here. An account record alone is not considered online.</p></div>';
      return;
    }
    host.innerHTML = `<div class="account-grid">${state.accounts.map(account => `<article class="account-card"><div class="account-card-top"><div><p class="eyebrow">${escapeHtml(account.brokerServer || 'MT5 ACCOUNT')}</p><h2 class="account-id">${escapeHtml(account.maskedAccount || '••••••')}</h2><span class="account-server">${escapeHtml(account.accountName || 'CornGrid EA')} · ${escapeHtml(account.eaVersion || 'Version N/A')}</span></div>${safeStatus(account.status)}</div><div class="account-meta"><div>Last heartbeat<strong>${escapeHtml(dateTime(account.lastHeartbeat))}</strong></div><div>Last synchronization<strong>${escapeHtml(dateTime(account.lastSync))}</strong></div><div>Open positions<strong>${escapeHtml(account.openPositions ?? 'N/A')}</strong></div><div>Linked on<strong>${escapeHtml(dateTime(account.linkedAt))}</strong></div></div><p class="method-note">${account.status === 'Online' ? 'A recent authenticated heartbeat was received.' : account.lastHeartbeat ? 'No authenticated heartbeat was received within the configured timeout.' : 'The account is paired, but its first heartbeat has not arrived.'}</p></article>`).join('')}</div>`;
  }

  async function loadProfile() {
    try {
      const data = await request('/me');
      state.profile = data;
      $('#profile-username').value = data.username || '';
      $('#profile-email').value = data.email || '';
      $('#profile-bio').value = data.bio || '';
      $('#created-at').textContent = dateTime(data.created_at);
      const name = data.username || data.email || 'Account';
      $('#user-name').textContent = name;
      $('#user-avatar').textContent = name.charAt(0).toUpperCase();
      if (data.preferences) applyPreferences(data.preferences);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function loadPortfolioSharing() {
    try {
      state.sharing = await request('/user/portfolio-sharing');
      $('#portfolio-visibility').value = state.sharing.isPublic ? 'public' : 'private';
      renderPublicAccountSelection(state.sharing.accounts || []);
      $('#portfolio-sharing-status').textContent = state.sharing.isPublic
        ? 'Your selected accounts are public and appear in the CornGrid portfolio directory.'
        : 'Your portfolio is private and is not visible in the public directory. Choose accounts before publishing.';
      $('#portfolio-share-link').hidden = !state.sharing.isPublic || !state.sharing.shareUrl;
      $('#portfolio-share-url').value = state.sharing.isPublic && state.sharing.shareUrl
        ? new URL(state.sharing.shareUrl, window.location.origin).href
        : '';
    } catch (error) {
      $('#portfolio-sharing-status').textContent = 'Portfolio sharing settings could not be loaded.';
      toast(error.message, 'error');
    }
  }

  function renderPublicAccountSelection(accounts) {
    const host = $('#public-account-selection-list');
    const count = $('#public-account-selection-count');
    if (!accounts.length) {
      count.textContent = '0 linked accounts';
      host.innerHTML = '<div class="empty-settings"><h3>No MT5 accounts linked</h3><p>Link one or more MT5 accounts from the MT5 Accounts page before selecting accounts to share.</p><button class="button button-secondary" type="button" data-go="accounts">Manage MT5 accounts</button></div>';
      return;
    }
    const selectedCount = accounts.filter(account => account.selectedPublic).length;
    count.textContent = `${selectedCount} of ${accounts.length} selected`;
    host.innerHTML = accounts.map(account => `<label class="public-account-option">
      <input type="checkbox" name="public-account" value="${escapeHtml(account.id)}" ${account.selectedPublic ? 'checked' : ''}>
      <span class="public-account-option-main"><strong>${escapeHtml(account.accountName)}</strong><small>${escapeHtml(account.maskedAccount)} · ${escapeHtml(account.currency)} · ${escapeHtml(account.lastHeartbeat ? dateTime(account.lastHeartbeat) : 'Waiting for data')}</small></span>
      <span class="public-account-option-values"><span>Balance <strong>${escapeHtml(money(account.balance, account.currency))}</strong></span><span>Equity <strong>${escapeHtml(money(account.equity, account.currency))}</strong></span></span>
    </label>`).join('');
  }

  function selectedPublicAccountIds() {
    return $$('input[name="public-account"]:checked', $('#public-account-selection-list'))
      .map(input => Number(input.value));
  }

  async function savePortfolioSharing() {
    const isPublic = $('#portfolio-visibility').value === 'public';
    const accountIds = selectedPublicAccountIds();
    if (isPublic && accountIds.length === 0) {
      toast('Select at least one trading account to make your portfolio public.', 'error');
      return;
    }
    const selectionChanged = accountIds.length !== (state.sharing.selectedAccountIds || []).length ||
      accountIds.some(id => !(state.sharing.selectedAccountIds || []).includes(id));
    if (isPublic && (!state.sharing.isPublic || selectionChanged)) {
      const selectedNames = (state.sharing.accounts || [])
        .filter(account => accountIds.includes(Number(account.id)))
        .map(account => account.accountName)
        .join(', ');
      const message = `Make your portfolio public with these selected account(s): ${selectedNames}? Their account summaries, positions, and recent trades will be visible to anyone.`;
      if (!window.confirm(message)) {
        $('#portfolio-visibility').value = state.sharing.isPublic ? 'public' : 'private';
        return;
      }
    } else if (!isPublic && state.sharing.isPublic) {
      if (!window.confirm('Make your portfolio private? Its public directory listing and share page will stop being accessible.')) {
        $('#portfolio-visibility').value = 'public';
        return;
      }
    }
    const button = $('#save-portfolio-visibility');
    button.disabled = true;
    try {
      state.sharing = await request('/user/portfolio-sharing', {
        method: 'PATCH',
        body: JSON.stringify({ isPublic, accountIds })
      });
      await loadPortfolioSharing();
      toast(isPublic ? 'Your portfolio is now public.' : 'Your portfolio is now private.', 'success');
    } catch (error) {
      $('#portfolio-visibility').value = state.sharing.isPublic ? 'public' : 'private';
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function applyPreferences(preferences) {
    const theme = ['dark', 'light', 'system'].includes(preferences.theme) ? preferences.theme : $('#pref-theme').value || 'dark';
    $('#pref-theme').value = theme;
    if (preferences.currency !== undefined) $('#pref-currency').value = ['account', 'USD', 'EUR', 'GBP'].includes(preferences.currency) ? preferences.currency : 'account';
    if (preferences.timezone !== undefined) {
      $('#pref-timezone').value = preferences.timezone || 'UTC';
      state.timezone = preferences.timezone || 'UTC';
    } else if (!state.timezone) {
      state.timezone = 'UTC';
      $('#pref-timezone').value = 'UTC';
    }
    if (preferences.dateFormat !== undefined) $('#pref-date-format').value = ['locale', 'en-US', 'en-GB', 'iso'].includes(preferences.dateFormat) ? preferences.dateFormat : 'locale';
    state.dateFormat = $('#pref-date-format').value;
    const light = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.body.classList.toggle('theme-light', light);
  }

  $$('.nav-item[data-page]').forEach(item => item.addEventListener('click', () => showPage(item.dataset.page)));
  $('#mobile-menu').addEventListener('click', () => {
    const open = !$('#sidebar').classList.contains('is-open');
    setSidebarOpen(open);
  });
  $('#overlay').addEventListener('click', () => {
    setSidebarOpen(false);
    $('#mobile-menu').focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('#sidebar').classList.contains('is-open')) {
      setSidebarOpen(false);
      $('#mobile-menu').focus();
    }
  });
  window.matchMedia('(max-width: 850px)').addEventListener('change', () => setSidebarOpen(false));
  setSidebarOpen(false);
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('theme-light') ? 'dark' : 'light';
    $('#pref-theme').value = next;
    applyPreferences({ theme: next });
    request('/user/preferences', { method: 'PATCH', body: JSON.stringify({ theme: next }) }).catch(error => toast(error.message, 'error'));
  });
  $('#period-select').addEventListener('change', event => {
    const custom = event.target.value === 'custom';
    state.period = event.target.value;
    $('#period-from').hidden = !custom;
    $('#period-to').hidden = !custom;
    if (custom) $('#period-from').focus();
    loadOverview();
  });
  $('#overview-account-select').addEventListener('change', event => {
    state.overviewAccountId = event.target.value;
    if (state.overviewAccountId) localStorage.setItem('corngrid_overview_account_id', state.overviewAccountId);
    else localStorage.removeItem('corngrid_overview_account_id');
    loadOverview();
  });
  $('#period-from').addEventListener('change', loadOverview);
  $('#period-to').addEventListener('change', loadOverview);
  $('#refresh-button').addEventListener('click', loadOverview);
  $('#retry-overview-accounts').addEventListener('click', () => loadOverview());
  $('#refresh-positions').addEventListener('click', loadPositions);
  $('[data-refresh]').addEventListener('click', loadMonitoring);
  $('#create-pairing').addEventListener('click', createPairingCode);
  $('#refresh-accounts').addEventListener('click', loadAccounts);
  document.addEventListener('click', event => {
    const pageLink = event.target.closest('[data-go]');
    if (pageLink) showPage(pageLink.dataset.go);
    const downloadButton = event.target.closest('[data-download-id]');
    if (downloadButton) downloadResource(downloadButton);
    if (event.target.closest('[data-create-pairing]')) createPairingCode();
    if (event.target.closest('[data-retry-accounts]')) {
      $('#account-list').dataset.loaded = 'false';
      loadAccounts();
    }
    const unlink = event.target.closest('.unlink-account');
    if (unlink) unlinkAccount(unlink.dataset.id);
    const rename = event.target.closest('.rename-account');
    if (rename) renameAccount(rename.dataset.id, rename.dataset.name);
  });
  $('#position-search').addEventListener('input', () => {
    window.clearTimeout(state.positionSearchTimer);
    state.positionSearchTimer = window.setTimeout(() => { state.positionPage = 0; loadPositions(); }, 250);
  });
  $('#position-direction').addEventListener('change', () => { state.positionPage = 0; loadPositions(); });
  $('#position-sort').addEventListener('change', () => { state.positionPage = 0; loadPositions(); });
  $('#positions-prev').addEventListener('click', () => { if (state.positionPage) { state.positionPage--; loadPositions(); } });
  $('#positions-next').addEventListener('click', () => { state.positionPage++; loadPositions(); });
  $('#trade-search').addEventListener('input', () => {
    window.clearTimeout(state.tradeSearchTimer);
    state.tradeSearchTimer = window.setTimeout(() => { state.tradePage = 0; loadTrades(); }, 250);
  });
  $('#trade-symbol').addEventListener('change', () => { state.tradePage = 0; loadTrades(); });
  $('#trade-result').addEventListener('change', () => { state.tradePage = 0; loadTrades(); });
  $('#trade-sort').addEventListener('change', () => { state.tradePage = 0; loadTrades(); });
  $('#trade-from').addEventListener('change', () => { state.tradePage = 0; loadTrades(); });
  $('#trade-to').addEventListener('change', () => { state.tradePage = 0; loadTrades(); });
  $('#trades-prev').addEventListener('click', () => { if (state.tradePage) { state.tradePage--; loadTrades(); } });
  $('#trades-next').addEventListener('click', () => { state.tradePage++; loadTrades(); });
  $('#export-trades').addEventListener('click', exportTrades);
  $$('.settings-tab').forEach(button => button.addEventListener('click', () => {
    $$('.settings-tab').forEach(tab => tab.classList.toggle('is-active', tab === button));
    $$('.settings-panel').forEach(panel => { panel.hidden = panel.id !== `setting-${button.dataset.setting}`; });
  }));
  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await request('/user/profile', { method: 'PUT', body: JSON.stringify({ username: $('#profile-username').value.trim(), bio: $('#profile-bio').value.trim() }) });
      toast(result.message || 'Profile saved.', 'success');
      await loadProfile();
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#save-portfolio-visibility').addEventListener('click', savePortfolioSharing);
  $('#public-account-selection-list').addEventListener('change', event => {
    if (!event.target.matches('input[name="public-account"]')) return;
    const selectedCount = selectedPublicAccountIds().length;
    const total = (state.sharing.accounts || []).length;
    $('#public-account-selection-count').textContent = `${selectedCount} of ${total} selected`;
  });
  $('#copy-portfolio-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#portfolio-share-url').value);
      toast('Public portfolio link copied.', 'success');
    } catch (error) {
      toast('Unable to copy the link. Select and copy it manually.', 'error');
    }
  });
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const newPassword = $('#new-password').value;
    if (newPassword !== $('#confirm-new-password').value) return toast('New password and confirmation do not match.', 'error');
    try {
      const result = await request('/user/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('#current-password').value, newPassword })
      });
      toast(result.message || 'Password changed. Please sign in again.', 'success');
      try {
        await fetch(`${API}/logout`, { method: 'POST', credentials: 'same-origin' });
      } catch (error) {
        console.error('Unable to clear the session after changing the password:', error);
      }
      window.setTimeout(() => window.location.replace('/login'), 900);
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#preferences-form').addEventListener('submit', async event => {
    event.preventDefault();
    const preferences = { theme: $('#pref-theme').value, currency: $('#pref-currency').value, timezone: $('#pref-timezone').value.trim() || 'UTC', dateFormat: $('#pref-date-format').value };
    try {
      await request('/user/preferences', { method: 'PATCH', body: JSON.stringify(preferences) });
      applyPreferences(preferences);
      toast('Preferences saved.', 'success');
      if (state.page === 'overview') loadOverview();
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#logout-btn').addEventListener('click', signOut);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.page === 'overview') loadOverview();
    if (!document.hidden && state.page === 'accounts') loadAccounts();
    if (!document.hidden && state.page === 'positions') loadPositions();
    if (!document.hidden && state.page === 'monitoring') loadMonitoring();
  });
  window.setInterval(() => {
    if (!document.hidden) {
      if (state.page === 'overview') loadOverview();
      if (state.page === 'accounts') loadAccounts();
      if (state.page === 'positions') loadPositions();
      if (state.page === 'monitoring') loadMonitoring();
    }
  }, 30000);

  loadOverview();
  loadProfile();
  loadPortfolioSharing();
})();
