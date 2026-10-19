'use strict';

// Market Overview API: public market data (provider abstraction) + per-user chart drawings.
// Providers: Twelve Data (primary, requires TWELVE_DATA_API_KEY) and Yahoo Finance (keyless fallback).
// Secret keys stay server-side only; the browser only ever calls these /api/market endpoints.

const SYMBOLS = Object.freeze({
  XAUUSD: { twelvedata: 'XAU/USD', yahoo: 'GC=F', label: 'Gold / US Dollar' },
  GBPUSD: { twelvedata: 'GBP/USD', yahoo: 'GBPUSD=X', label: 'British Pound / US Dollar' },
  EURUSD: { twelvedata: 'EUR/USD', yahoo: 'EURUSD=X', label: 'Euro / US Dollar' },
  USDJPY: { twelvedata: 'USD/JPY', yahoo: 'USDJPY=X', label: 'US Dollar / Japanese Yen' }
});

const INTERVALS = Object.freeze({
  '1m': { twelvedata: '1min', yahoo: '1m', yahooRange: '5d', ttlMs: 60_000 },
  '5m': { twelvedata: '5min', yahoo: '5m', yahooRange: '1mo', ttlMs: 60_000 },
  '15m': { twelvedata: '15min', yahoo: '15m', yahooRange: '1mo', ttlMs: 60_000 },
  '30m': { twelvedata: '30min', yahoo: '30m', yahooRange: '1mo', ttlMs: 60_000 },
  '1h': { twelvedata: '1h', yahoo: '60m', yahooRange: '3mo', ttlMs: 120_000 },
  '4h': { twelvedata: '4h', yahoo: '60m', yahooRange: '6mo', yahooAggregate: 4, ttlMs: 300_000 },
  '1d': { twelvedata: '1day', yahoo: '1d', yahooRange: '1y', ttlMs: 300_000 },
  '1w': { twelvedata: '1week', yahoo: '1wk', yahooRange: '5y', ttlMs: 900_000 }
});

const FETCH_TIMEOUT_MS = 8_000;
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CornGridMarket/1.0';

function validCandle(candle) {
  return candle
    && Number.isFinite(candle.time) && candle.time > 0
    && Number.isFinite(candle.open) && Number.isFinite(candle.high)
    && Number.isFinite(candle.low) && Number.isFinite(candle.close);
}

function aggregateCandles(candles, factor) {
  const bucketSeconds = factor * 3600;
  const buckets = new Map();
  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const current = buckets.get(bucketTime);
    if (!current) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume == null ? null : candle.volume
      });
    } else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      if (current.volume == null || candle.volume == null) current.volume = null;
      else current.volume += candle.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}


