const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const registerMt5Api = require('../mt5-api');
const createUserAuth = require('../user-auth');
const { AUTH_COOKIE_NAME } = require('../session-cookie');

test('MT5 pairing, ingestion, ownership, preferences, and password revocation', async () => {
  const db = new sqlite3.Database(':memory:');
  const app = express();
  const jwtSecret = 'test-signing-secret-for-dashboard';
  app.use(express.json());
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      email TEXT,
      password TEXT,
      bio TEXT,
      created_at TEXT
    );
  `, error => error ? reject(error) : resolve()));
  const passwordHash = await bcrypt.hash('original-test-password', 4);
  await new Promise((resolve, reject) => db.run(
    `INSERT INTO users (id, username, email, password, bio, created_at)
     VALUES (1, 'Alice', 'alice@example.test', ?, '', CURRENT_TIMESTAMP),
            (2, 'Bob', 'bob@example.test', ?, '', CURRENT_TIMESTAMP)`,
    [passwordHash, passwordHash],
    error => error ? reject(error) : resolve()
  ));

  const verifyToken = createUserAuth({ db, jwtSecret });
  registerMt5Api(app, db, verifyToken);
  await new Promise((resolve, reject) => db.get('SELECT 1', error => error ? reject(error) : resolve()));

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
    assert.equal((await request('/api/portfolio')).status, 401);
    let response = await request('/api/portfolio', aliceToken);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).balanceAvailable, false);

    const cookieOrigin = `http://127.0.0.1:${server.address().port}`;
    response = await fetch(`${cookieOrigin}/api/portfolio`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${aliceToken}` }
    });
    assert.equal(response.status, 200);

    response = await fetch(`${cookieOrigin}/api/user/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: `${AUTH_COOKIE_NAME}=${aliceToken}`,
        Origin: 'https://attacker.example',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ theme: 'light' })
    });
    assert.equal(response.status, 403);

    response = await fetch(`${cookieOrigin}/api/user/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: `${AUTH_COOKIE_NAME}=${aliceToken}`,
        Origin: cookieOrigin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ theme: 'light' })
    });
    assert.equal(response.status, 200);

    response = await request('/api/mt5/pairing-code', aliceToken, { method: 'POST', body: '{}' });
    assert.equal(response.status, 201);
    const { code } = await response.json();
    response = await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code, accountNumber: '12345678', brokerServer: 'TestBroker-Live', currency: 'USD', eaVersion: '2.60' })
    });
    assert.equal(response.status, 201);
    const { installationSecret } = await response.json();
    const pairedAccount = await (await request('/api/mt5/accounts', aliceToken)).json();
    assert.equal(pairedAccount.accounts[0].eaVersion, '2.60', 'EA version is recorded when the installation first pairs');
    assert.equal((await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code, accountNumber: '87654321', brokerServer: 'Other', currency: 'USD' })
    })).status, 400);

    assert.equal((await request('/api/mt5/heartbeat', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
      body: '{}'
    })).status, 401);

    const now = Date.now();
    const heartbeat = (time, equity, positions) => request('/api/mt5/heartbeat', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${installationSecret}` },
      body: JSON.stringify({
        timestamp: new Date(time).toISOString(),
        balance: 1000,
        equity,
        floatingProfit: equity - 1000,
        margin: 20,
        freeMargin: 980,
        eaName: 'CornGrid EA',
        eaVersion: '2.60',
        ...(positions === undefined ? {} : { positions })
      })
    });
    const positions = [{
      ticket: '77',
      symbol: 'EURUSD',
      direction: 'BUY',
      volume: 0.1,
      entryPrice: 1.08,
      currentPrice: 1.09,
      profit: 10,
      swap: 0,
      openedAt: new Date(now - 60_000).toISOString()
    }];
    assert.equal((await heartbeat(now - 10_000, 1000, positions)).status, 200);
    assert.equal((await heartbeat(now, 1010)).status, 200);
    const staleHeartbeat = await heartbeat(now - 5000, 900);
    assert.equal(staleHeartbeat.status, 202);
    assert.equal((await staleHeartbeat.json()).accepted, false);

    response = await request('/api/mt5/trades', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${installationSecret}` },
      body: JSON.stringify({ deals: [
        { dealId: 'D-1', symbol: 'EURUSD', direction: 'BUY', volume: 0.1, profit: 12, commission: -1, swap: 0, closedAt: new Date(now - 1000).toISOString(), durationSeconds: 60 },
        { dealId: 'D-1', symbol: 'EURUSD', direction: 'BUY', volume: 0.1, profit: 12, commission: -1, swap: 0, closedAt: new Date(now - 1000).toISOString(), durationSeconds: 60 },
        { dealId: 'D-2', symbol: 'GBPUSD', direction: 'SELL', volume: 0.2, profit: -5, commission: -1, swap: -0.5, closedAt: new Date(now - 500).toISOString() }
      ] })
    });
    assert.equal(response.status, 200);
    const imported = await response.json();
    assert.equal(imported.inserted, 2);
    assert.equal(imported.duplicatesIgnored, 1);

    const accountList = await (await request('/api/mt5/accounts', aliceToken)).json();
    assert.equal(accountList.accounts.length, 1);
    assert.equal(accountList.accounts[0].status, 'Online');
    assert.equal(accountList.accounts[0].maskedAccount.includes('12345678'), false);
    assert.equal((await request(`/api/mt5/accounts/${accountList.accounts[0].id}`, bobToken, {
      method: 'PATCH',
      body: JSON.stringify({ accountName: 'Unauthorized rename' })
    })).status, 404);
    response = await request(`/api/mt5/accounts/${accountList.accounts[0].id}`, aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ accountName: 'My Live Account' })
    });
    assert.equal(response.status, 200);
    assert.equal((await (await request('/api/mt5/accounts', aliceToken)).json()).accounts[0].accountName, 'My Live Account');
    assert.equal((await (await request('/api/portfolio/positions', aliceToken)).json()).items.length, 1);
    assert.equal((await (await request('/api/portfolio/positions?direction=SELL', aliceToken)).json()).total, 0);
    assert.equal((await (await request('/api/portfolio/positions', bobToken)).json()).items.length, 0);
    assert.equal((await request(`/api/mt5/accounts/${accountList.accounts[0].id}`, bobToken, { method: 'DELETE' })).status, 404);
    assert.equal((await request('/api/user/portfolio-sharing')).status, 401);
    assert.equal((await request('/api/public/portfolios')).status, 200);
    assert.equal((await (await request('/api/public/portfolios')).json()).portfolios.length, 0);
    assert.equal((await request('/api/user/portfolio-sharing', bobToken, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: true, accountIds: [] })
    })).status, 400, 'users must link an account before publishing a portfolio');
    assert.equal((await request('/api/user/portfolio-sharing', aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: 'yes', accountIds: [] })
    })).status, 400);

    response = await request('/api/mt5/pairing-code', aliceToken, { method: 'POST', body: '{}' });
    const aliceSecondCode = (await response.json()).code;
    response = await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code: aliceSecondCode, accountNumber: '87654321', brokerServer: 'OtherBroker-Live', currency: 'USD' })
    });
    assert.equal(response.status, 201);
    const { installationSecret: secondInstallationSecret } = await response.json();
    const secondAccountHeartbeat = await request('/api/mt5/heartbeat', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secondInstallationSecret}` },
      body: JSON.stringify({
        timestamp: new Date(now).toISOString(),
        balance: 2000,
        equity: 2010,
        floatingProfit: 10,
        eaName: 'CornGrid EA',
        eaVersion: '2.60',
        positions: [{
          ticket: '88',
          symbol: 'XAUUSD',
          direction: 'SELL',
          volume: 0.2,
          entryPrice: 2500,
          currentPrice: 2495,
          profit: 10,
          swap: 0,
          openedAt: new Date(now - 60_000).toISOString()
        }]
      })
    });
    assert.equal(secondAccountHeartbeat.status, 200);
    response = await request('/api/mt5/trades', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secondInstallationSecret}` },
      body: JSON.stringify({ deals: [
        { dealId: 'SECOND-ACCOUNT-DEAL', symbol: 'XAUUSD', direction: 'SELL', volume: 0.2, profit: 50, commission: -2, swap: 0, closedAt: new Date(now - 10_000).toISOString() }
      ] })
    });
    assert.equal(response.status, 200);

    response = await request('/api/mt5/pairing-code', bobToken, { method: 'POST', body: '{}' });
    const bobCode = (await response.json()).code;
    response = await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code: bobCode, accountNumber: '55550000', brokerServer: 'BobBroker-Live', currency: 'USD' })
    });
    assert.equal(response.status, 201);
    const bobAccounts = await (await request('/api/mt5/accounts', bobToken)).json();
    assert.equal(bobAccounts.accounts.length, 1);
    const aliceAccounts = await (await request('/api/mt5/accounts', aliceToken)).json();
    assert.equal(aliceAccounts.accounts.length, 2, 'users can link multiple MT5 accounts');
    const aliceSecondAccountId = aliceAccounts.accounts.find(account => account.id !== accountList.accounts[0].id).id;
    const firstAccountOverview = await (await request(`/api/portfolio?accountId=${accountList.accounts[0].id}`, aliceToken)).json();
    const secondAccountOverview = await (await request(`/api/portfolio?accountId=${aliceSecondAccountId}`, aliceToken)).json();
    assert.equal(firstAccountOverview.balance, 1000);
    assert.equal(secondAccountOverview.balance, 2000);
    assert.equal(firstAccountOverview.accountCount, 1);
    assert.equal(secondAccountOverview.accountCount, 1);
    assert.equal(firstAccountOverview.activeAccounts, 1);
    assert.equal(secondAccountOverview.activeAccounts, 1);
    assert.equal((await request(`/api/portfolio?accountId=${bobAccounts.accounts[0].id}`, aliceToken)).status, 404);
    assert.equal((await request('/api/portfolio?accountId=not-an-id', aliceToken)).status, 400);

    const firstAccountPerformance = await (await request(`/api/portfolio/performance?period=all&accountId=${accountList.accounts[0].id}`, aliceToken)).json();
    const secondAccountPerformance = await (await request(`/api/portfolio/performance?period=all&accountId=${aliceSecondAccountId}`, aliceToken)).json();
    assert.equal(firstAccountPerformance.closedDeals, 2);
    assert.equal(secondAccountPerformance.closedDeals, 1);
    // The two heartbeats above are 10s apart, which is inside the 60s balance
    // history interval, so only the first is persisted as a snapshot.
    assert.equal(firstAccountPerformance.snapshots.length, 1);
    assert.equal(secondAccountPerformance.snapshots.length, 1);
    assert.equal((await request(`/api/portfolio/performance?period=all&accountId=${bobAccounts.accounts[0].id}`, aliceToken)).status, 404);

    const firstAccountPositions = await (await request(`/api/portfolio/positions?accountId=${accountList.accounts[0].id}`, aliceToken)).json();
    const secondAccountPositions = await (await request(`/api/portfolio/positions?accountId=${aliceSecondAccountId}`, aliceToken)).json();
    assert.equal(firstAccountPositions.total, 1);
    assert.equal(secondAccountPositions.total, 1);
    assert.equal(secondAccountPositions.items[0].symbol, 'XAUUSD');
    assert.equal((await request(`/api/portfolio/positions?accountId=${bobAccounts.accounts[0].id}`, aliceToken)).status, 404);

    const firstAccountTrades = await (await request(`/api/portfolio/trades?accountId=${accountList.accounts[0].id}`, aliceToken)).json();
    const secondAccountTrades = await (await request(`/api/portfolio/trades?accountId=${aliceSecondAccountId}`, aliceToken)).json();
    assert.equal(firstAccountTrades.total, 2);
    assert.equal(secondAccountTrades.total, 1);
    assert.equal(secondAccountTrades.items[0].dealId, 'SECOND-ACCOUNT-DEAL');
    assert.deepEqual(secondAccountTrades.symbols, ['XAUUSD'], 'symbol options follow the selected account');
    assert.equal((await request(`/api/portfolio/trades?accountId=${bobAccounts.accounts[0].id}`, aliceToken)).status, 404);

    assert.equal((await request('/api/user/portfolio-sharing', aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: true, accountIds: [bobAccounts.accounts[0].id] })
    })).status, 400, 'users cannot publish another user’s trading account');
    response = await request('/api/user/portfolio-sharing', aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: true, accountIds: [accountList.accounts[0].id] })
    });
    assert.equal(response.status, 200);
    const sharing = await response.json();
    assert.match(sharing.shareUrl, /^\/portfolio\/[a-f0-9]{32}$/);
    assert.deepEqual(sharing.selectedAccountIds, [accountList.accounts[0].id]);
    const shareId = sharing.shareUrl.split('/').pop();
    const publicList = await (await request('/api/public/portfolios')).json();
    assert.equal(publicList.portfolios.length, 1);
    assert.equal(publicList.portfolios[0].displayName, 'Alice');
    assert.equal(publicList.portfolios[0].balance, 1000);
    assert.equal(publicList.portfolios[0].accountCount, 1, 'public totals only include selected accounts');
    response = await request(`/api/public/portfolios/${shareId}`);
    assert.equal(response.status, 200);
    const publicPortfolio = await response.json();
    assert.equal(publicPortfolio.accountCount, 1);
    assert.equal(publicPortfolio.equity, 1010);
    assert.equal(publicPortfolio.snapshots.length, 1, 'public equity curve only uses the selected account history');
    assert.equal(publicPortfolio.positions.length, 1);
    assert.equal(publicPortfolio.trades.length, 2);
    assert.equal(publicPortfolio.accounts.some(account => account.accountName === 'OtherBroker-Live'), false);
    const publicPayload = JSON.stringify(publicPortfolio);
    for (const privateField of ['alice@example.test', '12345678', 'TestBroker-Live', 'OtherBroker-Live', 'XAUUSD', 'SECOND-ACCOUNT-DEAL', 'dealId', 'ticket', 'magicNumber']) {
      assert.equal(publicPayload.includes(privateField), false, `public response must not expose ${privateField}`);
    }
    assert.equal((await request(`/api/public/portfolios/${shareId}`, bobToken)).status, 200);
    response = await request('/api/user/portfolio-sharing', aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ isPublic: false, accountIds: [accountList.accounts[0].id, aliceSecondAccountId] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).shareUrl, null);
    assert.equal((await (await request('/api/public/portfolios')).json()).portfolios.length, 0);
    assert.equal((await request(`/api/public/portfolios/${shareId}`)).status, 404);
    await new Promise((resolve, reject) => db.run('UPDATE mt5_accounts SET last_heartbeat = ? WHERE id = ?', [Date.now() - 300_000, accountList.accounts[0].id], error => error ? reject(error) : resolve()));
    const aliceAccountsAfterTimeout = await (await request('/api/mt5/accounts', aliceToken)).json();
    assert.equal(aliceAccountsAfterTimeout.accounts.find(account => account.id === accountList.accounts[0].id).status, 'Offline');
    const performance = await (await request('/api/portfolio/performance?period=all', aliceToken)).json();
    assert.equal(performance.closedDeals, 3);
    assert.equal(performance.netProfit, 52.5);
    assert.equal(performance.profitFactor, 12.4);
    assert.equal(performance.snapshots.length, 0);
    assert.match(performance.snapshotUnavailableReason, /multiple accounts/i);
    const winners = await (await request('/api/portfolio/trades?result=win&limit=1', aliceToken)).json();
    assert.equal(winners.total, 2);
    assert.equal(winners.items[0].dealId, 'D-1');
    const customRange = await (await request(`/api/portfolio/performance?period=custom&from=${new Date(now - 86400000).toISOString().slice(0, 10)}&to=${new Date(now).toISOString().slice(0, 10)}`, aliceToken)).json();
    assert.equal(customRange.closedDeals, 3);
    response = await request('/api/mt5/trades', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${installationSecret}` },
      body: JSON.stringify({ deals: [
        { dealId: 'D-3', symbol: 'XAUUSD', direction: 'SELL', volume: 0.1, profit: 100, closedAt: new Date(now).toISOString() }
      ] })
    });
    assert.equal(response.status, 200);
    const incompleteCosts = await (await request('/api/portfolio/performance?period=all', aliceToken)).json();
    assert.equal(incompleteCosts.netProfitAvailable, false);
    assert.equal(incompleteCosts.winRateAvailable, false);
    assert.equal(incompleteCosts.grossProfitAvailable, true);
    response = await request('/api/user/preferences', aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ theme: 'light', currency: 'USD', timezone: 'UTC' })
    });
    assert.equal(response.status, 200);
    assert.equal((await (await request('/api/me', aliceToken)).json()).preferences.theme, 'light');
    assert.equal((await request('/api/user/preferences', aliceToken, {
      method: 'PATCH',
      body: JSON.stringify({ timezone: 'not/a-time-zone' })
    })).status, 400);

    response = await request('/api/mt5/pairing-code', aliceToken, { method: 'POST', body: '{}' });
    const replacedCode = (await response.json()).code;
    response = await request('/api/mt5/pairing-code', aliceToken, { method: 'POST', body: '{}' });
    const expiredCode = (await response.json()).code;
    assert.equal((await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code: replacedCode, accountNumber: '456', brokerServer: 'Replaced', currency: 'USD' })
    })).status, 400, 'generating a replacement code invalidates the previous code');
    const codeHash = crypto.createHash('sha256').update(expiredCode).digest('hex');
    await new Promise((resolve, reject) => db.run(
      'UPDATE mt5_pairing_codes SET expires_at = ? WHERE code_hash = ?',
      [Date.now() - 1, codeHash],
      error => error ? reject(error) : resolve()
    ));
    assert.equal((await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code: expiredCode, accountNumber: '456', brokerServer: 'Expired', currency: 'USD' })
    })).status, 400);

    response = await request('/api/user/change-password', aliceToken, {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'incorrect', newPassword: 'replacement-password' })
    });
    assert.equal(response.status, 400);
    response = await request('/api/user/change-password', aliceToken, {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'original-test-password', newPassword: 'replacement-password' })
    });
    assert.equal(response.status, 200);
    assert.equal((await request('/api/me', aliceToken)).status, 403);
    response = await fetch(`${cookieOrigin}/api/me`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${aliceToken}` }
    });
    assert.equal(response.status, 403);
    const renewedToken = jwt.sign({ id: 1, authVersion: 1 }, jwtSecret);
    assert.equal((await request('/api/me', renewedToken)).status, 200);
    response = await fetch(`${cookieOrigin}/api/me`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${renewedToken}` }
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('MT5 accounts can be unlinked while the EA is offline and linked data is removed', async () => {
  const db = new sqlite3.Database(':memory:');
  const app = express();
  const jwtSecret = 'test-signing-secret-for-offline-unlink';
  app.use(express.json());
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      email TEXT,
      password TEXT,
      bio TEXT,
      created_at TEXT
    );
  `, error => error ? reject(error) : resolve()));
  const passwordHash = await bcrypt.hash('offline-unlink-password', 4);
  await new Promise((resolve, reject) => db.run(
    `INSERT INTO users (id, username, email, password, bio, created_at)
     VALUES (1, 'Owner', 'owner@example.test', ?, '', CURRENT_TIMESTAMP),
            (2, 'Stranger', 'stranger@example.test', ?, '', CURRENT_TIMESTAMP)`,
    [passwordHash, passwordHash],
    error => error ? reject(error) : resolve()
  ));

  const verifyToken = createUserAuth({ db, jwtSecret });
  registerMt5Api(app, db, verifyToken);
  await new Promise((resolve, reject) => db.get('SELECT 1', error => error ? reject(error) : resolve()));

  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const strangerToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);
  const request = (path, token, options = {}) => fetch(origin + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  try {
    let response = await request('/api/mt5/pairing-code', ownerToken, { method: 'POST', body: '{}' });
    assert.equal(response.status, 201);
    const { code } = await response.json();
    response = await request('/api/mt5/pair', null, {
      method: 'POST',
      body: JSON.stringify({ code, accountNumber: '99887766', brokerServer: 'OfflineBroker-Live', currency: 'USD', eaVersion: '2.60' })
    });
    assert.equal(response.status, 201);
    const { installationSecret } = await response.json();

    const now = Date.now();
    response = await request('/api/mt5/heartbeat', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${installationSecret}` },
      body: JSON.stringify({
        timestamp: new Date(now).toISOString(),
        balance: 5000,
        equity: 5050,
        floatingProfit: 50,
        margin: 50,
        freeMargin: 5000,
        eaName: 'CornGrid EA',
        eaVersion: '2.60',
        positions: [{
          ticket: '501',
          symbol: 'XAUUSD',
          direction: 'BUY',
          volume: 0.1,
          entryPrice: 2400,
          currentPrice: 2410,
          profit: 50,
          swap: 0,
          openedAt: new Date(now - 60_000).toISOString()
        }]
      })
    });
    assert.equal(response.status, 200);
    response = await request('/api/mt5/trades', null, {
      method: 'POST',
      headers: { Authorization: `Bearer ${installationSecret}` },
      body: JSON.stringify({ deals: [
        { dealId: 'OFFLINE-D-1', symbol: 'XAUUSD', direction: 'BUY', volume: 0.1, profit: 40, commission: -1, swap: 0, closedAt: new Date(now - 5_000).toISOString(), durationSeconds: 60 }
      ] })
    });
    assert.equal(response.status, 200);

    const accounts = (await (await request('/api/mt5/accounts', ownerToken)).json()).accounts;
    assert.equal(accounts.length, 1);
    const accountId = accounts[0].id;
    assert.equal(accounts[0].status, 'Online');

    await new Promise((resolve, reject) => db.run(`
      INSERT INTO mt5_accounts (user_id, account_number, broker_server, currency, linked_at, last_heartbeat)
      VALUES (1, 'ONLINE-UNLINK-1', 'DemoServer', 'USD', ?, ?)
    `, [Date.now(), Date.now()], error => error ? reject(error) : resolve()));
    const onlineAccounts = (await (await request('/api/mt5/accounts', ownerToken)).json()).accounts;
    const onlineAccount = onlineAccounts.find(account => account.id !== accountId);
    assert.equal(onlineAccount.status, 'Online', 'precondition: the second EA is online');
    assert.equal((await request(`/api/mt5/accounts/${onlineAccount.id}`, ownerToken, { method: 'DELETE' })).status, 200,
      'the owner can unlink an online EA account');

    // Make the EA stale so the account reports Offline: the state users report as blocking unlink.
    await new Promise((resolve, reject) => db.run(
      'UPDATE mt5_accounts SET last_heartbeat = ? WHERE id = ?',
      [Date.now() - 600_000, accountId],
      error => error ? reject(error) : resolve()
    ));
    const offlineAccounts = (await (await request('/api/mt5/accounts', ownerToken)).json()).accounts;
    assert.equal(offlineAccounts[0].status, 'Offline', 'precondition: the EA is offline before unlinking');
    assert.equal((await (await request('/api/portfolio/positions', ownerToken)).json()).items.length, 1);

    const counts = async table => (await new Promise((resolve, reject) =>
      db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE account_id = ?`, [accountId], (error, row) => error ? reject(error) : resolve(row.count))));
    assert.equal(await counts('mt5_positions'), 1);
    assert.equal(await counts('mt5_deals'), 1);
    assert.ok(await counts('mt5_snapshots') >= 1);
    assert.equal(await counts('mt5_installations'), 1);

    assert.equal((await request(`/api/mt5/accounts/${accountId}`, strangerToken, { method: 'DELETE' })).status, 404,
      'a different user cannot unlink the account');

    await new Promise((resolve, reject) => db.exec(`
      CREATE TABLE mt5_account_references (
        account_id INTEGER NOT NULL REFERENCES mt5_accounts(id)
      );
      INSERT INTO mt5_account_references (account_id) VALUES (${accountId});
    `, error => error ? reject(error) : resolve()));
    response = await request(`/api/mt5/accounts/${accountId}`, ownerToken, { method: 'DELETE' });
    assert.equal(response.status, 500, 'an unresolved foreign-key reference must prevent unlinking');
    assert.equal(await counts('mt5_positions'), 1, 'failed unlink rolls back earlier child deletions');
    assert.equal(await counts('mt5_deals'), 1, 'failed unlink leaves imported deals intact');
    assert.equal((await (await request('/api/mt5/accounts', ownerToken)).json()).accounts.length, 1,
      'failed unlink leaves the account intact');
    await new Promise((resolve, reject) => db.run(
      'DELETE FROM mt5_account_references WHERE account_id = ?',
      [accountId],
      error => error ? reject(error) : resolve()
    ));

    // Simulate a database where foreign-key cascades are unavailable (legacy schema):
    // unlinking must still remove the account and every linked row explicitly.
    await new Promise((resolve, reject) => db.run('PRAGMA foreign_keys = OFF',
      error => error ? reject(error) : resolve()));

    response = await request(`/api/mt5/accounts/${accountId}`, ownerToken, { method: 'DELETE' });
    assert.equal(response.status, 200, 'the owner can unlink an offline EA account');

    assert.equal(await counts('mt5_positions'), 0, 'positions cascade on unlink');
    assert.equal(await counts('mt5_deals'), 0, 'deals cascade on unlink');
    assert.equal(await counts('mt5_snapshots'), 0, 'snapshots cascade on unlink');
    assert.equal(await counts('mt5_installations'), 0, 'installations cascade on unlink');

    assert.equal((await (await request('/api/mt5/accounts', ownerToken)).json()).accounts.length, 0);
    assert.equal((await (await request('/api/portfolio/positions', ownerToken)).json()).items.length, 0);
    assert.equal((await request(`/api/mt5/accounts/${accountId}`, ownerToken, { method: 'DELETE' })).status, 404,
      'a second unlink attempt reports the account as gone');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('data retention cleanup prunes old snapshots and expired pairing codes', async () => {
  const db = new sqlite3.Database(':memory:');
  const app = express();
  const verifyToken = (req, res, next) => next();
  registerMt5Api(app, db, verifyToken);
  await new Promise((resolve, reject) => db.get('SELECT 1', err => err ? reject(err) : resolve()));

  await new Promise((resolve, reject) => db.run(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT)
  `, err => err ? reject(err) : resolve()));
  await new Promise((resolve, reject) => db.run(`
    INSERT INTO users (id, username, email, password) VALUES (1, 'User1', 'u@test.local', 'hash')
  `, err => err ? reject(err) : resolve()));
  await new Promise((resolve, reject) => db.run(`
    INSERT INTO mt5_accounts (id, user_id, account_number, broker_server, currency, linked_at)
    VALUES (1, 1, '12345', 'DemoServer', 'USD', ?)
  `, [Date.now()], err => err ? reject(err) : resolve()));

  const now = Date.now();
  const oldTime = now - (100 * 24 * 60 * 60 * 1000);
  const freshTime = now - (10 * 24 * 60 * 60 * 1000);

  await new Promise((resolve, reject) => db.run(`
    INSERT INTO mt5_snapshots (account_id, captured_at, balance, equity, floating_profit)
    VALUES (1, ?, 1000, 1000, 0), (1, ?, 1200, 1200, 0)
  `, [oldTime, freshTime], err => err ? reject(err) : resolve()));

  await registerMt5Api.performDataRetentionCleanup(db);

  const remaining = await new Promise((resolve, reject) => db.all('SELECT captured_at FROM mt5_snapshots', (err, rows) => err ? reject(err) : resolve(rows)));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].captured_at, freshTime);

  await new Promise(resolve => db.close(resolve));
});

