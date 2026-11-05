(() => {
  let page = 1;
  let totalPages = 0;
  let searchTimer;
  let selectedSupportUserId = null;
  let selectedSuspendUser = null;
  let supportBadgeTick = 0;
  const supportState = {
    conversations: [],
    conversationsSignature: '',
    search: '',
    filter: 'all',
    threadSignature: ''
  };
  const emailState = {
    tab: 'compose',
    settings: null,
    templates: [],
    drafts: [],
    recipients: [],
    selectedRecipientIds: new Set(),
    selectedRecipientMap: new Map(),
    recipientSearch: '',
    recipientSearchTimer: null,
    recipientTotal: 0,
    eligibleTotal: 0,
    editingTemplateId: null,
    historyPage: 1,
    historyTotalPages: 0,
    historySearch: '',
    historyStatus: '',
    historySearchTimer: null,
    loaded: { settings: false, templates: false, history: false, recipients: false, drafts: false }
  };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function toast(message, type = '') {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `toast ${type ? `toast-${type}` : ''}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function formatMoney(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${escapeHtml(currency || '')}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      void expireSession();
      throw new Error('Your administrator session has expired.');
    }
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  async function expireSession() {
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Session cleanup failed (${response.status}).`);
    } catch (error) {
      console.error('Unable to clear the CornGrid administrator session:', error);
    }
    window.location.replace('/login');
  }

  async function signOut() {
    const button = $('#admin-logout');
    button.disabled = true;
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('The server could not end this session.');
      window.location.replace('/login');
    } catch (error) {
      console.error('Unable to sign out of the administrator session:', error);
      window.alert(error.message || 'Unable to sign out. Please try again.');
      button.disabled = false;
    }
  }

  async function loadOverview() {
    const tbody = $('#admin-profiles');
    tbody.innerHTML = '<tr><td class="table-empty" colspan="8">Loading user profiles…</td></tr>';
    const query = new URLSearchParams({
      page: String(page),
      limit: '50',
      visibility: $('#admin-visibility').value,
      search: $('#admin-search').value.trim()
    });

    try {
      const data = await api(`/api/admin/overview?${query}`);

      $('#stat-users').textContent = data.summary.totalUsers;
      $('#stat-public').textContent = data.summary.publicPortfolios;
      $('#stat-private').textContent = data.summary.privatePortfolios;
      $('#stat-online').textContent = data.summary.onlineAccounts;
      $('#stat-total-accounts').textContent = data.summary.totalAccounts;
      $('#admin-result-count').textContent = `${data.pagination.total} profile${data.pagination.total === 1 ? '' : 's'}`;
      totalPages = data.pagination.totalPages;
      $('#admin-pagination-label').textContent = totalPages
        ? `Page ${page} of ${totalPages}`
        : 'No profiles found';
      $('#admin-prev').disabled = page <= 1;
      $('#admin-next').disabled = page >= totalPages;

      if (!data.profiles.length) {
        tbody.innerHTML = '<tr><td class="table-empty" colspan="8">No user profiles match these filters.</td></tr>';
        return;
      }
      tbody.innerHTML = data.profiles.map(profile => {
        const visibilityClass = profile.portfolioVisibility === 'Public' ? 'pill-online' : 'pill-muted';
        const statusClass = profile.accountStatus === 'Online'
          ? 'pill-online'
          : profile.accountStatus === 'Offline'
            ? 'pill-offline'
            : 'pill-muted';
        const accessStatus = profile.isSuspended
          ? `<span class="pill pill-suspended">Suspended until ${escapeHtml(formatDateTime(profile.suspendedUntil))}</span>`
          : '<span class="pill pill-online">Active</span>';
        const accessButton = profile.isSuspended
          ? `<button class="button button-small" type="button" data-user-action="restore" data-user-id="${profile.id}" data-username="${escapeHtml(profile.username)}">Restore</button>`
          : `<button class="button button-small" type="button" data-user-action="suspend" data-user-id="${profile.id}" data-username="${escapeHtml(profile.username)}">Suspend</button>`;
        return `<tr>
          <td data-label="User" class="cell-primary"><span class="admin-profile-name">${escapeHtml(profile.username || 'Unnamed user')}</span><span class="admin-profile-id">Profile #${profile.id}</span></td>
          <td data-label="Profile created" class="cell-extra">${escapeHtml(formatDate(profile.createdAt))}</td>
          <td data-label="Portfolio"><span class="pill ${visibilityClass}">${escapeHtml(profile.portfolioVisibility)}</span></td>
          <td data-label="Selected accounts" class="cell-extra">${profile.sharedAccounts}</td>
          <td data-label="Linked accounts" class="cell-extra">${profile.linkedAccounts}</td>
          <td data-label="Connection"><span class="pill admin-status ${statusClass}">${escapeHtml(profile.accountStatus)}</span></td>
          <td data-label="Account access" class="cell-extra">${accessStatus}</td>
          <td class="admin-actions cell-actions" data-label="Actions">
            <button class="button button-small" type="button" data-user-action="trading" data-user-id="${profile.id}">Trading overview</button>
            ${accessButton}
            <button class="button button-small button-danger" type="button" data-user-action="delete" data-user-id="${profile.id}" data-username="${escapeHtml(profile.username)}">Delete</button>
          </td>
        </tr>`;
      }).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td class="table-empty admin-error" colspan="8">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function renderTradingOverview(data) {
    const accountRows = data.accounts.length ? data.accounts.map(account => `<tr>
      <td data-label="Account" class="cell-primary">${escapeHtml(account.accountName || 'MT5 account')}<small>${escapeHtml(account.maskedAccount)}</small></td>
      <td data-label="Currency" class="cell-extra">${escapeHtml(account.currency)}</td><td data-label="Balance" class="cell-key">${formatMoney(account.balance, account.currency)}</td>
      <td data-label="Equity" class="cell-key">${formatMoney(account.equity, account.currency)}</td><td data-label="Floating P/L" class="cell-key">${formatMoney(account.floatingProfit, account.currency)}</td>
      <td data-label="Last heartbeat" class="cell-extra">${escapeHtml(formatDateTime(account.lastHeartbeat))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="table-empty">No linked trading accounts.</td></tr>';
    const positionRows = data.positions.length ? data.positions.map(position => `<tr>
      <td data-label="Account" class="cell-extra">${escapeHtml(position.maskedAccount)}</td><td data-label="Symbol" class="cell-primary">${escapeHtml(position.symbol)}</td><td data-label="Side">${escapeHtml(position.direction)}</td>
      <td data-label="Volume">${escapeHtml(position.volume)}</td><td data-label="Profit" class="cell-key">${formatMoney(position.profit, position.currency)}</td><td data-label="Opened" class="cell-extra">${escapeHtml(formatDateTime(position.openedAt))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="table-empty">No open positions.</td></tr>';
    const dealRows = data.deals.length ? data.deals.map(deal => `<tr>
      <td data-label="Account" class="cell-extra">${escapeHtml(deal.maskedAccount)}</td><td data-label="Symbol" class="cell-primary">${escapeHtml(deal.symbol)}</td><td data-label="Side">${escapeHtml(deal.direction)}</td>
      <td data-label="Volume">${escapeHtml(deal.volume)}</td><td data-label="Profit" class="cell-key">${formatMoney(deal.profit, deal.currency)}</td><td data-label="Closed" class="cell-extra">${escapeHtml(formatDateTime(deal.closedAt))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="table-empty">No recent closed trades.</td></tr>';
    $('#admin-trading-content').innerHTML = `
      <p class="eyebrow">TRADING OVERVIEW</p><h2>${escapeHtml(data.user.username)}</h2>
      <p class="muted">Account identifiers are masked. Latest 100 open positions and 50 closed trades are shown.</p>
      ${data.suspension ? `<p class="notice notice-info">Suspended until ${escapeHtml(formatDateTime(data.suspension.suspendedUntil))}${data.suspension.reason ? ` · ${escapeHtml(data.suspension.reason)}` : ''}</p>` : ''}
      <h3>Accounts</h3><div class="table-scroll"><table><thead><tr><th>Account</th><th>Currency</th><th>Balance</th><th>Equity</th><th>Floating P/L</th><th>Last heartbeat</th></tr></thead><tbody>${accountRows}</tbody></table></div>
      <h3>Open positions</h3><div class="table-scroll"><table><thead><tr><th>Account</th><th>Symbol</th><th>Side</th><th>Volume</th><th>Profit</th><th>Opened</th></tr></thead><tbody>${positionRows}</tbody></table></div>
      <h3>Recent closed trades</h3><div class="table-scroll"><table><thead><tr><th>Account</th><th>Symbol</th><th>Side</th><th>Volume</th><th>Profit</th><th>Closed</th></tr></thead><tbody>${dealRows}</tbody></table></div>`;
    $('#admin-trading-dialog').showModal();
  }

  async function loadTradingOverview(userId) {
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(userId)}/trading`);
      renderTradingOverview(data);
    } catch (error) {
      window.alert(error.message || 'Unable to load trading overview.');
    }
  }

  function supportInitial(username) {
    const value = String(username || '?').trim();
    return (value[0] || '?').toUpperCase();
  }

  const SUPPORT_AVATAR_PATTERN = /^\/uploads\/avatars\/[a-f0-9]{32}\.(jpg|png|webp)$/;

  function supportAvatarContent(username, avatarUrl) {
    const image = SUPPORT_AVATAR_PATTERN.test(avatarUrl || '')
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" decoding="async">`
      : '';
    return `<span class="admin-support-avatar-initials" aria-hidden="true">${escapeHtml(supportInitial(username))}</span>${image}`;
  }

  function supportAvatar(username, avatarUrl, extraClass = '') {
    return `<span class="admin-support-avatar${extraClass ? ` ${extraClass}` : ''}" aria-hidden="true">${supportAvatarContent(username, avatarUrl)}</span>`;
  }

  document.addEventListener('error', event => {
    const image = event.target;
    if (image && image.tagName === 'IMG' && image.closest('.admin-support-avatar')) image.remove();
  }, true);

  function supportIcon(name) {
    const icons = {
      inbox: '<path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
  }

  function formatSupportTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function updateSupportUnreadBadge() {
    const unread = supportState.conversations.reduce((sum, conversation) => sum + Number(conversation.unreadCount || 0), 0);
    const badge = $('#admin-support-unread');
    if (badge) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
    }
    const summary = $('#admin-support-unread-summary');
    if (summary) {
      summary.hidden = unread === 0;
      summary.textContent = unread === 1 ? '1 unread message' : `${unread} unread messages`;
    }
    const total = $('#admin-support-total');
    if (total) total.textContent = String(supportState.conversations.length);
  }

  function filterSupportConversations() {
    const query = supportState.search.trim().toLowerCase();
    return supportState.conversations.filter(conversation => {
      if (supportState.filter === 'unread' && !Number(conversation.unreadCount)) return false;
      if (!query) return true;
      return [conversation.username, conversation.email, conversation.lastMessage]
        .some(value => String(value || '').toLowerCase().includes(query));
    });
  }

  function renderSupportConversations() {
    const list = $('#admin-support-list');
    if (!list) return;
    const conversations = filterSupportConversations();
    if (!supportState.conversations.length) {
      list.innerHTML = `<div class="admin-support-empty"><span class="admin-support-empty-icon">${supportIcon('inbox')}</span><strong>No conversations yet</strong><p class="muted">User messages from Terminal Chat will appear here.</p></div>`;
      return;
    }
    if (!conversations.length) {
      list.innerHTML = `<div class="admin-support-empty"><span class="admin-support-empty-icon">${supportIcon('search')}</span><strong>No matching chats</strong><p class="muted">Try another search or switch the filter.</p></div>`;
      return;
    }
    list.innerHTML = conversations.map(conversation => {
      const unread = Number(conversation.unreadCount || 0);
      const selected = String(selectedSupportUserId) === String(conversation.userId);
      return `
        <button class="admin-support-item${selected ? ' is-selected' : ''}" type="button" data-support-user="${conversation.userId}" aria-pressed="${selected}">
            ${supportAvatar(conversation.username, conversation.avatarUrl)}
          <span class="admin-support-item-body">
            <span class="admin-support-item-top"><strong>${escapeHtml(conversation.username)}</strong><time title="${escapeHtml(formatDateTime(conversation.lastMessageAt))}">${escapeHtml(formatSupportTime(conversation.lastMessageAt))}</time></span>
            <span class="admin-support-item-email">${escapeHtml(conversation.email)}</span>
            <span class="admin-support-preview"><span class="admin-support-preview-text">${conversation.lastSenderRole === 'admin' ? '<span class="admin-support-you">You:</span> ' : ''}${escapeHtml(conversation.lastMessage)}</span>${unread ? `<b class="chat-unread-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</span>
          </span>
        </button>
      `;
    }).join('');
  }

  async function loadSupportConversations({ silent = false } = {}) {
    const list = $('#admin-support-list');
    try {
      const data = await api('/api/admin/support/conversations');
      const conversations = data.conversations || [];
      const signature = conversations.map(conversation => [
        conversation.userId, conversation.username, conversation.email, conversation.unreadCount,
        conversation.lastSenderRole, conversation.lastMessage, conversation.lastMessageAt
      ].join(':')).join('|');
      const changed = signature !== supportState.conversationsSignature;
      supportState.conversations = conversations;
      supportState.conversationsSignature = signature;
      updateSupportUnreadBadge();
      if (changed) renderSupportConversations();
    } catch (error) {
      if (!silent && list) list.innerHTML = `<p class="table-empty admin-error">${escapeHtml(error.message)}</p>`;
    }
  }

  async function loadSupportMessages(userId, { silent = false } = {}) {
    if (supportState.deleting) return;
    const requestId = supportState.threadRequestId = (supportState.threadRequestId || 0) + 1;
    if (!Number.isSafeInteger(userId)) return;
    const pane = $('#admin-support-messages');
    if (!pane) return;
    if (!silent) pane.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/api/admin/support/conversations/${encodeURIComponent(userId)}/messages`);
      if (String(selectedSupportUserId) !== String(userId) || requestId !== supportState.threadRequestId) return;
      if ($('#admin-support-user')) $('#admin-support-user').textContent = data.user.username;
      if ($('#admin-support-email')) $('#admin-support-email').textContent = data.user.email;
      if ($('#admin-support-avatar')) $('#admin-support-avatar').innerHTML = supportAvatarContent(data.user.username, data.user.avatarUrl);
      if ($('#admin-support-form')) $('#admin-support-form').hidden = false;
      const status = $('#admin-support-thread-status');
      if (status) {
        status.hidden = false;
        status.textContent = `${(data.messages || []).length} recent messages`;
      }
      const messages = data.messages || [];
      supportState.messageCount = messages.length;
      $('#admin-support-clear').hidden = false;
      $('#admin-support-clear').disabled = !messages.length;
      const stickToBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 90;
      const signature = userId + '|' + messages.map(message => `${message.id}:${message.readAt || ''}:${message.message}`).join('|');
      if (signature !== supportState.threadSignature) {
        supportState.threadSignature = signature;
        let previousDay = '';
        pane.innerHTML = messages.length ? messages.map(message => {
          const mine = message.senderRole === 'admin';
          const day = new Date(message.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          const divider = day !== previousDay ? `<div class="support-date-divider"><span>${escapeHtml(day)}</span></div>` : '';
          previousDay = day;
          return `
            ${divider}
            <div class="chat-bubble-wrap ${mine ? 'is-mine' : 'is-peer'}">
              <div class="chat-bubble">${escapeHtml(message.message)}</div>
              <div class="chat-meta"><span>${escapeHtml(formatDateTime(message.createdAt))}</span><span>${mine ? 'Support' : escapeHtml(data.user.username)}</span></div>
            </div>
          `;
        }).join('') : `<div class="chat-empty-state"><span class="chat-empty-state-icon">${supportIcon('chat')}</span><h3>Conversation started</h3><p class="muted">Send the first reply to help this user.</p></div>`;
        if (!silent || stickToBottom) pane.scrollTop = pane.scrollHeight;
      }
      await loadSupportConversations({ silent: true });
    } catch (error) {
      if (!silent && requestId === supportState.threadRequestId && selectedSupportUserId === userId) pane.innerHTML = `<div class="chat-empty-state admin-error"><h3>Unable to open conversation</h3><p>${escapeHtml(error.message)}</p></div>`;
    } finally {
      if (requestId === supportState.threadRequestId) pane.removeAttribute('aria-busy');
    }
  }

  function updateSupportComposer() {
    const input = $('#admin-support-input');
    const count = $('#admin-support-char-count');
    const send = $('#admin-support-send');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    const length = input.value.length;
    if (count) {
      count.textContent = `${length} / 2000`;
      count.classList.toggle('is-near-limit', length >= 1800);
    }
    if (send) send.disabled = !selectedSupportUserId || !input.value.trim();
  }

  async function refreshSupportInbox() {
    const button = $('#admin-support-refresh');
    if (button) button.disabled = true;
    try {
      if (selectedSupportUserId) await loadSupportMessages(selectedSupportUserId);
      else await loadSupportConversations();
      toast('Support inbox refreshed.');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function scrollSupportPanel(selector) {
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    const panel = document.querySelector(selector);
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Mobile sidebar (matches the dashboard shell behaviour) ----
  const SIDEBAR_BREAKPOINT = '(max-width: 850px)';

  function setSidebarOpen(open) {
    const sidebar = $('#admin-sidebar');
    const menu = $('#admin-mobile-menu');
    const overlay = $('#admin-overlay');
    if (!sidebar || !menu || !overlay) return;
    const mobile = window.matchMedia(SIDEBAR_BREAKPOINT).matches;
    sidebar.classList.toggle('is-open', open);
    // Keep the closed drawer out of the tab order and the accessibility tree.
    sidebar.inert = mobile && !open;
    sidebar.setAttribute('aria-hidden', String(mobile && !open));
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    overlay.hidden = !open;
  }

  function closeSidebarOnNavigation() {
    if (window.matchMedia(SIDEBAR_BREAKPOINT).matches) setSidebarOpen(false);
  }

  $('#admin-mobile-menu').addEventListener('click', () => {
    setSidebarOpen(!$('#admin-sidebar').classList.contains('is-open'));
  });
  $('#admin-overlay').addEventListener('click', () => {
    setSidebarOpen(false);
    $('#admin-mobile-menu').focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('#admin-sidebar').classList.contains('is-open')) {
      setSidebarOpen(false);
      $('#admin-mobile-menu').focus();
    }
  });
  window.matchMedia(SIDEBAR_BREAKPOINT).addEventListener('change', () => setSidebarOpen(false));
  setSidebarOpen(false);

  // ---- Reported content moderation queue ----
  // Lightweight poll used only to keep the sidebar badge accurate.
  async function refreshReportsBadge() {
    const badge = $('#admin-reports-unread');
    if (!badge) return;
    try {
      const data = await api('/api/feed/admin/reports');
      const count = (data.reports || []).length;
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
    } catch {
      // A badge refresh must never interrupt the admin workflow.
    }
  }

  async function loadReports() {
    const list = $('#admin-reports-list');
    const counter = $('#admin-reports-count');
    const badge = $('#admin-reports-unread');
    list.innerHTML = '<p class="table-empty">Loading reports…</p>';
    try {
      const data = await api('/api/feed/admin/reports');
      const reports = data.reports || [];
      counter.textContent = `${reports.length} open`;
      badge.hidden = reports.length === 0;
      badge.textContent = reports.length > 99 ? '99+' : String(reports.length);
      if (!reports.length) {
        list.innerHTML = '<p class="table-empty">No open reports. The community queue is clear.</p>';
        return;
      }
      list.innerHTML = reports.map(report => `
        <div class="admin-report-item" data-report-id="${escapeHtml(report.id)}">
          <div class="admin-report-head">
            <strong>${report.targetType === 'comment' ? 'Comment' : 'Post'} #${escapeHtml(report.targetId)}</strong>
            <span class="muted small">Reported by ${escapeHtml(report.reporter || 'Unknown')} · ${escapeHtml(formatDateTime(report.createdAt))}</span>
          </div>
          <p class="admin-report-reason"><span class="eyebrow">REASON</span>${escapeHtml(report.reason)}</p>
          <blockquote class="admin-report-preview">${escapeHtml(report.preview || 'The reported content is no longer available.')}</blockquote>
          <div class="admin-report-actions">
            <button class="button button-small button-danger" type="button" data-report-remove="${escapeHtml(report.targetType)}" data-report-target="${escapeHtml(report.targetId)}">Remove content</button>
            <button class="button button-small button-secondary" type="button" data-report-resolve="${escapeHtml(report.id)}">Mark as handled</button>
          </div>
        </div>`).join('');
    } catch (error) {
      list.innerHTML = `<p class="table-empty admin-error">${escapeHtml(error.message)}</p>`;
    }
  }

  $('#admin-reports-refresh').addEventListener('click', loadReports);

  $('#admin-reports-list').addEventListener('click', async event => {
    const resolveButton = event.target.closest('[data-report-resolve]');
    const removeButton = event.target.closest('[data-report-remove]');
    try {
      if (resolveButton) {
        resolveButton.disabled = true;
        await api(`/api/feed/admin/reports/${encodeURIComponent(resolveButton.dataset.reportResolve)}/resolve`, { method: 'POST' });
        toast('Report marked as handled.', 'success');
        loadReports();
        return;
      }
      if (removeButton) {
        const kind = removeButton.dataset.reportRemove === 'comment' ? 'comments' : 'posts';
        if (!window.confirm('Remove this reported content from the Live Feed?')) return;
        removeButton.disabled = true;
        await api(`/api/feed/admin/content/${encodeURIComponent(kind)}/${encodeURIComponent(removeButton.dataset.reportTarget)}`, { method: 'DELETE' });
        toast('Reported content removed from the feed.', 'success');
        // Close out every open report that points at the removed content so the
        // queue does not keep showing already-handled items.
        const item = removeButton.closest('[data-report-id]');
        const reportId = item && item.dataset.reportId;
        if (reportId) {
          await api(`/api/feed/admin/reports/${encodeURIComponent(reportId)}/resolve`, { method: 'POST' }).catch(() => {});
        }
        loadReports();
      }
    } catch (error) {
      toast(error.message, 'error');
      if (resolveButton) resolveButton.disabled = false;
      if (removeButton) removeButton.disabled = false;
    }
  });

  // ---- Community announcements (Live Feed) ----
  let editingAnnouncementId = null;

  async function loadAnnouncements() {
    const list = $('#admin-ann-list');
    list.innerHTML = '<p class="table-empty">Loading announcements…</p>';
    try {
      const data = await api('/api/feed/announcements');
      if (!data.announcements.length) {
        list.innerHTML = '<p class="table-empty">No announcements published yet.</p>';
        return;
      }
      list.innerHTML = data.announcements.map(item => `
        <div class="admin-ann-item${item.isPinned ? ' is-pinned' : ''}">
          <div class="admin-ann-head">
            <strong>${escapeHtml(item.title)}</strong>
            <span class="muted small">${item.isPinned ? '📌 Pinned · ' : ''}${escapeHtml(formatDateTime(item.createdAt))}${item.updatedAt ? ' · edited' : ''}</span>
          </div>
          <p class="admin-ann-body">${escapeHtml(item.content)}</p>
          <div class="admin-ann-actions">
            <button class="button button-secondary button-small" type="button" data-ann-edit="${escapeHtml(item.id)}">Edit</button>
            <button class="button button-secondary button-small" type="button" data-ann-pin="${escapeHtml(item.id)}" data-pinned="${item.isPinned ? '1' : '0'}">${item.isPinned ? 'Unpin' : 'Pin'}</button>
            <button class="button button-secondary button-small" type="button" data-ann-delete="${escapeHtml(item.id)}">Delete</button>
          </div>
        </div>`).join('');
    } catch (error) {
      list.innerHTML = `<p class="table-empty">${escapeHtml(error.message)}</p>`;
    }
  }

  function resetAnnouncementForm() {
    editingAnnouncementId = null;
    $('#admin-ann-form').reset();
    $('#admin-ann-form-title').textContent = 'New announcement';
    $('#admin-ann-submit').textContent = 'Publish announcement';
    $('#admin-ann-cancel').hidden = true;
  }

  $('#admin-ann-form').addEventListener('submit', async event => {
    event.preventDefault();
    const title = $('#admin-ann-title').value.trim();
    const content = $('#admin-ann-content').value.trim();
    if (!title || !content) return toast('Title and message are both required.', 'error');
    const submit = $('#admin-ann-submit');
    if (submit.disabled) return;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = editingAnnouncementId ? 'Saving…' : 'Publishing…';
    try {
      const body = JSON.stringify({ title, content, isPinned: $('#admin-ann-pin').checked });
      if (editingAnnouncementId != null) {
        await api(`/api/feed/announcements/${encodeURIComponent(editingAnnouncementId)}`, { method: 'PATCH', body });
        toast('Announcement updated.', 'success');
      } else {
        await api('/api/feed/announcements', { method: 'POST', body });
        toast('Announcement published.', 'success');
      }
      resetAnnouncementForm();
      loadAnnouncements();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  });

  $('#admin-ann-cancel').addEventListener('click', resetAnnouncementForm);
  $('#admin-ann-refresh').addEventListener('click', loadAnnouncements);

  $('#admin-ann-list').addEventListener('click', async event => {
    const editButton = event.target.closest('[data-ann-edit]');
    const pinButton = event.target.closest('[data-ann-pin]');
    const deleteButton = event.target.closest('[data-ann-delete]');
    try {
      if (editButton) {
        const data = await api('/api/feed/announcements');
        const item = data.announcements.find(entry => String(entry.id) === editButton.dataset.annEdit);
        if (!item) return;
        editingAnnouncementId = item.id;
        $('#admin-ann-title').value = item.title;
        $('#admin-ann-content').value = item.content;
        $('#admin-ann-pin').checked = item.isPinned;
        $('#admin-ann-form-title').textContent = 'Edit announcement';
        $('#admin-ann-submit').textContent = 'Save changes';
        $('#admin-ann-cancel').hidden = false;
        $('#admin-ann-title').focus();
        return;
      }
      if (pinButton) {
        const nextPinned = pinButton.dataset.pinned !== '1';
        await api(`/api/feed/announcements/${encodeURIComponent(pinButton.dataset.annPin)}`, {
          method: 'PATCH',
          body: JSON.stringify({ isPinned: nextPinned })
        });
        toast(nextPinned ? 'Announcement pinned.' : 'Announcement unpinned.', 'success');
        loadAnnouncements();
        return;
      }
      if (deleteButton) {
        if (!window.confirm('Remove this announcement from the Live Feed?')) return;
        await api(`/api/feed/announcements/${encodeURIComponent(deleteButton.dataset.annDelete)}`, { method: 'DELETE' });
        toast('Announcement removed.', 'success');
        loadAnnouncements();
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // ------------------------------- Email -------------------------------
  function emailStatusMessage(element, message, tone = '') {
    if (!element) return;
    element.textContent = message || '';
    element.classList.remove('is-success', 'is-error', 'is-pending');
    if (tone) element.classList.add(`is-${tone}`);
  }

  function emailStatusPill(status) {
    const map = {
      sent: ['pill-online', 'Sent'],
      failed: ['pill-offline', 'Failed'],
      pending: ['pill-delayed', 'Pending']
    };
    const [className, label] = map[status] || ['pill-muted', status || 'Unknown'];
    return `<span class="pill ${className}">${escapeHtml(label)}</span>`;
  }

  function splitEmailAddresses(value) {
    return String(value || '').split(/[,;]/).map(item => item.trim()).filter(Boolean);
  }

  function emailBodyHtml() {
    const source = $('#email-html-source');
    return source && !source.hidden ? source.value : ($('#email-editor') ? $('#email-editor').innerHTML : '');
  }

  function setEmailBodyHtml(html) {
    const editor = $('#email-editor');
    const source = $('#email-html-source');
    if (editor) editor.innerHTML = html || '';
    if (source) source.value = html || '';
  }

  function syncEmailSource(showSource) {
    const editor = $('#email-editor');
    const source = $('#email-html-source');
    const toggle = $('#email-source-toggle');
    if (!editor || !source || !toggle) return;
    if (showSource) {
      source.value = editor.innerHTML;
      editor.hidden = true;
      source.hidden = false;
      toggle.classList.add('is-active');
      toggle.setAttribute('aria-pressed', 'true');
      source.focus();
    } else {
      editor.innerHTML = source.value;
      source.hidden = true;
      editor.hidden = false;
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-pressed', 'false');
      editor.focus();
    }
  }

  function applyEmailTemplateVariables(value) {
    const origin = window.location.origin;
    const sender = emailState.settings?.fromEmail || 'support@corngrid.com';
    return String(value || '')
      .replace(/\{\{\s*app_name\s*\}\}/gi, 'CornGrid')
      .replace(/\{\{\s*app_url\s*\}\}/gi, origin)
      .replace(/\{\{\s*login_url\s*\}\}/gi, `${origin}/login`)
      .replace(/\{\{\s*support_email\s*\}\}/gi, sender);
  }

  function updateEmailSmtpBadge() {
    const badge = $('#email-smtp-badge');
    if (!badge) return;
    const settings = emailState.settings;
    if (!settings) {
      badge.className = 'pill pill-muted';
      badge.textContent = 'Checking SMTP…';
      return;
    }
    if (settings.enabled && settings.smtpHost && settings.fromEmail) {
      badge.className = 'pill pill-online';
      badge.textContent = 'SMTP enabled';
    } else if (settings.smtpHost) {
      badge.className = 'pill pill-delayed';
      badge.textContent = 'SMTP disabled';
    } else {
      badge.className = 'pill pill-muted';
      badge.textContent = 'SMTP not configured';
    }
  }

  async function loadEmailSettings() {
    try {
      const data = await api('/api/admin/email/settings');
      emailState.settings = data.settings;
      emailState.loaded.settings = true;
      const settings = data.settings;
      $('#email-smtp-host').value = settings.smtpHost || '';
      $('#email-smtp-port').value = settings.smtpPort || 587;
      $('#email-smtp-username').value = settings.smtpUsername || '';
      $('#email-smtp-password').value = '';
      $('#email-from-email').value = settings.fromEmail || '';
      $('#email-from-name').value = settings.fromName || '';
      $('#email-smtp-encryption').value = settings.encryption || 'tls';
      $('#email-smtp-enabled').checked = Boolean(settings.enabled);
      const passwordState = $('#email-settings-password-state');
      passwordState.textContent = settings.passwordConfigured ? 'Password stored securely' : 'No password stored';
      passwordState.className = `pill ${settings.passwordConfigured ? 'pill-online' : 'pill-muted'}`;
      updateEmailSmtpBadge();
      return settings;
    } catch (error) {
      updateEmailSmtpBadge();
      emailStatusMessage($('#email-settings-result'), error.message, 'error');
      $('#email-settings-result').hidden = false;
      return null;
    }
  }

  function renderEmailTemplateOptions() {
    const select = $('#email-template-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Blank email</option>' + emailState.templates.map(template =>
      `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`
    ).join('');
    if (current && emailState.templates.some(template => String(template.id) === current)) select.value = current;
  }

  function renderEmailTemplateList() {
    const list = $('#email-template-list');
    const count = $('#email-template-count');
    if (count) count.textContent = String(emailState.templates.length);
    if (!list) return;
    if (!emailState.templates.length) {
      list.innerHTML = '<p class="table-empty">No templates yet.</p>';
      return;
    }
    list.innerHTML = emailState.templates.map(template => `
      <button class="email-template-item${String(template.id) === String(emailState.editingTemplateId) ? ' is-selected' : ''}" type="button" data-template-id="${escapeHtml(template.id)}">
        <strong>${escapeHtml(template.name)}</strong>
        <span>${escapeHtml(template.slug)}${template.isSystem ? ' · CornGrid default' : ''}</span>
        <em>${escapeHtml(template.description || template.subject)}</em>
      </button>`).join('');
  }

  async function loadEmailTemplates() {
    try {
      const data = await api('/api/admin/email/templates');
      emailState.templates = data.templates || [];
      emailState.loaded.templates = true;
      renderEmailTemplateList();
      renderEmailTemplateOptions();
    } catch (error) {
      $('#email-template-list').innerHTML = `<p class="table-empty admin-error">${escapeHtml(error.message)}</p>`;
    }
  }

  function resetEmailTemplateForm() {
    emailState.editingTemplateId = null;
    $('#email-template-form').reset();
    $('#email-template-id').value = '';
    $('#email-template-form-title').textContent = 'New template';
    $('#email-template-system-badge').hidden = true;
    $('#email-template-delete').hidden = true;
    emailStatusMessage($('#email-template-status'), '');
    renderEmailTemplateList();
  }

  function editEmailTemplate(id) {
    const template = emailState.templates.find(item => String(item.id) === String(id));
    if (!template) return;
    emailState.editingTemplateId = template.id;
    $('#email-template-id').value = template.id;
    $('#email-template-name').value = template.name || '';
    $('#email-template-slug').value = template.slug || '';
    $('#email-template-description').value = template.description || '';
    $('#email-template-subject').value = template.subject || '';
    $('#email-template-html').value = template.html || '';
    $('#email-template-text').value = template.text || '';
    $('#email-template-form-title').textContent = 'Edit template';
    $('#email-template-system-badge').hidden = !template.isSystem;
    $('#email-template-delete').hidden = false;
    emailStatusMessage($('#email-template-status'), '');
    renderEmailTemplateList();
  }

  function emailTemplatePayload() {
    return {
      name: $('#email-template-name').value.trim(),
      slug: $('#email-template-slug').value.trim(),
      description: $('#email-template-description').value.trim(),
      subject: $('#email-template-subject').value.trim(),
      html: $('#email-template-html').value,
      text: $('#email-template-text').value
    };
  }

  async function saveEmailTemplate(event) {
    event.preventDefault();
    const payload = emailTemplatePayload();
    if (!payload.name || !payload.subject || (!payload.html.trim() && !payload.text.trim())) {
      return emailStatusMessage($('#email-template-status'), 'Name, subject, and a body are required.', 'error');
    }
    const button = $('#email-template-save');
    button.disabled = true;
    emailStatusMessage($('#email-template-status'), 'Saving template…', 'pending');
    try {
      if (emailState.editingTemplateId) {
        await api(`/api/admin/email/templates/${encodeURIComponent(emailState.editingTemplateId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        toast('Template updated.', 'success');
      } else {
        const created = await api('/api/admin/email/templates', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        emailState.editingTemplateId = created.id;
        toast('Template created.', 'success');
      }
      await loadEmailTemplates();
      if (emailState.editingTemplateId) editEmailTemplate(emailState.editingTemplateId);
      emailStatusMessage($('#email-template-status'), 'Template saved.', 'success');
    } catch (error) {
      emailStatusMessage($('#email-template-status'), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function deleteEmailTemplate() {
    if (!emailState.editingTemplateId) return;
    const template = emailState.templates.find(item => String(item.id) === String(emailState.editingTemplateId));
    if (!window.confirm(`Delete the template "${template ? template.name : 'this template'}"?`)) return;
    try {
      await api(`/api/admin/email/templates/${encodeURIComponent(emailState.editingTemplateId)}`, { method: 'DELETE' });
      toast('Template deleted.', 'success');
      resetEmailTemplateForm();
      await loadEmailTemplates();
    } catch (error) {
      emailStatusMessage($('#email-template-status'), error.message, 'error');
    }
  }

  function renderEmailDraftOptions() {
    const select = $('#email-draft-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">No draft selected</option>' + emailState.drafts.map(draft =>
      `<option value="${escapeHtml(draft.id)}">${escapeHtml(draft.name || draft.subject || `Draft #${draft.id}`)}</option>`
    ).join('');
    if (current && emailState.drafts.some(draft => String(draft.id) === current)) select.value = current;
  }

  async function loadEmailDrafts() {
    try {
      const data = await api('/api/admin/email/drafts');
      emailState.drafts = data.drafts || [];
      emailState.loaded.drafts = true;
      renderEmailDraftOptions();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function saveEmailDraft() {
    const payload = {
      name: $('#email-subject').value.trim() || `Draft ${new Date().toLocaleString()}`,
      to: splitEmailAddresses($('#email-to').value),
      cc: splitEmailAddresses($('#email-cc').value),
      bcc: splitEmailAddresses($('#email-bcc').value),
      subject: $('#email-subject').value.trim(),
      html: emailBodyHtml(),
      text: $('#email-text').value
    };
    try {
      await api('/api/admin/email/drafts', { method: 'POST', body: JSON.stringify(payload) });
      toast('Draft saved.', 'success');
      emailStatusMessage($('#email-compose-status'), 'Draft saved.', 'success');
      await loadEmailDrafts();
    } catch (error) {
      emailStatusMessage($('#email-compose-status'), error.message, 'error');
    }
  }

  function loadSelectedEmailDraft() {
    const id = $('#email-draft-select').value;
    if (!id) return emailStatusMessage($('#email-compose-status'), 'Choose a draft to load.', 'error');
    const draft = emailState.drafts.find(item => String(item.id) === String(id));
    if (!draft) return;
    $('#email-to').value = (draft.to || []).join(', ');
    $('#email-cc').value = (draft.cc || []).join(', ');
    $('#email-bcc').value = (draft.bcc || []).join(', ');
    $('#email-subject').value = draft.subject || '';
    setEmailBodyHtml(draft.html || '');
    $('#email-text').value = draft.text || '';
    emailStatusMessage($('#email-compose-status'), 'Draft loaded.', 'success');
  }

  async function deleteSelectedEmailDraft() {
    const id = $('#email-draft-select').value;
    if (!id) return emailStatusMessage($('#email-compose-status'), 'Choose a draft to delete.', 'error');
    if (!window.confirm('Delete this saved draft?')) return;
    try {
      await api(`/api/admin/email/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Draft deleted.', 'success');
      await loadEmailDrafts();
    } catch (error) {
      emailStatusMessage($('#email-compose-status'), error.message, 'error');
    }
  }

  function renderEmailRecipients() {
    const list = $('#email-recipient-list');
    if (!list) return;
    if (!emailState.recipients.length) {
      list.innerHTML = '<p class="table-empty">No eligible registered users match this search.</p>';
    } else {
      list.innerHTML = emailState.recipients.map(user => {
        const selected = emailState.selectedRecipientIds.has(String(user.id));
        return `<label class="email-recipient-item${selected ? ' is-selected' : ''}">
          <input type="checkbox" data-recipient-id="${escapeHtml(user.id)}"${selected ? ' checked' : ''}>
          <span class="email-recipient-copy"><strong>${escapeHtml(user.username || 'Unnamed user')}</strong><span>${escapeHtml(user.email)}</span></span>
        </label>`;
      }).join('');
    }
    const count = $('#email-recipient-count');
    if (count) count.textContent = String(emailState.recipientTotal);
    const selectAll = $('#email-recipient-select-all');
    if (selectAll) {
      const visibleIds = emailState.recipients.map(user => String(user.id));
      selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => emailState.selectedRecipientIds.has(id));
      selectAll.indeterminate = !selectAll.checked && visibleIds.some(id => emailState.selectedRecipientIds.has(id));
    }
    updateEmailAudienceButtons();
  }

  async function loadEmailRecipients() {
    try {
      const query = new URLSearchParams({ limit: '50', search: emailState.recipientSearch });
      const data = await api(`/api/admin/email/recipients?${query}`);
      emailState.recipients = data.users || [];
      emailState.recipientTotal = data.total || 0;
      emailState.eligibleTotal = data.eligibleTotal || 0;
      emailState.loaded.recipients = true;
      renderEmailRecipients();
      const note = $('#email-audience-note');
      if (note) note.textContent = `${emailState.eligibleTotal} eligible registered user${emailState.eligibleTotal === 1 ? '' : 's'}. Bulk announcements are queued one recipient at a time to protect the SMTP server.`;
    } catch (error) {
      $('#email-recipient-list').innerHTML = `<p class="table-empty admin-error">${escapeHtml(error.message)}</p>`;
    }
  }

  function updateEmailAudienceButtons() {
    const selected = emailState.selectedRecipientIds.size;
    const sendSelected = $('#email-send-selected');
    const addSelected = $('#email-add-selected');
    if (sendSelected) {
      sendSelected.textContent = `Send to selected (${selected})`;
      sendSelected.disabled = selected === 0;
    }
    if (addSelected) addSelected.disabled = selected === 0;
    const sendAll = $('#email-send-all');
    if (sendAll) sendAll.disabled = emailState.eligibleTotal === 0;
  }

  function addSelectedRecipientsToTo() {
    if (!emailState.selectedRecipientIds.size) return;
    const existing = new Set(splitEmailAddresses($('#email-to').value).map(item => item.toLowerCase()));
    const additions = [];
    for (const id of emailState.selectedRecipientIds) {
      const user = emailState.selectedRecipientMap.get(String(id));
      if (!user || !user.email) continue;
      if (existing.has(String(user.email).toLowerCase())) continue;
      existing.add(String(user.email).toLowerCase());
      additions.push(user.email);
    }
    if (!additions.length) return emailStatusMessage($('#email-compose-status'), 'The selected users are already in the To field.', 'pending');
    $('#email-to').value = [...splitEmailAddresses($('#email-to').value), ...additions].join(', ');
    emailStatusMessage($('#email-compose-status'), `${additions.length} recipient${additions.length === 1 ? '' : 's'} added to To.`, 'success');
  }

  function openEmailPreview({ subject, html, text, meta }) {
    const dialog = $('#email-preview-dialog');
    $('#email-preview-subject').textContent = subject || 'Email preview';
    $('#email-preview-meta').textContent = meta || '';
    $('#email-preview-frame').srcdoc = html || '<!doctype html><html><body style="font-family:Arial,sans-serif;padding:24px;color:#333;">No HTML body.</body></html>';
    $('#email-preview-text').textContent = text || '(No plain text alternative)';
    if (!dialog.open) dialog.showModal();
  }

  function previewComposeEmail() {
    openEmailPreview({
      subject: $('#email-subject').value.trim() || 'Email preview',
      html: emailBodyHtml(),
      text: $('#email-text').value,
      meta: `To: ${$('#email-to').value.trim() || 'No recipient'}`
    });
  }

  function emailComposePayload() {
    return {
      to: splitEmailAddresses($('#email-to').value),
      cc: splitEmailAddresses($('#email-cc').value),
      bcc: splitEmailAddresses($('#email-bcc').value),
      subject: $('#email-subject').value.trim(),
      html: emailBodyHtml(),
      text: $('#email-text').value
    };
  }

  function validateComposePayload(payload, requireRecipient = true) {
    if (requireRecipient && !payload.to.length) {
      emailStatusMessage($('#email-compose-status'), 'Add at least one recipient in the To field.', 'error');
      return false;
    }
    if (!payload.subject) {
      emailStatusMessage($('#email-compose-status'), 'Add a subject before continuing.', 'error');
      return false;
    }
    if (!payload.html.trim() && !payload.text.trim()) {
      emailStatusMessage($('#email-compose-status'), 'Add a message body before continuing.', 'error');
      return false;
    }
    return true;
  }

  async function sendComposeEmail(event) {
    event.preventDefault();
    const payload = emailComposePayload();
    if (!validateComposePayload(payload)) return;
    const button = $('#email-send-button');
    button.disabled = true;
    emailStatusMessage($('#email-compose-status'), 'Sending through SMTP…', 'pending');
    try {
      const data = await api('/api/admin/email/send', { method: 'POST', body: JSON.stringify(payload) });
      emailStatusMessage($('#email-compose-status'), data.message || 'The SMTP server accepted the email.', 'success');
      toast('Email accepted by the SMTP server.', 'success');
      if (emailState.loaded.history) loadEmailHistory(emailState.historyPage);
    } catch (error) {
      emailStatusMessage($('#email-compose-status'), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function sendBulkEmail({ allEligible }) {
    const payload = emailComposePayload();
    if (!validateComposePayload(payload, false)) return;
    const count = allEligible ? emailState.eligibleTotal : emailState.selectedRecipientIds.size;
    if (!count) {
      return emailStatusMessage($('#email-compose-status'), allEligible ? 'No eligible registered users were found.' : 'Select at least one registered user.', 'error');
    }
    const confirmation = window.confirm(
      allEligible
        ? `Queue this announcement for all ${count} eligible registered users? Each recipient receives an individual email.`
        : `Queue this announcement for ${count} selected user${count === 1 ? '' : 's'}? Each recipient receives an individual email.`
    );
    if (!confirmation) return;
    const button = allEligible ? $('#email-send-all') : $('#email-send-selected');
    button.disabled = true;
    emailStatusMessage($('#email-compose-status'), 'Queueing the announcement…', 'pending');
    try {
      const body = {
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        confirm: true,
        ...(allEligible ? { allEligible: true } : { userIds: [...emailState.selectedRecipientIds].map(Number) })
      };
      const data = await api('/api/admin/email/bulk', { method: 'POST', body: JSON.stringify(body) });
      emailStatusMessage($('#email-compose-status'), data.message || `${data.queued} email(s) queued.`, 'success');
      toast(`${data.queued} email${data.queued === 1 ? '' : 's'} queued.`, 'success');
      loadEmailQueue();
      if (emailState.loaded.history) loadEmailHistory(1);
    } catch (error) {
      emailStatusMessage($('#email-compose-status'), error.message, 'error');
    } finally {
      button.disabled = false;
      updateEmailAudienceButtons();
    }
  }

  async function saveEmailSettings(event) {
    event.preventDefault();
    const result = $('#email-settings-result');
    const payload = {
      smtpHost: $('#email-smtp-host').value.trim(),
      smtpPort: Number($('#email-smtp-port').value),
      smtpUsername: $('#email-smtp-username').value.trim(),
      fromEmail: $('#email-from-email').value.trim(),
      fromName: $('#email-from-name').value.trim(),
      encryption: $('#email-smtp-encryption').value,
      enabled: $('#email-smtp-enabled').checked
    };
    const password = $('#email-smtp-password').value;
    if (password) payload.password = password;
    const button = $('#email-smtp-save');
    button.disabled = true;
    result.hidden = false;
    result.className = 'notice notice-info email-settings-result';
    result.textContent = 'Saving SMTP settings…';
    try {
      await api('/api/admin/email/settings', { method: 'PUT', body: JSON.stringify(payload) });
      $('#email-smtp-password').value = '';
      result.className = 'notice email-settings-result is-success';
      result.textContent = 'SMTP settings saved. Run a connection test before sending.';
      toast('SMTP settings saved.', 'success');
      await loadEmailSettings();
    } catch (error) {
      result.className = 'notice email-settings-result is-error';
      result.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function testEmailSmtp() {
    const result = $('#email-settings-result');
    const payload = {
      smtpHost: $('#email-smtp-host').value.trim(),
      smtpPort: Number($('#email-smtp-port').value),
      smtpUsername: $('#email-smtp-username').value.trim(),
      fromEmail: $('#email-from-email').value.trim(),
      fromName: $('#email-from-name').value.trim(),
      encryption: $('#email-smtp-encryption').value,
      enabled: true
    };
    const password = $('#email-smtp-password').value;
    if (password) payload.password = password;
    const button = $('#email-smtp-test');
    button.disabled = true;
    result.hidden = false;
    result.className = 'notice notice-info email-settings-result';
    result.textContent = 'Testing the SMTP connection…';
    try {
      const data = await api('/api/admin/email/settings/test', { method: 'POST', body: JSON.stringify(payload) });
      result.className = 'notice email-settings-result is-success';
      result.textContent = data.message || 'SMTP connection established successfully.';
      toast('SMTP connection successful.', 'success');
    } catch (error) {
      result.className = 'notice email-settings-result is-error';
      result.textContent = error.message;
    } finally {
      button.disabled = false;
      updateEmailSmtpBadge();
    }
  }

  function renderEmailHistory(logs) {
    const body = $('#email-history-body');
    if (!body) return;
    if (!logs.length) {
      body.innerHTML = '<tr><td class="table-empty" colspan="7">No email activity matches these filters.</td></tr>';
      return;
    }
    body.innerHTML = logs.map(log => {
      const sender = log.senderName ? `${log.senderName} <${log.senderEmail}>` : (log.senderEmail || '—');
      const retry = log.status === 'failed'
        ? `<button class="button button-small" type="button" data-email-retry="${escapeHtml(log.id)}">Retry</button>`
        : '';
      return `<tr>
        <td data-label="Recipient" class="cell-primary"><span class="email-log-subject">${escapeHtml(log.recipient)}</span></td>
        <td data-label="Subject"><span class="email-log-subject" title="${escapeHtml(log.subject)}">${escapeHtml(log.subject)}</span></td>
        <td data-label="Sender" class="cell-extra">${escapeHtml(sender)}</td>
        <td data-label="Date and time" class="cell-extra">${escapeHtml(formatDateTime(log.createdAt))}</td>
        <td data-label="Status">${emailStatusPill(log.status)}</td>
        <td data-label="Error"><span class="email-log-error" title="${escapeHtml(log.errorMessage || '')}">${escapeHtml(log.errorMessage || '—')}</span></td>
        <td data-label="Actions" class="cell-actions">
          <button class="button button-small" type="button" data-email-view="${escapeHtml(log.id)}">View</button>
          ${retry}
        </td>
      </tr>`;
    }).join('');
  }

  async function loadEmailHistory(page = 1) {
    const body = $('#email-history-body');
    if (body) body.innerHTML = '<tr><td class="table-empty" colspan="7">Loading email history…</td></tr>';
    try {
      const query = new URLSearchParams({
        page: String(page),
        limit: '20',
        search: emailState.historySearch,
        status: emailState.historyStatus
      });
      const data = await api(`/api/admin/email/logs?${query}`);
      emailState.loaded.history = true;
      emailState.historyPage = data.pagination.page;
      emailState.historyTotalPages = data.pagination.totalPages;
      renderEmailHistory(data.logs || []);
      $('#email-history-page-label').textContent = data.pagination.totalPages
        ? `Page ${data.pagination.page} of ${data.pagination.totalPages} · ${data.pagination.total} email${data.pagination.total === 1 ? '' : 's'}`
        : 'No email activity found';
      $('#email-history-prev').disabled = data.pagination.page <= 1;
      $('#email-history-next').disabled = data.pagination.page >= data.pagination.totalPages;
    } catch (error) {
      if (body) body.innerHTML = `<tr><td class="table-empty admin-error" colspan="7">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function openEmailDetail(id) {
    const content = $('#email-detail-content');
    const dialog = $('#email-detail-dialog');
    content.innerHTML = '<p class="table-empty">Loading email details…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api(`/api/admin/email/logs/${encodeURIComponent(id)}`);
      const email = data.email;
      const sender = email.senderName ? `${email.senderName} <${email.senderEmail}>` : (email.senderEmail || '—');
      content.innerHTML = `
        <p class="eyebrow">EMAIL DETAILS</p>
        <h2>${escapeHtml(email.subject)}</h2>
        <p class="muted small">${emailStatusPill(email.status)} ${email.deliveryStatus === 'accepted_by_smtp' ? '<span class="muted small">SMTP accepted · inbox delivery not confirmed</span>' : ''}</p>
        <div class="email-detail-grid">
          <div><span>Recipient</span><strong>${escapeHtml(email.recipient)}</strong></div>
          <div><span>To</span><strong>${escapeHtml((email.to || []).join(', ') || '—')}</strong></div>
          <div><span>CC</span><strong>${escapeHtml((email.cc || []).join(', ') || '—')}</strong></div>
          <div><span>BCC</span><strong>${escapeHtml((email.bcc || []).join(', ') || '—')}</strong></div>
          <div><span>Sender</span><strong>${escapeHtml(sender)}</strong></div>
          <div><span>Created</span><strong>${escapeHtml(formatDateTime(email.createdAt))}</strong></div>
          <div><span>SMTP accepted</span><strong>${escapeHtml(email.sentAt ? formatDateTime(email.sentAt) : '—')}</strong></div>
          <div><span>Attempts</span><strong>${escapeHtml(email.attempts)}</strong></div>
          <div><span>Message ID</span><strong>${escapeHtml(email.messageId || '—')}</strong></div>
          <div><span>Source</span><strong>${escapeHtml(email.source)}</strong></div>
        </div>
        ${email.errorMessage ? `<div class="notice notice-warning"><span class="notice-icon" aria-hidden="true">!</span><span>${escapeHtml(email.errorMessage)}</span></div>` : ''}
        <div class="email-detail-actions">
          ${email.status === 'failed' ? `<button class="button button-primary" type="button" data-email-retry="${escapeHtml(email.id)}">Retry this email</button>` : ''}
          <button class="button button-secondary" type="button" id="email-detail-close">Close</button>
        </div>
        <h3>HTML preview</h3>
        <div id="email-detail-preview"></div>`;
      const frame = document.createElement('iframe');
      frame.className = 'email-preview-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.title = 'Email HTML preview';
      frame.srcdoc = email.html || '<!doctype html><html><body style="font-family:Arial,sans-serif;padding:24px;color:#333;">No HTML body was stored.</body></html>';
      $('#email-detail-preview').append(frame);
    } catch (error) {
      content.innerHTML = `<p class="table-empty admin-error">${escapeHtml(error.message)}</p>`;
    }
  }

  async function retryEmail(id) {
    if (!window.confirm('Retry sending this email through SMTP?')) return;
    try {
      await api(`/api/admin/email/logs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
      toast('The SMTP server accepted the email on retry.', 'success');
      if (emailState.loaded.history) loadEmailHistory(emailState.historyPage);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function loadEmailQueue() {
    try {
      const data = await api('/api/admin/email/queue');
      const badge = $('#email-queue-badge');
      if (!badge) return;
      const pending = (data.queue.pending || 0) + (data.queue.sending || 0);
      badge.hidden = pending === 0;
      badge.textContent = pending ? `Queue: ${pending} pending` : '';
      badge.className = 'pill pill-delayed';
    } catch {
      // A queue badge refresh must never interrupt the email workflow.
    }
  }

  async function loadEmailPage() {
    if (!emailState.loaded.settings) await loadEmailSettings();
    else updateEmailSmtpBadge();
    if (!emailState.loaded.templates) await loadEmailTemplates();
    if (!emailState.loaded.recipients) await loadEmailRecipients();
    if (!emailState.loaded.drafts) await loadEmailDrafts();
    loadEmailQueue();
    showEmailTab(emailState.tab);
  }

  function showEmailTab(name) {
    const tabs = ['compose', 'templates', 'history', 'settings'];
    const active = tabs.includes(name) ? name : 'compose';
    emailState.tab = active;
    $$('[data-email-tab]').forEach(tab => {
      const isActive = tab.dataset.emailTab === active;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });
    tabs.forEach(tabName => {
      const panel = document.getElementById(`email-tab-${tabName}`);
      if (!panel) return;
      panel.hidden = tabName !== active;
      panel.classList.toggle('is-active', tabName === active);
    });
    if (active === 'history' && !emailState.loaded.history) loadEmailHistory(1);
    if (active === 'templates' && !emailState.loaded.templates) loadEmailTemplates();
    if (active === 'settings' && !emailState.loaded.settings) loadEmailSettings();
    if (active === 'compose' && !emailState.loaded.recipients) loadEmailRecipients();
  }

  // --------------------------- Subscriptions ---------------------------
  function subStatusBadge(status) {
    const tone = status === 'active' || status === 'approved' ? 'success'
      : status === 'suspended' || status === 'rejected' || status === 'revoked' ? 'danger' : 'warning';
    const label = String(status || '—').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
  }

  function subDate(value) {
    if (!value) return '—';
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
  }

  async function loadAdminSubscriptionsPage() {
    await Promise.all([
      loadAdminSubscriptionSummary(),
      loadAdminPayments(),
      loadAdminSubscriptions(),
      loadAdminPlans(),
      loadAdminEaBuilds()
    ]);
  }

  async function loadAdminSubscriptionSummary() {
    try {
      const data = await api('/api/admin/subscriptions/overview');
      $('#sub-stat-total').textContent = data.total;
      $('#sub-stat-active').textContent = data.active;
      $('#sub-stat-pending').textContent = data.pending;
      $('#sub-stat-revenue').textContent = formatMoney(data.revenue, 'MYR');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function loadAdminPayments() {
    const tbody = $('#admin-payments-table');
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading payment requests…</td></tr>';
    try {
      const data = await api('/api/admin/subscription-payments');
      if (!data.payments.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No payment requests yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.payments.map(payment => `
        <tr>
          <td data-label="ID" class="cell-extra">#${escapeHtml(String(payment.id))}</td>
          <td data-label="User" class="cell-primary">${escapeHtml(payment.username || payment.user_id)}<div class="muted small">${escapeHtml(payment.email || '')}</div></td>
          <td data-label="Plan">${escapeHtml(payment.plan_name || '—')}</td>
          <td data-label="Amount" class="cell-key">${formatMoney(payment.amount, payment.currency)}</td>
          <td data-label="Reference" class="cell-extra">${escapeHtml(payment.payment_reference || '—')}${payment.hasProof ? ` · <a href="/api/admin/subscription-payments/${escapeHtml(String(payment.id))}/proof" target="_blank" rel="noopener">Proof</a>` : ''}</td>
          <td data-label="Status">${subStatusBadge(payment.status)}</td>
          <td class="cell-actions" data-label="Actions">
            ${payment.status === 'pending_approval' ? `
              <button class="button button-small" type="button" data-sub-action="approve-payment" data-id="${escapeHtml(String(payment.id))}">Approve</button>
              <button class="button button-small button-secondary" type="button" data-sub-action="reject-payment" data-id="${escapeHtml(String(payment.id))}">Reject</button>` : ['cancelled', 'rejected'].includes(payment.status) ? `
              <button class="button button-small button-danger" type="button" data-sub-action="delete-payment" data-id="${escapeHtml(String(payment.id))}">Delete</button>` : '—'}
          </td>
        </tr>`).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function loadAdminSubscriptions() {
    const tbody = $('#admin-subscriptions-table');
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading subscriptions…</td></tr>';
    try {
      const data = await api('/api/admin/subscriptions?limit=100');
      if (!data.subscriptions.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No subscriptions yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.subscriptions.map(subscription => `
        <tr>
          <td data-label="ID" class="cell-extra">#${escapeHtml(String(subscription.id))}</td>
          <td data-label="User" class="cell-primary">${escapeHtml(subscription.username || subscription.user_id)}<div class="muted small">${escapeHtml(subscription.email || '')}</div></td>
          <td data-label="Plan">${escapeHtml(subscription.plan_name || '—')}</td>
          <td data-label="Price" class="cell-key">${formatMoney(subscription.purchase_price, subscription.currency)}</td>
          <td data-label="Status">${subStatusBadge(subscription.status)}</td>
          <td data-label="Activations" class="cell-extra">${escapeHtml(String(subscription.activation_count || 0))} / ${escapeHtml(String(subscription.max_activations || 5))}</td>
          <td data-label="Expires">${subDate(subscription.expires_at)}</td>
          <td class="cell-actions" data-label="Actions">
            ${subscription.status === 'active' ? `<button class="button button-small button-secondary" type="button" data-sub-action="suspend" data-id="${escapeHtml(String(subscription.id))}">Suspend</button>` : ''}
            ${subscription.status === 'suspended' ? `<button class="button button-small" type="button" data-sub-action="reinstate" data-id="${escapeHtml(String(subscription.id))}">Reinstate</button>` : ''}
            ${['active', 'suspended'].includes(subscription.status) ? `<button class="button button-small button-secondary" type="button" data-sub-action="revoke" data-id="${escapeHtml(String(subscription.id))}">Revoke</button>` : ''}
            ${!['active', 'suspended'].includes(subscription.status) ? `<button class="button button-small button-danger" type="button" data-sub-action="delete-subscription" data-id="${escapeHtml(String(subscription.id))}">Delete</button>` : ''}
          </td>
        </tr>`).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  let adminPlans = [];
  let editingPlanId = null;

  async function loadAdminPlans() {
    const tbody = $('#admin-plans-table');
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading plans…</td></tr>';
    try {
      const data = await api('/api/admin/subscription-plans');
      adminPlans = data.plans;
      if (!data.plans.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No plans yet. Add one to allow subscriptions.</td></tr>';
        return;
      }
      tbody.innerHTML = data.plans.map(plan => `
        <tr>
          <td data-label="ID" class="cell-extra">#${escapeHtml(String(plan.id))}</td>
          <td data-label="Name" class="cell-primary">${escapeHtml(plan.name)}</td>
          <td data-label="Price" class="cell-key">${formatMoney(plan.price, plan.currency)}</td>
          <td data-label="Duration">${escapeHtml(String(plan.duration_days))} days</td>
          <td data-label="Max activations" class="cell-extra">${escapeHtml(String(plan.max_activations))}</td>
          <td data-label="Active">${subStatusBadge(plan.is_active ? 'active' : 'inactive')}</td>
          <td class="cell-actions" data-label="Actions">
            <button class="button button-small button-secondary" type="button" data-sub-action="edit-plan" data-id="${escapeHtml(String(plan.id))}">Edit</button>
            <button class="button button-small button-danger" type="button" data-sub-action="delete-plan" data-id="${escapeHtml(String(plan.id))}">Delete</button>
            <button class="button button-small button-secondary" type="button" data-sub-action="toggle-plan" data-id="${escapeHtml(String(plan.id))}" data-active="${plan.is_active ? '1' : '0'}">${plan.is_active ? 'Deactivate' : 'Activate'}</button>
          </td>
        </tr>`).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function loadAdminEaBuilds() {
    const tbody = $('#admin-ea-table');
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading EA builds…</td></tr>';
    try {
      const data = await api('/api/admin/ea-downloads');
      if (!data.versions.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No EA builds uploaded yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.versions.map(build => `
        <tr>
          <td data-label="ID" class="cell-extra">#${escapeHtml(String(build.id))}</td>
          <td data-label="Version" class="cell-primary">${escapeHtml(build.version)}</td>
          <td data-label="File" class="cell-extra">${escapeHtml(build.filename)}</td>
          <td data-label="Released">${subDate(build.created_at)}</td>
          <td data-label="Active">${subStatusBadge(build.is_active ? 'active' : 'inactive')}</td>
          <td class="cell-actions" data-label="Actions">${build.is_active ? '<span class="muted small">Current</span>' : `<button class="button button-small" type="button" data-sub-action="publish-build" data-id="${escapeHtml(String(build.id))}">Publish</button>`}</td>
        </tr>`).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function uploadEaBuild() {
    const file = $('#ea-file').files[0];
    const version = $('#ea-version').value.trim();
    if (!version) return toast('Enter the EA version.', 'error');
    if (!file) return toast('Select a compiled .ex5 file.', 'error');
    if (!file.name.toLowerCase().endsWith('.ex5')) return toast('The EA must be an .ex5 file.', 'error');
    const button = $('#ea-upload');
    button.disabled = true;
    try {
      const query = new URLSearchParams({
        version,
        filename: file.name,
        release_notes: $('#ea-release-notes').value.trim()
      });
      const response = await fetch(`/api/admin/ea-downloads/upload?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to upload the EA build.');
      toast('EA build uploaded. Publish it to make it available.', 'success');
      $('#ea-version').value = '';
      $('#ea-file').value = '';
      $('#ea-release-notes').value = '';
      loadAdminEaBuilds();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function resetPlanForm() {
    editingPlanId = null;
    ['#plan-name', '#plan-price', '#plan-duration', '#plan-desc'].forEach(selector => { $(selector).value = ''; });
    $('#plan-max-act').value = '5';
    $('#plan-currency').value = 'MYR';
    $('#plan-form').style.display = 'none';
    $('#admin-plan-create').textContent = 'Create Plan';
    $('#admin-plan-cancel').hidden = true;
  }

  function startPlanEdit(planId) {
    const plan = adminPlans.find(item => String(item.id) === String(planId));
    if (!plan) return toast('This plan could not be found. Refresh and try again.', 'error');
    editingPlanId = plan.id;
    $('#plan-name').value = plan.name || '';
    $('#plan-price').value = Number(plan.price);
    $('#plan-duration').value = plan.duration_days ?? '';
    $('#plan-max-act').value = plan.max_activations ?? 5;
    $('#plan-currency').value = plan.currency || 'MYR';
    $('#plan-desc').value = plan.description || '';
    $('#plan-form').style.display = 'block';
    $('#admin-plan-create').textContent = 'Save Changes';
    $('#admin-plan-cancel').hidden = false;
    $('#plan-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function saveSubscriptionPlan() {
    const payload = {
      name: $('#plan-name').value.trim(),
      price: Number($('#plan-price').value),
      duration_days: Number.parseInt($('#plan-duration').value, 10),
      max_activations: Number.parseInt($('#plan-max-act').value, 10) || 5,
      currency: $('#plan-currency').value.trim().toUpperCase() || 'MYR',
      description: $('#plan-desc').value.trim()
    };
    try {
      if (editingPlanId) {
        await api(`/api/admin/subscription-plans/${editingPlanId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Plan updated.', 'success');
      } else {
        await api('/api/admin/subscription-plans', { method: 'POST', body: JSON.stringify(payload) });
        toast('Plan created.', 'success');
      }
      resetPlanForm();
      loadAdminPlans();
      loadAdminSubscriptionSummary();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  $('#admin-payments-refresh').addEventListener('click', loadAdminPayments);
  $('#admin-subscriptions-refresh').addEventListener('click', loadAdminSubscriptions);
  $('#admin-plan-add').addEventListener('click', () => {
    const form = $('#plan-form');
    const wasHidden = form.style.display === 'none';
    resetPlanForm();
    if (wasHidden) form.style.display = 'block';
  });
  $('#admin-plan-create').addEventListener('click', saveSubscriptionPlan);
  $('#admin-plan-cancel').addEventListener('click', resetPlanForm);

  async function handleSubscriptionAction(button) {
    const { subAction, id } = button.dataset;
    if (subAction === 'edit-plan') {
      startPlanEdit(id);
      return;
    }
    let path = null;
    let body = {};
    let method = 'POST';
    if (subAction === 'approve-payment') path = `/api/admin/subscription-payments/${id}/approve`;
    else if (subAction === 'reject-payment') {
      const reason = window.prompt('Reason for rejecting this payment:');
      if (!reason) return;
      path = `/api/admin/subscription-payments/${id}/reject`;
      body = { reason };
    } else if (subAction === 'suspend') {
      const reason = window.prompt('Reason for suspending this subscription:');
      if (!reason) return;
      path = `/api/admin/subscriptions/${id}/suspend`;
      body = { reason };
    } else if (subAction === 'reinstate') {
      path = `/api/admin/subscriptions/${id}/reinstate`;
    } else if (subAction === 'revoke') {
      const reason = window.prompt('Reason for revoking this subscription:');
      if (!reason) return;
      path = `/api/admin/subscriptions/${id}/revoke`;
      body = { reason };
    } else if (subAction === 'delete-payment') {
      if (!window.confirm('Delete this cancelled/rejected payment request? This cannot be undone.')) return;
      path = `/api/admin/subscription-payments/${id}`;
      method = 'DELETE';
    } else if (subAction === 'delete-subscription') {
      if (!window.confirm('Delete this inactive subscription record? This cannot be undone.')) return;
      path = `/api/admin/subscriptions/${id}`;
      method = 'DELETE';
    } else if (subAction === 'delete-plan') {
      if (!window.confirm('Delete this plan permanently? Plans with payment history must be deactivated instead.')) return;
      path = '/api/admin/subscription-plans/' + id;
      method = 'DELETE';
    } else if (subAction === 'toggle-plan') {
      path = `/api/admin/subscription-plans/${id}`;
      method = 'PUT';
      body = { is_active: button.dataset.active !== '1' };
    } else if (subAction === 'publish-build') {
      path = `/api/admin/ea-downloads/${id}/activate`;
    }
    if (!path) return;
    button.disabled = true;
    try {
      await api(path, { method, body: JSON.stringify(body) });
      toast('Subscription updated.', 'success');
      loadAdminSubscriptionsPage();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  $('#admin-payments-table').addEventListener('click', event => {
    const button = event.target.closest('[data-sub-action]');
    if (button) handleSubscriptionAction(button);
  });
  $('#admin-subscriptions-table').addEventListener('click', event => {
    const button = event.target.closest('[data-sub-action]');
    if (button) handleSubscriptionAction(button);
  });
  $('#admin-plans-table').addEventListener('click', event => {
    const button = event.target.closest('[data-sub-action]');
    if (button) handleSubscriptionAction(button);
  });
  $('#admin-ea-table').addEventListener('click', event => {
    const button = event.target.closest('[data-sub-action]');
    if (button) handleSubscriptionAction(button);
  });
  $('#ea-upload').addEventListener('click', uploadEaBuild);

  // ------------------------- Email event wiring -------------------------
  function syncEmailRecipientSelectAll() {
    const selectAll = $('#email-recipient-select-all');
    if (!selectAll) return;
    const visibleIds = emailState.recipients.map(user => String(user.id));
    selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => emailState.selectedRecipientIds.has(id));
    selectAll.indeterminate = !selectAll.checked && visibleIds.some(id => emailState.selectedRecipientIds.has(id));
  }

  $$('[data-email-tab]').forEach(tab => {
    tab.addEventListener('click', () => showEmailTab(tab.dataset.emailTab));
  });

  $$('.email-tool[data-editor-cmd]').forEach(button => {
    button.addEventListener('click', () => {
      const editor = $('#email-editor');
      if (!editor || editor.hidden) return;
      editor.focus();
      document.execCommand(button.dataset.editorCmd, false, button.dataset.editorValue || null);
    });
  });

  $('#email-link-button').addEventListener('click', () => {
    const editor = $('#email-editor');
    if (!editor || editor.hidden) return;
    const url = window.prompt('Enter the link URL (https://… or mailto:…)');
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) return toast('Enter an http(s) or mailto link.', 'error');
    editor.focus();
    document.execCommand('createLink', false, url.trim());
  });

  $('#email-source-toggle').addEventListener('click', () => {
    const source = $('#email-html-source');
    syncEmailSource(source.hidden);
  });

  $('#email-template-insert').addEventListener('click', () => {
    const id = $('#email-template-select').value;
    if (!id) return;
    const template = emailState.templates.find(item => String(item.id) === String(id));
    if (!template) return;
    const hasContent = $('#email-subject').value.trim() || emailBodyHtml().trim();
    if (hasContent && !window.confirm('Replace the current subject and message with this template?')) return;
    const subject = applyEmailTemplateVariables(template.subject);
    const html = applyEmailTemplateVariables(template.html);
    const text = applyEmailTemplateVariables(template.text);
    $('#email-subject').value = subject;
    setEmailBodyHtml(html);
    $('#email-text').value = text;
    const hasPlaceholders = /\{\{[A-Za-z0-9_]+\}\}/.test(`${subject} ${html} ${text}`);
    emailStatusMessage(
      $('#email-compose-status'),
      hasPlaceholders
        ? 'Template inserted. Replace the remaining {{variables}} before sending.'
        : 'Template inserted.',
      'success'
    );
  });

  $('#email-preview-button').addEventListener('click', previewComposeEmail);
  $('#email-save-draft').addEventListener('click', saveEmailDraft);
  $('#email-draft-load').addEventListener('click', loadSelectedEmailDraft);
  $('#email-draft-delete').addEventListener('click', deleteSelectedEmailDraft);
  $('#email-compose-form').addEventListener('submit', sendComposeEmail);

  $('#email-recipient-search').addEventListener('input', event => {
    emailState.recipientSearch = event.target.value.trim();
    window.clearTimeout(emailState.recipientSearchTimer);
    emailState.recipientSearchTimer = window.setTimeout(loadEmailRecipients, 250);
  });
  $('#email-recipient-refresh').addEventListener('click', loadEmailRecipients);
  $('#email-recipient-select-all').addEventListener('change', event => {
    const visible = emailState.recipients;
    for (const user of visible) {
      const id = String(user.id);
      if (event.target.checked) {
        emailState.selectedRecipientIds.add(id);
        emailState.selectedRecipientMap.set(id, user);
      } else {
        emailState.selectedRecipientIds.delete(id);
        emailState.selectedRecipientMap.delete(id);
      }
    }
    renderEmailRecipients();
  });
  $('#email-recipient-list').addEventListener('change', event => {
    const checkbox = event.target.closest('[data-recipient-id]');
    if (!checkbox) return;
    const id = String(checkbox.dataset.recipientId);
    if (checkbox.checked) {
      emailState.selectedRecipientIds.add(id);
      const user = emailState.recipients.find(item => String(item.id) === id);
      if (user) emailState.selectedRecipientMap.set(id, user);
    } else {
      emailState.selectedRecipientIds.delete(id);
      emailState.selectedRecipientMap.delete(id);
    }
    const item = checkbox.closest('.email-recipient-item');
    if (item) item.classList.toggle('is-selected', checkbox.checked);
    updateEmailAudienceButtons();
    syncEmailRecipientSelectAll();
  });
  $('#email-add-selected').addEventListener('click', addSelectedRecipientsToTo);
  $('#email-send-selected').addEventListener('click', () => sendBulkEmail({ allEligible: false }));
  $('#email-send-all').addEventListener('click', () => sendBulkEmail({ allEligible: true }));

  $('#email-template-new').addEventListener('click', resetEmailTemplateForm);
  $('#email-template-list').addEventListener('click', event => {
    const item = event.target.closest('[data-template-id]');
    if (item) editEmailTemplate(item.dataset.templateId);
  });
  $('#email-template-form').addEventListener('submit', saveEmailTemplate);
  $('#email-template-preview').addEventListener('click', () => {
    openEmailPreview({
      subject: $('#email-template-subject').value.trim() || 'Template preview',
      html: $('#email-template-html').value,
      text: $('#email-template-text').value,
      meta: 'Template preview'
    });
  });
  $('#email-template-delete').addEventListener('click', deleteEmailTemplate);

  $('#email-history-refresh').addEventListener('click', () => loadEmailHistory(emailState.historyPage));
  $('#email-history-search').addEventListener('input', event => {
    emailState.historySearch = event.target.value.trim();
    window.clearTimeout(emailState.historySearchTimer);
    emailState.historySearchTimer = window.setTimeout(() => loadEmailHistory(1), 250);
  });
  $('#email-history-status').addEventListener('change', event => {
    emailState.historyStatus = event.target.value;
    loadEmailHistory(1);
  });
  $('#email-history-prev').addEventListener('click', () => {
    if (emailState.historyPage > 1) loadEmailHistory(emailState.historyPage - 1);
  });
  $('#email-history-next').addEventListener('click', () => {
    if (emailState.historyPage < emailState.historyTotalPages) loadEmailHistory(emailState.historyPage + 1);
  });
  $('#email-history-body').addEventListener('click', event => {
    const view = event.target.closest('[data-email-view]');
    if (view) return openEmailDetail(view.dataset.emailView);
    const retry = event.target.closest('[data-email-retry]');
    if (retry) return retryEmail(retry.dataset.emailRetry);
  });

  $('#email-settings-form').addEventListener('submit', saveEmailSettings);
  $('#email-smtp-test').addEventListener('click', testEmailSmtp);

  $('#email-detail-content').addEventListener('click', event => {
    if (event.target.closest('#email-detail-close')) return $('#email-detail-dialog').close();
    const retry = event.target.closest('[data-email-retry]');
    if (retry) {
      $('#email-detail-dialog').close();
      retryEmail(retry.dataset.emailRetry);
    }
  });
  $('#email-preview-dialog').addEventListener('click', event => {
    if (event.target === $('#email-preview-dialog')) $('#email-preview-dialog').close();
  });
  $('#email-detail-dialog').addEventListener('click', event => {
    if (event.target === $('#email-detail-dialog')) $('#email-detail-dialog').close();
  });

  function showAdminPage(name) {
    const pages = ['overview', 'subscriptions', 'support', 'email', 'reports', 'announcements', 'sandbox', 'ea-submissions', 'commissions'];
    const active = pages.includes(name) ? name : 'overview';
    pages.forEach(pageName => {
      const section = document.getElementById(pageName);
      if (!section) return;
      section.hidden = pageName !== active;
      section.classList.toggle('is-visible', pageName === active);
    });
    $$('[data-admin-page]').forEach(link => {
      link.classList.toggle('is-active', link.dataset.adminPage === active);
      if (link.dataset.adminPage === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const labels = { overview: 'Overview', subscriptions: 'Subscriptions', support: 'Support', email: 'Email', reports: 'Reports', announcements: 'Announcements', sandbox: 'Sandbox Management', 'ea-submissions': 'EA Submissions', commissions: 'Commissions' };
    $('#admin-breadcrumb-page').textContent = labels[active];
    if (active === 'subscriptions') loadAdminSubscriptionsPage();
    if (active === 'support') loadSupportConversations();
    if (active === 'email') loadEmailPage();
    if (active === 'reports') loadReports();
    if (active === 'announcements') loadAnnouncements();
    if (window.CornGridAdminSandbox) {
      if (active === 'sandbox') window.CornGridAdminSandbox.openSandbox();
      else window.CornGridAdminSandbox.closeSandbox();
      if (active === 'ea-submissions') window.CornGridAdminSandbox.loadSubmissions();
      if (active === 'commissions') window.CornGridAdminSandbox.loadCommissions();
    }
    closeSidebarOnNavigation();
  }

  $('#admin-refresh').addEventListener('click', () => {
    if (!$('#subscriptions').hidden) loadAdminSubscriptionsPage();
    else if (!$('#support').hidden) refreshSupportInbox();
    else if (!$('#email').hidden) {
      if (emailState.tab === 'history') loadEmailHistory(emailState.historyPage);
      else if (emailState.tab === 'templates') loadEmailTemplates();
      else if (emailState.tab === 'settings') loadEmailSettings();
      else {
        loadEmailSettings();
        loadEmailRecipients();
        loadEmailDrafts();
      }
      loadEmailQueue();
    }
    else if (!$('#reports').hidden) loadReports();
    else if (!$('#announcements').hidden) loadAnnouncements();
    else loadOverview();
  });
  $$('[data-admin-page]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    showAdminPage(link.dataset.adminPage);
    history.replaceState(null, '', `#${link.dataset.adminPage}`);
  }));
  $('#admin-prev').addEventListener('click', () => {
    if (page > 1) {
      page -= 1;
      loadOverview();
    }
  });
  $('#admin-next').addEventListener('click', () => {
    if (page < totalPages) {
      page += 1;
      loadOverview();
    }
  });
  $('#admin-visibility').addEventListener('change', () => {
    page = 1;
    loadOverview();
  });
  $('#admin-search').addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      page = 1;
      loadOverview();
    }, 250);
  });
  $('#admin-logout').addEventListener('click', signOut);
  $('#admin-profiles').addEventListener('click', async event => {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const userId = Number(button.dataset.userId);
    const username = button.dataset.username || `user ${userId}`;
    if (button.dataset.userAction === 'trading') return loadTradingOverview(userId);
    if (button.dataset.userAction === 'suspend') {
      selectedSuspendUser = { id: userId, username };
      $('#admin-suspend-user').textContent = `${username} will lose access until the suspension expires or is lifted.`;
      $('#admin-suspend-reason').value = '';
      $('#admin-suspend-dialog').showModal();
      return;
    }
    if (button.dataset.userAction === 'restore') {
      if (!window.confirm(`Restore access for ${username}?`)) return;
      try {
        await api(`/api/admin/users/${userId}/suspension`, { method: 'DELETE' });
        await loadOverview();
      } catch (error) { window.alert(error.message); }
      return;
    }
    if (button.dataset.userAction === 'delete') {
      const confirmation = window.prompt(`This permanently deletes ${username} and linked trading data. Type the exact username to continue:`);
      if (confirmation !== username) {
        if (confirmation !== null) window.alert('The username did not match. Nothing was deleted.');
        return;
      }
      try {
        await api(`/api/admin/users/${userId}`, {
          method: 'DELETE',
          body: JSON.stringify({ confirmUsername: confirmation })
        });
        await loadOverview();
      } catch (error) { window.alert(error.message); }
    }
  });
  $('#admin-suspend-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedSuspendUser) return;
    const submit = $('#admin-suspend-submit');
    submit.disabled = true;
    try {
      await api(`/api/admin/users/${selectedSuspendUser.id}/suspension`, {
        method: 'POST',
        body: JSON.stringify({
          durationHours: Number($('#admin-suspend-duration').value),
          reason: $('#admin-suspend-reason').value.trim()
        })
      });
      $('#admin-suspend-dialog').close();
      await loadOverview();
    } catch (error) { window.alert(error.message); }
    finally { submit.disabled = false; }
  });
  $('#admin-suspend-cancel').addEventListener('click', () => $('#admin-suspend-dialog').close());
  $('#admin-support-refresh').addEventListener('click', refreshSupportInbox);
  $('#admin-support-back').addEventListener('click', () => {
    $('#support').classList.remove('support-thread-open');
    ($(`[data-support-user="${selectedSupportUserId}"]`) || $('#admin-support-search'))?.focus();
    scrollSupportPanel('.admin-support-list-panel');
  });
  $('#admin-support-clear').addEventListener('click', async () => {
    const userId = selectedSupportUserId;
    if (!userId || supportState.deleting) return;
    const username = $('#admin-support-user').textContent;
    if (!window.confirm(`Permanently delete the entire support conversation with ${username} for both the user and support team? This cannot be undone.`)) return;
    const button = $('#admin-support-clear');
    supportState.deleting = true;
    supportState.threadRequestId = (supportState.threadRequestId || 0) + 1;
    button.disabled = true;
    try {
      await api(`/api/admin/support/conversations/${userId}/messages`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      supportState.threadSignature = '';
      supportState.deleting = false;
      if (selectedSupportUserId === userId) await loadSupportMessages(userId);
      else await loadSupportConversations();
      toast('Support chat history deleted.', 'success');
    } catch (error) { toast(error.message, 'error'); }
    finally { supportState.deleting = false; button.disabled = !supportState.messageCount; }
  });
  $('#admin-support-search').addEventListener('input', event => {
    supportState.search = event.target.value;
    renderSupportConversations();
  });
  $('#admin-support-filter').addEventListener('change', event => {
    supportState.filter = event.target.value === 'unread' ? 'unread' : 'all';
    renderSupportConversations();
  });
  $('#admin-support-list').addEventListener('click', event => {
    const item = event.target.closest('[data-support-user]');
    if (!item) return;
    const userId = Number(item.dataset.supportUser);
    if (String(selectedSupportUserId) !== String(userId)) {
      const input = $('#admin-support-input');
      if (input) input.value = '';
    }
    selectedSupportUserId = userId;
    $('#support').classList.add('support-thread-open');
    $('#admin-support-clear').hidden = true;
    supportState.threadSignature = '';
    renderSupportConversations();
    $('#admin-support-user').textContent = 'Loading conversation…';
    $('#admin-support-email').textContent = 'Fetching the latest messages.';
    $('#admin-support-avatar').innerHTML = supportAvatarContent('?', null);
    const status = $('#admin-support-thread-status');
    if (status) status.hidden = true;
    $('#admin-support-form').hidden = true;
    $('#admin-support-messages').innerHTML = `<div class="chat-empty-state"><span class="chat-empty-state-icon">${supportIcon('clock')}</span><h3>Opening conversation</h3><p class="muted">Loading the latest messages.</p></div>`;
    updateSupportComposer();
    loadSupportMessages(selectedSupportUserId);
    window.requestAnimationFrame(() => scrollSupportPanel('.admin-support-chat'));
  });
  $('#admin-support-input').addEventListener('input', updateSupportComposer);
  updateSupportComposer();
  $('#admin-support-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#admin-support-input');
    const button = $('#admin-support-send');
    const message = input.value.trim();
    if (!selectedSupportUserId || !message) {
      updateSupportComposer();
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/admin/support/conversations/${selectedSupportUserId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message })
      });
      input.value = '';
      updateSupportComposer();
      toast('Reply sent.');
      await loadSupportMessages(selectedSupportUserId);
    } catch (error) {
      toast(error.message || 'Unable to send this reply.', 'error');
    } finally {
      updateSupportComposer();
      input.focus();
    }
  });
  $('#admin-support-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#admin-support-form').requestSubmit();
    }
  });
  window.addEventListener('hashchange', () => {
    const hash = location.hash.replace('#', '');
    showAdminPage(['subscriptions', 'support', 'email', 'reports', 'announcements'].includes(hash) ? hash : 'overview');
  });
  window.setInterval(() => {
    if (document.hidden) return;
    if (!$('#support').hidden) {
      if (selectedSupportUserId) loadSupportMessages(selectedSupportUserId, { silent: true });
      else loadSupportConversations({ silent: true });
    } else if (++supportBadgeTick % 3 === 0) {
      loadSupportConversations({ silent: true });
    }
    if (!$('#email').hidden) {
      loadEmailQueue();
      if (emailState.tab === 'history' && emailState.loaded.history) loadEmailHistory(emailState.historyPage);
    }
    refreshReportsBadge();
  }, 10000);
  $('#admin-trading-dialog').addEventListener('click', event => {
    if (event.target === $('#admin-trading-dialog')) $('#admin-trading-dialog').close();
  });
  if (location.hash === '#subscriptions') showAdminPage('subscriptions');
  else if (location.hash === '#support') showAdminPage('support');
  else if (location.hash === '#email') showAdminPage('email');
  else if (location.hash === '#reports') showAdminPage('reports');
  else if (location.hash === '#announcements') showAdminPage('announcements');
  loadOverview();
  loadSupportConversations({ silent: true });
  refreshReportsBadge();
})();
