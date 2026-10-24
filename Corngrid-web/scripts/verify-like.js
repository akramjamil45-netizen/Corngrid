'use strict';
// End-to-end like-flow verification on the running server. Restores the
// original like state afterwards, so production data is left unchanged.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const user = (await pg.query('SELECT id, email, username FROM users ORDER BY id LIMIT 1')).rows[0];
  const post = (await pg.query("SELECT id FROM feed_posts WHERE deleted_at IS NULL ORDER BY id LIMIT 1")).rows[0];
  await pg.end();
  if (!user || !post) { console.log('No user/post to test with.'); process.exit(1); }

  const token = jwt.sign({ id: user.id, email: user.email, username: user.username, authVersion: 0 },
    process.env.JWT_SECRET, { expiresIn: '2m' });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = 'http://localhost:3000';

  const state = await fetch(`${base}/api/feed/posts/${post.id}`, { headers }).then(r => r.json());
  const originallyLiked = Boolean(state.post && state.post.likedByMe);
  const originalCount = state.post ? state.post.likeCount : null;
  console.log(`before: likedByMe=${state.post.likedByMe} likeCount=${originalCount}`);

  if (!originallyLiked) {
    const like = await fetch(`${base}/api/feed/posts/${post.id}/like`, { method: 'POST', headers }).then(r => r.json());
    console.log(`POST like: liked=${like.liked} likeCount=${like.likeCount}`);
    const after = await fetch(`${base}/api/feed/posts/${post.id}`, { headers }).then(r => r.json());
    console.log(`after like: likedByMe=${after.post.likedByMe} likeCount=${after.post.likeCount}`);
    console.log(after.post.likedByMe === true && after.post.likeCount === originalCount + 1
      ? 'LIKE RECORDED CORRECTLY' : 'LIKE STILL BROKEN');
    // restore
    await fetch(`${base}/api/feed/posts/${post.id}/like`, { method: 'DELETE', headers });
    const restored = await fetch(`${base}/api/feed/posts/${post.id}`, { headers }).then(r => r.json());
    console.log(`restored: likedByMe=${restored.post.likedByMe} likeCount=${restored.post.likeCount}`);
  } else {
    console.log('User already liked this post; toggling off and back on to verify.');
    const unlike = await fetch(`${base}/api/feed/posts/${post.id}/like`, { method: 'DELETE', headers }).then(r => r.json());
    const mid = await fetch(`${base}/api/feed/posts/${post.id}`, { headers }).then(r => r.json());
    console.log(`after unlike: liked=${unlike.liked} likedByMe=${mid.post.likedByMe} likeCount=${mid.post.likeCount}`);
    await fetch(`${base}/api/feed/posts/${post.id}/like`, { method: 'POST', headers });
    const restored = await fetch(`${base}/api/feed/posts/${post.id}`, { headers }).then(r => r.json());
    console.log(`restored: likedByMe=${restored.post.likedByMe} likeCount=${restored.post.likeCount}`);
    console.log(mid.post.likedByMe === false && restored.post.likedByMe === true
      ? 'LIKE FLOW WORKS CORRECTLY' : 'LIKE STILL BROKEN');
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
