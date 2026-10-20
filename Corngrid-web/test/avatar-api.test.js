const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { PNG } = require('pngjs');
const registerAvatarApi = require('../avatar-api');
const registerFeedApi = require('../feed-api');
const registerChatApi = require('../chat-api');
const registerMt5Api = require('../mt5-api');

function pngBytes(size = 32) {
  const png = new PNG({ width: size, height: size });
  png.data.fill(200);
  return PNG.sync.write(png);
}

// Structurally valid JPEG (SOF + SOS) carrying EXIF with fake GPS text that must be stripped.
function jpegWithExif(width = 40, height = 40) {
  const exif = Buffer.concat([Buffer.from([0xFF, 0xE1, 0x00, 0x20]), Buffer.from('Exif\0\0GPSLatitude=1.23456;ZZ', 'latin1')]);
  exif.writeUInt16BE(exif.length - 2, 2);
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x0B, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x12, 0x34, 0xFF, 0xD9]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46]), exif, sof, sos]);
}

function webpWithExif(width = 40, height = 40) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08; // EXIF flag set
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const vp8l = Buffer.alloc(9);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8x), chunk('EXIF', Buffer.from('GPSLatitude=9.87654', 'latin1')), chunk('VP8L', vp8l)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

async function setup({ maxBytes } = {}) {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, email TEXT, password TEXT, bio TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE password_reset_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER, used_at INTEGER, created_at INTEGER);
    INSERT INTO users (id, username, email, password) VALUES (1, 'Alice', 'a@t.test', 'x'), (2, 'Bob', 'b@t.test', 'x'), (3, 'Cara', 'c@t.test', 'x');
  `, error => error ? reject(error) : resolve()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-avatars-'));
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-feed-'));
  const app = express();
  app.use(express.json());
  const verifyToken = (req, res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (!id) return res.status(401).json({ error: 'Access denied.' });
    req.user = { id };
    return next();
  };
  const avatars = registerAvatarApi(app, db, verifyToken, { avatarDir: dir, maxBytes: maxBytes || 5 * 1024 * 1024, writeLimit: 50 });
  registerMt5Api(app, db, verifyToken);
  registerChatApi(app, db, verifyToken);
  registerFeedApi(app, db, verifyToken, verifyToken, { uploadDir });
  await new Promise(resolve => setTimeout(resolve, 100));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { user, body, type, json } = {}) => fetch(`${base}${url}`, {
    method,
    headers: { ...(user ? { 'x-test-user': String(user) } : {}), ...(type ? { 'Content-Type': type } : json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : body
  });
  const close = () => { avatars.close(); return new Promise(resolve => server.close(resolve)); };
  return { db, dir, call, close };
}

const dbGet = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));
const dbRun = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (e) { return e ? reject(e) : resolve(this.lastID); }));

test('authenticated users can upload, replace, and remove only their own avatar', async () => {
  const { db, dir, call, close } = await setup();
  try {
    assert.equal((await call('PUT', '/api/user/avatar', { body: pngBytes(), type: 'image/png' })).status, 401, 'visitors cannot upload');

    const first = await call('PUT', '/api/user/avatar', { user: 1, body: pngBytes(), type: 'image/png' });
    assert.equal(first.status, 200);
    const { avatarUrl } = await first.json();
    assert.match(avatarUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.png$/);
    const served = await call('GET', avatarUrl);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(fs.readdirSync(dir).length, 1);

    // Another user's upload never touches user 1.
    const other = await (await call('PUT', '/api/user/avatar', { user: 2, body: pngBytes(), type: 'image/png' })).json();
    assert.notEqual(other.avatarUrl, avatarUrl);
    assert.equal((await dbGet(db, 'SELECT file FROM user_avatars WHERE user_id = 1')).file, avatarUrl.split('/').pop());

    // Replacing swaps the file and deletes the old one.
    const replaced = await (await call('PUT', '/api/user/avatar', { user: 1, body: jpegWithExif(), type: 'image/jpeg' })).json();
    assert.notEqual(replaced.avatarUrl, avatarUrl);
    assert.equal((await call('GET', avatarUrl)).status, 404);
    assert.equal(fs.readdirSync(dir).length, 2);

    const removed = await call('DELETE', '/api/user/avatar', { user: 1 });
    assert.equal(removed.status, 200);
    assert.equal(await dbGet(db, 'SELECT file FROM user_avatars WHERE user_id = 1'), undefined);
    assert.equal(fs.readdirSync(dir).length, 1, 'only the other user file remains');
    assert.equal((await call('DELETE', '/api/user/avatar', { user: 1 })).status, 200, 'removal is idempotent');
    assert.equal((await call('DELETE', '/api/user/avatar')).status, 401);
  } finally { await close(); }
});

test('oversized, disguised, and unsupported uploads are rejected', async () => {
  const { dir, call, close } = await setup({ maxBytes: 2000 });
  try {
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: Buffer.alloc(5000, 1), type: 'image/png' })).status, 413);
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/png' })).status, 400);
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml' })).status, 415);
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: Buffer.from('MZ\x90\x00'), type: 'application/octet-stream' })).status, 415);
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: pngBytes(), type: 'image/jpeg' })).status, 400, 'PNG data declared as JPEG');
    // Tiny and huge dimensions.
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: pngBytes(8), type: 'image/png' })).status, 400);
    const big = Buffer.from(pngBytes(32));
    big.writeUInt32BE(5000, 16);
    big.writeUInt32BE(5000, 20);
    assert.equal((await call('PUT', '/api/user/avatar', { user: 1, body: big, type: 'image/png' })).status, 400);
    assert.equal(fs.readdirSync(dir).length, 0, 'nothing stored for rejected uploads');
  } finally { await close(); }
});

test('metadata is stripped from JPEG and WebP and path traversal is blocked', async () => {
  const { dir, call, close } = await setup();
  try {
    const jpeg = await (await call('PUT', '/api/user/avatar', { user: 1, body: jpegWithExif(), type: 'image/jpeg' })).json();
    const jpegStored = fs.readFileSync(path.join(dir, jpeg.avatarUrl.split('/').pop()));
    assert.ok(!jpegStored.includes('GPSLatitude') && !jpegStored.includes('Exif'));
    assert.equal(jpegStored[0], 0xFF);

    const webp = await (await call('PUT', '/api/user/avatar', { user: 2, body: webpWithExif(), type: 'image/webp' })).json();
    const webpStored = fs.readFileSync(path.join(dir, webp.avatarUrl.split('/').pop()));
    assert.ok(!webpStored.includes('GPSLatitude') && !webpStored.includes('EXIF'));
    assert.equal(webpStored.toString('ascii', 0, 4), 'RIFF');
    assert.equal(webpStored.readUInt32LE(4), webpStored.length - 8);

    for (const attempt of ['/uploads/avatars/..%2f..%2fserver.js', '/uploads/avatars/../../package.json', '/uploads/avatars/abc.png']) {
      assert.equal((await call('GET', attempt)).status, 404, attempt);
    }
  } finally { await close(); }
});

test('avatars appear with the real author in feed posts, comments, replies, chat, and /api/me; old users fall back to null', async () => {
  const { db, call, close } = await setup();
  try {
    const alice = await (await call('PUT', '/api/user/avatar', { user: 1, body: pngBytes(), type: 'image/png' })).json();
    const now = Date.now();
    const post = await dbRun(db, "INSERT INTO feed_posts (author_user_id, kind, content, created_at) VALUES (1, 'community', 'hello', ?)", [now]);
    const top = await dbRun(db, 'INSERT INTO feed_comments (post_id, author_user_id, content, created_at) VALUES (?, 1, ?, ?)', [post, 'top', now]);
    await dbRun(db, 'INSERT INTO feed_comments (post_id, author_user_id, parent_id, content, created_at) VALUES (?, 2, ?, ?, ?)', [post, top, 'reply', now]);
    await dbRun(db, "INSERT INTO feed_posts (author_user_id, kind, content, created_at) VALUES (2, 'community', 'bob post', ?)", [now]);
    await dbRun(db, 'INSERT INTO direct_messages (sender_id, recipient_id, message, created_at) VALUES (1, 3, ?, ?)', ['hi cara', now]);

    const feed = await (await call('GET', '/api/feed', { user: 3 })).json();
    const alicePost = feed.posts.find(item => item.author.username === 'Alice');
    const bobPost = feed.posts.find(item => item.author.username === 'Bob');
    assert.equal(alicePost.author.avatarUrl, alice.avatarUrl);
    assert.equal(bobPost.author.avatarUrl, null, 'user without a photo uses the fallback');

    const comments = await (await call('GET', `/api/feed/posts/${post}/comments`, { user: 3 })).json();
    assert.equal(comments.comments[0].author.avatarUrl, alice.avatarUrl);
    assert.equal(comments.comments[0].replies[0].author.avatarUrl, null);

    const conversations = await (await call('GET', '/api/chat/conversations', { user: 3 })).json();
    assert.equal(conversations.conversations[0].avatarUrl, alice.avatarUrl);
    const history = await (await call('GET', '/api/chat/messages/1', { user: 3 })).json();
    assert.equal(history.peer.avatarUrl, alice.avatarUrl);
    const users = await (await call('GET', '/api/chat/users?search=ali', { user: 3 })).json();
    assert.equal(users.users[0].avatarUrl, alice.avatarUrl);

    const me = await (await call('GET', '/api/me', { user: 1 })).json();
    assert.equal(me.avatarUrl, alice.avatarUrl);
    const meOther = await (await call('GET', '/api/me', { user: 3 })).json();
    assert.equal(meOther.avatarUrl, null);

    // A new photo is reflected everywhere without touching old content.
    const updated = await (await call('PUT', '/api/user/avatar', { user: 1, body: pngBytes(48), type: 'image/png' })).json();
    const feedAfter = await (await call('GET', '/api/feed', { user: 3 })).json();
    assert.equal(feedAfter.posts.find(item => item.author.username === 'Alice').author.avatarUrl, updated.avatarUrl);

    // Editing a comment cannot change its author or supply an avatar.
    const edit = await call('PATCH', `/api/feed/comments/${top}`, { user: 1, json: { content: 'edited', avatarUrl: '/uploads/avatars/evil.png', author_user_id: 2 } });
    assert.equal(edit.status, 200);
    assert.equal((await dbGet(db, 'SELECT author_user_id FROM feed_comments WHERE id = ?', [top])).author_user_id, 1);
  } finally { await close(); }
});
