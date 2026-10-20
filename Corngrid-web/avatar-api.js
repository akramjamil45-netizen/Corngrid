'use strict';

// Profile photos: one row per user (user_avatars), files stored outside /public and served only
// through a strict filename route. Uploads are validated and metadata-stripped server-side; every
// upload gets a new random filename, which doubles as cache busting.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const AVATAR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_avatars (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    file TEXT NOT NULL UNIQUE,
    updated_at INTEGER NOT NULL
  );
`;
const FILE_PATTERN = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const MIME = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const CONTENT_TYPE = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

function avatarUrl(file) {
  return typeof file === 'string' && FILE_PATTERN.test(file) ? `/uploads/avatars/${file}` : null;
}

class ImageError extends Error {}
const fail = message => { throw new ImageError(message); };

// Returns a metadata-free copy of the JPEG plus its dimensions.
function processJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) fail('Not a valid JPEG image.');
  const parts = [buf.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset < buf.length) {
    if (buf[offset] !== 0xFF) fail('Corrupt JPEG data.');
    while (buf[offset] === 0xFF) offset += 1;
    const marker = buf[offset];
    offset += 1;
    if (marker === 0xD9) { parts.push(Buffer.from([0xFF, 0xD9])); offset = buf.length; break; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { parts.push(Buffer.from([0xFF, marker])); continue; }
    if (offset + 2 > buf.length) fail('Corrupt JPEG data.');
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) fail('Corrupt JPEG data.');
    const segment = buf.subarray(offset - 2, offset + length);
    const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSof) {
      if (length < 8) fail('Corrupt JPEG data.');
      height = buf.readUInt16BE(offset + 3);
      width = buf.readUInt16BE(offset + 5);
    }
    const metadata = (marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE;
    if (!metadata) parts.push(segment);
    offset += length;
    if (marker === 0xDA) {
      if (!width) fail('Corrupt JPEG data.');
      parts.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
  }
  if (!width || !height) fail('Could not read the JPEG dimensions.');
  return { ext: 'jpg', width, height, data: Buffer.concat(parts) };
}

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB']);
function processPng(buf) {
  if (buf.length < 33 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('Not a valid PNG image.');
  const parts = [buf.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIend = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buf.length) fail('Corrupt PNG data.');
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) fail('Corrupt PNG data.');
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    }
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend || !width || !height) fail('Corrupt PNG data.');
  return { ext: 'png', width, height, data: Buffer.concat(parts) };
}

function processWebp(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') fail('Not a valid WebP image.');
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = [];
  let offset = 12;
  let width = 0;
  let height = 0;
  while (offset + 8 <= riffEnd) {
    const type = buf.toString('ascii', offset, offset + 4);
    const length = buf.readUInt32LE(offset + 4);
    const padded = length + (length % 2);
    if (offset + 8 + length > riffEnd) fail('Corrupt WebP data.');
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'VP8X') {
      if (length < 10) fail('Corrupt WebP data.');
      if (body[0] & 0x02) fail('Animated WebP images are not supported.');
      width = 1 + (body[4] | (body[5] << 8) | (body[6] << 16));
      height = 1 + (body[7] | (body[8] << 8) | (body[9] << 16));
      const cleaned = Buffer.from(body);
      cleaned[0] &= ~(0x20 | 0x08 | 0x04); // drop ICC, EXIF, XMP flags
      chunks.push({ type, body: cleaned });
    } else if (type === 'VP8 ') {
      if (length < 10 || body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) fail('Corrupt WebP data.');
      if (!width) { width = body.readUInt16LE(6) & 0x3FFF; height = body.readUInt16LE(8) & 0x3FFF; }
      chunks.push({ type, body });
    } else if (type === 'VP8L') {
      if (length < 5 || body[0] !== 0x2f) fail('Corrupt WebP data.');
      if (!width) { const bits = body.readUInt32LE(1); width = (bits & 0x3FFF) + 1; height = ((bits >>> 14) & 0x3FFF) + 1; }
      chunks.push({ type, body });
    } else if (type === 'ALPH') {
      chunks.push({ type, body });
    }
    offset += 8 + padded;
  }
  if (!width || !height || !chunks.some(chunk => chunk.type === 'VP8 ' || chunk.type === 'VP8L')) fail('Could not read the WebP image.');
  const payload = chunks.map(({ type, body }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  });
  const total = 4 + payload.reduce((sum, part) => sum + part.length, 0);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(total, 4);
  head.write('WEBP', 8, 'ascii');
  return { ext: 'webp', width, height, data: Buffer.concat([head, ...payload]) };
}

function processImage(buf, declaredExt, { minSide, maxSide }) {
  const result = declaredExt === 'jpg' ? processJpeg(buf) : declaredExt === 'png' ? processPng(buf) : processWebp(buf);
  if (result.width < minSide || result.height < minSide) fail(`The image must be at least ${minSide}x${minSide} pixels.`);
  if (result.width > maxSide || result.height > maxSide) fail(`The image must be no larger than ${maxSide}x${maxSide} pixels.`);
  return result;
}

function createLimiter({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 1000) for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key);
    const key = String(req.user.id);
    const bucket = buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) { buckets.set(key, { count: 1, expiresAt: now + windowMs }); return next(); }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.expiresAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many photo changes. Please wait a few minutes.' });
    }
    return next();
  };
}

const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (e) { return e ? reject(e) : resolve({ changes: this.changes }); }));
const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || [])));

function registerAvatarApi(app, db, verifyToken, options = {}) {
  const dir = options.avatarDir || process.env.AVATAR_DIR || path.join(__dirname, 'storage', 'avatars');
  const maxBytes = options.maxBytes || Number(process.env.AVATAR_MAX_BYTES) || 5 * 1024 * 1024;
  const maxSide = options.maxSide || Number(process.env.AVATAR_MAX_DIMENSION) || 2048;
  const minSide = 16;
  fs.mkdirSync(dir, { recursive: true });
  db.exec(AVATAR_SCHEMA, error => { if (error) console.error('Unable to initialize avatar storage table:', error.message); });

  const writeLimit = createLimiter({ limit: options.writeLimit || 10, windowMs: 10 * 60 * 1000 });

  const removeFile = file => {
    if (!FILE_PATTERN.test(file)) return;
    fs.unlink(path.join(dir, file), error => {
      if (error && error.code !== 'ENOENT') console.error('Unable to remove an avatar file:', error.message);
    });
  };

  // Files left behind by account deletion or failed writes are removed once they are unreferenced.
  async function sweepOrphans() {
    try {
      const used = new Set((await all(db, 'SELECT file FROM user_avatars')).map(row => row.file));
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const name of fs.readdirSync(dir)) {
        if (!FILE_PATTERN.test(name) || used.has(name)) continue;
        if (fs.statSync(path.join(dir, name)).mtimeMs < cutoff) removeFile(name);
      }
    } catch (error) {
      console.error('Avatar cleanup failed:', error.message);
    }
  }
  const sweepTimer = setInterval(sweepOrphans, 60 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
  setTimeout(sweepOrphans, 15_000).unref?.();

  app.get('/uploads/avatars/:filename', (req, res) => {
    const { filename } = req.params;
    if (!FILE_PATTERN.test(filename)) return res.status(404).end();
    res.set({
      'Content-Type': CONTENT_TYPE[filename.split('.')[1]],
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    return res.sendFile(filename, { root: dir, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.status(error.statusCode === 404 || error.code === 'ENOENT' ? 404 : 500).end();
    });
  });

  const rawBody = express.raw({ type: Object.keys(MIME), limit: maxBytes });
  const bodyErrors = (error, req, res, next) => {
    if (!error) return next();
    if (error.type === 'entity.too.large' || error.status === 413) return res.status(413).json({ error: `The image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.` });
    return res.status(400).json({ error: 'The upload could not be read.' });
  };

  // PUT /api/user/avatar — raw JPEG/PNG/WebP body; ownership always comes from the session.
  app.put('/api/user/avatar', verifyToken, writeLimit, rawBody, bodyErrors, async (req, res) => {
    const declared = MIME[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
    if (!declared || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(415).json({ error: 'Upload a JPEG, PNG, or WebP image.' });
    }
    let image;
    try {
      image = processImage(req.body, declared, { minSide, maxSide });
    } catch (error) {
      if (error instanceof ImageError) return res.status(400).json({ error: error.message });
      console.error('Avatar processing failed:', error.message);
      return res.status(400).json({ error: 'The image could not be processed.' });
    }
    const file = `${crypto.randomBytes(16).toString('hex')}.${image.ext}`;
    const now = Date.now();
    try {
      fs.writeFileSync(path.join(dir, file), image.data, { flag: 'wx', mode: 0o640 });
      const previous = await get(db, 'SELECT file FROM user_avatars WHERE user_id = ?', [req.user.id]);
      await run(db, `
        INSERT INTO user_avatars (user_id, file, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET file = excluded.file, updated_at = excluded.updated_at
      `, [req.user.id, file, now]);
      if (previous && previous.file !== file) removeFile(previous.file);
      return res.status(200).json({ avatarUrl: avatarUrl(file), updatedAt: now, message: 'Profile photo updated.' });
    } catch (error) {
      removeFile(file);
      console.error('Failed to save the profile photo:', error.message);
      return res.status(500).json({ error: 'Unable to save the profile photo.' });
    }
  });

  app.delete('/api/user/avatar', verifyToken, writeLimit, async (req, res) => {
    try {
      const previous = await get(db, 'SELECT file FROM user_avatars WHERE user_id = ?', [req.user.id]);
      if (previous) {
        await run(db, 'DELETE FROM user_avatars WHERE user_id = ?', [req.user.id]);
        removeFile(previous.file);
      }
      return res.json({ avatarUrl: null, message: 'Profile photo removed.' });
    } catch (error) {
      console.error('Failed to remove the profile photo:', error.message);
      return res.status(500).json({ error: 'Unable to remove the profile photo.' });
    }
  });

  return { sweepOrphans, close: () => clearInterval(sweepTimer), dir };
}

module.exports = registerAvatarApi;
module.exports.AVATAR_SCHEMA = AVATAR_SCHEMA;
module.exports.avatarUrl = avatarUrl;
module.exports.processImage = processImage;
