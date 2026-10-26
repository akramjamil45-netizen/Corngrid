'use strict';

// Live broker-feed ingestion for Market Overview.
// CornGrid EA (MT5) POSTs quotes + candles to /api/mt5/market using its per-installation credential.
// Latest quotes are kept in memory only; candles are stored in SQLite (bounded per series).
// Quotes are never persisted tick-by-tick. Freshness is judged from SERVER receipt time, not EA clocks.

const { exclusive } = require('./db-write');

const TIMEFRAMES = Object.freeze({
  M1: { key: '1m', seconds: 60 },
  M5: { key: '5m', seconds: 300 },
  M15: { key: '15m', seconds: 900 },
  M30: { key: '30m', seconds: 1800 },
  H1: { key: '1h', seconds: 3600 },
  H4: { key: '4h', seconds: 14400 },
  D1: { key: '1d', seconds: 86400 },
  W1: { key: '1w', seconds: 604800 }
});
const TF_BY_KEY = Object.freeze(Object.fromEntries(Object.entries(TIMEFRAMES).map(([code, tf]) => [tf.key, { code, ...tf }])));
const STATE_RANK = Object.freeze({ LIVE: 3, DELAYED: 2, STALE: 1, OFFLINE: 0 });

const MAX_QUOTES = 16;
const MAX_CANDLE_SERIES = 12;
const MAX_BARS_PER_SERIES = 1000;
const MAX_BARS_PER_REQUEST = 2000;
const MAX_STORED_BARS = 1500;
// One candle row binds 11 columns, and SQLite limits the number of bound
// parameters per statement. Chunking the writes keeps each statement well under
// the classic 999-parameter ceiling while still using a single round trip.
const CANDLE_COLUMNS = 11;
const MAX_BIND_PARAMS = 900;
const ROWS_PER_INSERT = Math.floor(MAX_BIND_PARAMS / CANDLE_COLUMNS);

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function loadConfig(overrides = {}) {
  const config = {
    liveSeconds: intFromEnv('MARKET_LIVE_MAX_AGE_SECONDS', 10, 1, 3600),
    delayedSeconds: intFromEnv('MARKET_DELAYED_MAX_AGE_SECONDS', 30, 1, 3600),
    staleSeconds: intFromEnv('MARKET_STALE_MAX_AGE_SECONDS', 120, 1, 86400),
    // A quiet market (no new tick) is flagged, not hidden, once the last tick is this old.
    quietSeconds: intFromEnv('MARKET_QUIET_TICK_SECONDS', 90, 5, 86400),
    takeoverSeconds: intFromEnv('MARKET_PUBLISHER_TAKEOVER_SECONDS', 15, 3, 3600),
    clockToleranceSeconds: intFromEnv('MARKET_CLOCK_TOLERANCE_SECONDS', 300, 5, 86400),
    // How often a stored series is trimmed back to MAX_STORED_BARS. Running the
    // trim on every candle post put an extra DELETE (with an OFFSET 1500 scan) on
    // the shared connection for the whole fleet; trimming per series at most this
    // often keeps the table bounded while leaving the hot path to the INSERT.
    candleCleanupIntervalMs: intFromEnv('MARKET_CANDLE_CLEANUP_INTERVAL_MS', 60000, 0, 3600000),
    maxStreamClients: intFromEnv('MARKET_SSE_MAX_CLIENTS', 300, 1, 10000),
    maxStreamPerUser: intFromEnv('MARKET_SSE_MAX_PER_USER', 3, 1, 50),
    streamIntervalMs: intFromEnv('MARKET_STREAM_MIN_INTERVAL_MS', 250, 50, 5000),
    // Keep streams short so a proxy that buffers (or silently drops) the client
    // cannot leave a request hanging for half an hour. The browser reconnects.
    streamMaxLifetimeSeconds: intFromEnv('MARKET_SSE_MAX_LIFETIME_SECONDS', 120, 60, 86400),
    preferredFeed: slugFeed(process.env.MARKET_PREFERRED_FEED || ''),
    // The external provider (Twelve Data / Yahoo) is used only when explicitly enabled.
    fallbackEnabled: String(process.env.MARKET_FALLBACK_PROVIDER || '').toLowerCase() === 'external',
    aliases: parseAliases(process.env.MARKET_SYMBOL_ALIASES || ''),
    now: () => Date.now(),
    ...overrides
  };
  if (!(config.liveSeconds <= config.delayedSeconds && config.delayedSeconds <= config.staleSeconds)) {
    throw new Error('Market freshness thresholds must satisfy LIVE <= DELAYED <= STALE.');
  }
  return config;
}

