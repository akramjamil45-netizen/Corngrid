'use strict';

const crypto = require('crypto');

const DEFAULT_FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const SOURCE_TIME_ZONE = 'America/New_York';
const DISPLAY_TIME_ZONE = 'Asia/Kuala_Lumpur';
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 300;
const MAX_VALUE_LENGTH = 48;
const MIN_RETRY_MS = 20_000;
const MAX_RETRY_MS = 15 * 60 * 1000;
const FORCE_COOLDOWN_MS = 15_000;

const XAU_KEYWORDS = /non[\s-]?farm|payroll|\bnfp\b|consumer price|\bcpi\b|core cpi|federal funds|\binterest rate\b|\bfomc\b|\bfed\b|powell|\bgdp\b|\bpce\b|unemployment claims|jobless claims|retail sales|inflation|producer price|\bppi\b/i;

const CURRENCY_RELEVANCE = Object.freeze({
  USD: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  EUR: ['EURUSD'],
  GBP: ['GBPUSD'],
  JPY: ['USDJPY']
});

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, date - Date.now()));
  return null;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanText(value, maxLength = MAX_TITLE_LENGTH) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function readXmlTag(block, tag) {
  const valuePattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(valuePattern);
  if (!match) return '';
  return cleanText(decodeEntities(match[1]), tag === 'url' ? 500 : MAX_TITLE_LENGTH);
}

// Minimal, safe parser for the Forex Factory weekly XML feed. It never
// resolves external entities or a DTD, and every field is treated as text.
function parseXmlCalendar(xml) {
  const source = String(xml || '');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new Error('The economic calendar feed contains unsupported XML declarations.');
  }
  if (source.length > MAX_FEED_BYTES) {
    throw new Error('The economic calendar feed is larger than expected.');
  }
  const events = [];
  const eventPattern = /<event\b[^>]*>([\s\S]*?)<\/event>/gi;
  let match;
  while ((match = eventPattern.exec(source)) !== null) {
    const block = match[1];
    events.push({
      title: readXmlTag(block, 'title'),
      country: readXmlTag(block, 'country'),
      date: readXmlTag(block, 'date'),
      time: readXmlTag(block, 'time'),
      impact: readXmlTag(block, 'impact'),
      forecast: readXmlTag(block, 'forecast'),
      previous: readXmlTag(block, 'previous'),
      actual: readXmlTag(block, 'actual'),
      revised: readXmlTag(block, 'revised'),
      url: readXmlTag(block, 'url')
    });
    if (events.length > 2000) throw new Error('The economic calendar feed contains too many events.');
  }
  return events;
}

