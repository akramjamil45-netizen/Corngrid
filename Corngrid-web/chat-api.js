const { avatarUrl, AVATAR_SCHEMA } = require('./avatar-api');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

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

function rateLimit({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 1000) {
      for (const [key, bucket] of buckets) {
        if (bucket.expiresAt <= now) buckets.delete(key);
      }
    }
    const key = `${req.user ? req.user.id : req.ip}`;
    const current = buckets.get(key);
    if (!current || current.expiresAt <= now) {
      buckets.set(key, { count: 1, expiresAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) {
      res.set('Retry-After', String(Math.ceil((current.expiresAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many messages sent. Please slow down.' });
    }
    return next();
  };
}

const schema = `
  ${AVATAR_SCHEMA}
  CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dm_participants ON direct_messages(sender_id, recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dm_recipient_read ON direct_messages(recipient_id, read_at);
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
`;

function registerChatApi(app, db, verifyToken) {
  db.exec(schema, (error) => {
    if (error) console.error('Failed to initialize chat schema:', error.message);
  });

  const chatMessageRateLimit = rateLimit({ limit: 60, windowMs: 60 * 1000 });

  // 1. Get total unread count for current user
  app.get('/api/chat/unread-count', verifyToken, async (req, res) => {
    try {
      const row = await get(db, `
        SELECT
          (SELECT COUNT(*) FROM direct_messages dm
            JOIN users sender ON sender.id = dm.sender_id
            WHERE dm.recipient_id = ? AND dm.read_at IS NULL) +
          (SELECT COUNT(*) FROM support_messages WHERE user_id = ? AND sender_role = 'admin' AND read_at IS NULL)
          AS unread_count
      `, [req.user.id, req.user.id]);
      return res.json({ unreadCount: row ? row.unread_count : 0 });
    } catch (err) {
      console.error('Failed to get unread message count:', err.message);
      return res.status(500).json({ error: 'Unable to get unread message count.' });
    }
  });

  // 2. Search users by username (excluding self)
  app.get('/api/chat/users', verifyToken, async (req, res) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      let users;
      if (search) {
        users = await all(
          db,
          `SELECT u.id, u.username, u.bio, u.created_at, av.file AS avatar_file
           FROM users u LEFT JOIN user_avatars av ON av.user_id = u.id
           WHERE u.id != ? AND u.username LIKE ? COLLATE NOCASE
           ORDER BY u.username ASC
           LIMIT 20`,
          [req.user.id, `%${search}%`]
        );
      } else {
        users = await all(
          db,
          `SELECT u.id, u.username, u.bio, u.created_at, av.file AS avatar_file
           FROM users u LEFT JOIN user_avatars av ON av.user_id = u.id
           WHERE u.id != ?
           ORDER BY u.id DESC
           LIMIT 15`,
          [req.user.id]
        );
      }
      return res.json({ users: users.map(({ avatar_file: file, ...user }) => ({ ...user, avatarUrl: avatarUrl(file) })) });
    } catch (err) {
      console.error('Failed to search chat users:', err.message);
      return res.status(500).json({ error: 'Failed to search users.' });
    }
  });

  // 3. Get active conversations list with latest message and unread count
  app.get('/api/chat/conversations', verifyToken, async (req, res) => {
    try {
      const myId = req.user.id;
      const rows = await all(
        db,
        `WITH peer_latest AS (
           SELECT 
             CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
             MAX(id) AS latest_id
           FROM direct_messages
           WHERE sender_id = ? OR recipient_id = ?
           GROUP BY peer_id
         )
         SELECT 
           u.id AS peer_id,
           u.username,
           u.bio,
           av.file AS avatar_file,
           m.id AS message_id,
           m.message AS last_message,
           m.sender_id AS last_sender_id,
           m.created_at AS last_message_at,
           (
             SELECT COUNT(*)
             FROM direct_messages
             WHERE sender_id = u.id AND recipient_id = ? AND read_at IS NULL
           ) AS unread_count
         FROM peer_latest pl
         JOIN users u ON u.id = pl.peer_id
         LEFT JOIN user_avatars av ON av.user_id = u.id
         JOIN direct_messages m ON m.id = pl.latest_id
         ORDER BY m.created_at DESC`,
        [myId, myId, myId, myId]
      );

      return res.json({
        conversations: rows.map(r => ({
          peerId: r.peer_id,
          username: r.username,
          bio: r.bio,
          avatarUrl: avatarUrl(r.avatar_file),
          lastMessage: r.last_message,
          lastSenderId: r.last_sender_id,
          lastMessageAt: r.last_message_at,
          unreadCount: r.unread_count
        }))
      });
    } catch (err) {
      console.error('Failed to load conversations:', err.message);
      return res.status(500).json({ error: 'Failed to load conversations.' });
    }
  });

  // 4. Get message history with a peer user and mark as read
  app.get('/api/chat/messages/:peerId', verifyToken, async (req, res) => {
    try {
      const myId = req.user.id;
      const peerId = Number.parseInt(req.params.peerId, 10);
      if (!Number.isSafeInteger(peerId) || peerId <= 0 || peerId === myId) {
        return res.status(400).json({ error: 'Invalid peer user ID.' });
      }

      const peer = await get(db, `SELECT u.id, u.username, u.bio, av.file AS avatar_file
        FROM users u LEFT JOIN user_avatars av ON av.user_id = u.id WHERE u.id = ?`, [peerId]);
      if (!peer) {
        return res.status(404).json({ error: 'User not found.' });
      }

      // Mark incoming unread messages as read
      await run(
        db,
        `UPDATE direct_messages
         SET read_at = ?
         WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
        [Date.now(), peerId, myId]
      );

      const messages = await all(
        db,
        `SELECT id, sender_id, recipient_id, message, read_at, created_at
         FROM direct_messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at ASC
         LIMIT 150`,
        [myId, peerId, peerId, myId]
      );

      return res.json({
        peer: {
          id: peer.id,
          username: peer.username,
          bio: peer.bio,
          avatarUrl: avatarUrl(peer.avatar_file)
        },
        messages: messages.map(m => ({
          id: m.id,
          senderId: m.sender_id,
          recipientId: m.recipient_id,
          message: m.message,
          isMine: m.sender_id === myId,
          readAt: m.read_at,
          createdAt: m.created_at
        }))
      });
    } catch (err) {
      console.error('Failed to load messages:', err.message);
      return res.status(500).json({ error: 'Failed to load messages.' });
    }
  });

  // 5. Send a direct message to a user
  app.post('/api/chat/messages', verifyToken, chatMessageRateLimit, async (req, res) => {
    try {
      const myId = req.user.id;
      const { recipientId, message } = req.body || {};
      const parsedRecipientId = Number.parseInt(recipientId, 10);

      if (!Number.isSafeInteger(parsedRecipientId) || parsedRecipientId <= 0 || parsedRecipientId === myId) {
        return res.status(400).json({ error: 'Invalid recipient ID.' });
      }

      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
      }

      const trimmedMessage = message.trim();
      if (trimmedMessage.length > 2000) {
        return res.status(400).json({ error: 'Message cannot exceed 2000 characters.' });
      }

      const recipient = await get(db, 'SELECT id, username FROM users WHERE id = ?', [parsedRecipientId]);
      if (!recipient) {
        return res.status(404).json({ error: 'Recipient user not found.' });
      }

      const now = Date.now();
      const result = await run(
        db,
        `INSERT INTO direct_messages (sender_id, recipient_id, message, created_at)
         VALUES (?, ?, ?, ?)`,
        [myId, parsedRecipientId, trimmedMessage, now]
      );

      return res.status(201).json({
        id: result.lastID,
        senderId: myId,
        recipientId: parsedRecipientId,
        message: trimmedMessage,
        isMine: true,
        createdAt: now
      });
    } catch (err) {
      console.error('Failed to send message:', err.message);
      return res.status(500).json({ error: 'Failed to send message.' });
    }
  });

  app.get('/api/chat/support/messages', verifyToken, async (req, res) => {
    try {
      const userId = req.user.id;
      await run(db, `
        UPDATE support_messages SET read_at = ?
        WHERE user_id = ? AND sender_role = 'admin' AND read_at IS NULL
      `, [Date.now(), userId]);
      const messages = await all(db, `
        SELECT id, sender_role, message, read_at, created_at
        FROM support_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 150
      `, [userId]);
      return res.json({
        peer: { username: 'CornGrid Support', bio: 'Official customer support' },
        messages: messages.reverse().map(message => ({
          id: message.id,
          message: message.message,
          senderRole: message.sender_role,
          isMine: message.sender_role === 'user',
          readAt: message.read_at,
          createdAt: message.created_at
        }))
      });
    } catch (error) {
      console.error('Failed to load user support messages:', error.message);
      return res.status(500).json({ error: 'Unable to load support messages.' });
    }
  });

  app.post('/api/chat/support/messages', verifyToken, chatMessageRateLimit, async (req, res) => {
    try {
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!message) return res.status(400).json({ error: 'Message cannot be empty.' });
      if (message.length > 2000) return res.status(400).json({ error: 'Message cannot exceed 2000 characters.' });

      const now = Date.now();
      const result = await run(db, `
        INSERT INTO support_messages (user_id, sender_role, message, created_at)
        VALUES (?, 'user', ?, ?)
      `, [req.user.id, message, now]);
      return res.status(201).json({
        id: result.lastID,
        message,
        senderRole: 'user',
        isMine: true,
        createdAt: now
      });
    } catch (error) {
      console.error('Failed to send user support message:', error.message);
      return res.status(500).json({ error: 'Unable to send support message.' });
    }
  });
}

module.exports = registerChatApi;