// Normalized provider result: { candles: [{time(seconds),open,high,low,close,volume|null}], instrumentNote }
async function fetchYahooCandles(symbolKey, intervalKey, outputsize) {
  const symbol = SYMBOLS[symbolKey];
  const interval = INTERVALS[intervalKey];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.yahoo)}`
    + `?interval=${encodeURIComponent(interval.yahoo)}&range=${encodeURIComponent(interval.yahooRange)}`;
  const { status, body } = await fetchJson(url, { 'User-Agent': YAHOO_UA });
  if (status === 429) {
    const error = new Error('The market data provider is rate limiting requests.');
    error.statusCode = 429;
    throw error;
  }
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) {
    const message = body && body.chart && body.chart.error && body.chart.error.description;
    const error = new Error(message || 'The market data provider returned no data for this instrument.');
    error.statusCode = status === 200 ? 502 : status;
    throw error;
  }
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote) {
    const error = new Error('The market data provider returned an unexpected response.');
    error.statusCode = 502;
    throw error;
  }
  let candles = result.timestamp
    .map((time, index) => ({
      time,
      open: quote.open ? quote.open[index] : null,
      high: quote.high ? quote.high[index] : null,
      low: quote.low ? quote.low[index] : null,
      close: quote.close ? quote.close[index] : null,
      volume: quote.volume ? quote.volume[index] : null
    }))
    .filter(validCandle)
    .map(candle => ({
      ...candle,
      volume: Number.isFinite(candle.volume) && candle.volume > 0 ? candle.volume : null
    }));
  if (interval.yahooAggregate) candles = aggregateCandles(candles, interval.yahooAggregate);
  candles = candles.slice(-outputsize);
  const instrumentNote = symbolKey === 'XAUUSD'
    ? 'Gold is shown from Yahoo Finance gold futures (GC=F) as the closest freely available instrument.'
    : null;
  return { candles, instrumentNote };
}

async function fetchTwelveDataCandles(apiKey, symbolKey, intervalKey, outputsize) {
  const symbol = SYMBOLS[symbolKey];
  const interval = INTERVALS[intervalKey];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol.twelvedata)}`
    + `&interval=${encodeURIComponent(interval.twelvedata)}&outputsize=${outputsize}&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`;
  const { status, body } = await fetchJson(url);
  if (status === 401) {
    const error = new Error('The configured Twelve Data API key was rejected.');
    error.statusCode = 502;
    throw error;
  }
  if (status === 429 || (body && body.code === 429)) {
    const error = new Error('The market data provider is rate limiting requests.');
    error.statusCode = 429;
    throw error;
  }
  if (!body || body.status !== 'ok' || !Array.isArray(body.values)) {
    const error = new Error((body && body.message) || 'The market data provider returned no data for this instrument.');
    error.statusCode = status === 200 ? 502 : status;
    throw error;
  }
  const candles = body.values
    .map(row => ({
      time: Date.parse(`${String(row.datetime).replace(' ', 'T')}Z`) / 1000,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume != null && Number(row.volume) > 0 ? Number(row.volume) : null
    }))
    .filter(validCandle)
    .sort((a, b) => a.time - b.time)
    .slice(-outputsize);
  return { candles, instrumentNote: null };
}


function createMarketData({ apiKey }) {
  const primaryAvailable = Boolean(apiKey && apiKey.trim());
  const providerName = primaryAvailable ? 'twelvedata' : 'yahoo';
  return {
    name: providerName,
    label: primaryAvailable ? 'Twelve Data' : 'Yahoo Finance',
    attribution: primaryAvailable ? 'Market data provided by Twelve Data.' : 'Market data provided by Yahoo Finance.',
    // Twelve Data free tier: historical forex/commodity data, may be delayed. Yahoo: unofficial public endpoint, may be delayed.
    dataStatus: 'Delayed',
    async fetchCandles(symbolKey, intervalKey, outputsize) {
      if (primaryAvailable) {
        try {
          return await fetchTwelveDataCandles(apiKey.trim(), symbolKey, intervalKey, outputsize);
        } catch (error) {
          // Fall back to Yahoo only for availability/rate problems, not for user-input errors.
          if (error.statusCode !== 429 && error.statusCode !== 502 && error.statusCode !== 503) throw error;
        }
      }
      return fetchYahooCandles(symbolKey, intervalKey, outputsize);
    }
  };
}

// In-memory response cache with per-interval TTL; keeps free-tier usage low.
function createCandleCache() {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (store.size > 200) {
        const now = Date.now();
        for (const [staleKey, entry] of store) {
          if (entry.expiresAt <= now) store.delete(staleKey);
        }
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
  };
}

// Simple per-user token bucket to respect provider free-tier limits.
function rateLimiter({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 1000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }
    const key = req.user && req.user.id ? req.user.id : req.ip;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many market data requests. Please wait a moment and try again.' });
    }
    return next();
  };
}