function parseJsonCalendar(json) {
  let parsed;
  try {
    parsed = JSON.parse(String(json || ''));
  } catch {
    throw new Error('The economic calendar feed is not valid JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('The economic calendar feed has an unexpected structure.');
  if (parsed.length > 2000) throw new Error('The economic calendar feed contains too many events.');
  return parsed.map(item => ({
    title: item && item.title,
    country: item && item.country,
    date: item && item.date,
    time: item && item.time,
    impact: item && item.impact,
    forecast: item && item.forecast,
    previous: item && item.previous,
    actual: item && item.actual,
    revised: item && item.revised,
    url: item && item.url
  }));
}

function parseCalendarFeed(content) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('The economic calendar feed is empty.');
  if (text.startsWith('<')) return parseXmlCalendar(text);
  if (text.startsWith('[') || text.startsWith('{')) return parseJsonCalendar(text);
  throw new Error('The economic calendar feed uses an unsupported format.');
}

function timeZoneOffsetMs(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - epochMs;
}

// Converts a wall-clock time in an IANA time zone to a UTC epoch. The offset is
// resolved with Intl, so the source's daylight-saving transitions are honoured.
function zonedWallTimeToUtcMs({ year, month, day, hour, minute }, timeZone) {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = wallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = wallClock - timeZoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function formatInZone(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const pad = value => String(value).padStart(2, '0');
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${pad(hour)}:${pad(Number(parts.minute))}`,
    seconds: Number(parts.second)
  };
}

function parseUsDate(value) {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(cleanText(value, 16));
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

function parseClock(value) {
  const text = cleanText(value, 24).toLowerCase();
  if (!text) return null;
  if (/all\s*day|tentative|tba|time\s*n\/?a/.test(text)) return null;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (minute > 59) return null;
  if (match[3]) {
    if (hour < 1 || hour > 12) return null;
    if (match[3] === 'pm' && hour !== 12) hour += 12;
    if (match[3] === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

function normalizeCurrency(value) {
  const text = cleanText(value, 16).toUpperCase();
  if (!text || text === 'ALL' || text === 'GLOBAL') return null;
  return /^[A-Z]{3,4}$/.test(text) ? text : null;
}

function normalizeImpact(value) {
  const text = cleanText(value, 16).toLowerCase();
  if (text === 'high' || text === 'medium' || text === 'low' || text === 'holiday') return text;
  return 'unknown';
}

function normalizeValue(value) {
  const text = cleanText(value, MAX_VALUE_LENGTH);
  return text ? text : null;
}

function safeEventUrl(value) {
  const raw = cleanText(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'www.forexfactory.com' && url.hostname !== 'forexfactory.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function relevanceFor(currency, impact, title) {
  if (!currency) return [];
  const relevant = new Set();
  for (const instrument of CURRENCY_RELEVANCE[currency] || []) {
    if (instrument === 'XAUUSD') {
      if (impact === 'high' || XAU_KEYWORDS.test(title)) relevant.add('XAUUSD');
    } else {
      relevant.add(instrument);
    }
  }
  return [...relevant];
}

function eventId(currency, title, startMs, dateKey) {
  return crypto
    .createHash('sha1')
    .update(`${currency || 'ALL'}|${title}|${startMs ?? dateKey ?? 'no-date'}`)
    .digest('hex')
    .slice(0, 20);
}

function normalizeEvent(raw) {
  const title = cleanText(raw && raw.title, MAX_TITLE_LENGTH);
  if (!title) return null;

  const currency = normalizeCurrency(raw && raw.country);
  const impact = normalizeImpact(raw && raw.impact);
  const actual = normalizeValue(raw && raw.actual);
  const forecast = normalizeValue(raw && raw.forecast);
  const previous = normalizeValue(raw && raw.previous);
  const revised = normalizeValue(raw && raw.revised);

  let startMs = null;
  let timeUnknown = false;
  let dateKey = null;

  const rawDate = cleanText(raw && raw.date, 40);
  const rawTime = cleanText(raw && raw.time, 24);

  if (/\d{2}:\d{2}/.test(rawDate)) {
    const parsed = Date.parse(rawDate);
    if (!Number.isFinite(parsed)) return null;
    startMs = parsed;
  } else {
    const dateParts = parseUsDate(rawDate);
    if (dateParts) {
      const clock = parseClock(rawTime);
      if (clock) {
        startMs = zonedWallTimeToUtcMs({ ...dateParts, ...clock }, SOURCE_TIME_ZONE);
      } else {
        timeUnknown = true;
        dateKey = `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
      }
    }
  }

  if (startMs !== null) {
    const display = formatInZone(startMs, DISPLAY_TIME_ZONE);
    dateKey = display.dateKey;
  }

  const id = eventId(currency, title, startMs, dateKey);

  return {
    id,
    title,
    currency,
    impact,
    startMs,
    timeUnknown,
    dateKey,
    actual,
    forecast,
    previous,
    revised,
    url: safeEventUrl(raw && raw.url),
    relevance: relevanceFor(currency, impact, title)
  };
}

function normalizeEvents(rawEvents) {
  const byId = new Map();
  for (const raw of rawEvents) {
    const event = normalizeEvent(raw);
    if (!event) continue;
    const existing = byId.get(event.id);
    if (!existing) {
      byId.set(event.id, event);
      continue;
    }
    // Keep the most complete duplicate (for example a later revision that
    // includes an actual result).
    const score = item => (item.actual ? 8 : 0) + (item.revised ? 2 : 0) + (item.forecast ? 2 : 0) + (item.previous ? 1 : 0);
    if (score(event) > score(existing)) byId.set(event.id, event);
  }
  const sortValue = event => event.startMs ?? (
    event.dateKey ? Date.parse(`${event.dateKey}T00:00:00+08:00`) : Number.POSITIVE_INFINITY
  );
  return [...byId.values()].sort((a, b) => sortValue(a) - sortValue(b));
}

