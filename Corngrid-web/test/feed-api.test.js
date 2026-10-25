const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const registerFeedApi = require('../feed-api');
const createUserAuth = require('../user-auth');

function stubAdminAuth(req, res, next) {
  if (req.headers['x-admin'] !== 'yes') {
    return res.status(403).json({ error: 'Administrator session is invalid or has expired.' });
  }
  req.admin = true;
  return next();
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  return app;
}

test('Community feed: posts, comments, likes, profiles, and admin announcements', async () => {
  const db = new sqlite3.Database(':memory:');
  const jwtSecret = 'test-signing-secret-for-feed';
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE,
      email TEXT,
      password TEXT,
      bio TEXT DEFAULT '',
      created_at TEXT
    );
    CREATE TABLE user_auth_versions (user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users (id, username, email, password, created_at) VALUES
      (1, 'Alice', 'alice@t.test', 'x', '2026-01-01'),
      (2, 'Bob', 'bob@t.test', 'x', '2026-02-01');
  `, error => error ? reject(error) : resolve()));

  const app = buildApp(db);
  const verifyToken = createUserAuth({ db, jwtSecret });
  registerFeedApi(app, db, verifyToken, stubAdminAuth);
  await new Promise((resolve, reject) => db.get('SELECT 1', error => error ? reject(error) : resolve()));

  const server = await new Promise(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const aliceToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const bobToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);
  const request = (path, token, options = {}) => fetch(origin + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.admin ? { 'X-Admin': 'yes' } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });

  try {
    assert.equal((await request('/api/feed')).status, 401, 'feed requires authentication');

    // --- Post creation and validation ---
    assert.equal((await request('/api/feed/posts', aliceToken, { method: 'POST', body: JSON.stringify({ content: '   ' }) })).status, 400, 'empty posts are rejected');
    assert.equal((await request('/api/feed/posts', aliceToken, { method: 'POST', body: JSON.stringify({ content: 'x'.repeat(4001) }) })).status, 400, 'oversized posts are rejected');
    assert.equal((await request('/api/feed/posts', aliceToken, { method: 'POST', body: JSON.stringify({ content: 'Hi', imagePath: '/etc/passwd' }) })).status, 400, 'arbitrary image paths are rejected');

    const created = await request('/api/feed/posts', aliceToken, { method: 'POST', body: JSON.stringify({ content: 'First community post from Alice' }) });
    assert.equal(created.status, 201);
    const post1 = (await created.json()).post;
    assert.equal(post1.kind, 'community');
    assert.equal(post1.author.username, 'Alice');
    assert.equal(post1.likeCount, 0);
    assert.equal(post1.commentCount, 0);
    assert.equal(post1.likedByMe, false);

    // Announcements cannot be created by regular users through the post endpoint.
    const fakeAnnouncement = await request('/api/feed/posts', aliceToken, {
      method: 'POST', body: JSON.stringify({ content: 'Fake official post', kind: 'announcement' })
    });
    assert.equal(fakeAnnouncement.status, 201, 'client-supplied kind is ignored');
    assert.equal((await fakeAnnouncement.json()).post.kind, 'community', 'users can never create announcements');

    await request('/api/feed/posts', bobToken, { method: 'POST', body: JSON.stringify({ content: 'Bob shares a market observation' }) });

    // --- Feed filters and cursor pagination ---
    const latest = await (await request('/api/feed?filter=latest&limit=1', aliceToken)).json();
    assert.equal(latest.posts.length, 1, 'limit=1 returns one post');
    assert.ok(latest.nextCursor, 'a cursor is returned when more posts exist');
    const page2 = await (await request(`/api/feed?filter=latest&limit=1&cursor=${latest.nextCursor}`, aliceToken)).json();
    assert.notEqual(page2.posts[0].id, latest.posts[0].id, 'cursor advances without duplicates');
    const mine = await (await request('/api/feed?filter=mine', aliceToken)).json();
    assert.ok(mine.posts.every(post => post.author.username === 'Alice'), 'mine filter returns only own posts');
    const popular = await (await request('/api/feed?filter=popular', aliceToken)).json();
    assert.ok(popular.posts.length >= 2, 'popular filter lists posts');

    // --- Editing and deleting: ownership enforced ---
    assert.equal((await request(`/api/feed/posts/${post1.id}`, bobToken, { method: 'PATCH', body: JSON.stringify({ content: 'hijack' }) })).status, 403, 'other users cannot edit');
    const edited = await request(`/api/feed/posts/${post1.id}`, aliceToken, { method: 'PATCH', body: JSON.stringify({ content: 'Edited community post from Alice' }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).post.edited, true, 'edited flag is set');
    assert.equal((await request(`/api/feed/posts/${post1.id}`, bobToken, { method: 'DELETE' })).status, 403, 'other users cannot delete');


    // --- Comments and replies ---
    const bobPosts = await (await request('/api/feed?filter=mine', bobToken)).json();
    const post2 = bobPosts.posts[0];
    assert.equal((await request(`/api/feed/posts/${post2.id}/comments`, bobToken, { method: 'POST', body: JSON.stringify({ content: '  ' }) })).status, 400, 'empty comments are rejected');
    const comment1 = await request(`/api/feed/posts/${post2.id}/comments`, aliceToken, { method: 'POST', body: JSON.stringify({ content: 'Nice setup on gold' }) });
    assert.equal(comment1.status, 201);
    const commentPayload = await comment1.json();
    assert.equal(commentPayload.commentCount, 1, 'comment count updates on create');
    const reply = await request(`/api/feed/posts/${post2.id}/comments`, bobToken, { method: 'POST', body: JSON.stringify({ content: 'Thanks!', parentId: commentPayload.comment.id }) });
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).comment.parentId, commentPayload.comment.id, 'reply links to parent');
    assert.equal((await request(`/api/feed/comments/${commentPayload.comment.id}`, bobToken, { method: 'PATCH', body: JSON.stringify({ content: 'hijack' }) })).status, 403, 'other users cannot edit comments');
    assert.equal((await request(`/api/feed/comments/${commentPayload.comment.id}`, bobToken, { method: 'DELETE' })).status, 403, 'other users cannot delete comments');

    const commentsList = await (await request(`/api/feed/posts/${post2.id}/comments`, aliceToken)).json();
    assert.equal(commentsList.comments.length, 1, 'top-level listing groups replies');
    assert.equal(commentsList.comments[0].replies.length, 1, 'reply is nested under parent');
    const freshPost = await (await request(`/api/feed/posts/${post2.id}`, aliceToken)).json();
    assert.equal(freshPost.post.commentCount, 2, 'comment count includes replies');

    // My Activity: assert on the comment's own content (never the post excerpt, which
    // may quote another author's name) and check before any deletion hides the comments.
    const activity = await (await request('/api/feed/my-activity', aliceToken)).json();
    assert.ok(activity.activity.some(item => item.content === 'Nice setup on gold'), 'my-activity returns the viewer\u2019s comments');
    assert.ok(!activity.activity.some(item => item.content === 'Thanks!'), 'activity excludes other users\u2019 comments');

    // --- Likes: idempotent, accurate counts ---
    assert.equal((await request(`/api/feed/posts/${post2.id}/like`, aliceToken, { method: 'POST' })).status, 200);
    const likeAgain = await (await request(`/api/feed/posts/${post2.id}/like`, aliceToken, { method: 'POST' })).json();
    assert.equal(likeAgain.likeCount, 1, 'repeated likes do not duplicate');
    assert.equal(likeAgain.liked, true);
    const likedView = await (await request(`/api/feed/posts/${post2.id}`, aliceToken)).json();
    assert.equal(likedView.post.likedByMe, true, 'likedByMe reflects the viewer');
    const unlike = await (await request(`/api/feed/posts/${post2.id}/like`, aliceToken, { method: 'DELETE' })).json();
    assert.equal(unlike.liked, false);
    assert.equal(unlike.likeCount, 0, 'unlike removes the reaction');


    // --- Admin announcements: only the admin token may create or manage them ---
    assert.equal((await request('/api/feed/announcements', aliceToken, { method: 'POST', body: JSON.stringify({ title: 'T', content: 'C' }) })).status, 403, 'users cannot publish announcements');
    assert.equal((await request('/api/feed/announcements', aliceToken)).status, 403, 'users cannot list announcements');
    const announcement = await request('/api/feed/announcements', null, {
      method: 'POST', admin: true, body: JSON.stringify({ title: 'EA v2.8 released', content: 'Faster sync and new presets.', isPinned: true })
    });
    assert.equal(announcement.status, 201);
    const announcementId = (await announcement.json()).announcementId;

    // Pinned announcement appears first in the latest feed, labelled as announcement.
    const feedWithAnnouncement = await (await request('/api/feed?filter=latest', aliceToken)).json();
    assert.equal(feedWithAnnouncement.posts[0].kind, 'announcement', 'pinned announcement is first');
    assert.equal(feedWithAnnouncement.posts[0].isPinned, true);
    assert.equal(feedWithAnnouncement.posts[0].title, 'EA v2.8 released');
    assert.equal(feedWithAnnouncement.posts[0].author.username, null, 'announcements have no user author');
    const announcementsOnly = await (await request('/api/feed?filter=announcements', aliceToken)).json();
    assert.ok(announcementsOnly.posts.every(post => post.kind === 'announcement'), 'announcements filter isolates announcements');

    // Users cannot edit or delete announcements; admins can pin/unpin, edit, delete.
    assert.equal((await request(`/api/feed/posts/${announcementId}`, aliceToken, { method: 'PATCH', body: JSON.stringify({ content: 'nope' }) })).status, 403);
    assert.equal((await request(`/api/feed/posts/${announcementId}`, aliceToken, { method: 'DELETE' })).status, 403);
    assert.equal((await request(`/api/feed/announcements/${announcementId}`, null, { method: 'PATCH', admin: true, body: JSON.stringify({ isPinned: false }) })).status, 200);
    const unpinned = await (await request('/api/feed?filter=announcements', aliceToken)).json();
    assert.equal(unpinned.posts[0].isPinned, false, 'admin can unpin');
    assert.equal((await request(`/api/feed/announcements/${announcementId}`, null, { method: 'PATCH', admin: true, body: JSON.stringify({ title: 'Updated title' }) })).status, 200, 'admin can edit announcements');
    const adminAnnouncements = await (await request('/api/feed/announcements', null, { admin: true })).json();
    assert.equal(adminAnnouncements.announcements.find(item => item.id === announcementId).title, 'Updated title', 'admin list reflects edits');
    assert.equal((await request(`/api/feed/announcements/${announcementId}`, null, { method: 'DELETE', admin: true })).status, 200, 'admin can delete announcements');
    const afterAnnouncementDelete = await (await request('/api/feed/announcements', null, { admin: true })).json();
    assert.ok(!afterAnnouncementDelete.announcements.some(item => item.id === announcementId), 'deleted announcement is removed from the admin list');
    const feedAfterAnnouncementDelete = await (await request('/api/feed?filter=announcements', aliceToken)).json();
    assert.ok(!feedAfterAnnouncementDelete.posts.some(post => post.id === announcementId), 'deleted announcement is removed from the feed');


    // --- Reports and moderation ---
    assert.equal((await request('/api/feed/reports', aliceToken, { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: post2.id, reason: 'Spam content' }) })).status, 201, 'users can report posts');
    assert.equal((await request('/api/feed/reports', aliceToken, { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: post2.id, reason: '' }) })).status, 400, 'empty report reasons are rejected');
    const adminReports = await (await request('/api/feed/admin/reports', null, { admin: true })).json();
    assert.equal(adminReports.reports.length, 1, 'admin sees open reports');
    assert.equal(adminReports.reports[0].targetId, post2.id);
    assert.equal((await request('/api/feed/admin/reports', aliceToken)).status, 403, 'users cannot view reports');
    assert.equal((await request(`/api/feed/admin/content/posts/${post2.id}`, aliceToken, { method: 'DELETE' })).status, 403, 'users cannot moderate');
    assert.equal((await request(`/api/feed/admin/content/posts/${post2.id}`, null, { method: 'DELETE', admin: true })).status, 200, 'admin can remove content');
    const moderatedFeed = await (await request('/api/feed?filter=latest', aliceToken)).json();
    assert.ok(!moderatedFeed.posts.some(post => post.id === post2.id), 'moderated post is hidden from the feed');
    assert.equal((await request(`/api/feed/admin/reports/${adminReports.reports[0].id}/resolve`, null, { method: 'POST', admin: true })).status, 200, 'admin can resolve reports');

    // --- Soft delete of own post hides it everywhere ---
    assert.equal((await request(`/api/feed/posts/${post1.id}`, aliceToken, { method: 'DELETE' })).status, 200);
    assert.equal((await request(`/api/feed/posts/${post1.id}`, aliceToken)).status, 404, 'soft-deleted post returns 404');
    const afterDeleteFeed = await (await request('/api/feed?filter=latest', aliceToken)).json();
    assert.ok(!afterDeleteFeed.posts.some(post => post.id === post1.id), 'deleted post is hidden');
    const afterDeleteMine = await (await request('/api/feed?filter=mine', aliceToken)).json();
    assert.ok(!afterDeleteMine.posts.some(post => post.id === post1.id), 'deleted post leaves My Posts');
    assert.equal((await request(`/api/feed/posts/${post1.id}`, aliceToken, { method: 'DELETE' })).status, 404, 'second delete reports not found');

    // --- Profiles ---
    const profile = await (await request('/api/feed/profile/Alice', bobToken)).json();
    assert.equal(profile.profile.username, 'Alice');
    assert.equal(profile.profile.bio, '', 'bio is exposed but email never is');
    assert.ok(profile.posts.every(post => post.author.username === 'Alice'), 'profile lists only that user\u2019s posts');
    assert.ok(!JSON.stringify(profile).includes('alice@t.test'), 'email addresses are never exposed');
    assert.equal((await request('/api/feed/profile/ghost', bobToken)).status, 404, 'unknown profiles return 404');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

