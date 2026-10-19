(() => {
  const host = document.querySelector('#public-portfolios');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const money = (value, currency) => value === null || value === undefined || !Number.isFinite(Number(value))
    ? 'N/A'
    : `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${escapeHtml(currency || '')}`.trim();

  async function loadPortfolios() {
    try {
      const response = await fetch('/api/public/portfolios');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load public portfolios.');
      if (!Array.isArray(data.portfolios) || data.portfolios.length === 0) {
        host.innerHTML = '<div class="panel empty-state public-empty"><span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg></span><h2>No public portfolios yet</h2><p>When a CornGrid user chooses to share a portfolio publicly, it will appear here.</p></div>';
        return;
      }
      host.innerHTML = data.portfolios.map(portfolio => `
        <a class="public-portfolio-card" href="/portfolio/${encodeURIComponent(portfolio.shareId)}">
          <div><p class="eyebrow">SHARED CORNGRID PORTFOLIO</p><h2>${escapeHtml(portfolio.displayName)}</h2><span class="muted small">${Number(portfolio.accountCount)} linked MT5 account${Number(portfolio.accountCount) === 1 ? '' : 's'} · ${escapeHtml(portfolio.currency || 'Multiple currencies')}</span></div>
          <div class="public-card-stats">
            <div><span>Balance</span><strong>${portfolio.balanceAvailable ? money(portfolio.balance, portfolio.currency) : 'N/A'}</strong></div>
            <div><span>Equity</span><strong>${portfolio.equityAvailable ? money(portfolio.equity, portfolio.currency) : 'N/A'}</strong></div>
            <div><span>Floating P/L</span><strong>${portfolio.floatingProfitAvailable ? money(portfolio.floatingProfit, portfolio.currency) : 'N/A'}</strong></div>
          </div>
          <span class="muted small">Open public portfolio →</span>
        </a>`).join('');
    } catch (error) {
      host.innerHTML = `<div class="panel empty-state public-empty"><span class="empty-icon">!</span><h2>Public portfolios unavailable</h2><p>${escapeHtml(error.message)}</p><button class="button button-secondary" id="retry-public-portfolios">Try again</button></div>`;
      document.querySelector('#retry-public-portfolios')?.addEventListener('click', loadPortfolios);
    }
  }

  loadPortfolios();
})();
