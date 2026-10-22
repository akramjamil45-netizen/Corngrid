const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const registerMarketApi = require('../market-api');
const registerMt5Api = require('../mt5-api');
const createMarketFeed = require('../market-feed');

const SYMBOLS = registerMarketApi.SYMBOLS;
const EXAMPLE = { feedA: 'BrokerA-Live', feedB: 'BrokerB-Demo' };

function makeClock(start = Date.UTC(2030, 0, 1, 12, 0, 0)) {
  const clock = { value: start, now: () => clock.value, advance(ms) { clock.value += ms; } };
  return clock;
}

function installation(id, broker = EXAMPLE.feedA) {
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

test('valid EA data is accepted and broker suffixes map to website symbols', async () => {
  const { clock, feed } = await setup();
  const result = await feed.ingest(installation(1), payload(clock));
  assert.equal(result.status, 200);
  assert.equal(result.body.quotes.accepted, 1);
  const view = await feed.currentView('XAUUSD');
  assert.equal(view.bid, 2000.10);
  assert.equal(view.brokerSymbol, 'XAUUSD.a');
  assert.equal(view.last, null, 'missing last price stays null rather than zero');
  assert.equal(view.state, 'LIVE');
  assert.equal(view.source.kind, 'corngrid-ea');
  feed.close();
});

test('malformed or invalid market data is rejected', async () => {
  const { clock, feed } = await setup();
  const bad = [
    null,
    {},
    payload(clock, { quotes: [quote(clock, { bid: 'abc' })] }),
    payload(clock, { quotes: [quote(clock, { bid: 0 })] }),
    payload(clock, { quotes: [quote(clock, { ask: 1990 })] }),
    payload(clock, { quotes: [quote(clock, { last: 0 })] }),
    payload(clock, { quotes: [quote(clock, { symbol: 'XAU USD<script>' })] }),
    payload(clock, { quotes: [quote(clock, { tickTimeMs: clock.value + 10 * 60_000 })] }),
    payload(clock, { quotes: undefined, candles: [{ symbol: 'XAUUSD', tf: 'M1', bars: [bar(1, { h: 1 })] }] }),
    payload(clock, { quotes: undefined, candles: [{ symbol: 'XAUUSD', tf: 'M2', bars: [bar(1700000000)] }] }),
    payload(clock, { quotes: Array(40).fill(quote(clock)) }),
    { schema: 1, sentAtMs: clock.value }
  ];
  for (const body of bad) {
    const result = await feed.ingest(installation(1), body);
    assert.ok(result.status === 400, `expected 400, got ${result.status} for ${JSON.stringify(body)?.slice(0, 80)}`);
  }
  const skewed = await feed.ingest(installation(1), payload(clock, { sentAtMs: clock.value - 3600_000 }));
  assert.equal(skewed.status, 422);
  assert.equal(await feed.currentView('XAUUSD'), null, 'nothing was stored');
  feed.close();
});

test('unmappable symbols are reported and not stored', async () => {
  const { clock, feed } = await setup();
  const result = await feed.ingest(installation(1), payload(clock, { quotes: [quote(clock, { symbol: 'US30' })] }));
  assert.equal(result.status, 422);
  assert.deepEqual(result.body.quotes.unmapped, ['US30']);
  feed.close();
});

test('stale or replayed updates never overwrite newer data', async () => {
  const { clock, feed } = await setup();
  await feed.ingest(installation(1), payload(clock));
  clock.advance(2000);
  const newer = await feed.ingest(installation(1), payload(clock, { quotes: [quote(clock, { bid: 2001, ask: 2001.2 })] }));
  assert.equal(newer.status, 200);

  const replay = await feed.ingest(installation(1), payload(clock, { sentAtMs: clock.value - 1500, quotes: [quote(clock, { bid: 1500, ask: 1500.2 })] }));
  assert.equal(replay.status, 202);
  assert.equal(replay.body.reason, 'stale');
  assert.equal((await feed.currentView('XAUUSD')).bid, 2001);

  clock.advance(1000);
  const olderTick = await feed.ingest(installation(1), payload(clock, { quotes: [quote(clock, { bid: 1999, ask: 1999.2, tickTimeMs: clock.value - 60_000 })] }));
  assert.equal(olderTick.status, 202);
  assert.equal((await feed.currentView('XAUUSD')).bid, 2001, 'older tick ignored');
  feed.close();
});

test('state follows server receipt time: LIVE, DELAYED, STALE, OFFLINE and quiet market flag', async () => {
  const { clock, feed } = await setup();
  await feed.ingest(installation(1), payload(clock));
  assert.equal((await feed.currentView('XAUUSD')).state, 'LIVE');
  clock.advance(20_000);
  assert.equal((await feed.currentView('XAUUSD')).state, 'DELAYED');
  clock.advance(40_000);
  assert.equal((await feed.currentView('XAUUSD')).state, 'STALE');
  clock.advance(120_000);
  const offline = await feed.currentView('XAUUSD');
  assert.equal(offline.state, 'OFFLINE');

  // Reconnect restores live updates.
  await feed.ingest(installation(1), payload(clock, { quotes: [quote(clock, { bid: 2005, ask: 2005.2 })] }));
  const back = await feed.currentView('XAUUSD');
  assert.equal(back.state, 'LIVE');
  assert.equal(back.bid, 2005);

  // Connected but unchanged tick for a long time: LIVE yet flagged quiet, never silently "fresh".
  for (let i = 0; i < 12; i += 1) {
    clock.advance(9000);
    await feed.ingest(installation(1), payload(clock, { quotes: [quote(clock, { bid: 2005, ask: 2005.2, tickTimeMs: back.tickTime ? Date.parse(back.tickTime) : clock.value - 500 })] }));
  }
  const quiet = await feed.currentView('XAUUSD');
  assert.equal(quiet.state, 'LIVE');
  assert.equal(quiet.quiet, true);
  feed.close();
});

test('a standby publisher cannot override a healthy primary; takeover happens after it goes silent', async () => {
  const { clock, feed } = await setup();
  await feed.ingest(installation(1), payload(clock));
  clock.advance(2000);
  const standby = await feed.ingest(installation(2), payload(clock, { quotes: [quote(clock, { bid: 1900, ask: 1900.2 })] }));
  assert.equal(standby.status, 202);
  assert.equal(standby.body.reason, 'standby');
  assert.equal((await feed.currentView('XAUUSD')).bid, 2000.10);

  clock.advance(20_000);
  const takeover = await feed.ingest(installation(2), payload(clock, { quotes: [quote(clock, { bid: 1900, ask: 1900.2 })] }));
  assert.equal(takeover.status, 200);
  assert.equal((await feed.currentView('XAUUSD')).bid, 1900);
  feed.close();
});

test('different brokers are never merged; a healthy feed beats a stale one and preferred feed wins when healthy', async () => {
  const { clock, feed } = await setup();
  await feed.ingest(installation(1, EXAMPLE.feedA), payload(clock));
  clock.advance(60_000);
  await feed.ingest(installation(3, EXAMPLE.feedB), payload(clock, { quotes: [quote(clock, { bid: 2100, ask: 2100.2 })] }));
  let view = await feed.currentView('XAUUSD');
  assert.equal(view.feed.id, 'brokerb-demo');
  assert.equal(view.bid, 2100);
  assert.equal((await feed.currentView('XAUUSD', 'brokera-live')).bid, 2000.10, 'explicit selection returns that broker only');

  const pref = await setup({ preferredFeed: 'brokera-live' });
  await pref.feed.ingest(installation(1, EXAMPLE.feedA), payload(pref.clock));
  pref.clock.advance(1000);
  await pref.feed.ingest(installation(3, EXAMPLE.feedB), payload(pref.clock, { quotes: [quote(pref.clock, { bid: 2100, ask: 2100.2 })] }));
  assert.equal((await pref.feed.currentView('XAUUSD')).feed.id, 'brokera-live');
  pref.clock.advance(60_000);
  await pref.feed.ingest(installation(3, EXAMPLE.feedB), payload(pref.clock, { quotes: [quote(pref.clock, { bid: 2100, ask: 2100.2 })] }));
  assert.equal((await pref.feed.currentView('XAUUSD')).feed.id, 'brokerb-demo', 'stale preferred feed yields to healthy feed');
  feed.close();
  pref.feed.close();
});

test('historical candles and live tail updates are stored and bounded', async () => {
  const { clock, feed } = await setup();
  const base = Math.floor(clock.value / 1000 / 60) * 60 - 60 * 100;
  const history = Array.from({ length: 100 }, (_, i) => bar(base + i * 60, { c: 2000 + i * 0.01, h: 2005 + i * 0.01 }));
  const first = await feed.ingest(installation(1), payload(clock, { candles: [{ symbol: 'XAUUSD.a', tf: 'M1', bars: history }] }));
  assert.equal(first.status, 200);
  assert.equal(first.body.candles.accepted, 100);

  clock.advance(2000);
  const tail = bar(base + 99 * 60, { c: 2010, h: 2011 });
  await feed.ingest(installation(1), payload(clock, { candles: [{ symbol: 'XAUUSD.a', tf: 'M1', bars: [tail] }] }));
  const stored = await feed.getCandles('brokera-live', 'XAUUSD', '1m', 500);
  assert.equal(stored.length, 100, 'forming candle is updated in place, not duplicated');
  assert.equal(stored[99].close, 2010);
  assert.ok(stored[0].time < stored[99].time, 'ascending order');
  assert.deepEqual(await feed.getCandles('brokera-live', 'XAUUSD', '5m', 10), [], 'no fabricated history for untransmitted timeframes');

  // Duplicate timestamps in one series are rejected.
  const dup = await feed.ingest(installation(1), payload(clock, { sentAtMs: clock.value + 1, quotes: undefined, candles: [{ symbol: 'XAUUSD', tf: 'M1', bars: [bar(base), bar(base)] }] }));
  assert.equal(dup.status, 400);
  feed.close();
});

test('a full-size backfill is stored correctly and answered well inside the EA timeout', async () => {
  // The EA aborts its WebRequest after 1000 ms. A backfill of the maximum payload
  // (2,000 bars) used to be written one row per SQL statement, which took longer
  // than that timeout, so the EA dropped the upload mid-body and the server
  // logged the request as client-aborted. The rows are now written in batches.
  const clock = makeClock(Date.now());
  const db = new sqlite3.Database(':memory:');
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now } });
  await feed.ready;

  const base = Math.floor(clock.value / 1000 / 60) * 60 - 60 * 1000;
  const series = tf => Array.from({ length: 1000 }, (_, i) => bar(base + i * 60, { c: 2000 + (i % 50) * 0.01 }));
  const body = payload(clock, {
    quotes: undefined,
    candles: [
      { symbol: 'XAUUSD.a', tf: 'M1', bars: series('M1') },
      { symbol: 'XAUUSD.a', tf: 'M5', bars: series('M5') }
    ]
  });

  const started = Date.now();
  const result = await feed.ingest(installation(1), body);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 200);
  assert.equal(result.body.candles.accepted, 2000);
  assert.ok(elapsed < 1000, `ingest of the maximum payload took ${elapsed} ms and must stay under the EA timeout`);

  // Every bar of both series is present and correct - batching must not lose rows.
  const m1 = await feed.getCandles('brokera-live', 'XAUUSD', '1m', 1200);
  assert.equal(m1.length, 1000);
  assert.equal(m1[0].time, base);
  assert.equal(m1[999].close, 2000 + (999 % 50) * 0.01);
  const m5 = await feed.getCandles('brokera-live', 'XAUUSD', '5m', 1200);
  assert.equal(m5.length, 1000);
  assert.ok(m1.every(candle => candle.open === 2000 && candle.high === 2002 && candle.low === 1999));

  // Re-sending the same history updates in place instead of duplicating rows.
  clock.advance(2000);
  const again = await feed.ingest(installation(1), payload(clock, { quotes: undefined, candles: body.candles }));
  assert.equal(again.status, 200);
  assert.equal((await feed.getCandles('brokera-live', 'XAUUSD', '1m', 1200)).length, 1000);

  feed.close();
  db.close();
});

