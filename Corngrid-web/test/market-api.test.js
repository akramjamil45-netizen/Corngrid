const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const registerMarketApi = require('../market-api');
const createUserAuth = require('../user-auth');

// Mock upstream provider responses so tests never hit the network.
const dailyCandles = [
  { time: Math.floor(Date.now() / 1000) - 2 * 86400, open: 2380, high: 2400, low: 2370, close: 2390, volume: null },
  { time: Math.floor(Date.now() / 1000) - 86400, open: 2390, high: 2420, low: 2385, close: 2410, volume: null },
  { time: Math.floor(Date.now() / 1000), open: 2410, high: 2430, low: 2400, close: 2425.5, volume: null }
];

function stubGlobalFetch(calls) {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    // Let the test's own HTTP calls to the local server pass through untouched.
    if (parsed.hostname !== 'query1.finance.yahoo.com' && parsed.hostname !== 'api.twelvedata.com') {
      return realFetch(url, options);
    }
    calls.push(String(url));
    if (parsed.hostname === 'query1.finance.yahoo.com') {
      const intraday = !['1d', '1wk'].includes(parsed.searchParams.get('interval'));
      const rows = intraday
        ? dailyCandles.flatMap(candle => [0, 3600, 7200].map(offset => ({
            time: candle.time + offset,
            open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: null
          })))
        : dailyCandles;
      return {
        status: 200,
        json: async () => ({
          chart: {
            result: [{
              timestamp: rows.map(row => row.time),
              indicators: { quote: [{ open: rows.map(r => r.open), high: rows.map(r => r.high), low: rows.map(r => r.low), close: rows.map(r => r.close), volume: rows.map(() => 0) }] }
            }],
            error: null
          }
        })
      };
    }
    return { status: 404, json: async () => ({}) };
  };
}

test('Market Overview API validates input, serves candles, and stores per-user drawings', async () => {
  const calls = [];
  stubGlobalFetch(calls);

  const db = new sqlite3.Database(':memory:');
  const app = express();
  const jwtSecret = 'test-signing-secret-for-market';
  app.use(express.json());
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT);
    INSERT INTO users (id, username, email, password, bio, created_at) VALUES (1, 'Alice', 'a@t.test', 'x', '', CURRENT_TIMESTAMP), (2, 'Bob', 'b@t.test', 'x', '', CURRENT_TIMESTAMP);
    CREATE TABLE user_auth_versions (user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
  `, error => error ? reject(error) : resolve()));

  const verifyToken = createUserAuth({ db, jwtSecret });
  registerMarketApi(app, db, verifyToken);
  await new Promise((resolve, reject) => db.get('SELECT 1', error => error ? reject(error) : resolve()));

  const server = await new Promise(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const aliceToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const bobToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);
  const request = (path, token, options = {}) => fetch(origin + path, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
  });

  try {
    assert.equal((await request('/api/market/summary')).status, 401, 'market endpoints require authentication');
    assert.equal((await request('/api/market/summary?symbol=FAKE', aliceToken)).status, 400, 'unsupported symbols are rejected');
    assert.equal((await request('/api/market/candles?symbol=XAUUSD&interval=2h', aliceToken)).status, 400, 'unsupported timeframes are rejected');

    const summaryResponse = await request('/api/market/summary?symbol=XAUUSD', aliceToken);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.symbol, 'XAUUSD');
    assert.equal(summary.price, 2425.5, 'price comes from the latest genuine daily close');
    assert.ok(Math.abs(summary.change - 15.5) < 1e-9, 'change is computed from previous daily close');
    assert.ok(summary.changePercent > 0, 'positive day shows positive change');
    assert.ok(summary.attribution.includes('Yahoo Finance'), 'provider attribution is exposed');

    const candlesResponse = await request('/api/market/candles?symbol=XAUUSD&interval=1h&outputsize=50', aliceToken);
    assert.equal(candlesResponse.status, 200);
    const candlesPayload = await candlesResponse.json();
    assert.ok(candlesPayload.candles.length >= 3);
    const sorted = candlesPayload.candles.every((candle, index, all) => index === 0 || candle.time > all[index - 1].time);
    assert.ok(sorted, 'candles are sorted ascending for the chart');
    assert.ok(candlesPayload.candles.every(candle => Number.isFinite(candle.open) && Number.isFinite(candle.close)));

    // Drawings: create, list, isolate per user, delete.
    const hline = await request('/api/market/drawings', aliceToken, { method: 'POST', body: JSON.stringify({ symbol: 'XAUUSD', kind: 'hline', data: { price: 2400 } }) });
    assert.equal(hline.status, 201);
    const trend = await request('/api/market/drawings', aliceToken, { method: 'POST', body: JSON.stringify({ symbol: 'XAUUSD', kind: 'trend', data: { points: [{ time: 1000, price: 2390 }, { time: 2000, price: 2420 }] } }) });
    assert.equal(trend.status, 201);
    assert.equal((await request('/api/market/drawings', aliceToken, { method: 'POST', body: JSON.stringify({ symbol: 'XAUUSD', kind: 'trend', data: { points: [{ time: 1, price: 1 }] } }) })).status, 400, 'malformed trend lines are rejected');
    assert.equal((await request('/api/market/drawings', aliceToken, { method: 'POST', body: JSON.stringify({ symbol: 'XAUUSD', kind: 'arrow', data: { price: 1 } }) })).status, 400, 'unknown drawing kinds are rejected');

    const aliceList = await (await request('/api/market/drawings?symbol=XAUUSD', aliceToken)).json();
    assert.equal(aliceList.drawings.length, 2, 'the owner sees both drawings');
    const bobList = await (await request('/api/market/drawings?symbol=XAUUSD', bobToken)).json();
    assert.equal(bobList.drawings.length, 0, 'drawings stay isolated per authenticated user');

    const drawingId = aliceList.drawings[0].id;
    assert.equal((await request(`/api/market/drawings/${drawingId}`, bobToken, { method: 'DELETE' })).status, 404, 'another user cannot delete a drawing');
    assert.equal((await request(`/api/market/drawings/${drawingId}`, aliceToken, { method: 'DELETE' })).status, 200);
    const afterDelete = await (await request('/api/market/drawings?symbol=XAUUSD', aliceToken)).json();
    assert.equal(afterDelete.drawings.length, 1, 'the owner can delete their drawing');

    // Caching: repeated identical reads must not create duplicate upstream calls.
    const before = calls.length;
    await request('/api/market/candles?symbol=XAUUSD&interval=1h&outputsize=50', aliceToken);
    assert.equal(calls.length, before, 'repeated candle reads are served from cache');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    delete global.fetch;
  }
});

