'use strict';

// Community Live Feed API: posts, comments, likes, reports, and admin announcements.
// Announcements are authored by the separate administrator identity (not a user row),
// so community_posts.author_user_id stays NULL for them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
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

function rateLimit({ limit, windowMs, message }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 1000) {
      for (const [key, bucket] of buckets) {
        if (bucket.expiresAt <= now) buckets.delete(key);
      }
    }
    const key = req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`;
    const current = buckets.get(key);
    if (!current || current.expiresAt <= now) {
      buckets.set(key, { count: 1, expiresAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) {
      res.set('Retry-After', String(Math.ceil((current.expiresAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

// Normalize untrusted text: strip NUL/control characters (keep newline/tab) and cap length.
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? null : cleaned;
}

const schema = `
  ${AVATAR_SCHEMA}
  CREATE TABLE IF NOT EXISTS feed_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'community' CHECK(kind IN ('community', 'announcement')),
    title TEXT,
    content TEXT NOT NULL,
    image_path TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    deleted_at INTEGER,
    CHECK (
      (kind = 'announcement' AND author_user_id IS NULL) OR
      (kind = 'community' AND author_user_id IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_feed_posts_live ON feed_posts(deleted_at, kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_feed_posts_author ON feed_posts(author_user_id, deleted_at, created_at);
  CREATE TABLE IF NOT EXISTS feed_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES feed_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, deleted_at, id);
  CREATE INDEX IF NOT EXISTS idx_feed_comments_author ON feed_comments(author_user_id, deleted_at);
  CREATE TABLE IF NOT EXISTS feed_likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE INDEX IF NOT EXISTS idx_feed_likes_post ON feed_likes(post_id);
  CREATE TABLE IF NOT EXISTS feed_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment')),
    target_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feed_reports_open ON feed_reports(resolved_at, created_at);
`;

// Shared image upload: validates magic bytes (never trusts extension or headers alone).
const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: b => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  'image/png': { ext: 'png', magic: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A },
  'image/webp': { ext: 'webp', magic: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function createImageUploadHandler(uploadDir) {
  return (req, res) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const type = IMAGE_TYPES[contentType];
    const body = req.body;
    if (!type || !Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'Upload a JPEG, PNG, or WebP image.' });
    }
    if (body.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Image must be 5 MB or smaller.' });
    }
    if (!type.magic(body)) {
      return res.status(400).json({ error: 'The uploaded file is not a valid image.' });
    }
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      const filename = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), body);
      return res.status(201).json({ url: `/uploads/feed/${filename}` });
    } catch (error) {
      console.error('Failed to store feed image:', error.message);
      return res.status(500).json({ error: 'Unable to store the uploaded image.' });
    }
  };
}

// Post shape shared by feed listing and single-post reads (no N+1: aggregated subqueries).
// One `?` binds the viewer id for the liked_by_me flag.
const POST_SELECT = `
  SELECT p.id, p.kind, p.title, p.content, p.image_path, p.is_pinned,
         p.created_at, p.updated_at, p.author_user_id,
         u.username AS author_username, u.bio AS author_bio, av.file AS author_avatar,
         (SELECT COUNT(*) FROM feed_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM feed_likes l WHERE l.post_id = p.id) AS like_count,
         EXISTS(SELECT 1 FROM feed_likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked_by_me
  FROM feed_posts p
  LEFT JOIN users u ON u.id = p.author_user_id
  LEFT JOIN user_avatars av ON av.user_id = p.author_user_id
`;

// Uploaded paths must match our own naming scheme; reject anything else outright.
function validateImagePath(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\/uploads\/feed\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(value)) return undefined;
  return value;
}

function shapePost(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    imagePath: row.image_path,
    isPinned: Boolean(row.is_pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Boolean(row.updated_at),
    author: row.kind === 'announcement'
      ? { username: null, displayName: 'CornGrid Announcement', bio: null, avatarUrl: null }
      : { username: row.author_username, displayName: row.author_username, bio: row.author_bio, avatarUrl: avatarUrl(row.author_avatar) },
    commentCount: row.comment_count,
    likeCount: row.like_count,
    likedByMe: Boolean(row.liked_by_me)
  };
}


function registerFeedApi(app, db, verifyToken, verifyAdminToken, options = {}) {
  const uploadDir = options.uploadDir || path.join(__dirname, 'public', 'uploads', 'feed');
  db.exec(schema, error => {
    if (error) console.error('Failed to initialize feed schema:', error.message);
  });

  const postRateLimit = rateLimit({ limit: 10, windowMs: 10 * 60 * 1000, message: 'You are posting too quickly. Please wait a moment.' });
  const commentRateLimit = rateLimit({ limit: 30, windowMs: 10 * 60 * 1000, message: 'You are commenting too quickly. Please wait a moment.' });
  const likeRateLimit = rateLimit({ limit: 120, windowMs: 60 * 1000, message: 'Too many reactions. Please slow down.' });
  const uploadRateLimit = rateLimit({ limit: 20, windowMs: 10 * 60 * 1000, message: 'Too many uploads. Please wait a moment.' });

  // Serve uploaded images (validated filenames only; files are written with random names).
  app.get('/uploads/feed/:filename', (req, res) => {
    const filename = String(req.params.filename || '');
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid image name.' });
    }
    res.sendFile(path.join(uploadDir, filename), error => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Image not found.' });
    });
  });

  // Raw image upload (JPEG/PNG/WebP, magic-byte validated, 5 MB cap).
  app.post('/api/feed/uploads', verifyToken, uploadRateLimit,
    express.raw({ type: Object.keys(IMAGE_TYPES), limit: MAX_IMAGE_BYTES }),
    createImageUploadHandler(uploadDir));

  // GET /api/feed?filter=latest|popular|announcements|mine — cursor pagination on post id.
  app.get('/api/feed', verifyToken, async (req, res) => {
    const filter = ['latest', 'popular', 'announcements', 'mine'].includes(req.query.filter) ? req.query.filter : 'latest';
    const cursor = Number.parseInt(req.query.cursor, 10);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 15));
    const viewerId = req.user.id;
    try {
      const params = [viewerId];
      let where = 'WHERE p.deleted_at IS NULL';
      if (filter === 'announcements') {
        where += " AND p.kind = 'announcement'";
      } else if (filter === 'mine') {
        where += ' AND p.author_user_id = ?';
        params.push(viewerId);
      } else {
        where += " AND (p.kind = 'community' OR p.is_pinned)";
      }
      if (Number.isSafeInteger(cursor) && cursor > 0) {
        where += ' AND p.id < ?';
        params.push(cursor);
      }
      const order = filter === 'popular'
        ? 'ORDER BY like_count DESC, p.id DESC'
        : 'ORDER BY p.is_pinned DESC, p.id DESC';
      const rows = await all(db, `${POST_SELECT} ${where} ${order} LIMIT ?`, [...params, limit + 1]);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).map(shapePost);
      return res.json({
        posts: page,
        nextCursor: hasMore && page.length ? page[page.length - 1].id : null
      });
    } catch (error) {
      console.error('Failed to list feed posts:', error.message);
      return res.status(500).json({ error: 'Unable to load the feed.' });
    }
  });


  // GET /api/feed/posts/:id — single post (soft-deleted posts are invisible to everyone except admins).
  app.get('/api/feed/posts/:id', verifyToken, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    try {
      const row = await get(db, `${POST_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`, [req.user.id, postId]);
      if (!row) return res.status(404).json({ error: 'Post not found.' });
      return res.json({ post: shapePost(row) });
    } catch (error) {
      console.error('Failed to load feed post:', error.message);
      return res.status(500).json({ error: 'Unable to load the post.' });
    }
  });

  // POST /api/feed/posts — publish a community post.
  app.post('/api/feed/posts', verifyToken, postRateLimit, async (req, res) => {
    const content = cleanText(req.body && req.body.content, 4000);
    if (!content) {
      return res.status(400).json({ error: 'Post content is required (1–4000 characters).' });
    }
    const imagePath = validateImagePath(req.body && req.body.imagePath);
    if (req.body && req.body.imagePath != null && !imagePath) {
      return res.status(400).json({ error: 'Image must be uploaded through the image endpoint first.' });
    }
    try {
      const now = Date.now();
      const result = await run(db, `
        INSERT INTO feed_posts (author_user_id, kind, content, image_path, created_at)
        VALUES (?, 'community', ?, ?, ?)
      `, [req.user.id, content, imagePath, now]);
      const row = await get(db, `${POST_SELECT} WHERE p.id = ?`, [req.user.id, result.lastID]);
      return res.status(201).json({ post: shapePost(row) });
    } catch (error) {
      console.error('Failed to create feed post:', error.message);
      return res.status(500).json({ error: 'Unable to publish the post.' });
    }
  });

  // PATCH /api/feed/posts/:id — edit an owned community post (admins may edit announcements too).
  app.patch('/api/feed/posts/:id', verifyToken, postRateLimit, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    const content = cleanText(req.body && req.body.content, 4000);
    if (!content) return res.status(400).json({ error: 'Post content is required (1–4000 characters).' });
    try {
      const existing = await get(db, 'SELECT author_user_id, kind FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [postId]);
      if (!existing) return res.status(404).json({ error: 'Post not found.' });
      if (existing.author_user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only edit your own posts.' });
      }
      await run(db, 'UPDATE feed_posts SET content = ?, updated_at = ? WHERE id = ?', [content, Date.now(), postId]);
      const row = await get(db, `${POST_SELECT} WHERE p.id = ?`, [req.user.id, postId]);
      return res.json({ post: shapePost(row) });
    } catch (error) {
      console.error('Failed to edit feed post:', error.message);
      return res.status(500).json({ error: 'Unable to edit the post.' });
    }
  });

  // DELETE /api/feed/posts/:id — soft-delete an owned community post.
  app.delete('/api/feed/posts/:id', verifyToken, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    try {
      const existing = await get(db, 'SELECT author_user_id FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [postId]);
      if (!existing) return res.status(404).json({ error: 'Post not found.' });
      if (existing.author_user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only delete your own posts.' });
      }
      await run(db, 'UPDATE feed_posts SET deleted_at = ? WHERE id = ?', [Date.now(), postId]);
      return res.json({ message: 'Post deleted.' });
    } catch (error) {
      console.error('Failed to delete feed post:', error.message);
      return res.status(500).json({ error: 'Unable to delete the post.' });
    }
  });


  const COMMENT_SELECT = `
    SELECT c.id, c.post_id, c.parent_id, c.content, c.created_at, c.updated_at,
           c.author_user_id, u.username AS author_username, av.file AS author_avatar
    FROM feed_comments c
    JOIN users u ON u.id = c.author_user_id
    LEFT JOIN user_avatars av ON av.user_id = c.author_user_id
  `;

  function shapeComment(row, viewerId) {
    return {
      id: row.id,
      postId: row.post_id,
      parentId: row.parent_id,
      content: row.content,
      createdAt: row.created_at,
      edited: Boolean(row.updated_at),
      author: { username: row.author_username, displayName: row.author_username, avatarUrl: avatarUrl(row.author_avatar) },
      canEdit: row.author_user_id === viewerId
    };
  }

  // GET /api/feed/posts/:id/comments?cursor=&limit= — top-level comments, newest first,
  // each with up to 3 newest replies nested (keeps one mobile-friendly level of depth).
  app.get('/api/feed/posts/:id/comments', verifyToken, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    const cursor = Number.parseInt(req.query.cursor, 10);
    const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit, 10) || 15));
    try {
      const post = await get(db, 'SELECT id FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [postId]);
      if (!post) return res.status(404).json({ error: 'Post not found.' });
      const params = [postId];
      let cursorSql = '';
      if (Number.isSafeInteger(cursor) && cursor > 0) {
        cursorSql = ' AND c.id < ?';
        params.push(cursor);
      }
      const rows = await all(db, `
        ${COMMENT_SELECT}
        WHERE c.post_id = ? AND c.parent_id IS NULL AND c.deleted_at IS NULL${cursorSql}
        ORDER BY c.id DESC LIMIT ?
      `, [...params, limit + 1]);
      const hasMore = rows.length > limit;
      const tops = rows.slice(0, limit);
      const comments = [];
      for (const top of tops) {
        const replies = await all(db, `
          ${COMMENT_SELECT}
          WHERE c.parent_id = ? AND c.deleted_at IS NULL
          ORDER BY c.id ASC LIMIT 3
        `, [top.id]);
        comments.push({ ...shapeComment(top, req.user.id), replies: replies.map(row => shapeComment(row, req.user.id)) });
      }
      return res.json({ comments, nextCursor: hasMore && tops.length ? tops[tops.length - 1].id : null });
    } catch (error) {
      console.error('Failed to list comments:', error.message);
      return res.status(500).json({ error: 'Unable to load comments.' });
    }
  });


  // POST /api/feed/posts/:id/comments — add a comment or a one-level reply.
  app.post('/api/feed/posts/:id/comments', verifyToken, commentRateLimit, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    const content = cleanText(req.body && req.body.content, 2000);
    if (!content) return res.status(400).json({ error: 'Comment text is required (1–2000 characters).' });
    let parentId = null;
    if (req.body && req.body.parentId != null) {
      parentId = Number.parseInt(req.body.parentId, 10);
      if (!Number.isSafeInteger(parentId) || parentId < 1) {
        return res.status(400).json({ error: 'Invalid reply identifier.' });
      }
    }
    try {
      const post = await get(db, 'SELECT id FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [postId]);
      if (!post) return res.status(404).json({ error: 'Post not found.' });
      if (parentId != null) {
        const parent = await get(db, 'SELECT id, post_id, parent_id FROM feed_comments WHERE id = ? AND deleted_at IS NULL', [parentId]);
        if (!parent || parent.post_id !== postId) {
          return res.status(400).json({ error: 'Reply target was not found on this post.' });
        }
        if (parent.parent_id != null) {
          parentId = parent.parent_id; // flatten: reply-to-reply attaches to the top comment
        }
      }
      const now = Date.now();
      const result = await run(db, `
        INSERT INTO feed_comments (post_id, author_user_id, parent_id, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [postId, req.user.id, parentId, content, now]);
      const row = await get(db, `${COMMENT_SELECT} WHERE c.id = ?`, [result.lastID]);
      const counts = await get(db, 'SELECT COUNT(*) AS count FROM feed_comments WHERE post_id = ? AND deleted_at IS NULL', [postId]);
      return res.status(201).json({ comment: shapeComment(row, req.user.id), commentCount: counts.count });
    } catch (error) {
      console.error('Failed to create comment:', error.message);
      return res.status(500).json({ error: 'Unable to post the comment.' });
    }
  });

  // PATCH /api/feed/comments/:id — edit an owned comment.
  app.patch('/api/feed/comments/:id', verifyToken, commentRateLimit, async (req, res) => {
    const commentId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      return res.status(400).json({ error: 'Invalid comment identifier.' });
    }
    const content = cleanText(req.body && req.body.content, 2000);
    if (!content) return res.status(400).json({ error: 'Comment text is required (1–2000 characters).' });
    try {
      const existing = await get(db, 'SELECT author_user_id FROM feed_comments WHERE id = ? AND deleted_at IS NULL', [commentId]);
      if (!existing) return res.status(404).json({ error: 'Comment not found.' });
      if (existing.author_user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only edit your own comments.' });
      }
      await run(db, 'UPDATE feed_comments SET content = ?, updated_at = ? WHERE id = ?', [content, Date.now(), commentId]);
      const row = await get(db, `${COMMENT_SELECT} WHERE c.id = ?`, [commentId]);
      return res.json({ comment: shapeComment(row, req.user.id) });
    } catch (error) {
      console.error('Failed to edit comment:', error.message);
      return res.status(500).json({ error: 'Unable to edit the comment.' });
    }
  });

  // DELETE /api/feed/comments/:id — soft-delete an owned comment.
  app.delete('/api/feed/comments/:id', verifyToken, async (req, res) => {
    const commentId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      return res.status(400).json({ error: 'Invalid comment identifier.' });
    }
    try {
      const existing = await get(db, 'SELECT author_user_id, post_id FROM feed_comments WHERE id = ? AND deleted_at IS NULL', [commentId]);
      if (!existing) return res.status(404).json({ error: 'Comment not found.' });
      if (existing.author_user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only delete your own comments.' });
      }
      await run(db, 'UPDATE feed_comments SET deleted_at = ? WHERE id = ?', [Date.now(), commentId]);
      const counts = await get(db, 'SELECT COUNT(*) AS count FROM feed_comments WHERE post_id = ? AND deleted_at IS NULL', [existing.post_id]);
      return res.json({ message: 'Comment deleted.', commentCount: counts.count });
    } catch (error) {
      console.error('Failed to delete comment:', error.message);
      return res.status(500).json({ error: 'Unable to delete the comment.' });
    }
  });


  // POST /api/feed/posts/:id/like — idempotent: unique (user_id, post_id) prevents duplicates.
  app.post('/api/feed/posts/:id/like', verifyToken, likeRateLimit, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    try {
      const post = await get(db, 'SELECT id FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [postId]);
      if (!post) return res.status(404).json({ error: 'Post not found.' });
      await run(db, 'INSERT OR IGNORE INTO feed_likes (user_id, post_id, created_at) VALUES (?, ?, ?)',
        [req.user.id, postId, Date.now()]);
      const counts = await get(db, 'SELECT COUNT(*) AS count FROM feed_likes WHERE post_id = ?', [postId]);
      return res.json({ liked: true, likeCount: counts.count });
    } catch (error) {
      console.error('Failed to like post:', error.message);
      return res.status(500).json({ error: 'Unable to like the post.' });
    }
  });

  // DELETE /api/feed/posts/:id/like — idempotent unlike.
  app.delete('/api/feed/posts/:id/like', verifyToken, likeRateLimit, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Invalid post identifier.' });
    }
    try {
      await run(db, 'DELETE FROM feed_likes WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);
      const counts = await get(db, 'SELECT COUNT(*) AS count FROM feed_likes WHERE post_id = ?', [postId]);
      return res.json({ liked: false, likeCount: counts.count });
    } catch (error) {
      console.error('Failed to unlike post:', error.message);
      return res.status(500).json({ error: 'Unable to update the reaction.' });
    }
  });

  // GET /api/feed/profile/:username — public community profile with post count and recent posts.
  app.get('/api/feed/profile/:username', verifyToken, async (req, res) => {
    const username = cleanText(req.params.username, 60);
    if (!username) return res.status(400).json({ error: 'Invalid username.' });
    try {
      const user = await get(db, `SELECT u.id, u.username, u.bio, u.created_at, av.file AS avatar_file
        FROM users u LEFT JOIN user_avatars av ON av.user_id = u.id
        WHERE u.username = ? COLLATE NOCASE`, [username]);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const stats = await get(db, `
        SELECT
          (SELECT COUNT(*) FROM feed_posts WHERE author_user_id = ? AND deleted_at IS NULL) AS post_count,
          (SELECT COUNT(*) FROM feed_comments WHERE author_user_id = ? AND deleted_at IS NULL) AS comment_count
      `, [user.id, user.id]);
      const rows = await all(db, `
        ${POST_SELECT} WHERE p.author_user_id = ? AND p.deleted_at IS NULL
        ORDER BY p.id DESC LIMIT 20
      `, [req.user.id, user.id]);
      return res.json({
        profile: {
          username: user.username,
          displayName: user.username,
          avatarUrl: avatarUrl(user.avatar_file),
          bio: user.bio,
          joinedAt: user.created_at,
          postCount: stats.post_count,
          commentCount: stats.comment_count
        },
        posts: rows.map(shapePost)
      });
    } catch (error) {
      console.error('Failed to load profile:', error.message);
      return res.status(500).json({ error: 'Unable to load the profile.' });
    }
  });

  // GET /api/feed/my-activity?cursor= — the viewer's own recent comments (for My Activity).
  app.get('/api/feed/my-activity', verifyToken, async (req, res) => {
    const cursor = Number.parseInt(req.query.cursor, 10);
    const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit, 10) || 20));
    try {
      const params = [req.user.id];
      let cursorSql = '';
      if (Number.isSafeInteger(cursor) && cursor > 0) {
        cursorSql = ' AND c.id < ?';
        params.push(cursor);
      }
      const rows = await all(db, `
        SELECT c.id, c.post_id, c.content, c.created_at, c.updated_at, p.content AS post_content
        FROM feed_comments c
        JOIN feed_posts p ON p.id = c.post_id AND p.deleted_at IS NULL
        WHERE c.author_user_id = ? AND c.deleted_at IS NULL${cursorSql}
        ORDER BY c.id DESC LIMIT ?
      `, [...params, limit + 1]);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(row => ({
        id: row.id,
        postId: row.post_id,
        content: row.content,
        createdAt: row.created_at,
        edited: Boolean(row.updated_at),
        postExcerpt: row.post_content.slice(0, 140)
      }));
      return res.json({ activity: items, nextCursor: hasMore && items.length ? items[items.length - 1].id : null });
    } catch (error) {
      console.error('Failed to load activity:', error.message);
      return res.status(500).json({ error: 'Unable to load your activity.' });
    }
  });


  // POST /api/feed/reports — flag a post or comment for administrator review.
  const reportRateLimit = rateLimit({ limit: 20, windowMs: 10 * 60 * 1000, message: 'Too many reports. Please wait before reporting again.' });
  app.post('/api/feed/reports', verifyToken, reportRateLimit, async (req, res) => {
    const targetType = req.body && req.body.targetType;
    if (targetType !== 'post' && targetType !== 'comment') {
      return res.status(400).json({ error: 'Report target must be a post or a comment.' });
    }
    const targetId = Number.parseInt(req.body && req.body.targetId, 10);
    if (!Number.isSafeInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Invalid report target.' });
    }
    const reason = cleanText(req.body && req.body.reason, 500);
    if (!reason) return res.status(400).json({ error: 'A report reason is required (1–500 characters).' });
    try {
      const table = targetType === 'post' ? 'feed_posts' : 'feed_comments';
      const target = await get(db, `SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`, [targetId]);
      if (!target) return res.status(404).json({ error: 'The reported content was not found.' });
      await run(db, `
        INSERT INTO feed_reports (reporter_user_id, target_type, target_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [req.user.id, targetType, targetId, reason, Date.now()]);
      return res.status(201).json({ message: 'Report submitted. An administrator will review it.' });
    } catch (error) {
      console.error('Failed to submit report:', error.message);
      return res.status(500).json({ error: 'Unable to submit the report.' });
    }
  });

  // ---------------- Administrator announcements (enforced by verifyAdminToken) ----------------
  const announcementRateLimit = rateLimit({ limit: 30, windowMs: 10 * 60 * 1000, message: 'Too many announcement changes. Please wait.' });

  function validateAnnouncement(body, { requireAll = true } = {}) {
    const title = body && body.title != null ? cleanText(body.title, 140) : undefined;
    const content = body && body.content != null ? cleanText(body.content, 8000) : undefined;
    if (requireAll) {
      if (!title) return { error: 'An announcement title is required (1–140 characters).' };
      if (!content) return { error: 'Announcement content is required (1–8000 characters).' };
    } else {
      if (body && body.title != null && !title) return { error: 'Announcement title is required (1–140 characters).' };
      if (body && body.content != null && !content) return { error: 'Announcement content is required (1–8000 characters).' };
    }
    return { title, content };
  }

  // GET /api/feed/announcements — list announcements for the admin composer.
  app.get('/api/feed/announcements', verifyAdminToken, async (req, res) => {
    try {
      const rows = await all(db, `
        SELECT id, title, content, image_path, is_pinned, created_at, updated_at, deleted_at
        FROM feed_posts WHERE kind = 'announcement' AND deleted_at IS NULL
        ORDER BY is_pinned DESC, id DESC LIMIT 100
      `);
      return res.json({
        announcements: rows.map(row => ({
          id: row.id,
          title: row.title,
          content: row.content,
          imagePath: row.image_path,
          isPinned: Boolean(row.is_pinned),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deleted: Boolean(row.deleted_at)
        }))
      });
    } catch (error) {
      console.error('Failed to list announcements:', error.message);
      return res.status(500).json({ error: 'Unable to load announcements.' });
    }
  });


  // POST /api/feed/announcements — publish an official announcement.
  app.post('/api/feed/announcements', verifyAdminToken, announcementRateLimit, async (req, res) => {
    const { title, content, error } = validateAnnouncement(req.body);
    if (error) return res.status(400).json({ error });
    const imagePath = validateImagePath(req.body && req.body.imagePath);
    if (req.body && req.body.imagePath != null && !imagePath) {
      return res.status(400).json({ error: 'Image must be uploaded through the image endpoint first.' });
    }
    const isPinned = Boolean(req.body && req.body.isPinned);
    try {
      const now = Date.now();
      const result = await run(db, `
        INSERT INTO feed_posts (author_user_id, kind, title, content, image_path, is_pinned, created_at)
        VALUES (NULL, 'announcement', ?, ?, ?, ?, ?)
      `, [title, content, imagePath, isPinned, now]);
      return res.status(201).json({ announcementId: result.lastID, message: 'Announcement published.' });
    } catch (dbError) {
      console.error('Failed to publish announcement:', dbError.message);
      return res.status(500).json({ error: 'Unable to publish the announcement.' });
    }
  });

  // PATCH /api/feed/announcements/:id — edit and/or pin/unpin an announcement.
  app.patch('/api/feed/announcements/:id', verifyAdminToken, announcementRateLimit, async (req, res) => {
    const announcementId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(announcementId) || announcementId < 1) {
      return res.status(400).json({ error: 'Invalid announcement identifier.' });
    }
    const { title, content, error } = validateAnnouncement(req.body, { requireAll: false });
    if (error) return res.status(400).json({ error });
    const hasPin = req.body && (req.body.isPinned === true || req.body.isPinned === false);
    try {
      const existing = await get(db, 'SELECT id FROM feed_posts WHERE id = ? AND kind = ? AND deleted_at IS NULL', [announcementId, 'announcement']);
      if (!existing) return res.status(404).json({ error: 'Announcement not found.' });
      const sets = [];
      const params = [];
      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (content !== undefined) { sets.push('content = ?'); params.push(content); }
      if (hasPin) { sets.push('is_pinned = ?'); params.push(Boolean(req.body.isPinned)); }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
      sets.push('updated_at = ?');
      params.push(Date.now());
      params.push(announcementId);
      await run(db, `UPDATE feed_posts SET ${sets.join(', ')} WHERE id = ?`, params);
      return res.json({ message: 'Announcement updated.' });
    } catch (dbError) {
      console.error('Failed to update announcement:', dbError.message);
      return res.status(500).json({ error: 'Unable to update the announcement.' });
    }
  });


  // DELETE /api/feed/announcements/:id — soft-delete an announcement.
  app.delete('/api/feed/announcements/:id', verifyAdminToken, announcementRateLimit, async (req, res) => {
    const announcementId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(announcementId) || announcementId < 1) {
      return res.status(400).json({ error: 'Invalid announcement identifier.' });
    }
    try {
      const existing = await get(db, 'SELECT id FROM feed_posts WHERE id = ? AND kind = ? AND deleted_at IS NULL', [announcementId, 'announcement']);
      if (!existing) return res.status(404).json({ error: 'Announcement not found.' });
      await run(db, 'UPDATE feed_posts SET deleted_at = ? WHERE id = ?', [Date.now(), announcementId]);
      return res.json({ message: 'Announcement removed from the feed.' });
    } catch (dbError) {
      console.error('Failed to delete announcement:', dbError.message);
      return res.status(500).json({ error: 'Unable to delete the announcement.' });
    }
  });

  // DELETE /api/feed/admin/content/:kind/:id — moderator removal of any post or comment.
  app.delete('/api/feed/admin/content/:kind/:id', verifyAdminToken, announcementRateLimit, async (req, res) => {
    const kind = req.params.kind;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!['posts', 'comments'].includes(kind) || !Number.isSafeInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Invalid moderation target.' });
    }
    const table = kind === 'posts' ? 'feed_posts' : 'feed_comments';
    try {
      const result = await run(db, `UPDATE ${table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [Date.now(), targetId]);
      if (result.changes !== 1) return res.status(404).json({ error: 'Content not found.' });
      return res.json({ message: 'Content removed from the feed.' });
    } catch (dbError) {
      console.error('Failed to moderate content:', dbError.message);
      return res.status(500).json({ error: 'Unable to remove the content.' });
    }
  });

  // GET /api/feed/admin/reports — open moderation reports with content previews.
  app.get('/api/feed/admin/reports', verifyAdminToken, async (req, res) => {
    try {
      const rows = await all(db, `
        SELECT r.id, r.target_type, r.target_id, r.reason, r.created_at,
               u.username AS reporter_username,
               CASE WHEN r.target_type = 'post' THEN (SELECT substr(p.content, 1, 200) FROM feed_posts p WHERE p.id = r.target_id)
                    ELSE (SELECT substr(c.content, 1, 200) FROM feed_comments c WHERE c.id = r.target_id) END AS preview
        FROM feed_reports r
        JOIN users u ON u.id = r.reporter_user_id
        WHERE r.resolved_at IS NULL
        ORDER BY r.id DESC LIMIT 100
      `);
      return res.json({
        reports: rows.map(row => ({
          id: row.id,
          targetType: row.target_type,
          targetId: row.target_id,
          reason: row.reason,
          preview: row.preview,
          reporter: row.reporter_username,
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('Failed to list reports:', error.message);
      return res.status(500).json({ error: 'Unable to load reports.' });
    }
  });

  // POST /api/feed/admin/reports/:id/resolve — mark a report handled.
  app.post('/api/feed/admin/reports/:id/resolve', verifyAdminToken, async (req, res) => {
    const reportId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(reportId) || reportId < 1) {
      return res.status(400).json({ error: 'Invalid report identifier.' });
    }
    try {
      const result = await run(db, 'UPDATE feed_reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', [Date.now(), reportId]);
      if (result.changes !== 1) return res.status(404).json({ error: 'Report not found or already resolved.' });
      return res.json({ message: 'Report resolved.' });
    } catch (dbError) {
      console.error('Failed to resolve report:', dbError.message);
      return res.status(500).json({ error: 'Unable to resolve the report.' });
    }
  });
}

module.exports = registerFeedApi;