function createEconomicCalendar({ db, fetchImpl, now = () => Date.now(), config = {} } = {}) {
  const feedUrl = config.feedUrl || process.env.ECONOMIC_CALENDAR_URL || DEFAULT_FEED_URL;
  const refreshIntervalMs = positiveInt(
    config.refreshIntervalMs || process.env.ECONOMIC_CALENDAR_REFRESH_MS,
    5 * 60 * 1000
  );
  const fetchTimeoutMs = positiveInt(
    config.fetchTimeoutMs || process.env.ECONOMIC_CALENDAR_TIMEOUT_MS,
    12_000
  );
  const doFetch = fetchImpl || global.fetch;
  const readLimit = positiveInt(config.readLimit, 120);
  const refreshLimit = positiveInt(config.refreshLimit, 6);

  let cache = null; // { events, fetchedAt }
  let lastAttemptAt = 0;
  let lastError = null;
  let blockedUntil = 0;
  let refreshing = null;
  let lastForcedAt = 0;

  function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!db) return resolve({ changes: 0 });
      db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve({ changes: this.changes });
      });
    });
  }

  function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!db) return resolve(null);
      db.get(sql, params, (error, row) => {
        if (error) reject(error);
        else resolve(row || null);
      });
    });
  }

  const ready = (async () => {
    if (!db) return;
    try {
      await dbRun(`
        CREATE TABLE IF NOT EXISTS economic_calendar_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          source_url TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
      const row = await dbGet('SELECT payload, fetched_at FROM economic_calendar_cache WHERE id = 1');
      if (!row) return;
      const payload = JSON.parse(row.payload);
      if (Array.isArray(payload)) {
        cache = { events: payload, fetchedAt: Number(row.fetched_at) || 0 };
      }
    } catch (error) {
      console.error('Unable to load the cached economic calendar:', error.message);
    }
  })();

  async function persist() {
    if (!db || !cache) return;
    try {
      await dbRun(`
        INSERT INTO economic_calendar_cache (id, payload, fetched_at, source_url, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          fetched_at = excluded.fetched_at,
          source_url = excluded.source_url,
          updated_at = excluded.updated_at
      `, [JSON.stringify(cache.events), cache.fetchedAt, feedUrl, now()]);
    } catch (error) {
      console.error('Unable to persist the economic calendar cache:', error.message);
    }
  }

  function buildMeta({ stale, error }) {
    const current = now();
    const fetchedAt = cache ? cache.fetchedAt : null;
    const age = fetchedAt !== null ? current - fetchedAt : null;
    let feedState = 'UNAVAILABLE';
    if (fetchedAt !== null) {
      if (age <= refreshIntervalMs * 1.5) feedState = 'LIVE';
      else if (age <= refreshIntervalMs * 3) feedState = 'DELAYED';
      else feedState = 'STALE';
    }
    const events = cache ? cache.events : [];
    return {
      source: 'Forex Factory (FairEconomy)',
      sourceUrl: feedUrl,
      sourceTimeZone: SOURCE_TIME_ZONE,
      displayTimeZone: DISPLAY_TIME_ZONE,
      fetchedAt,
      lastAttemptAt: lastAttemptAt || null,
      ageMs: age,
      stale: Boolean(stale),
      error: error || null,
      feedState,
      refreshIntervalMs,
      nextRefreshAt: fetchedAt !== null ? fetchedAt + refreshIntervalMs : null,
      eventCount: events.length,
      actualsPublished: events.some(event => event.actual !== null),
      countsTowards: 'events in the current weekly feed'
    };
  }

  function snapshot({ stale = false, error = null } = {}) {
    return {
      events: cache ? cache.events : [],
      meta: buildMeta({ stale: stale || Boolean(error && lastError), error: error || lastError })
    };
  }

  async function performRefresh() {
    lastAttemptAt = now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await doFetch(feedUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
          'User-Agent': 'CornGrid-EconomicCalendar/1.0 (+https://corngrid.com)'
        }
      });
      if (!response.ok) {
        const retryAfter = parseRetryAfter(response.headers && response.headers.get ? response.headers.get('retry-after') : null);
        blockedUntil = now() + (retryAfter || Math.min(MAX_RETRY_MS, refreshIntervalMs));
        const failure = new Error(`The economic calendar source responded with HTTP ${response.status}.`);
        failure.statusCode = response.status;
        throw failure;
      }
      const contentLength = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_FEED_BYTES) {
        throw new Error('The economic calendar feed is larger than expected.');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_FEED_BYTES) {
        throw new Error('The economic calendar feed is larger than expected.');
      }
      const events = normalizeEvents(parseCalendarFeed(text));
      if (!events.length) throw new Error('The economic calendar feed did not contain any events.');
      cache = { events, fetchedAt: now() };
      console.info(`Economic calendar feed refreshed: ${events.length} events from ${feedUrl}.`);
      lastError = null;
      blockedUntil = 0;
      await persist();
      return snapshot();
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? 'The economic calendar source did not respond in time.'
        : (error && error.message) || 'The economic calendar source is unavailable.';
      lastError = message;
      if (cache) return snapshot({ stale: true, error: message });
      const failure = new Error(message);
      failure.statusCode = 503;
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh({ force = false } = {}) {
    await ready;
    const current = now();
    if (refreshing) return refreshing;
    if (force && current - lastForcedAt < FORCE_COOLDOWN_MS) {
      return snapshot({ stale: Boolean(lastError) });
    }
    if (current < blockedUntil) {
      return snapshot({ stale: Boolean(lastError), error: lastError });
    }
    if (!force && cache && current - cache.fetchedAt < refreshIntervalMs) {
      return snapshot();
    }
    if (force) lastForcedAt = current;
    refreshing = performRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  function rateLimiter({ limit, windowMs }) {
    const buckets = new Map();
    return (req, res, next) => {
      const current = now();
      if (buckets.size > 500) {
        for (const [key, bucket] of buckets) {
          if (bucket.expiresAt <= current) buckets.delete(key);
        }
      }
      const key = req.user && req.user.id ? `user:${req.user.id}` : `ip:${req.ip}`;
      const bucket = buckets.get(key);
      if (!bucket || bucket.expiresAt <= current) {
        buckets.set(key, { count: 1, expiresAt: current + windowMs });
        return next();
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        res.set('Retry-After', String(Math.ceil((bucket.expiresAt - current) / 1000)));
        return res.status(429).json({ error: 'Too many economic calendar requests. Please slow down.' });
      }
      return next();
    };
  }

  function registerRoutes(app, { verifyToken }) {
    const readLimiter = rateLimiter({ limit: readLimit, windowMs: 60 * 1000 });
    const manualLimiter = rateLimiter({ limit: refreshLimit, windowMs: 15 * 60 * 1000 });

    app.get('/api/economic-calendar', verifyToken, readLimiter, async (req, res) => {
      try {
        const data = await refresh({ force: false });
        res.set('Cache-Control', 'no-store');
        return res.json(data);
      } catch (error) {
        console.error('Unable to load the economic calendar:', error.message);
        return res.status(error.statusCode || 503).json({
          error: 'The economic calendar is temporarily unavailable. Please try again shortly.'
        });
      }
    });

    app.post('/api/economic-calendar/refresh', verifyToken, manualLimiter, async (req, res) => {
      try {
        const data = await refresh({ force: true });
        res.set('Cache-Control', 'no-store');
        if (data.meta.error) {
          return res.status(200).json(data);
        }
        return res.json(data);
      } catch (error) {
        console.error('Unable to refresh the economic calendar:', error.message);
        return res.status(error.statusCode || 503).json({
          error: 'The economic calendar could not be refreshed. Please try again shortly.'
        });
      }
    });
  }

  return {
    ready,
    refresh,
    getSnapshot: options => refresh(options),
    registerRoutes,
    feedUrl,
    refreshIntervalMs
  };
}

module.exports = createEconomicCalendar;
module.exports.createEconomicCalendar = createEconomicCalendar;
module.exports.parseCalendarFeed = parseCalendarFeed;
module.exports.parseXmlCalendar = parseXmlCalendar;
module.exports.parseJsonCalendar = parseJsonCalendar;
module.exports.normalizeEvent = normalizeEvent;
module.exports.normalizeEvents = normalizeEvents;
module.exports.zonedWallTimeToUtcMs = zonedWallTimeToUtcMs;
module.exports.formatInZone = formatInZone;
module.exports.parseClock = parseClock;
module.exports.parseUsDate = parseUsDate;
module.exports.SOURCE_TIME_ZONE = SOURCE_TIME_ZONE;
module.exports.DISPLAY_TIME_ZONE = DISPLAY_TIME_ZONE;
module.exports.DEFAULT_FEED_URL = DEFAULT_FEED_URL;
