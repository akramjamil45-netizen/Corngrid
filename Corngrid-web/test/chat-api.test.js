const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const registerChatApi = require('../chat-api');
const createUserAuth = require('../user-auth');

test('Chat API: user search, conversations, messaging, and unread count', async () => {
  const db = new sqlite3.Database(':memory:');
  const app = express();
  const jwtSecret = 'test-chat-jwt-secret';
  app.use(express.json());

  // Setup users table
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      password TEXT,
      bio TEXT DEFAULT 'CornGrid trader',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_auth_versions (
      user_id INTEGER PRIMARY KEY,
      version INTEGER DEFAULT 0
    );
  `, error => error ? reject(error) : resolve()));

  // Insert test users
  await new Promise((resolve, reject) => db.run(
    `INSERT INTO users (id, username, email, password, bio)
     VALUES (1, 'AliceTrader', 'alice@test.local', 'hash1', 'Gold scalper'),
            (2, 'BobAlgo', 'bob@test.local', 'hash2', 'Grid master'),
            (3, 'CharlieFx', 'charlie@test.local', 'hash3', 'Swing trader')`,
    error => error ? reject(error) : resolve()
  ));

  const verifyToken = createUserAuth({ db, jwtSecret });
  registerChatApi(app, db, verifyToken);

  // Wait for schema init
  await new Promise((resolve, reject) => db.get('SELECT 1 FROM direct_messages', error => error ? reject(error) : resolve()));

  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const aliceToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const bobToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);

  const request = (path, token, options = {}) => fetch(origin + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  try {
    // 1. Unauthenticated check
    assert.equal((await request('/api/chat/unread-count')).status, 401);
    assert.equal((await request('/api/chat/users')).status, 401);

    // 2. Initial unread count for Alice
    let res = await request('/api/chat/unread-count', aliceToken);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unreadCount, 0);

    // 3. Search users as Alice (should return Bob and Charlie, but not Alice)
    res = await request('/api/chat/users?search=bob', aliceToken);
    assert.equal(res.status, 200);
    let usersData = await res.json();
    assert.equal(usersData.users.length, 1);
    assert.equal(usersData.users[0].username, 'BobAlgo');

    // Case-insensitive search
    res = await request('/api/chat/users?search=CHARLIE', aliceToken);
    assert.equal(res.status, 200);
    usersData = await res.json();
    assert.equal(usersData.users.length, 1);
    assert.equal(usersData.users[0].username, 'CharlieFx');

    // 4. Send message from Alice to Bob
    res = await request('/api/chat/messages', aliceToken, {
      method: 'POST',
      body: JSON.stringify({ recipientId: 2, message: 'Hello Bob! How is XAUUSD grid today?' })
    });
    assert.equal(res.status, 201);
    const sentMsg = await res.json();
    assert.equal(sentMsg.senderId, 1);
    assert.equal(sentMsg.recipientId, 2);
    assert.equal(sentMsg.message, 'Hello Bob! How is XAUUSD grid today?');

    // Cannot message self
    res = await request('/api/chat/messages', aliceToken, {
      method: 'POST',
      body: JSON.stringify({ recipientId: 1, message: 'Talking to myself' })
    });
    assert.equal(res.status, 400);

    // Cannot send empty message
    res = await request('/api/chat/messages', aliceToken, {
      method: 'POST',
      body: JSON.stringify({ recipientId: 2, message: '   ' })
    });
    assert.equal(res.status, 400);

    // 5. Bob checks unread count -> should be 1
    res = await request('/api/chat/unread-count', bobToken);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unreadCount, 1);

    // 6. Bob checks conversations list
    res = await request('/api/chat/conversations', bobToken);
    assert.equal(res.status, 200);
    const convos = await res.json();
    assert.equal(convos.conversations.length, 1);
    assert.equal(convos.conversations[0].username, 'AliceTrader');
    assert.equal(convos.conversations[0].unreadCount, 1);
    assert.equal(convos.conversations[0].lastMessage, 'Hello Bob! How is XAUUSD grid today?');

    // 7. Bob opens messages with Alice (marks as read)
    res = await request('/api/chat/messages/1', bobToken);
    assert.equal(res.status, 200);
    const chatHistory = await res.json();
    assert.equal(chatHistory.peer.username, 'AliceTrader');
    assert.equal(chatHistory.messages.length, 1);
    assert.equal(chatHistory.messages[0].isMine, false);

    // Unread count should now be 0 for Bob
    res = await request('/api/chat/unread-count', bobToken);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unreadCount, 0);

    // 8. Bob replies to Alice
    res = await request('/api/chat/messages', bobToken, {
      method: 'POST',
      body: JSON.stringify({ recipientId: 1, message: 'Hey Alice! Dynamic tier martingale is running smoothly.' })
    });
    assert.equal(res.status, 201);

    // Alice checks message history with Bob
    res = await request('/api/chat/messages/2', aliceToken);
    assert.equal(res.status, 200);
    const aliceChat = await res.json();
    assert.equal(aliceChat.messages.length, 2);
    assert.equal(aliceChat.messages[0].isMine, true);
    assert.equal(aliceChat.messages[1].isMine, false);
    assert.equal(aliceChat.messages[1].message, 'Hey Alice! Dynamic tier martingale is running smoothly.');

    res = await request('/api/chat/support/messages', bobToken, {
      method: 'POST',
      body: JSON.stringify({ message: 'I need help linking my account.' })
    });
    assert.equal(res.status, 201);
    const supportMessage = await res.json();
    assert.equal(supportMessage.senderRole, 'user');
    assert.equal(supportMessage.isMine, true);

    res = await request('/api/chat/support/messages', bobToken);
    assert.equal(res.status, 200);
    const supportThread = await res.json();
    assert.equal(supportThread.peer.username, 'CornGrid Support');
    assert.equal(supportThread.messages.length, 1);
    assert.equal(supportThread.messages[0].message, 'I need help linking my account.');

    res = await request('/api/chat/unread-count', bobToken);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unreadCount, 0);

    await new Promise((resolve, reject) => db.run(`
      INSERT INTO support_messages (user_id, sender_role, message, created_at)
      VALUES (2, 'admin', 'Please send the account server name.', ?)
    `, [Date.now()], error => error ? reject(error) : resolve()));
    res = await request('/api/chat/unread-count', bobToken);
    assert.equal((await res.json()).unreadCount, 1);
    res = await request('/api/chat/support/messages', bobToken);
    const repliedSupportThread = await res.json();
    assert.equal(repliedSupportThread.messages.length, 2);
    assert.equal(repliedSupportThread.messages[1].isMine, false);
    assert.equal(repliedSupportThread.messages[1].message, 'Please send the account server name.');

    res = await request('/api/chat/unread-count', bobToken);
    assert.equal((await res.json()).unreadCount, 0);

    res = await request('/api/chat/support/messages', bobToken, {
      method: 'POST',
      body: JSON.stringify({ message: '   ' })
    });
    assert.equal(res.status, 400);

  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});
