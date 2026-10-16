function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function registerAdminApi(app, db, verifyAdminToken, heartbeatTimeoutSeconds) {
  app.get('/api/admin/overview', verifyAdminToken, async (req, res) => {
    const page = Math.min(1000000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const visibility = ['public', 'private'].includes(req.query.visibility) ? req.query.visibility : 'all';
    const now = Date.now();
    const onlineSince = now - heartbeatTimeoutSeconds * 1000;
    const onlineUntil = now + 60 * 1000;
    const publicCondition = `
      EXISTS (
        SELECT 1 FROM public_portfolios pp
        WHERE pp.user_id = u.id
          AND pp.is_public = 1
          AND EXISTS (
            SELECT 1 FROM public_portfolio_accounts ppa
            WHERE ppa.user_id = u.id
          )
      )
    `;
    const searchCondition = search ? `AND u.username LIKE ? COLLATE NOCASE` : '';
    const visibilityCondition = visibility === 'all'
      ? ''
      : visibility === 'public'
        ? `AND ${publicCondition}`
        : `AND NOT ${publicCondition}`;
    const params = [];
    if (search) params.push(`%${search}%`);
    const filteredCondition = `${searchCondition} ${visibilityCondition}`;

    try {
      const summary = await get(db, `
        SELECT
          (SELECT COUNT(*) FROM users) AS totalUsers,
          (SELECT COUNT(*) FROM mt5_accounts) AS totalAccounts,
          (
            SELECT COUNT(*) FROM users u
            WHERE ${publicCondition}
          ) AS publicPortfolios,
          (
            SELECT COUNT(*) FROM mt5_accounts
            WHERE last_heartbeat IS NOT NULL
              AND last_heartbeat >= ?
              AND last_heartbeat <= ?
          ) AS onlineAccounts
      `, [onlineSince, onlineUntil]);
      const filtered = await get(db, `
        SELECT COUNT(*) AS total
        FROM users u
        WHERE 1 = 1 ${filteredCondition}
      `, params);
      const profiles = await all(db, `
        SELECT
          u.id,
          u.username,
          u.created_at AS createdAt,
          (
            SELECT COUNT(*) FROM mt5_accounts a
            WHERE a.user_id = u.id
          ) AS linkedAccounts,
          (
            SELECT COUNT(*) FROM mt5_accounts a
            WHERE a.user_id = u.id
              AND a.last_heartbeat IS NOT NULL
              AND a.last_heartbeat >= ?
              AND a.last_heartbeat <= ?
          ) AS onlineAccounts,
          (
            SELECT COUNT(*) FROM public_portfolio_accounts ppa
            WHERE ppa.user_id = u.id
          ) AS sharedAccounts,
          CASE WHEN ${publicCondition} THEN 1 ELSE 0 END AS isPublic
        FROM users u
        WHERE 1 = 1 ${filteredCondition}
        ORDER BY u.id DESC
        LIMIT ? OFFSET ?
      `, [onlineSince, onlineUntil, ...params, limit, (page - 1) * limit]);

      return res.json({
        summary: {
          totalUsers: summary.totalUsers,
          publicPortfolios: summary.publicPortfolios,
          privatePortfolios: summary.totalUsers - summary.publicPortfolios,
          totalAccounts: summary.totalAccounts,
          onlineAccounts: summary.onlineAccounts
        },
        profiles: profiles.map(profile => ({
          ...profile,
          portfolioVisibility: profile.isPublic ? 'Public' : 'Private',
          accountStatus: profile.onlineAccounts > 0
            ? 'Online'
            : profile.linkedAccounts > 0
              ? 'Offline'
              : 'No accounts'
        })),
        pagination: {
          page,
          limit,
          total: filtered.total,
          totalPages: Math.ceil(filtered.total / limit)
        }
      });
    } catch (error) {
      console.error('Failed to load the administrator overview:', error.message);
      return res.status(500).json({ error: 'Unable to load administrator dashboard data.' });
    }
  });
}

module.exports = registerAdminApi;
