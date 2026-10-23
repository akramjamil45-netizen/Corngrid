'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const registerMarketApi = require('../market-api');
const registerMt5Api = require('../mt5-api');
const createMarketFeed = require('../market-feed');
const { exclusive } = require('../db-write');

const SYMBOLS = registerMarketApi.SYMBOLS;

test('the shared write queue never overlaps blocks, survives a failure, and does not deadlock when nested', async () => {
  // Every module writes on the same sqlite connection, so the queue is what
  // keeps two transactions from overlapping on it.
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', error => error ? reject(error) : resolve()));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));

  let active = 0;
  let maxActive = 0;
  const block = fn => exclusive(db, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await fn();
    active -= 1;
  });

  await Promise.all([1, 2, 3, 4, 5].map(n => block(async () => {
    await run('INSERT INTO t (v) VALUES (?)', ['x' + n]);
    await new Promise(resolve => setTimeout(resolve, 5));
  })));
  assert.equal(maxActive, 1, 'write blocks must not overlap');

  // A nested call must run inline instead of waiting on the queue it holds.
  const nested = await exclusive(db, async () => {
    await run('INSERT INTO t (v) VALUES (?)', ['outer']);
    return exclusive(db, async () => {
      await run('INSERT INTO t (v) VALUES (?)', ['inner']);
      return 'inner-ok';
    });
  });
  assert.equal(nested, 'inner-ok');

  // A failed block must not poison the queue for later writers.
  await assert.rejects(() => exclusive(db, async () => { throw new Error('boom'); }));
  await exclusive(db, async () => { await run('INSERT INTO t (v) VALUES (?)', ['after-failure']); });

  const rows = await new Promise((resolve, reject) => db.all('SELECT v FROM t ORDER BY id', (error, result) => error ? reject(error) : resolve(result)));
  assert.equal(rows.length, 8, 'every write must land');
  db.close();
});

function makeClock(start = Date.now()) {
  const clock = { value: start, now: () => clock.value, advance(ms) { clock.value += ms; } };
  return clock;
}

function installation(id, broker = 'Broker-Live') {
  return { installation_id: id, account_id: id, user_id: 1, broker_server: broker };
}

function quote(clock, overrides = {}) {
  return { symbol: 'XAUUSD.a', bid: 2000.10, ask: 2000.30, last: null, spreadPoints: 20, digits: 2, tickTimeMs: clock.value - 500, tickVolume: 12, ...overrides };
}

function payload(clock, overrides = {}) {
  return { schema: 1, sentAtMs: clock.value, quotes: [quote(clock)], ...overrides };
}

function bar(t, overrides = {}) {
  return { t, o: 2000, h: 2002, l: 1999, c: 2001, tv: 50, ...overrides };
}

async function setup(configOverrides = {}) {
  const clock = makeClock();
  const db = new sqlite3.Database(':memory:');
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now, ...configOverrides } });
  await feed.ready;
  return { clock, db, feed };
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Waits until registerMt5Api has created its tables.
function setupPairedEaWait(db, resolve, reject, attempts = 0) {
  if (attempts > 100) return reject(new Error('The MT5 tables were not created in time.'));
  db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mt5_installations'", (error, row) => {
    if (error) return reject(error);
    if (row) return resolve();
    return setTimeout(() => setupPairedEaWait(db, resolve, reject, attempts + 1), 25);
  });
}

// Creates the MT5 tables plus one paired installation and returns the
// credential the EA would use. The MT5 API must be registered first, because
// that is what creates the tables.
async function setupPairedEa(app, db, { broker = 'Broker-Live' } = {}) {
  await new Promise((resolve, reject) => db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT); INSERT OR IGNORE INTO users (id, username, email, password, bio, created_at) VALUES (1, 'Owner', 'owner@example.test', 'x', '', CURRENT_TIMESTAMP);", error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => setupPairedEaWait(db, resolve, reject));
  const account = await new Promise((resolve, reject) => db.run(
    'INSERT INTO mt5_accounts (user_id, account_number, broker_server, currency, linked_at) VALUES (1, ?, ?, ?, ?)',
    ['ACC-1', broker, 'USD', Date.now()],
    function (error) { error ? reject(error) : resolve({ id: this.lastID }); }
  ));
  const secret = crypto.randomBytes(32).toString('hex');
  await new Promise((resolve, reject) => db.run(
    'INSERT INTO mt5_installations (account_id, secret_hash, created_at) VALUES (?, ?, ?)',
    [account.id, crypto.createHash('sha256').update(secret).digest('hex'), Date.now()],
    error => error ? reject(error) : resolve()
  ));
  return { account, secret };
}

