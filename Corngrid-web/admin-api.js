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

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function registerAdminApi(app, db, verifyAdminToken, heartbeatTimeoutSeconds) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_account_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      suspended_until INTEGER NOT NULL,
      reason TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('user', 'admin')),
      message TEXT NOT NULL,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_support_user_created ON support_messages(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_support_unread ON support_messages(sender_role, read_at);
  `, error => {
    if (error) console.error('Failed to initialize administrator support and access tables:', error.message);
  });

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
          access.suspended_until AS suspendedUntil,
          access.reason AS suspensionReason,
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
        LEFT JOIN user_account_access access
          ON access.user_id = u.id AND access.suspended_until > ?
        WHERE 1 = 1 ${filteredCondition}
        ORDER BY u.id DESC
        LIMIT ? OFFSET ?
      `, [onlineSince, onlineUntil, now, ...params, limit, (page - 1) * limit]);

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
          isSuspended: profile.suspendedUntil != null,
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

  app.get('/api/admin/users/:userId/trading', verifyAdminToken, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
    try {
      const user = await get(db, 'SELECT id, username, created_at AS createdAt FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const accounts = await all(db, `
        SELECT id, account_number, currency, account_name, balance, equity,
          floating_profit, last_heartbeat, last_sync, linked_at
        FROM mt5_accounts
        WHERE user_id = ?
        ORDER BY linked_at DESC
      `, [userId]);
      const positions = await all(db, `
        SELECT a.id AS account_id, a.account_number, a.currency,
          p.symbol, p.direction, p.volume, p.entry_price, p.current_price,
          p.profit, p.opened_at, p.updated_at
        FROM mt5_positions p
        JOIN mt5_accounts a ON a.id = p.account_id
        WHERE a.user_id = ?
        ORDER BY p.updated_at DESC
        LIMIT 100
      `, [userId]);
      const deals = await all(db, `
        SELECT a.account_number, a.currency,
          d.symbol, d.direction, d.volume, d.entry_price, d.exit_price,
          d.profit, d.commission, d.swap, d.closed_at
        FROM mt5_deals d
        JOIN mt5_accounts a ON a.id = d.account_id
        WHERE a.user_id = ?
        ORDER BY d.closed_at DESC
        LIMIT 50
      `, [userId]);
      const suspension = await get(db, `
        SELECT suspended_until AS suspendedUntil, reason
        FROM user_account_access
        WHERE user_id = ? AND suspended_until > ?
      `, [userId, Date.now()]);
      const maskAccount = value => value.length <= 4 ? '•'.repeat(value.length) : `••••${value.slice(-4)}`;
      return res.json({
        user,
        suspension: suspension || null,
        accounts: accounts.map(account => ({
          accountName: account.account_name,
          maskedAccount: maskAccount(account.account_number),
          currency: account.currency,
          balance: account.balance,
          equity: account.equity,
          floatingProfit: account.floating_profit,
          lastHeartbeat: account.last_heartbeat,
          lastSync: account.last_sync,
          linkedAt: account.linked_at
        })),
        positions: positions.map(position => ({
          maskedAccount: maskAccount(position.account_number),
          currency: position.currency,
          symbol: position.symbol,
          direction: position.direction,
          volume: position.volume,
          entryPrice: position.entry_price,
          currentPrice: position.current_price,
          profit: position.profit,
          openedAt: position.opened_at,
          updatedAt: position.updated_at
        })),
        deals: deals.map(deal => ({
          maskedAccount: maskAccount(deal.account_number),
          currency: deal.currency,
          symbol: deal.symbol,
          direction: deal.direction,
          volume: deal.volume,
          entryPrice: deal.entry_price,
          exitPrice: deal.exit_price,
          profit: deal.profit,
          commission: deal.commission,
          swap: deal.swap,
          closedAt: deal.closed_at
        }))
      });
    } catch (error) {
      console.error('Failed to load the user trading overview:', error.message);
      return res.status(500).json({ error: 'Unable to load this user trading overview.' });
    }
  });

  app.post('/api/admin/users/:userId/suspension', verifyAdminToken, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    const durationHours = Number(req.body?.durationHours);
    const allowedDurations = new Set([24, 168, 720]);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
    if (!allowedDurations.has(durationHours)) {
      return res.status(400).json({ error: 'Suspension duration must be 24, 168, or 720 hours.' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    const suspendedUntil = Date.now() + durationHours * 60 * 60 * 1000;
    try {
      const user = await get(db, 'SELECT id FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      await run(db, `
        INSERT INTO user_account_access (user_id, suspended_until, reason, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          suspended_until = excluded.suspended_until,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `, [userId, suspendedUntil, reason || null, Date.now()]);
      return res.json({ suspendedUntil, reason: reason || null });
    } catch (error) {
      console.error('Failed to suspend user account:', error.message);
      return res.status(500).json({ error: 'Unable to suspend this user account.' });
    }
  });

  app.delete('/api/admin/users/:userId/suspension', verifyAdminToken, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
    try {
      const result = await run(db, 'DELETE FROM user_account_access WHERE user_id = ?', [userId]);
      if (!result.changes) return res.status(404).json({ error: 'No active suspension was found for this user.' });
      return res.json({ message: 'User access has been restored.' });
    } catch (error) {
      console.error('Failed to restore user account access:', error.message);
      return res.status(500).json({ error: 'Unable to restore this user account.' });
    }
  });

  app.delete('/api/admin/users/:userId', verifyAdminToken, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    const confirmUsername = typeof req.body?.confirmUsername === 'string' ? req.body.confirmUsername : '';
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
    if (!confirmUsername) return res.status(400).json({ error: 'Username confirmation is required.' });
    try {
      const result = await run(db, 'DELETE FROM users WHERE id = ? AND username = ?', [userId, confirmUsername]);
      if (!result.changes) {
        const user = await get(db, 'SELECT id FROM users WHERE id = ?', [userId]);
        return res.status(user ? 400 : 404).json({
          error: user ? 'The username confirmation does not match.' : 'User not found.'
        });
      }
      return res.json({ message: 'User account and linked data have been deleted.' });
    } catch (error) {
      console.error('Failed to delete user account:', error.message);
      return res.status(500).json({ error: 'Unable to delete this user account.' });
    }
  });

  app.get('/api/admin/support/conversations', verifyAdminToken, async (_req, res) => {
    try {
      const conversations = await all(db, `
        WITH latest AS (
          SELECT user_id, MAX(id) AS latest_id
          FROM support_messages
          GROUP BY user_id
        )
        SELECT u.id AS userId, u.username, u.email, u.created_at AS createdAt,
          m.message AS lastMessage, m.sender_role AS lastSenderRole, m.created_at AS lastMessageAt,
          (SELECT COUNT(*) FROM support_messages unread
           WHERE unread.user_id = u.id AND unread.sender_role = 'user' AND unread.read_at IS NULL) AS unreadCount
        FROM latest
        JOIN users u ON u.id = latest.user_id
        JOIN support_messages m ON m.id = latest.latest_id
        ORDER BY m.id DESC
        LIMIT 200
      `);
      return res.json({ conversations });
    } catch (error) {
      console.error('Failed to load administrator support inbox:', error.message);
      return res.status(500).json({ error: 'Unable to load support conversations.' });
    }
  });

  app.get('/api/admin/support/conversations/:userId/messages', verifyAdminToken, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
    try {
      const user = await get(db, 'SELECT id, username, email FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      await run(db, `
        UPDATE support_messages SET read_at = ?
        WHERE user_id = ? AND sender_role = 'user' AND read_at IS NULL
      `, [Date.now(), userId]);
      const messages = await all(db, `
        SELECT id, sender_role AS senderRole, message, read_at AS readAt, created_at AS createdAt
        FROM support_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 150
      `, [userId]);
      return res.json({ user, messages: messages.reverse() });
    } catch (error) {
      console.error('Failed to load support conversation:', error.message);
      return res.status(500).json({ error: 'Unable to load this support conversation.' });
    }
  });

  app.post('/api/admin/support/conversations/:userId/messages', verifyAdminToken, async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
    if (!message) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message cannot exceed 2000 characters.' });
    try {
      const user = await get(db, 'SELECT id FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const now = Date.now();
      const result = await run(db, `
        INSERT INTO support_messages (user_id, sender_role, message, created_at)
        VALUES (?, 'admin', ?, ?)
      `, [userId, message, now]);
      return res.status(201).json({ id: result.lastID, senderRole: 'admin', message, createdAt: now });
    } catch (error) {
      console.error('Failed to send administrator support response:', error.message);
      return res.status(500).json({ error: 'Unable to send this support response.' });
    }
  });
}

module.exports = registerAdminApi;