test('a client that disconnects mid-upload does not break the server or the next request', async () => {
  const clock = makeClock(Date.now());
  const db = new sqlite3.Database(':memory:');
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  const verifyToken = (req, res, next) => { req.user = { id: 1 }; next(); };
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now } });
  feed.registerRoutes(app, { verifyToken, authenticateInstallation: (req, res, next) => { req.installation = installation(1); next(); } });
  const { server, base } = await listen(app);
  try {
    // Send a truncated body and drop the socket, like an EA that gives up waiting.
    const aborted = new Promise(resolve => {
      const request = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/mt5/market', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' }
      });
      request.on('error', () => resolve());
      request.write('{"schema":1,"sentAtMs":');
      setTimeout(() => { request.destroy(); resolve(); }, 30);
    });
    await aborted;

    // The server stays healthy and keeps accepting EA updates afterwards.
    const response = await fetch(`${base}/api/mt5/market`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(clock))
    });
    assert.equal(response.status, 200);
    assert.equal((await feed.currentView('XAUUSD')).bid, 2000.10);
  } finally {
    feed.close();
    await new Promise(resolve => server.close(resolve));
  }
});

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('HTTP: invalid credentials are rejected and valid EA requests are accepted via the real installation auth', async () => {
  const clock = makeClock(Date.now());
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec(
    `CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT);
     CREATE TABLE password_reset_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER, used_at INTEGER, created_at INTEGER);
     INSERT INTO users (id, username, email, password) VALUES (1, 'Alice', 'a@t.test', 'x');`,
    error => error ? reject(error) : resolve()));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  const verifyToken = (req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); };
  const { authenticateInstallation } = registerMt5Api(app, db, verifyToken);
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now } });
  feed.registerRoutes(app, { verifyToken, authenticateInstallation });
  registerMarketApi(app, db, verifyToken, feed);
  const { server, base } = await listen(app);
  try {
    const post = (body, token) => fetch(`${base}/api/mt5/market`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    assert.equal((await post(payload(clock))).status, 401);
    assert.equal((await post(payload(clock), 'f'.repeat(64))).status, 401);
    assert.equal((await post(payload(clock), 'not-hex')).status, 401);

    // Pair a real installation to get a valid credential.
    const code = 'ABCDEF12';
    const crypto = require('node:crypto');
    await new Promise((resolve, reject) => db.run(
      'INSERT INTO mt5_pairing_codes (code_hash, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)',
      [crypto.createHash('sha256').update(code).digest('hex'), Date.now() + 60_000, Date.now()], e => e ? reject(e) : resolve()));
    const paired = await fetch(`${base}/api/mt5/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, accountNumber: '123456', brokerServer: EXAMPLE.feedA, currency: 'USD', eaVersion: '2.60' })
    });
    assert.equal(paired.status, 201);
    const { installationSecret } = await paired.json();

    clock.value = Date.now();
    const ok = await post(payload(clock), installationSecret);
    assert.equal(ok.status, 200);

    // Market Overview reads the EA feed first; nothing external is called.
    const summary = await (await fetch(`${base}/api/market/summary?symbol=XAUUSD`)).json();
    assert.equal(summary.source.kind, 'corngrid-ea');
    assert.equal(summary.bid, 2000.10);
    assert.equal(summary.state, 'LIVE');
    assert.equal(summary.change, null, 'no daily candle history yet, so no fabricated change');

    // Offline publisher: not presented as live.
    clock.advance(10 * 60_000);
    const offline = await (await fetch(`${base}/api/market/summary?symbol=XAUUSD`)).json();
    assert.equal(offline.state, 'OFFLINE');

    // No feed for another symbol and fallback disabled: honest unavailable state.
    const none = await fetch(`${base}/api/market/summary?symbol=EURUSD`);
    assert.equal(none.status, 503);
    assert.equal((await none.json()).state, 'OFFLINE');
    const noCandles = await fetch(`${base}/api/market/candles?symbol=EURUSD&interval=1h`);
    assert.equal(noCandles.status, 503);
    assert.equal((await fetch(`${base}/api/market/quote?symbol=BAD`)).status, 400);
  } finally {
    feed.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP: external fallback is used only when enabled and is labeled as fallback', async () => {
  const clock = makeClock(Date.now());
  const db = new sqlite3.Database(':memory:');
  const app = express();
  app.use(express.json());
  const verifyToken = (req, res, next) => { req.user = { id: 1 }; next(); };
  await new Promise((resolve, reject) => db.exec(
    'CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT);',
    error => error ? reject(error) : resolve()));
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now, fallbackEnabled: true } });
  feed.registerRoutes(app, { verifyToken, authenticateInstallation: (req, res, next) => { req.installation = installation(1); next(); } });
  registerMarketApi(app, db, verifyToken, feed);

  const realFetch = global.fetch;
  const day = Math.floor(Date.now() / 1000);
  global.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== 'query1.finance.yahoo.com') return realFetch(url, options);
    const times = [day - 172800, day - 86400, day];
    return {
      status: 200,
      json: async () => ({ chart: { result: [{ timestamp: times, indicators: { quote: [{ open: [1, 1, 1], high: [2, 2, 2], low: [1, 1, 1], close: [1.5, 1.6, 1.7], volume: [0, 0, 0] }] } }], error: null } })
    };
  };
  const { server, base } = await listen(app);
  try {
    const fallback = await (await fetch(`${base}/api/market/summary?symbol=EURUSD`)).json();
    assert.equal(fallback.state, 'FALLBACK');
    assert.equal(fallback.source.kind, 'fallback');
    assert.match(fallback.source.label, /not CornGrid EA/);

    // A fresh EA feed takes precedence over the fallback.
    const post = await fetch(`${base}/api/mt5/market`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(clock, { quotes: [quote(clock, { symbol: 'EURUSD', bid: 1.1, ask: 1.10002, digits: 5 })] }))
    });
    assert.equal(post.status, 200);
    const live = await (await fetch(`${base}/api/market/summary?symbol=EURUSD`)).json();
    assert.equal(live.source.kind, 'corngrid-ea');
    assert.equal(live.state, 'LIVE');

    // EA goes offline: the fallback returns and is labeled as such, never as live EA data.
    clock.advance(10 * 60_000);
    const after = await (await fetch(`${base}/api/market/summary?symbol=EURUSD`)).json();
    assert.equal(after.source.kind, 'fallback');
    assert.equal(after.state, 'FALLBACK');
  } finally {
    global.fetch = realFetch;
    feed.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('SSE stream pushes new quotes to subscribed clients and cleans up on disconnect', async () => {
  const clock = makeClock(Date.now());
  const db = new sqlite3.Database(':memory:');
  const app = express();
  app.use(express.json());
  const verifyToken = (req, res, next) => { req.user = { id: 7 }; next(); };
  const feed = createMarketFeed({ db, symbols: SYMBOLS, config: { now: clock.now, streamIntervalMs: 50 } });
  feed.registerRoutes(app, { verifyToken, authenticateInstallation: (req, res, next) => { req.installation = installation(1); next(); } });
  const { server, base } = await listen(app);
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/api/market/stream?symbol=XAUUSD`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async needle => {
      const deadline = Date.now() + 4000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer.includes(needle);
    };
    assert.ok(await readUntil('event: snapshot'));
    assert.equal(feed.clientCount(), 1);

    await fetch(`${base}/api/mt5/market`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(clock)) });
    assert.ok(await readUntil('event: quote'));
    assert.match(buffer, /"bid":2000\.1/);

    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(feed.clientCount(), 0);
  } finally {
    controller.abort();
    feed.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('mapSymbol handles broker prefixes/suffixes and rejects ambiguous names', () => {
  const keys = Object.keys(SYMBOLS);
  assert.equal(createMarketFeed.mapSymbol('XAUUSD', keys), 'XAUUSD');
  assert.equal(createMarketFeed.mapSymbol('XAUUSD.a', keys), 'XAUUSD');
  assert.equal(createMarketFeed.mapSymbol('m.EURUSD', keys), 'EURUSD');
  assert.equal(createMarketFeed.mapSymbol('GBPUSDpro', keys), 'GBPUSD');
  assert.equal(createMarketFeed.mapSymbol('EURUSDXAUUSD', keys), null);
  assert.equal(createMarketFeed.mapSymbol('US30', keys), null);
  assert.equal(createMarketFeed.mapSymbol('GOLD', keys, new Map([['GOLD', 'XAUUSD']])), 'XAUUSD');
});