test('the candle store is indexed by symbol so feed discovery never scans the table', async () => {
  // The feed discovery query filters by symbol only, while the table is keyed by
  // (feed, symbol, tf, t). Without an index on symbol that query was a full
  // table scan, and it ran on every SSE tick for every connected client on the
  // shared sqlite connection - which delayed the EA's own request past its
  // timeout and produced the "client-aborted request" reports.
  const { feed, db } = await setup();
  const plan = await new Promise((resolve, reject) => db.all(
    'EXPLAIN QUERY PLAN SELECT feed, MAX(updated_at) FROM market_candles WHERE symbol = ? GROUP BY feed',
    ['XAUUSD'],
    (error, rows) => error ? reject(error) : resolve(rows)
  ));
  const detail = plan.map(row => row.detail).join(' ');
  assert.match(detail, /USING (COVERING )?INDEX/i, `feed discovery must use an index, got: ${detail}`);
  assert.doesNotMatch(detail, /SCAN market_candles/i, `feed discovery must not scan the table, got: ${detail}`);
  feed.close();
});

test('two accounts on the same broker server do not flap the published price', async () => {
  // Both accounts publish to the same broker feed, so they share one stream.
  // Ownership must stay with the account that is actually publishing, otherwise
  // the visible bid flips between the two accounts on every request.
  const { clock, feed } = await setup();
  await feed.ingest(installation(1), payload(clock));
  assert.equal((await feed.currentView('XAUUSD')).bid, 2000.10);

  for (let i = 0; i < 5; i += 1) {
    clock.advance(2000);
    const standby = await feed.ingest(installation(2), payload(clock, { quotes: [quote(clock, { bid: 1900, ask: 1900.2 })] }));
    assert.equal(standby.status, 202, 'the second account stands by while the first publishes');
    clock.advance(2000);
    const primary = await feed.ingest(installation(1), payload(clock, { quotes: [quote(clock, { bid: 2001 + i, ask: 2001.2 + i })] }));
    assert.equal(primary.status, 200);
    assert.equal((await feed.currentView('XAUUSD')).bid, 2001 + i, 'the visible price must not flap between accounts');
  }
  feed.close();
});

test('a publisher that only sends candles keeps its ownership of the stream', async () => {
  // Ownership used to be derived from the visible quote, so an account that
  // only published candles was never seen as the owner and its candles were
  // dropped by the next account on the same broker.
  const { clock, feed } = await setup();
  const base = Math.floor(clock.value / 1000 / 60) * 60;
  const first = await feed.ingest(installation(1), payload(clock, { quotes: undefined, candles: [{ symbol: 'XAUUSD.a', tf: 'M1', bars: [bar(base)] }] }));
  assert.equal(first.status, 200);
  assert.equal(first.body.candles.accepted, 1);

  clock.advance(2000);
  const second = await feed.ingest(installation(2), payload(clock, { quotes: undefined, candles: [{ symbol: 'XAUUSD.a', tf: 'M1', bars: [bar(base + 60, { c: 2002 })] }] }));
  assert.equal(second.status, 202, 'the second account stands by while the first keeps publishing');
  assert.equal(second.body.candles.ignored, 1);
  assert.equal((await feed.getCandles('broker-live', 'XAUUSD', '1m', 10)).length, 1, "the owner's candles are kept");
  feed.close();
});

test('a failed candle store is reported as retryable and leaves the feed usable', async () => {
  // A storage failure must not look like a permanent data error, and it must
  // not leave the server unable to serve the next request.
  const clock = makeClock();
  const db = new sqlite3.Database(':memory:');
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now } });
  await feed.ready;
  const base = Math.floor(clock.value / 1000 / 60) * 60;

  // Break the candle store by dropping the table it writes to.
  await new Promise((resolve, reject) => db.exec('DROP TABLE market_candles', error => error ? reject(error) : resolve()));
  const failed = await feed.ingest(installation(1), payload(clock, {
    quotes: undefined,
    candles: [{ symbol: 'XAUUSD.a', tf: 'M1', bars: [bar(base)] }]
  }));
  assert.equal(failed.status, 503, 'a storage failure is retryable, not a permanent rejection');
  assert.match(failed.body.error, /retry/i);

  // The server still answers afterwards.
  await new Promise((resolve, reject) => db.exec('CREATE TABLE market_candles (feed TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, tv INTEGER, v REAL, updated_at INTEGER NOT NULL, PRIMARY KEY (feed, symbol, tf, t)) WITHOUT ROWID;', error => error ? reject(error) : resolve()));
  clock.advance(2000);
  const recovered = await feed.ingest(installation(1), payload(clock));
  assert.equal(recovered.status, 200, 'the feed recovers after a storage failure');
  assert.equal((await feed.currentView('XAUUSD')).bid, 2000.10);
  feed.close();
  db.close();
});