function parseAliases(raw) {
  const aliases = new Map();
  for (const part of raw.split(',')) {
    const [from, to] = part.split('=').map(item => (item || '').trim().toUpperCase());
    if (from && to && /^[A-Z0-9]+$/.test(from) && /^[A-Z0-9]+$/.test(to)) aliases.set(from, to);
  }
  return aliases;
}

function slugFeed(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) { return error ? reject(error) : resolve({ changes: this.changes }); });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}
function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
}

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const isPositive = value => isNum(value) && value > 0;

// True while the client is still on the line. `req.destroyed` cannot be used for
// this: Node destroys the request stream as soon as a healthy body has been read,
// so it is true for successful requests too. The response socket is the reliable
// signal - it is destroyed only when the peer really went away.
function clientConnected(res) {
  if (res.writableEnded) return false;
  const socket = res.socket;
  if (!socket) return true;
  return !socket.destroyed;
}

function parseTimeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string' && value.length <= 40) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

// Maps a broker symbol ("XAUUSD.a", "m.EURUSD", "GBPUSDpro") onto a website symbol key, or null.
function mapSymbol(brokerSymbol, keys, aliases = new Map()) {
  const letters = String(brokerSymbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (aliases.has(letters)) return keys.includes(aliases.get(letters)) ? aliases.get(letters) : null;
  const hits = keys.filter(key => letters.includes(key));
  if (hits.length !== 1) return null;
  return letters.length <= hits[0].length + 8 ? hits[0] : null;
}

function createMarketFeed({ db, symbols, config: configOverrides }) {
  const config = loadConfig(configOverrides);
  const symbolKeys = Object.keys(symbols);
  const now = () => config.now();

  const publishers = new Map(); // installationId -> { lastSentAt, lastReceivedAt }
  const quotes = new Map(); // `${feed}|${symbol}` -> quote record
  const clients = new Set();
  const dirtySymbols = new Set();
  const lastCandleCleanup = new Map(); // `${feed}|${symbol}|${tf}` -> last trim time
  let revCounter = 0;
  // Track connected SSE clients so stream ticks can skip queries for clients that
  // already disconnected. Without this, a slow database queue can keep running
  // queries for stale sockets long after response.end() was called.
  const connectedClients = new WeakSet();
  const clientExpiredAt = new WeakMap(); // client -> expiresAt
  const clientUserId = new WeakMap(); // client -> userId
  const clientSymbol = new WeakMap(); // client -> symbol
  const stoppedClients = new WeakSet();
  let streamTimer = null;
  let tickCount = 0;

  const ready = exec(db, `
    CREATE TABLE IF NOT EXISTS market_candles (
      feed TEXT NOT NULL,
      symbol TEXT NOT NULL,
      tf TEXT NOT NULL,
      t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      tv INTEGER,
      v REAL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (feed, symbol, tf, t)
    ) WITHOUT ROWID;
    -- The table is keyed by (feed, symbol, tf, t), so a lookup by symbol alone
    -- (the feed discovery query) had no usable index and fell back to a full
    -- table scan on every read. This covering index keeps that lookup cheap.
    CREATE INDEX IF NOT EXISTS idx_market_candles_symbol_feed
      ON market_candles(symbol, feed, updated_at);
  `).catch(error => console.error('Unable to initialize market candle storage:', error.message));

  // ---------------------------------------------------------------- state
  function stateForAge(ageMs) {
    if (ageMs <= config.liveSeconds * 1000) return 'LIVE';
    if (ageMs <= config.delayedSeconds * 1000) return 'DELAYED';
    if (ageMs <= config.staleSeconds * 1000) return 'STALE';
    return 'OFFLINE';
  }

  function viewOf(record) {
    const current = now();
    const ageMs = Math.max(0, current - record.receivedAt);
    const state = stateForAge(ageMs);
    const tickAgeMs = Math.max(0, current - record.changedAt);
    const spread = record.ask - record.bid;
    return {
      symbol: record.symbol,
      brokerSymbol: record.brokerSymbol,
      feed: { id: record.feed },
      source: { kind: 'corngrid-ea', label: 'CornGrid EA broker feed' },
      bid: record.bid,
      ask: record.ask,
      last: record.last,
      spread: Number(spread.toFixed(record.digits + 1)),
      spreadPoints: record.spreadPoints,
      digits: record.digits,
      tickVolume: record.tickVolume,
      volume: record.volume,
      tickTime: new Date(record.tickTimeMs).toISOString(),
      receivedAt: new Date(record.receivedAt).toISOString(),
      state,
      ageMs,
      // Connected but the broker produced no new tick for a while (e.g. market closed).
      quiet: state !== 'OFFLINE' && tickAgeMs > config.quietSeconds * 1000,
      serverUtcOffsetSec: record.serverUtcOffsetSec,
      rev: record.rev,
      limits: { liveSeconds: config.liveSeconds, delayedSeconds: config.delayedSeconds, staleSeconds: config.staleSeconds }
    };
  }

  // Feed discovery runs on every SSE tick for every connected client, so the
  // result is cached for a few seconds. The lookup itself is indexed, and the
  // cache keeps the shared connection free for the EA requests.
  const feedCache = new Map(); // symbol -> { rows, expiresAt }
  const FEED_CACHE_TTL_MS = 5000;

  function invalidateFeedCache(symbol) {
    feedCache.delete(symbol);
  }

  async function dbFeedsFor(symbol) {
    await ready;
    const cached = feedCache.get(symbol);
    if (cached && cached.expiresAt > now()) return cached.rows;
    const rows = await all(db, 'SELECT feed, MAX(updated_at) AS updated_at FROM market_candles WHERE symbol = ? GROUP BY feed ORDER BY updated_at DESC', [symbol]);
    feedCache.set(symbol, { rows, expiresAt: now() + FEED_CACHE_TTL_MS });
    return rows;
  }

  // Picks the single feed to show for a symbol. Never merges brokers.
  async function selectFeed(symbol, explicitFeed = '') {
    const wanted = slugFeed(explicitFeed);
    const candidates = [...quotes.values()].filter(record => record.symbol === symbol);
    if (wanted) {
      const record = candidates.find(item => item.feed === wanted);
      if (record) return { feed: wanted, record };
      const stored = (await dbFeedsFor(symbol)).find(row => row.feed === wanted);
      return stored ? { feed: wanted, record: null } : null;
    }
    if (candidates.length) {
      const ranked = candidates
        .map(record => ({ record, rank: STATE_RANK[viewOf(record).state] }))
        .sort((a, b) => {
          const healthy = item => item.rank >= STATE_RANK.DELAYED;
          if (config.preferredFeed) {
            const aPreferred = a.record.feed === config.preferredFeed && healthy(a);
            const bPreferred = b.record.feed === config.preferredFeed && healthy(b);
            if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
          }
          return b.rank - a.rank || b.record.receivedAt - a.record.receivedAt;
        });
      return { feed: ranked[0].record.feed, record: ranked[0].record };
    }
    const stored = await dbFeedsFor(symbol);
    return stored.length ? { feed: stored[0].feed, record: null } : null;
  }

  async function currentView(symbol, explicitFeed = '') {
    const selected = await selectFeed(symbol, explicitFeed);
    if (!selected) return null;
    if (!selected.record) return { symbol, feed: { id: selected.feed }, source: { kind: 'corngrid-ea', label: 'CornGrid EA broker feed' }, bid: null, ask: null, state: 'OFFLINE', ageMs: null, quiet: false, rev: 0, limits: limitsView() };
    return viewOf(selected.record);
  }

  function limitsView() {
    return { liveSeconds: config.liveSeconds, delayedSeconds: config.delayedSeconds, staleSeconds: config.staleSeconds };
  }

  function listFeeds() {
    const feeds = new Map();
    for (const record of quotes.values()) {
      const entry = feeds.get(record.feed) || { id: record.feed, symbols: {} };
      const view = viewOf(record);
      entry.symbols[record.symbol] = { state: view.state, ageMs: view.ageMs, brokerSymbol: record.brokerSymbol };
      feeds.set(record.feed, entry);
    }
    return [...feeds.values()];
  }

  // ---------------------------------------------------------------- ingest
  function reject(status, error) {
    return { status, body: { accepted: false, error } };
  }

  function validateQuote(raw, receivedAt) {
    if (!raw || typeof raw !== 'object') return { error: 'Each quote must be an object.' };
    if (typeof raw.symbol !== 'string' || !/^[A-Za-z0-9._#@-]{1,32}$/.test(raw.symbol)) return { error: 'Quote symbol is invalid.' };
    if (!isPositive(raw.bid) || !isPositive(raw.ask)) return { error: 'Quote bid and ask must be positive numbers.' };
    if (raw.ask < raw.bid) return { error: 'Quote ask must not be below bid.' };
    const last = raw.last === undefined ? null : raw.last;
    if (last !== null && !isPositive(last)) return { error: 'Quote last must be null or a positive number.' };
    const spreadPoints = raw.spreadPoints === undefined ? null : raw.spreadPoints;
    if (spreadPoints !== null && !(Number.isInteger(spreadPoints) && spreadPoints >= 0 && spreadPoints <= 1e7)) return { error: 'Quote spreadPoints must be null or a non-negative integer.' };
    const digits = raw.digits === undefined ? 5 : raw.digits;
    if (!Number.isInteger(digits) || digits < 0 || digits > 10) return { error: 'Quote digits must be an integer between 0 and 10.' };
    const tickTimeMs = parseTimeMs(raw.tickTimeMs);
    if (!tickTimeMs || tickTimeMs > receivedAt + 60_000) return { error: 'Quote tickTimeMs is missing or in the future.' };
    for (const field of ['tickVolume', 'volume']) {
      if (raw[field] != null && !(isNum(raw[field]) && raw[field] >= 0)) return { error: `Quote ${field} must be null or a non-negative number.` };
    }
    return {
      value: {
        brokerSymbol: raw.symbol, bid: raw.bid, ask: raw.ask, last, spreadPoints, digits, tickTimeMs,
        tickVolume: raw.tickVolume ?? null, volume: raw.volume ?? null
      }
    };
  }

  function validateCandleSeries(raw, receivedAt) {
    if (!raw || typeof raw !== 'object') return { error: 'Each candle series must be an object.' };
    if (typeof raw.symbol !== 'string' || !/^[A-Za-z0-9._#@-]{1,32}$/.test(raw.symbol)) return { error: 'Candle symbol is invalid.' };
    if (typeof raw.tf !== 'string' || !Object.hasOwn(TIMEFRAMES, raw.tf)) return { error: 'Candle timeframe must be one of M1, M5, M15, M30, H1, H4, D1, W1.' };
    if (!Array.isArray(raw.bars) || raw.bars.length < 1 || raw.bars.length > MAX_BARS_PER_SERIES) return { error: `Candle bars must contain 1 to ${MAX_BARS_PER_SERIES} entries.` };
    // Candle times are broker server-time epochs (as on the MT5 chart), so allow for the server's UTC offset.
    const maxTime = Math.floor(receivedAt / 1000) + TIMEFRAMES[raw.tf].seconds + 18 * 3600 + 60;
    const bars = [];
    const seen = new Set();
    for (const bar of raw.bars) {
      if (!bar || !Number.isInteger(bar.t) || bar.t <= 0 || bar.t > maxTime) return { error: 'A candle has an invalid or future timestamp.' };
      if (![bar.o, bar.h, bar.l, bar.c].every(isPositive)) return { error: 'A candle has a non-positive or non-numeric OHLC value.' };
      if (bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c, bar.h)) return { error: 'A candle has inconsistent OHLC values.' };
      for (const field of ['tv', 'v']) {
        if (bar[field] != null && !(isNum(bar[field]) && bar[field] >= 0)) return { error: `A candle has an invalid ${field} value.` };
      }
      if (seen.has(bar.t)) return { error: 'Candle timestamps must be unique within a series.' };
      seen.add(bar.t);
      bars.push({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, tv: bar.tv ?? null, v: bar.v ?? null });
    }
    return { value: { brokerSymbol: raw.symbol, tf: raw.tf, bars } };
  }

  // One publisher owns a feed/symbol at a time, and quotes and candles are
// tracked separately. Ownership is kept in its own map instead of being derived
// from the visible quote, because a publisher which is alive but sends an
// unchanged tick (or only candles) must still hold the stream. Deriving it
// from the quote record made the visible price flap between two accounts that
// share a broker server, because a publisher that only sent candles was never
// recognised as the owner.
  const owners = new Map(); // `${feed}|${symbol}` -> { installationId, lastQuoteAt, lastCandleAt }

  function ownerAllows(feed, symbol, installationId, receivedAt, kind) {
    const owner = owners.get(`${feed}|${symbol}`);
    if (!owner) return true;
    if (owner.installationId === installationId) return true;
    const lastSeen = kind === 'candle' ? owner.lastCandleAt : owner.lastQuoteAt;
    // The current owner must be genuinely silent before another publisher may take over.
    if (!lastSeen) return true;
    return receivedAt - lastSeen > config.takeoverSeconds * 1000;
  }

  function claimOwnership(feed, symbol, installationId, receivedAt, kind) {
    const key = `${feed}|${symbol}`;
    let owner = owners.get(key);
    if (!owner) {
      owner = { installationId, lastQuoteAt: 0, lastCandleAt: 0 };
      owners.set(key, owner);
    }
    if (owner.installationId !== installationId) {
      // A publisher that takes over a stream replaces the previous owner.
      owner.installationId = installationId;
      owner.lastQuoteAt = 0;
      owner.lastCandleAt = 0;
    }
    if (kind === 'candle') owner.lastCandleAt = receivedAt;
    else owner.lastQuoteAt = receivedAt;
  }

  async function ingest(installation, body) {
    const receivedAt = now();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'A JSON object body is required.');
    const feed = slugFeed(installation.broker_server);
    if (!feed) return reject(400, 'This installation has no usable broker feed identifier.');
    if (body.schema !== undefined && body.schema !== 1) return reject(400, 'Unsupported market payload schema.');

    const sentAt = parseTimeMs(body.sentAtMs);
    if (!sentAt) return reject(400, 'sentAtMs is required.');
    if (Math.abs(sentAt - receivedAt) > config.clockToleranceSeconds * 1000) {
      return reject(422, 'sentAtMs is too far from server time; check the EA machine clock.');
    }
    const quoteList = body.quotes === undefined ? [] : body.quotes;
    const serverUtcOffsetSec = body.serverUtcOffsetSec === undefined ? null : body.serverUtcOffsetSec;
    if (serverUtcOffsetSec !== null && !(Number.isInteger(serverUtcOffsetSec) && Math.abs(serverUtcOffsetSec) <= 18 * 3600)) {
      return reject(400, 'serverUtcOffsetSec must be an integer within +/-18 hours.');
    }
    const candleList = body.candles === undefined ? [] : body.candles;
    if (!Array.isArray(quoteList) || quoteList.length > MAX_QUOTES) return reject(400, `quotes must be an array of at most ${MAX_QUOTES} entries.`);
    if (!Array.isArray(candleList) || candleList.length > MAX_CANDLE_SERIES) return reject(400, `candles must be an array of at most ${MAX_CANDLE_SERIES} entries.`);
    if (!quoteList.length && !candleList.length) return reject(400, 'Payload contains no quotes or candles.');

    const parsedQuotes = [];
    for (const raw of quoteList) {
      const result = validateQuote(raw, receivedAt);
      if (result.error) return reject(400, result.error);
      parsedQuotes.push(result.value);
    }
    const parsedSeries = [];
    let totalBars = 0;
    for (const raw of candleList) {
      const result = validateCandleSeries(raw, receivedAt);
      if (result.error) return reject(400, result.error);
      totalBars += result.value.bars.length;
      parsedSeries.push(result.value);
    }
    if (totalBars > MAX_BARS_PER_REQUEST) return reject(400, `A request may carry at most ${MAX_BARS_PER_REQUEST} candles.`);

    // Replay / out-of-order protection per installation.
    const publisher = publishers.get(installation.installation_id) || { lastSentAt: 0, lastReceivedAt: 0 };
    if (sentAt <= publisher.lastSentAt) {
      return { status: 202, body: { accepted: false, reason: 'stale', message: 'Out-of-order or replayed market update ignored.' } };
    }
    publisher.lastSentAt = sentAt;
    publisher.lastReceivedAt = receivedAt;
    publishers.set(installation.installation_id, publisher);

    const outcome = { accepted: true, quotes: { accepted: 0, ignored: 0, unmapped: [] }, candles: { accepted: 0, ignored: 0 }, serverTime: new Date(receivedAt).toISOString() };

    for (const quote of parsedQuotes) {
      const symbol = mapSymbol(quote.brokerSymbol, symbolKeys, config.aliases);
      if (!symbol) { outcome.quotes.unmapped.push(quote.brokerSymbol); continue; }
      if (!ownerAllows(feed, symbol, installation.installation_id, receivedAt, 'quote')) { outcome.quotes.ignored += 1; continue; }
      claimOwnership(feed, symbol, installation.installation_id, receivedAt, 'quote');
      const key = `${feed}|${symbol}`;
      const existing = quotes.get(key);
      const sameOwner = existing && existing.publisherId === installation.installation_id;
      // A tick older than the stored one from the same publisher never overwrites newer data.
      if (sameOwner && quote.tickTimeMs < existing.tickTimeMs) { outcome.quotes.ignored += 1; continue; }
      const changed = !existing || !sameOwner || quote.tickTimeMs !== existing.tickTimeMs || quote.bid !== existing.bid || quote.ask !== existing.ask;
      revCounter += 1;
      quotes.set(key, {
        feed, symbol, publisherId: installation.installation_id, ...quote, serverUtcOffsetSec,
        receivedAt, changedAt: changed ? receivedAt : existing.changedAt, rev: revCounter
      });
      dirtySymbols.add(symbol);
      outcome.quotes.accepted += 1;
    }

    const storable = [];
    for (const series of parsedSeries) {
      const symbol = mapSymbol(series.brokerSymbol, symbolKeys, config.aliases);
      if (!symbol) { outcome.candles.ignored += series.bars.length; continue; }
      if (!ownerAllows(feed, symbol, installation.installation_id, receivedAt, 'candle')) { outcome.candles.ignored += series.bars.length; continue; }
      claimOwnership(feed, symbol, installation.installation_id, receivedAt, 'candle');
      storable.push({ symbol, tf: series.tf, bars: series.bars });
      outcome.candles.accepted += series.bars.length;
    }
    if (storable.length) {
      try {
        await storeCandles(feed, storable, receivedAt);
      } catch (error) {
        console.error('Failed to store market candles:', error.message);
        // A storage failure is temporary, not a data error. 503 tells the EA to
        // retry shortly instead of treating the update as permanently rejected.
        return { status: 503, retryAfterSeconds: 30, body: { ...outcome, accepted: false, error: 'Unable to store candles. Please retry.' } };
      }
    }

    if (outcome.quotes.accepted === 0 && outcome.candles.accepted === 0) {
      const onlyUnmapped = outcome.quotes.unmapped.length > 0 && outcome.quotes.ignored === 0 && outcome.candles.ignored === 0;
      if (onlyUnmapped) return { status: 422, body: { ...outcome, accepted: false, error: 'No symbol could be mapped to a supported market.' } };
      return { status: 202, body: { ...outcome, accepted: false, reason: 'standby', message: 'Another publisher currently owns this feed.' } };
    }
    return { status: 200, body: outcome };
  }

  // The shared sqlite connection cannot nest transactions, so writes run one at a
  // time. The queue is shared with the other API modules through db-write.js, so
  // a candle write can never collide with an account unlink or a heartbeat.
  function storeCandles(feed, seriesList, receivedAt) {
    return exclusive(db, async () => {
      await storeCandlesNow(feed, seriesList, receivedAt);
      // A stored series can introduce a new feed for its symbol, so the cached
      // feed list for those symbols must be recomputed.
      for (const series of seriesList) invalidateFeedCache(series.symbol);
    });
  }

  async function storeCandlesNow(feed, seriesList, receivedAt) {
    await ready;
    await run(db, 'BEGIN IMMEDIATE');
    try {
      for (const series of seriesList) {
        // Batch the rows into multi-row INSERT statements. One statement per bar
        // was the main reason a backfill could take longer than the EA's 1000 ms
        // WebRequest timeout, which made the EA abort the upload mid-body and the
        // server log the request as "client-aborted".
        for (let offset = 0; offset < series.bars.length; offset += ROWS_PER_INSERT) {
          const chunk = series.bars.slice(offset, offset + ROWS_PER_INSERT);
          const values = [];
          const params = [];
          for (const bar of chunk) {
            values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            params.push(feed, series.symbol, series.tf, bar.t, bar.o, bar.h, bar.l, bar.c, bar.tv, bar.v, receivedAt);
          }
          await run(db, `
            INSERT INTO market_candles (feed, symbol, tf, t, o, h, l, c, tv, v, updated_at)
            VALUES ${values.join(', ')}
            ON CONFLICT(feed, symbol, tf, t) DO UPDATE SET
              o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
              tv = excluded.tv, v = excluded.v, updated_at = excluded.updated_at
          `, params);
        }
        const cleanupKey = `${feed}|${series.symbol}|${series.tf}`;
        const lastTrim = lastCandleCleanup.get(cleanupKey) || 0;
        if (config.candleCleanupIntervalMs <= 0 || receivedAt - lastTrim >= config.candleCleanupIntervalMs) {
          await run(db, `
            DELETE FROM market_candles WHERE feed = ? AND symbol = ? AND tf = ?
              AND t < COALESCE((SELECT t FROM market_candles WHERE feed = ? AND symbol = ? AND tf = ? ORDER BY t DESC LIMIT 1 OFFSET ?), 0)
          `, [feed, series.symbol, series.tf, feed, series.symbol, series.tf, MAX_STORED_BARS]);
          lastCandleCleanup.set(cleanupKey, receivedAt);
        }
      }
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => {});
      throw error;
    }
  }

  // ---------------------------------------------------------------- reads
  async function getCandles(feed, symbol, intervalKey, limit) {
    await ready;
    const tf = TF_BY_KEY[intervalKey];
    if (!tf) return [];
    const rows = await all(db, 'SELECT t, o, h, l, c, tv FROM market_candles WHERE feed = ? AND symbol = ? AND tf = ? ORDER BY t DESC LIMIT ?', [feed, symbol, tf.code, limit]);
    return rows.reverse().map(row => ({ time: row.t, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.tv != null && row.tv > 0 ? row.tv : null }));
  }

  async function lastCandleUpdate(feed, symbol, intervalKey) {
    await ready;
    const tf = TF_BY_KEY[intervalKey];
    const rows = await all(db, 'SELECT MAX(updated_at) AS updated_at FROM market_candles WHERE feed = ? AND symbol = ? AND tf = ?', [feed, symbol, tf.code]);
    return rows[0] && rows[0].updated_at ? Number(rows[0].updated_at) : null;
  }

  async function dayStats(feed, symbol) {
    const daily = await getCandles(feed, symbol, '1d', 2);
    if (!daily.length) return null;
    const latest = daily[daily.length - 1];
    const previous = daily.length > 1 ? daily[daily.length - 2] : null;
    return { dayOpen: latest.open, dayHigh: latest.high, dayLow: latest.low, previousClose: previous ? previous.close : null, dayTime: latest.time };
  }

  // ---------------------------------------------------------------- streaming (SSE)
  // A buffering proxy accepts writes long after the browser has gone, so a failed
  // write alone is not enough. Cap the queued bytes and drop the client once it is
  // clearly not draining; otherwise a single stalled stream can grow without bound.
  const MAX_STREAM_BUFFER_BYTES = 512 * 1024;
  let streamTicking = false;

  function send(client, event, data) {
    const res = client.res;
    if (client.closed || !clientConnected(res)) { dropClient(client); return false; }
    if ((res.writableLength || 0) > MAX_STREAM_BUFFER_BYTES) { dropClient(client); return false; }
    try {
      res.write(`event: ${event}\nid: ${data && data.rev ? data.rev : 0}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      dropClient(client);
      return false;
    }
  }

  function dropClient(client) {
    if (client.closed) return;
    client.closed = true;
    connectedClients.delete(client);
    stoppedClients.add(client);
    clients.delete(client);
    try { client.res.end(); } catch { /* connection already closed */ }
    if (!clients.size && streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  }

  async function streamTick() {
    // setInterval does not wait for an async callback. A slow database or provider
    // used to let ticks pile up on top of each other; skip instead of queueing.
    if (streamTicking) return;
    streamTicking = true;
    try {
      tickCount += 1;
      const current = now();
      const dirty = new Set(dirtySymbols);
      dirtySymbols.clear();
      const statusPass = tickCount % Math.max(1, Math.round(2000 / config.streamIntervalMs)) === 0;
      const pingPass = tickCount % Math.max(1, Math.round(15000 / config.streamIntervalMs)) === 0;
      for (const client of [...clients]) {
        if (client.closed || stoppedClients.has(client)) continue;
        if (current >= client.expiresAt) { send(client, 'bye', { reason: 'session-refresh' }); dropClient(client); continue; }
        // Stop processing requests for clients that have already disconnected.
        if (!connectedClients.has(client) || !clientConnected(client.res)) { dropClient(client); continue; }
        if (dirty.has(client.symbol) || statusPass) {
          const view = await currentView(client.symbol, client.feed).catch(() => null);
          if (view && (view.rev !== client.lastRev || view.state !== client.lastState)) {
            if (send(client, 'quote', view)) { client.lastRev = view.rev; client.lastState = view.state; }
          }
        } else if (pingPass) {
          // A named event (not an SSE comment) lets the browser distinguish a
          // healthy but quiet stream from one that a proxy is silently buffering.
          send(client, 'ping', { time: current });
        }
      }
    } finally {
      streamTicking = false;
    }
  }

  function addClient(req, res, { symbol, feed, userId }) {
    if (clients.size >= config.maxStreamClients) return { error: 'Too many live connections.' };
    let mine = 0;
    for (const client of clients) if (client.userId === userId) mine += 1;
    if (mine >= config.maxStreamPerUser) return { error: 'Too many live connections for this account.' };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const client = { res, symbol, feed, userId, lastRev: 0, lastState: null, closed: false, expiresAt: now() + config.streamMaxLifetimeSeconds * 1000 };
    clients.add(client);
    connectedClients.add(client);
    clientExpiredAt.set(client, client.expiresAt);
    clientUserId.set(client, userId);
    clientSymbol.set(client, symbol);
    if (!streamTimer) {
      streamTimer = setInterval(() => { streamTick().catch(error => console.error('Market stream tick failed:', error.message)); }, config.streamIntervalMs);
      if (streamTimer.unref) streamTimer.unref();
    }
    const cleanup = () => dropClient(client);
    // Different Node versions/proxies report a gone client on different events.
    // Listen to all of them; dropClient is idempotent.
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    return { client };
  }

  function sweep() {
    const cutoff = now() - 24 * 3600 * 1000;
    for (const [id, publisher] of publishers) if (publisher.lastReceivedAt < cutoff) publishers.delete(id);
    for (const [key, record] of quotes) if (record.receivedAt < cutoff) quotes.delete(key);
    for (const [key, owner] of owners) if (Math.max(owner.lastQuoteAt, owner.lastCandleAt) < cutoff) owners.delete(key);
  }
  const sweepTimer = setInterval(sweep, 3600 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();

  function close() {
    clearInterval(sweepTimer);
    if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
    for (const client of [...clients]) { connectedClients.delete(client); dropClient(client); }
  }

  // ---------------------------------------------------------------- routes
  function bucketLimiter({ limit, windowMs, key }) {
    const buckets = new Map();
    return (req, res, next) => {
      const current = Date.now();
      if (buckets.size > 1000) for (const [k, b] of buckets) if (b.resetAt <= current) buckets.delete(k);
      const id = key(req);
      let bucket = buckets.get(id);
      if (!bucket || bucket.resetAt <= current) { bucket = { count: 0, resetAt: current + windowMs }; buckets.set(id, bucket); }
      bucket.count += 1;
      if (bucket.count > limit) {
        res.set('Retry-After', String(Math.ceil((bucket.resetAt - current) / 1000)));
        return res.status(429).json({ error: 'Too many market requests. Please slow down.' });
      }
      return next();
    };
  }

  function registerRoutes(app, { verifyToken, authenticateInstallation }) {
    const publishLimit = bucketLimiter({ limit: 90, windowMs: 60_000, key: req => `pub:${req.installation ? req.installation.installation_id : req.ip}` });
    // Behind a reverse proxy req.ip may be shared, so this coarse pre-auth cap is deliberately high.
    const ipLimit = bucketLimiter({ limit: 3000, windowMs: 60_000, key: req => `pubip:${req.ip}` });
    const readLimit = bucketLimiter({ limit: 120, windowMs: 60_000, key: req => `read:${req.user ? req.user.id : req.ip}` });
    const streamLimit = bucketLimiter({ limit: 20, windowMs: 60_000, key: req => `stream:${req.user ? req.user.id : req.ip}` });

    const symbolOf = req => {
      const symbol = String(req.query.symbol || '').toUpperCase();
      return Object.hasOwn(symbols, symbol) ? symbol : null;
    };
    const feedOf = req => (typeof req.query.feed === 'string' ? req.query.feed : '');

    app.post('/api/mt5/market', ipLimit, authenticateInstallation, publishLimit, async (req, res) => {
      try {
        const result = await ingest(req.installation, req.body);
        // The EA gives up after its WebRequest timeout. If the socket is already
        // gone there is nobody left to answer, so the response is skipped.
        // Note: `req.destroyed` is NOT usable here - Node destroys the request
        // stream once a healthy body has been read, so it is true either way.
        if (res.headersSent || !clientConnected(res)) return undefined;
        // A rejected payload must not be retried immediately: the EA reads
        // Retry-After and backs off instead of hammering the endpoint.
        if (result.status === 429 || result.status === 503) {
          res.set('Retry-After', String(result.retryAfterSeconds || 30));
        }
        return res.status(result.status).json(result.body);
      } catch (error) {
        console.error('Market ingest failed:', error.message);
        if (res.headersSent || !clientConnected(res)) return undefined;
        const status = error && error.statusCode ? error.statusCode : 500;
        return res.status(status).json({ accepted: false, error: status === 503 ? 'Server is busy. Please retry.' : 'Unable to process market data.' });
      }
    });

    app.get('/api/market/quote', verifyToken, readLimit, async (req, res) => {
      const symbol = symbolOf(req);
      if (!symbol) return res.status(400).json({ error: 'Unsupported symbol.' });
      try {
        const view = await currentView(symbol, feedOf(req));
        return res.json({ quote: view, fallbackEnabled: config.fallbackEnabled, serverTime: new Date(now()).toISOString() });
      } catch (error) {
        console.error('Market quote failed:', error.message);
        return res.status(500).json({ error: 'Unable to load the latest quote.' });
      }
    });

    app.get('/api/market/feeds', verifyToken, readLimit, (req, res) => {
      res.json({ feeds: listFeeds(), preferredFeed: config.preferredFeed || null, fallbackEnabled: config.fallbackEnabled });
    });

    app.get('/api/market/stream', verifyToken, streamLimit, async (req, res) => {
      const symbol = symbolOf(req);
      if (!symbol) return res.status(400).json({ error: 'Unsupported symbol.' });
      const added = addClient(req, res.status(200), { symbol, feed: feedOf(req), userId: req.user.id });
      if (added.error) return res.status(429).json({ error: added.error });
      const view = await currentView(symbol, feedOf(req)).catch(() => null);
      added.client.lastRev = view ? view.rev : 0;
      added.client.lastState = view ? view.state : null;
      send(added.client, 'snapshot', view || { symbol, state: 'OFFLINE', bid: null, ask: null, rev: 0, limits: limitsView() });
    });
  }

  return {
    config, ingest, selectFeed, currentView, getCandles, lastCandleUpdate, dayStats, listFeeds,
    registerRoutes, close, stateForAge, ready,
    clientCount: () => clients.size
  };
}

module.exports = createMarketFeed;
module.exports.mapSymbol = mapSymbol;
module.exports.slugFeed = slugFeed;
module.exports.TIMEFRAMES = TIMEFRAMES;
module.exports.TF_BY_KEY = TF_BY_KEY;
module.exports.loadConfig = loadConfig;
