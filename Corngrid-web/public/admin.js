(() => {
  let page = 1;
  let totalPages = 0;
  let searchTimer;
  let selectedSupportUserId = null;
  let selectedSuspendUser = null;
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
          <td><span class="admin-profile-name">${escapeHtml(profile.username || 'Unnamed user')}</span><span class="admin-profile-id">Profile #${profile.id}</span></td>
          <td>${escapeHtml(formatDate(profile.createdAt))}</td>
          <td><span class="pill ${visibilityClass}">${escapeHtml(profile.portfolioVisibility)}</span></td>
          <td>${profile.sharedAccounts}</td>
          <td>${profile.linkedAccounts}</td>
          <td><span class="pill admin-status ${statusClass}">${escapeHtml(profile.accountStatus)}</span></td>
          <td>${accessStatus}</td>
          <td class="admin-actions">
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
      <td>${escapeHtml(account.accountName || 'MT5 account')}<small>${escapeHtml(account.maskedAccount)}</small></td>
      <td>${escapeHtml(account.currency)}</td><td>${formatMoney(account.balance, account.currency)}</td>
      <td>${formatMoney(account.equity, account.currency)}</td><td>${formatMoney(account.floatingProfit, account.currency)}</td>
      <td>${escapeHtml(formatDateTime(account.lastHeartbeat))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="table-empty">No linked trading accounts.</td></tr>';
    const positionRows = data.positions.length ? data.positions.map(position => `<tr>
      <td>${escapeHtml(position.maskedAccount)}</td><td>${escapeHtml(position.symbol)}</td><td>${escapeHtml(position.direction)}</td>
      <td>${escapeHtml(position.volume)}</td><td>${formatMoney(position.profit, position.currency)}</td><td>${escapeHtml(formatDateTime(position.openedAt))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="table-empty">No open positions.</td></tr>';
    const dealRows = data.deals.length ? data.deals.map(deal => `<tr>
      <td>${escapeHtml(deal.maskedAccount)}</td><td>${escapeHtml(deal.symbol)}</td><td>${escapeHtml(deal.direction)}</td>
      <td>${escapeHtml(deal.volume)}</td><td>${formatMoney(deal.profit, deal.currency)}</td><td>${escapeHtml(formatDateTime(deal.closedAt))}</td>
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

  async function loadSupportConversations() {
    const list = $('#admin-support-list');
    try {
      const data = await api('/api/admin/support/conversations');
      const conversations = data.conversations || [];
      const unread = conversations.reduce((sum, conversation) => sum + Number(conversation.unreadCount || 0), 0);
      const badge = $('#admin-support-unread');
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      if (!conversations.length) {
        list.innerHTML = '<p class="table-empty">No support conversations yet.</p>';
        return;
      }
      list.innerHTML = conversations.map(conversation => `
        <button class="admin-support-item${String(selectedSupportUserId) === String(conversation.userId) ? ' is-selected' : ''}" type="button" data-support-user="${conversation.userId}">
          <span class="admin-support-item-top"><strong>${escapeHtml(conversation.username)}</strong><time>${escapeHtml(formatDateTime(conversation.lastMessageAt))}</time></span>
          <span class="admin-support-preview">${conversation.lastSenderRole === 'admin' ? 'You: ' : ''}${escapeHtml(conversation.lastMessage)}${Number(conversation.unreadCount) ? `<b class="chat-unread-badge">${Number(conversation.unreadCount) > 99 ? '99+' : Number(conversation.unreadCount)}</b>` : ''}</span>
        </button>
      `).join('');
    } catch (error) {
      list.innerHTML = `<p class="table-empty admin-error">${escapeHtml(error.message)}</p>`;
    }
  }

  async function loadSupportMessages(userId) {
    // Guard against NaN / null / undefined user IDs — the backend correctly
    // rejects them with a 400, so bail here to avoid firing the request.
    if (!Number.isSafeInteger(userId)) return;
    try {
      const data = await api(`/api/admin/support/conversations/${encodeURIComponent(userId)}/messages`);
      if (String(selectedSupportUserId) !== String(userId)) return;
      $('#admin-support-user').textContent = data.user.username;
      $('#admin-support-email').textContent = data.user.email;
      $('#admin-support-form').hidden = false;
      const messages = data.messages || [];
      $('#admin-support-messages').innerHTML = messages.length ? messages.map(message => `
        <div class="chat-bubble-wrap ${message.senderRole === 'admin' ? 'is-mine' : 'is-peer'}">
          <div class="chat-bubble">${escapeHtml(message.message)}</div>
          <div class="chat-meta"><span>${escapeHtml(formatDateTime(message.createdAt))}</span>${message.senderRole === 'admin' ? '<span>Support</span>' : `<span>${escapeHtml(data.user.username)}</span>`}</div>
        </div>
      `).join('') : '<div class="chat-empty-state"><h3>Conversation started</h3><p class="muted">Send a reply to help this user.</p></div>';
      $('#admin-support-messages').scrollTop = $('#admin-support-messages').scrollHeight;
      await loadSupportConversations();
    } catch (error) {
      $('#admin-support-messages').innerHTML = `<div class="chat-empty-state admin-error">${escapeHtml(error.message)}</div>`;
    }
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
          <td>#${escapeHtml(String(payment.id))}</td>
          <td>${escapeHtml(payment.username || payment.user_id)}<div class="muted small">${escapeHtml(payment.email || '')}</div></td>
          <td>${escapeHtml(payment.plan_name || '—')}</td>
          <td>${formatMoney(payment.amount, payment.currency)}</td>
          <td>${escapeHtml(payment.payment_reference || '—')}${payment.hasProof ? ` · <a href="/api/admin/subscription-payments/${escapeHtml(String(payment.id))}/proof" target="_blank" rel="noopener">Proof</a>` : ''}</td>
          <td>${subStatusBadge(payment.status)}</td>
          <td>
            ${payment.status === 'pending_approval' ? `
              <button class="button button-small" type="button" data-sub-action="approve-payment" data-id="${escapeHtml(String(payment.id))}">Approve</button>
              <button class="button button-small button-secondary" type="button" data-sub-action="reject-payment" data-id="${escapeHtml(String(payment.id))}">Reject</button>` : '—'}
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
          <td>#${escapeHtml(String(subscription.id))}</td>
          <td>${escapeHtml(subscription.username || subscription.user_id)}<div class="muted small">${escapeHtml(subscription.email || '')}</div></td>
          <td>${escapeHtml(subscription.plan_name || '—')}</td>
          <td>${formatMoney(subscription.purchase_price, subscription.currency)}</td>
          <td>${subStatusBadge(subscription.status)}</td>
          <td>${escapeHtml(String(subscription.activation_count || 0))} / ${escapeHtml(String(subscription.max_activations || 5))}</td>
          <td>${subDate(subscription.expires_at)}</td>
          <td>
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

  async function loadAdminPlans() {
    const tbody = $('#admin-plans-table');
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading plans…</td></tr>';
    try {
      const data = await api('/api/admin/subscription-plans');
      if (!data.plans.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No plans yet. Add one to allow subscriptions.</td></tr>';
        return;
      }
      tbody.innerHTML = data.plans.map(plan => `
        <tr>
          <td>#${escapeHtml(String(plan.id))}</td>
          <td>${escapeHtml(plan.name)}</td>
          <td>${formatMoney(plan.price, plan.currency)}</td>
          <td>${escapeHtml(String(plan.duration_days))} days</td>
          <td>${escapeHtml(String(plan.max_activations))}</td>
          <td>${subStatusBadge(plan.is_active ? 'active' : 'inactive')}</td>
          <td><button class="button button-small button-secondary" type="button" data-sub-action="toggle-plan" data-id="${escapeHtml(String(plan.id))}" data-active="${plan.is_active ? '1' : '0'}">${plan.is_active ? 'Deactivate' : 'Activate'}</button></td>
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
          <td>#${escapeHtml(String(build.id))}</td>
          <td>${escapeHtml(build.version)}</td>
          <td>${escapeHtml(build.filename)}</td>
          <td>${subDate(build.created_at)}</td>
          <td>${subStatusBadge(build.is_active ? 'active' : 'inactive')}</td>
          <td>${build.is_active ? '<span class="muted small">Current</span>' : `<button class="button button-small" type="button" data-sub-action="publish-build" data-id="${escapeHtml(String(build.id))}">Publish</button>`}</td>
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

  async function createSubscriptionPlan() {
    const payload = {
      name: $('#plan-name').value.trim(),
      price: Number($('#plan-price').value),
      duration_days: Number.parseInt($('#plan-duration').value, 10),
      max_activations: Number.parseInt($('#plan-max-act').value, 10) || 5,
      currency: $('#plan-currency').value.trim().toUpperCase() || 'MYR',
      description: $('#plan-desc').value.trim()
    };
    try {
      await api('/api/admin/subscription-plans', { method: 'POST', body: JSON.stringify(payload) });
      toast('Plan created.', 'success');
      ['#plan-name', '#plan-price', '#plan-duration', '#plan-desc'].forEach(selector => { $(selector).value = ''; });
      $('#plan-form').style.display = 'none';
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
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });
  $('#admin-plan-create').addEventListener('click', createSubscriptionPlan);

  async function handleSubscriptionAction(button) {
    const { subAction, id } = button.dataset;
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
    } else if (subAction === 'delete-subscription') {
      if (!window.confirm('Delete this inactive subscription record? This cannot be undone.')) return;
      path = `/api/admin/subscriptions/${id}`;
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

  function showAdminPage(name) {
    const pages = ['overview', 'subscriptions', 'support', 'reports', 'announcements'];
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
    const labels = { overview: 'Overview', subscriptions: 'Subscriptions', support: 'Support', reports: 'Reports', announcements: 'Announcements' };
    $('#admin-breadcrumb-page').textContent = labels[active];
    if (active === 'subscriptions') loadAdminSubscriptionsPage();
    if (active === 'support') loadSupportConversations();
    if (active === 'reports') loadReports();
    if (active === 'announcements') loadAnnouncements();
    closeSidebarOnNavigation();
  }

  $('#admin-refresh').addEventListener('click', () => {
    if (!$('#subscriptions').hidden) loadAdminSubscriptionsPage();
    else if (!$('#support').hidden) loadSupportConversations();
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
  $('#admin-support-refresh').addEventListener('click', loadSupportConversations);
  $('#admin-support-list').addEventListener('click', event => {
    const item = event.target.closest('[data-support-user]');
    if (!item) return;
    selectedSupportUserId = Number(item.dataset.supportUser);
    loadSupportMessages(selectedSupportUserId);
  });
  $('#admin-support-form').addEventListener('submit', async event => {
    event.preventDefault();
    const message = $('#admin-support-input').value.trim();
    if (!selectedSupportUserId || !message) return;
    const button = $('#admin-support-send');
    button.disabled = true;
    try {
      await api(`/api/admin/support/conversations/${selectedSupportUserId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message })
      });
      $('#admin-support-input').value = '';
      await loadSupportMessages(selectedSupportUserId);
    } catch (error) { window.alert(error.message); }
    finally { button.disabled = false; }
  });
  $('#admin-support-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#admin-support-form').requestSubmit();
    }
  });
  window.addEventListener('hashchange', () => {
    const hash = location.hash.replace('#', '');
    showAdminPage(['subscriptions', 'support', 'reports', 'announcements'].includes(hash) ? hash : 'overview');
  });
  window.setInterval(() => {
    if (document.hidden) return;
    if (!$('#support').hidden) {
      if (selectedSupportUserId) loadSupportMessages(selectedSupportUserId);
      else loadSupportConversations();
    }
    refreshReportsBadge();
  }, 10000);
  $('#admin-trading-dialog').addEventListener('click', event => {
    if (event.target === $('#admin-trading-dialog')) $('#admin-trading-dialog').close();
  });
  if (location.hash === '#subscriptions') showAdminPage('subscriptions');
  else if (location.hash === '#support') showAdminPage('support');
  else if (location.hash === '#reports') showAdminPage('reports');
  else if (location.hash === '#announcements') showAdminPage('announcements');
  loadOverview();
  refreshReportsBadge();
})();