test('an account unlink does not collide with a concurrent market candle write', async () => {
  // Both modules use the same sqlite connection. Two overlapping transactions on
  // one connection fail with "cannot start a transaction within a transaction",
  // which used to break the unlink and lose the candle rows.
  const clock = makeClock();
  const db = new sqlite3.Database(':memory:');
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  const verifyToken = (req, res, next) => { req.user = { id: 1 }; next(); };
  const { authenticateInstallation } = registerMt5Api(app, db, verifyToken);
  const { account, secret } = await setupPairedEa(app, db);
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now } });
  feed.registerRoutes(app, { verifyToken, authenticateInstallation });
  const { server, base } = await listen(app);

  try {
    const base2 = Math.floor(clock.value / 1000 / 60) * 60;
    const bars = Array.from({ length: 200 }, (_, i) => bar(base2 + i * 60));
    const marketBody = JSON.stringify({
      schema: 1, sentAtMs: clock.value, serverUtcOffsetSec: 0,
      quotes: [{ symbol: 'XAUUSD.a', bid: 2000.1, ask: 2000.3, digits: 2, tickTimeMs: clock.value - 500 }],
      candles: [{ symbol: 'XAUUSD.a', tf: 'M1', bars }]
    });

    // Run the market post and the unlink at the same time.
    const market = fetch(`${base}/api/mt5/market`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: marketBody
    }).then(async response => ({ status: response.status, body: await response.json() }));
    const unlink = fetch(`${base}/api/mt5/accounts/${account.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' }
    }).then(async response => ({ status: response.status }));

    const [marketResult, unlinkResult] = await Promise.all([market, unlink]);
    assert.equal(marketResult.status, 200, 'the market post must not fail with a transaction error');
    assert.equal(unlinkResult.status, 200, 'the unlink must not fail with a transaction error');
    assert.equal(marketResult.body.error, undefined, 'no transaction collision error');
  } finally {
    feed.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('a heartbeat with many open positions is stored correctly and quickly', async () => {
  // Positions used to be written one statement at a time, which meant up to
  // 2,000 sequential round trips on the shared connection and delayed the EA's
  // own market request beyond its timeout.
  const clock = makeClock();
  const db = new sqlite3.Database(':memory:');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const verifyToken = (req, res, next) => { req.user = { id: 1 }; next(); };
  const { authenticateInstallation } = registerMt5Api(app, db, verifyToken);
  const { account, secret } = await setupPairedEa(app, db);
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now } });
  feed.registerRoutes(app, { verifyToken, authenticateInstallation });
  const { server, base } = await listen(app);

  try {
    const positions = Array.from({ length: 500 }, (_, i) => ({
      ticket: String(1000 + i), symbol: 'XAUUSD', direction: i % 2 ? 'SELL' : 'BUY', volume: 0.1,
      entryPrice: 2400, currentPrice: 2410, profit: 50, swap: 0, commission: 0,
      openedAt: new Date(clock.value - 60_000).toISOString()
    }));
    const started = Date.now();
    const response = await fetch(`${base}/api/mt5/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        timestamp: new Date(clock.value).toISOString(), balance: 5000, equity: 5050, floatingProfit: 50,
        margin: 50, freeMargin: 5000, eaName: 'CornGrid EA', eaVersion: '2.60', positions
      })
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);

    const stored = await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS c FROM mt5_positions WHERE account_id = ?', [account.id], (error, row) => error ? reject(error) : resolve(row.c)));
    assert.equal(stored, 500, 'every position must be stored');
    assert.ok(elapsed < 1000, `a 500-position heartbeat took ${elapsed} ms and must stay inside the EA budget`);

    // A second heartbeat that drops half the positions removes exactly those rows.
    const response2 = await fetch(`${base}/api/mt5/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        timestamp: new Date(clock.value + 1000).toISOString(), balance: 5000, equity: 5050, floatingProfit: 50,
        margin: 50, freeMargin: 5000, eaName: 'CornGrid EA', eaVersion: '2.60', positions: positions.slice(0, 250)
      })
    });
    assert.equal(response2.status, 200);
    const after = await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS c FROM mt5_positions WHERE account_id = ?', [account.id], (error, row) => error ? reject(error) : resolve(row.c)));
    assert.equal(after, 250, 'closed positions must be removed');
  } finally {
    feed.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
