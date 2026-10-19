(() => {
  const host = document.querySelector('#portfolio-content');
  const shareId = window.location.pathname.split('/').filter(Boolean).at(-1) || '';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const money = (value, currency = '') => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
    const amount = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
    return currency ? `${amount} ${escapeHtml(currency)}` : amount;
  };
  const dateTime = value => {
    if (!value || Number.isNaN(new Date(value).getTime())) return 'N/A';
    return new Date(value).toLocaleString(undefined, { timeZone: 'UTC' });
  };
  const tone = value => Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : '';
  const renderStat = (label, value, note, positive = false, negative = false) => `
    <article class="stat-card"><div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span></div>
    <strong class="stat-value ${positive ? 'positive' : ''} ${negative ? 'negative' : ''}">${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;

  function renderChart(snapshots, currency) {
    if (!snapshots.length) {
      return '<div class="chart-empty"><span class="empty-chart-icon">⌁</span><strong>No equity history available</strong><span>A historical curve is shown when this portfolio contains one account with recorded snapshots.</span></div>';
    }
    const width = 800, height = 230, pad = 28;
    const values = snapshots.flatMap(point => [Number(point.equity), Number(point.balance)]).filter(Number.isFinite);
    if (!values.length) return '<div class="chart-empty"><strong>No valid equity data is available.</strong></div>';
    const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    const x = index => pad + index * (width - pad * 2) / Math.max(snapshots.length - 1, 1);
    const y = value => height - pad - (value - min) * (height - pad * 2) / range;
    const pathFor = key => snapshots.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(Number(point[key])).toFixed(1)}`).join(' ');
    const equityPath = pathFor('equity');
    const balancePath = pathFor('balance');
    const first = new Date(snapshots[0].capturedAt).toLocaleDateString();
    const last = new Date(snapshots[snapshots.length - 1].capturedAt).toLocaleDateString();
    return `<svg class="equity-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historical balance and equity chart">
      <defs><linearGradient id="public-equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".2"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      <path d="${equityPath} L ${x(snapshots.length - 1)} ${height - pad} L ${pad} ${height - pad} Z" fill="url(#public-equity-fill)"/>
      <path d="${balancePath}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="5 5"/>
      <path d="${equityPath}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>
      ${snapshots.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(Number(point.equity)).toFixed(1)}" r="3" fill="var(--accent)"><title>${escapeHtml(dateTime(point.capturedAt))} · Equity ${escapeHtml(money(point.equity, currency))} · Balance ${escapeHtml(money(point.balance, currency))}</title></circle>`).join('')}
      <text x="${pad}" y="${height - 4}" fill="currentColor" font-size="10">${escapeHtml(first)}</text>
      <text x="${width - pad}" y="${height - 4}" fill="currentColor" font-size="10" text-anchor="end">${escapeHtml(last)}</text></svg>`;
  }

  function renderAccounts(accounts) {
    if (!accounts.length) return '<div class="panel empty-state public-empty"><h2>No linked accounts to display</h2></div>';
    return accounts.map(account => `<article class="account-card">
      <div class="account-card-top"><div><p class="eyebrow">SHARED MT5 ACCOUNT</p><h2 class="account-id">${escapeHtml(account.maskedAccount)}</h2><span class="account-server">${escapeHtml(account.accountName)}</span></div>
      <span class="pill ${account.status === 'Online' ? 'pill-online' : account.status === 'Offline' || account.status === 'Authentication error' ? 'pill-offline' : 'pill-muted'}">${escapeHtml(account.status)}</span></div>
      <div class="account-stats"><div><span>BALANCE</span><strong>${escapeHtml(money(account.balance, account.currency))}</strong></div><div><span>EQUITY</span><strong>${escapeHtml(money(account.equity, account.currency))}</strong></div><div><span>FLOATING P/L</span><strong class="${tone(account.floatingProfit)}">${escapeHtml(money(account.floatingProfit, account.currency))}</strong></div></div>
      <div class="account-meta"><div>EA<strong>${escapeHtml(account.eaName || 'N/A')} ${escapeHtml(account.eaVersion || '')}</strong></div><div>Last heartbeat<strong>${escapeHtml(dateTime(account.lastHeartbeat))}</strong></div></div>
    </article>`).join('');
  }

  function renderPositions(positions) {
    if (!positions.length) return '<tr><td colspan="10" class="table-empty">No open positions are currently reported.</td></tr>';
    return positions.map(position => `<tr><td>${escapeHtml(position.symbol)}</td><td>${escapeHtml(position.direction)}</td><td>${escapeHtml(position.accountName)}</td><td>${escapeHtml(position.volume)}</td><td>${escapeHtml(position.entryPrice ?? 'N/A')}</td><td>${escapeHtml(position.currentPrice ?? 'N/A')}</td><td class="${tone(position.profit)}">${escapeHtml(money(position.profit, position.currency))}</td><td>${escapeHtml(money(position.swap, position.currency))}</td><td>${escapeHtml(dateTime(position.openedAt))}</td><td>${escapeHtml(position.currency)}</td></tr>`).join('');
  }

  function renderTrades(trades) {
    if (!trades.length) return '<tr><td colspan="9" class="table-empty">No recent trade history is available.</td></tr>';
    return trades.map(trade => `<tr><td>${escapeHtml(dateTime(trade.closedAt))}</td><td>${escapeHtml(trade.symbol)}</td><td>${escapeHtml(trade.direction)}</td><td>${escapeHtml(trade.accountName)}</td><td>${escapeHtml(trade.volume)}</td><td>${escapeHtml(trade.entryPrice ?? 'N/A')}</td><td>${escapeHtml(trade.exitPrice ?? 'N/A')}</td><td class="${tone(trade.netProfit)}">${escapeHtml(money(trade.netProfit, trade.currency))}</td><td>${escapeHtml(trade.currency)}</td></tr>`).join('');
  }

  async function loadPortfolio() {
    if (!/^[a-f0-9]{32}$/.test(shareId)) throw new Error('This public portfolio link is invalid or unavailable.');
    const response = await fetch(`/api/public/portfolios/${encodeURIComponent(shareId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'This public portfolio is unavailable.');
    document.title = `${data.displayName} | CornGrid Public Portfolio`;
    const stats = [
      renderStat('Total balance', data.balanceAvailable ? money(data.balance, data.currency) : 'N/A', 'Latest reported balance'),
      renderStat('Current equity', data.equityAvailable ? money(data.equity, data.currency) : 'N/A', 'Latest reported equity'),
      renderStat('Floating P/L', data.floatingProfitAvailable ? money(data.floatingProfit, data.currency) : 'N/A', 'Unrealized P/L', tone(data.floatingProfit) === 'positive', tone(data.floatingProfit) === 'negative'),
      renderStat('Net profit', data.netProfitAvailable ? money(data.netProfit, data.currency) : 'N/A', 'Closed deals · 30 days', tone(data.netProfit) === 'positive', tone(data.netProfit) === 'negative'),
      renderStat('Daily P/L', data.dailyProfitAvailable ? money(data.dailyProfit, data.currency) : 'N/A', 'Closed deals today · UTC', tone(data.dailyProfit) === 'positive', tone(data.dailyProfit) === 'negative'),
      renderStat('Monthly P/L', data.monthlyProfitAvailable ? money(data.monthlyProfit, data.currency) : 'N/A', 'Closed deals this month · UTC', tone(data.monthlyProfit) === 'positive', tone(data.monthlyProfit) === 'negative'),
      renderStat('Closed deals', data.closedDeals > 0 ? Number(data.closedDeals).toLocaleString() : 'N/A', 'Imported deal records · 30 days'),
      renderStat('Win rate', data.winRateAvailable ? `${Number(data.winRate).toFixed(1)}%` : 'N/A', 'Requires verified deal costs'),
      renderStat('Profit factor', data.profitFactorAvailable ? Number(data.profitFactor).toFixed(2) : 'N/A', 'Gross profit ÷ gross loss'),
      renderStat('Maximum drawdown', data.drawdownAvailable ? `${money(data.maxDrawdown, data.currency)}${data.maxDrawdownPercent === null ? '' : ` (${Number(data.maxDrawdownPercent).toFixed(2)}%)`}` : 'N/A', 'Requires complete equity history'),
      renderStat('Current drawdown', data.drawdownAvailable ? money(data.currentDrawdown, data.currency) : 'N/A', 'Compared with recorded equity peak'),
      renderStat('Online accounts', Number(data.activeAccounts).toLocaleString(), `${Number(data.accountCount)} published account${Number(data.accountCount) === 1 ? '' : 's'}`)
    ].join('');
    host.innerHTML = `
      <section class="public-heading"><p class="eyebrow">PUBLIC CORNGRID PORTFOLIO</p><h1>${escapeHtml(data.displayName)}</h1><p class="muted">Performance and account information shared publicly by this portfolio owner · Last update: ${escapeHtml(dateTime(data.lastUpdate))}</p></section>
      <div class="notice notice-info public-data-note"><span class="notice-icon">i</span><span>Some values may show N/A when the source data is incomplete or accounts use different currencies. MT5 account identifiers are masked; trade and position ticket IDs are not published.</span></div>
      <section class="stat-grid">${stats}</section>
      <div class="content-grid">
        <section class="panel chart-panel"><div class="panel-header"><div><p class="eyebrow">PORTFOLIO PERFORMANCE</p><h2>Balance &amp; equity</h2></div><div class="chart-legend"><span><i class="legend-equity"></i>Equity</span><span><i class="legend-balance"></i>Balance</span></div></div><div class="chart-area public-curve-chart">${renderChart(data.snapshots || [], data.currency)}</div><div class="chart-foot"><span>Historical values are reported by the linked MT5 account.</span><span>UTC</span></div></section>
        <section class="panel connection-panel"><div class="panel-header"><div><p class="eyebrow">CONNECTIVITY</p><h2>EA status</h2></div><span class="pill ${data.activeAccounts ? 'pill-online' : 'pill-muted'}">${data.activeAccounts ? 'Online' : 'No live feed'}</span></div><div class="connection-details">${(data.accounts || []).map(account => `<div class="connection-detail"><span>${escapeHtml(account.accountName)}</span><strong>${escapeHtml(account.status)}</strong></div>`).join('') || '<p class="muted">No account information is available.</p>'}</div></section>
      </div>
      <section class="panel public-section"><div class="panel-header"><div><p class="eyebrow">LINKED ACCOUNTS</p><h2>Shared MT5 accounts</h2></div></div><div class="account-grid public-account-grid">${renderAccounts(data.accounts || [])}</div></section>
      <section class="panel table-panel public-section"><div class="panel-header"><div><p class="eyebrow">LIVE TRADE MONITORING</p><h2>Open positions</h2></div></div><div class="table-scroll"><table><thead><tr><th>Symbol</th><th>Direction</th><th>Account</th><th>Volume</th><th>Entry</th><th>Current</th><th>Floating P/L</th><th>Swap</th><th>Opened</th><th>Currency</th></tr></thead><tbody>${renderPositions(data.positions || [])}</tbody></table></div></section>
      <section class="panel table-panel public-section"><div class="panel-header"><div><p class="eyebrow">RECENT PERFORMANCE RECORD</p><h2>Recent closed deals</h2></div></div><div class="table-scroll"><table><thead><tr><th>Close time</th><th>Symbol</th><th>Direction</th><th>Account</th><th>Volume</th><th>Entry</th><th>Exit</th><th>Net P/L</th><th>Currency</th></tr></thead><tbody>${renderTrades(data.trades || [])}</tbody></table></div></section>`;
  }

  loadPortfolio().catch(error => {
    host.innerHTML = `<section class="public-heading"><p class="eyebrow">PUBLIC CORNGRID PORTFOLIO</p><h1>Portfolio unavailable</h1><p class="muted">${escapeHtml(error.message)}</p><a class="button button-secondary" href="/portfolios">Browse public portfolios</a></section>`;
  });
})();
