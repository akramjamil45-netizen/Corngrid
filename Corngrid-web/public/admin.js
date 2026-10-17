(() => {
  let page = 1;
  let totalPages = 0;
  let searchTimer;
  const $ = selector => document.querySelector(selector);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
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
    tbody.innerHTML = '<tr><td class="table-empty" colspan="6">Loading user profiles…</td></tr>';
    const query = new URLSearchParams({
      page: String(page),
      limit: '50',
      visibility: $('#admin-visibility').value,
      search: $('#admin-search').value.trim()
    });

    try {
      const response = await fetch(`/api/admin/overview?${query}`, {
        credentials: 'same-origin'
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        expireSession();
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Unable to load administrator dashboard data.');

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
        tbody.innerHTML = '<tr><td class="table-empty" colspan="6">No user profiles match these filters.</td></tr>';
        return;
      }
      tbody.innerHTML = data.profiles.map(profile => {
        const visibilityClass = profile.portfolioVisibility === 'Public' ? 'pill-online' : 'pill-muted';
        const statusClass = profile.accountStatus === 'Online'
          ? 'pill-online'
          : profile.accountStatus === 'Offline'
            ? 'pill-offline'
            : 'pill-muted';
        return `<tr>
          <td><span class="admin-profile-name">${escapeHtml(profile.username || 'Unnamed user')}</span><span class="admin-profile-id">Profile #${profile.id}</span></td>
          <td>${escapeHtml(formatDate(profile.createdAt))}</td>
          <td><span class="pill ${visibilityClass}">${escapeHtml(profile.portfolioVisibility)}</span></td>
          <td>${profile.sharedAccounts}</td>
          <td>${profile.linkedAccounts}</td>
          <td><span class="pill admin-status ${statusClass}">${escapeHtml(profile.accountStatus)}</span></td>
        </tr>`;
      }).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td class="table-empty admin-error" colspan="6">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  $('#admin-refresh').addEventListener('click', loadOverview);
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
  loadOverview();
})();