function registerMarketApi(app, db, verifyToken) {
  const market = createMarketData({ apiKey: process.env.TWELVE_DATA_API_KEY });
  const cache = createCandleCache();
  const marketReadLimit = rateLimiter({ limit: 30, windowMs: 60_000 });

  db.exec(`
    CREATE TABLE IF NOT EXISTS market_drawings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('hline', 'trend')),
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS market_drawings_user_symbol ON market_drawings(user_id, symbol);
  `, error => {
    if (error) console.error('Unable to initialize market drawings table:', error.message);
  });

  // GET /api/market/summary?symbol=XAUUSD — latest price + daily change from the daily series.
  app.get('/api/market/summary', verifyToken, marketReadLimit, async (req, res) => {
    const symbolKey = String(req.query.symbol || '').toUpperCase();
    if (!Object.hasOwn(SYMBOLS, symbolKey)) {
      return res.status(400).json({ error: 'Unsupported symbol. Choose XAUUSD, EURUSD, GBPUSD, or USDJPY.' });
    }
    const cacheKey = `summary:${market.name}:${symbolKey}`;
    try {
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);
      const { candles, instrumentNote } = await market.fetchCandles(symbolKey, '1d', 30);
      if (candles.length < 2) {
        return res.status(502).json({ error: 'The market data provider did not return enough history for this instrument.' });
      }
      const latest = candles[candles.length - 1];
      // Find the previous completed daily candle (skip the latest if it is still forming).
      const previous = candles[candles.length - 2];
      const change = latest.close - previous.close;
      const changePercent = previous.close !== 0 ? (change / previous.close) * 100 : 0;
      const payload = {
        symbol: symbolKey,
        label: SYMBOLS[symbolKey].label,
        price: latest.close,
        change,
        changePercent,
        dayOpen: latest.open,
        dayHigh: latest.high,
        dayLow: latest.low,
        previousClose: previous.close,
        lastUpdate: new Date(latest.time * 1000).toISOString(),
        provider: market.label,
        attribution: market.attribution,
        dataStatus: market.dataStatus,
        instrumentNote
      };
      cache.set(cacheKey, payload, 60_000);
      return res.json(payload);
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.error('Market summary failed:', error.message);
      return res.status(statusCode).json({ error: `Unable to load market summary: ${error.message}` });
    }
  });

  // GET /api/market/candles?symbol=XAUUSD&interval=1h&outputsize=500
  app.get('/api/market/candles', verifyToken, marketReadLimit, async (req, res) => {
    const symbolKey = String(req.query.symbol || '').toUpperCase();
    const intervalKey = String(req.query.interval || '1h');
    if (!Object.hasOwn(SYMBOLS, symbolKey)) {
      return res.status(400).json({ error: 'Unsupported symbol. Choose XAUUSD, EURUSD, GBPUSD, or USDJPY.' });
    }
    if (!Object.hasOwn(INTERVALS, intervalKey)) {
      return res.status(400).json({ error: 'Unsupported timeframe. Choose 1m, 5m, 15m, 30m, 1h, 4h, 1d, or 1w.' });
    }
    const requested = Number.parseInt(req.query.outputsize, 10);
    const outputsize = Number.isSafeInteger(requested) ? Math.min(1000, Math.max(20, requested)) : 500;
    const cacheKey = `candles:${market.name}:${symbolKey}:${intervalKey}:${outputsize}`;
    try {
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);
      const { candles, instrumentNote } = await market.fetchCandles(symbolKey, intervalKey, outputsize);
      if (!candles.length) {
        return res.status(502).json({ error: 'The market data provider returned no candles for this instrument and timeframe.' });
      }
      const payload = {
        symbol: symbolKey,
        interval: intervalKey,
        candles,
        provider: market.label,
        attribution: market.attribution,
        dataStatus: market.dataStatus,
        instrumentNote,
        lastUpdate: new Date().toISOString()
      };
      cache.set(cacheKey, payload, INTERVALS[intervalKey].ttlMs);
      return res.json(payload);
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.error('Market candles failed:', error.message);
      return res.status(statusCode).json({ error: `Unable to load market candles: ${error.message}` });
    }
  });

  // GET /api/market/drawings?symbol=XAUUSD — the signed-in user's saved drawings for one symbol.
  app.get('/api/market/drawings', verifyToken, async (req, res) => {
    const symbolKey = String(req.query.symbol || '').toUpperCase();
    if (!Object.hasOwn(SYMBOLS, symbolKey)) {
      return res.status(400).json({ error: 'Unsupported symbol. Choose XAUUSD, EURUSD, GBPUSD, or USDJPY.' });
    }
    try {
      const rows = await new Promise((resolve, reject) => {
        db.all(
          'SELECT id, kind, data, created_at FROM market_drawings WHERE user_id = ? AND symbol = ? ORDER BY created_at ASC',
          [req.user.id, symbolKey],
          (error, results) => error ? reject(error) : resolve(results || [])
        );
      });
      return res.json({
        drawings: rows.map(row => ({
          id: row.id,
          kind: row.kind,
          data: JSON.parse(row.data),
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('Failed to list market drawings:', error.message);
      return res.status(500).json({ error: 'Unable to load saved drawings.' });
    }
  });

  // POST /api/market/drawings — persist one drawing ({ symbol, kind: 'hline'|'trend', data }).
  app.post('/api/market/drawings', verifyToken, async (req, res) => {
    const { symbol, kind } = req.body || {};
    const symbolKey = String(symbol || '').toUpperCase();
    if (!Object.hasOwn(SYMBOLS, symbolKey)) {
      return res.status(400).json({ error: 'Unsupported symbol. Choose XAUUSD, EURUSD, GBPUSD, or USDJPY.' });
    }
    if (kind !== 'hline' && kind !== 'trend') {
      return res.status(400).json({ error: 'Drawing kind must be hline or trend.' });
    }
    const data = req.body && req.body.data;
    const dataJson = JSON.stringify(data);
    if (!data || typeof data !== 'object' || dataJson.length > 2000) {
      return res.status(400).json({ error: 'Drawing data is missing or too large.' });
    }
    // hline: { price } — trend: { points: [{ time, price }, { time, price }] }
    const priceOk = value => typeof value === 'number' && Number.isFinite(value);
    if (kind === 'hline' && !priceOk(data.price)) {
      return res.status(400).json({ error: 'A horizontal line needs one valid price level.' });
    }
    if (kind === 'trend' && (!Array.isArray(data.points) || data.points.length !== 2
      || !data.points.every(point => point && priceOk(point.price) && Number.isFinite(point.time)))) {
      return res.status(400).json({ error: 'A trend line needs exactly two valid points.' });
    }
    try {
      const existing = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) AS count FROM market_drawings WHERE user_id = ? AND symbol = ?',
          [req.user.id, symbolKey], (error, row) => error ? reject(error) : resolve(row.count));
      });
      if (existing >= 50) {
        return res.status(400).json({ error: 'Drawing limit reached for this symbol. Remove some drawings first.' });
      }
      const result = await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO market_drawings (user_id, symbol, kind, data, created_at) VALUES (?, ?, ?, ?, ?)',
          [req.user.id, symbolKey, kind, dataJson, Date.now()],
          function (error) { return error ? reject(error) : resolve({ id: this.lastID }); }
        );
      });
      return res.status(201).json({ id: result.id, kind, data });
    } catch (error) {
      console.error('Failed to save market drawing:', error.message);
      return res.status(500).json({ error: 'Unable to save the drawing.' });
    }
  });

  // DELETE /api/market/drawings/:id — remove one of the user's own drawings.
  app.delete('/api/market/drawings/:id', verifyToken, async (req, res) => {
    const drawingId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(drawingId) || drawingId < 1) {
      return res.status(400).json({ error: 'Invalid drawing identifier.' });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        db.run('DELETE FROM market_drawings WHERE id = ? AND user_id = ?',
          [drawingId, req.user.id], function (error) { return error ? reject(error) : resolve({ changes: this.changes }); });
      });
      if (result.changes !== 1) return res.status(404).json({ error: 'Drawing not found.' });
      return res.json({ message: 'Drawing removed.' });
    } catch (error) {
      console.error('Failed to delete market drawing:', error.message);
      return res.status(500).json({ error: 'Unable to delete the drawing.' });
    }
  });
}

module.exports = registerMarketApi;
module.exports.SYMBOLS = SYMBOLS;
module.exports.INTERVALS = INTERVALS;
module.exports.aggregateCandles = aggregateCandles;