test('economic news preferences are validated, merged, and served by /api/me', async () => {
  const db = new sqlite3.Database(':memory:');
  const app = express();
  const jwtSecret = 'test-signing-secret-for-economic-news';
  app.use(express.json());
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT
    );
  `, error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.run(
    `INSERT INTO users (id, username, email, password, bio, created_at)
     VALUES (1, 'Alice', 'alice@example.test', 'x', '', CURRENT_TIMESTAMP)`,
    error => error ? reject(error) : resolve()
  ));

  const verifyToken = createUserAuth({ db, jwtSecret });
  registerMt5Api(app, db, verifyToken);
  const server = await new Promise(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const request = (path, options = {}) => fetch(origin + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  try {
    // Defaults are returned even before anything is saved.
    let me = await (await request('/api/me')).json();
    assert.equal(typeof me.preferences, 'object');
    assert.equal(me.preferences.economicNews, undefined, 'no economic news block until saved');

    // A valid economic news object is accepted.
    let response = await request('/api/user/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ economicNews: { enabled: true, alertWindow: 30, browserNotifications: false, relevance: 'XAUUSD' } })
    });
    assert.equal(response.status, 200);

    me = await (await request('/api/me')).json();
    assert.equal(me.preferences.economicNews.alertWindow, 30);
    assert.equal(me.preferences.economicNews.relevance, 'XAUUSD');

    // Saving an unrelated preference must not wipe the economic news block.
    response = await request('/api/user/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ theme: 'light' })
    });
    assert.equal(response.status, 200);
    me = await (await request('/api/me')).json();
    assert.equal(me.preferences.theme, 'light');
    assert.equal(me.preferences.economicNews.alertWindow, 30, 'economic news block survives other updates');

    // Partial economic news updates merge over the stored block.
    response = await request('/api/user/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ economicNews: { alertWindow: 5 } })
    });
    assert.equal(response.status, 200);
    me = await (await request('/api/me')).json();
    assert.equal(me.preferences.economicNews.alertWindow, 5);
    assert.equal(me.preferences.economicNews.relevance, 'XAUUSD', 'unspecified fields keep their previous values');

    // Invalid values are rejected without touching the stored preferences.
    const bad = [
      { economicNews: null },
      { economicNews: 'yes' },
      { economicNews: [] },
      { economicNews: { alertWindow: 7 } },
      { economicNews: { alertWindow: 'fifteen' } },
      { economicNews: { enabled: 'true' } },
      { economicNews: { browserNotifications: 1 } },
      { economicNews: { relevance: 'DOGEUSD' } },
      { economicNews: { unknownKey: true } },
      { economicNews: { alertWindow: 0 } }
    ];
    for (const body of bad) {
      response = await request('/api/user/preferences', { method: 'PATCH', body: JSON.stringify(body) });
      assert.equal(response.status, 400, `rejects ${JSON.stringify(body)}`);
    }
    me = await (await request('/api/me')).json();
    assert.equal(me.preferences.economicNews.alertWindow, 5, 'invalid patches leave stored preferences untouched');

    // Unknown top-level preference keys are still rejected (existing behaviour).
    response = await request('/api/user/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ somethingElse: true })
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});
