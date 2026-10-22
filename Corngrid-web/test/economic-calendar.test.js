const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const createEconomicCalendar = require('../economic-calendar');

const {
  parseCalendarFeed,
  parseXmlCalendar,
  parseJsonCalendar,
  normalizeEvent,
  normalizeEvents,
  zonedWallTimeToUtcMs,
  formatInZone,
  parseClock,
  parseUsDate
} = createEconomicCalendar;

const XML_FEED = `<?xml version="1.0" encoding="windows-1252"?>
<weeklyevents>
  <event>
    <title>Non-Farm Employment Change</title>
    <country>USD</country>
    <date>07-15-2026</date>
    <time>8:30am</time>
    <impact>High</impact>
    <forecast>180K</forecast>
    <previous>200K</previous>
    <actual>215K</actual>
    <revised>205K</revised>
    <url>https://www.forexfactory.com/calendar?event=123</url>
  </event>
  <event>
    <title>Core CPI m/m</title>
    <country>USD</country>
    <date>07-15-2026</date>
    <time>8:30am</time>
    <impact>High</impact>
    <forecast>0.3%</forecast>
    <previous>0.2%</previous>
    <actual></actual>
    <url>https://www.forexfactory.com/calendar?event=124</url>
  </event>
  <event>
    <title>National Day</title>
    <country>EUR</country>
    <date>07-16-2026</date>
    <time>All Day</time>
    <impact>Holiday</impact>
    <forecast></forecast>
    <previous></previous>
    <actual></actual>
    <url></url>
  </event>
  <event>
    <title>French Flash Manufacturing PMI</title>
    <country>EUR</country>
    <date>07-16-2026</date>
    <time>4:00pm</time>
    <impact>Medium</impact>
    <forecast>49.5</forecast>
    <previous>48.9</previous>
    <actual></actual>
    <url>https://www.forexfactory.com/calendar?event=125</url>
  </event>
  <event>
    <title>Unemployment Rate</title>
    <country>GBP</country>
    <date>07-17-2026</date>
    <time>7:00am</time>
    <impact>Medium</impact>
    <forecast>4.4%</forecast>
    <previous>4.4%</previous>
    <actual>4.5%</actual>
    <url>https://www.forexfactory.com/calendar?event=126</url>
  </event>
</weeklyevents>`;

const JSON_FEED = JSON.stringify([
  {
    title: 'Federal Funds Rate',
    country: 'USD',
    date: '2026-01-15T14:00:00-05:00',
    impact: 'High',
    forecast: '4.50%',
    previous: '4.50%',
    actual: '4.25%',
    url: 'https://www.forexfactory.com/calendar?event=200'
  },
  {
    title: 'Retail Sales m/m',
    country: 'USD',
    date: '2026-01-16T08:30:00-05:00',
    impact: 'High',
    forecast: '0.6%',
    previous: '0.4%',
    url: 'https://www.forexfactory.com/calendar?event=201'
  }
]);

function xmlResponse(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
    ...overrides
  };
}

function jsonResponse(body, overrides = {}) {
  return xmlResponse(JSON.stringify(body), overrides);
}

function fakeFetchSequence(responses) {
  let index = 0;
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const item = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (item instanceof Error) throw item;
    return item;
  };
  fn.calls = calls;
  return fn;
}

async function makeDb() {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.exec(
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT
    );`,
    error => error ? reject(error) : resolve()
  ));
  return db;
}

function makeClock(start = Date.UTC(2026, 6, 15, 12, 0, 0)) {
  const clock = { value: start, now: () => clock.value, advance(ms) { clock.value += ms; } };
  return clock;
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token === 'invalid') return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: Number(token) || 1 };
  next();
}

test('XML feed parses all fields including actual and revised', () => {
  const events = parseXmlCalendar(XML_FEED);
  assert.equal(events.length, 5);
  const nfp = events[0];
  assert.equal(nfp.title, 'Non-Farm Employment Change');
  assert.equal(nfp.country, 'USD');
  assert.equal(nfp.date, '07-15-2026');
  assert.equal(nfp.time, '8:30am');
  assert.equal(nfp.impact, 'High');
  assert.equal(nfp.forecast, '180K');
  assert.equal(nfp.previous, '200K');
  assert.equal(nfp.actual, '215K');
  assert.equal(nfp.revised, '205K');
  assert.equal(nfp.url, 'https://www.forexfactory.com/calendar?event=123');
});

test('JSON feed parses ISO timestamps with offsets', () => {
  const events = parseJsonCalendar(JSON_FEED);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'Federal Funds Rate');
  assert.equal(events[0].date, '2026-01-15T14:00:00-05:00');
  assert.equal(events[0].actual, '4.25%');
  assert.equal(events[1].actual, undefined);
});

test('parseCalendarFeed auto-detects XML and JSON', () => {
  assert.equal(parseCalendarFeed(XML_FEED).length, 5);
  assert.equal(parseCalendarFeed(JSON_FEED).length, 2);
  assert.throws(() => parseCalendarFeed('not a feed'), /unsupported format/);
  assert.throws(() => parseCalendarFeed(''), /empty/);
});

test('XML with DOCTYPE or ENTITY declarations is rejected', () => {
  const doctype = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]><weeklyevents></weeklyevents>';
  assert.throws(() => parseXmlCalendar(doctype), /unsupported XML declarations/);
  const entity = '<?xml version="1.0"?><weeklyevents><!ENTITY x "y"></weeklyevents>';
  assert.throws(() => parseXmlCalendar(entity), /unsupported XML declarations/);
});

test('source wall time converts to UTC and displays in Malaysia time (DST-aware)', () => {
  // Summer (EDT, UTC-4): 8:30am New York -> 20:30 Kuala Lumpur same day.
  const summer = zonedWallTimeToUtcMs({ year: 2026, month: 7, day: 15, hour: 8, minute: 30 }, 'America/New_York');
  const summerDisplay = formatInZone(summer, 'Asia/Kuala_Lumpur');
  assert.equal(summerDisplay.dateKey, '2026-07-15');
  assert.equal(summerDisplay.time, '20:30');

  // Winter (EST, UTC-5): 8:30am New York -> 21:30 Kuala Lumpur same day.
  const winter = zonedWallTimeToUtcMs({ year: 2026, month: 1, day: 15, hour: 8, minute: 30 }, 'America/New_York');
  const winterDisplay = formatInZone(winter, 'Asia/Kuala_Lumpur');
  assert.equal(winterDisplay.dateKey, '2026-01-15');
  assert.equal(winterDisplay.time, '21:30');

  // The same 8:30am New York wall time lands one hour apart in Malaysia because
  // of daylight saving (EDT vs EST), which proves the conversion is DST-aware.
  assert.equal(summerDisplay.time, '20:30');
  assert.equal(winterDisplay.time, '21:30');
  const toMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  assert.equal(toMinutes(winterDisplay.time) - toMinutes(summerDisplay.time), 60);

  // Late-evening New York event rolls into the next day in Malaysia.
  const rollover = zonedWallTimeToUtcMs({ year: 2026, month: 7, day: 15, hour: 20, minute: 0 }, 'America/New_York');
  const rolloverDisplay = formatInZone(rollover, 'Asia/Kuala_Lumpur');
  assert.equal(rolloverDisplay.dateKey, '2026-07-16');
  assert.equal(rolloverDisplay.time, '08:00');
});

test('clock strings parse correctly including midnight and noon', () => {
  assert.deepEqual(parseClock('8:30am'), { hour: 8, minute: 30 });
  assert.deepEqual(parseClock('8:30pm'), { hour: 20, minute: 30 });
  assert.deepEqual(parseClock('12:00am'), { hour: 0, minute: 0 });
  assert.deepEqual(parseClock('12:00pm'), { hour: 12, minute: 0 });
  assert.deepEqual(parseClock('14:30'), { hour: 14, minute: 30 });
  assert.deepEqual(parseClock('9'), { hour: 9, minute: 0 });
  assert.equal(parseClock('All Day'), null);
  assert.equal(parseClock('tentative'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('25:00'), null);
});

test('US date strings parse and invalid dates are rejected', () => {
  assert.deepEqual(parseUsDate('07-15-2026'), { year: 2026, month: 7, day: 15 });
  assert.equal(parseUsDate('13-01-2026'), null);
  assert.equal(parseUsDate('02-30-2026'), null);
  assert.equal(parseUsDate('garbage'), null);
});

test('normalization produces Malaysia dateKey, MYT time, and safe fields', () => {
  const event = normalizeEvent({
    title: 'Non-Farm Employment Change',
    country: 'USD',
    date: '07-15-2026',
    time: '8:30am',
    impact: 'High',
    forecast: '180K',
    previous: '200K',
    actual: '215K',
    revised: '205K',
    url: 'https://www.forexfactory.com/calendar?event=123'
  });
  assert.equal(event.currency, 'USD');
  assert.equal(event.impact, 'high');
  assert.equal(event.dateKey, '2026-07-15');
  assert.equal(event.actual, '215K');
  assert.equal(event.revised, '205K');
  assert.equal(event.timeUnknown, false);
  assert.ok(event.startMs > 0);
  assert.ok(event.id && event.id.length <= 20);
  assert.ok(event.relevance.includes('XAUUSD'), 'high-impact USD events map to XAUUSD');
  assert.ok(event.relevance.includes('EURUSD'));
  assert.equal(event.url, 'https://www.forexfactory.com/calendar?event=123');
});

test('all-day and tentative events keep a dateKey but no startMs', () => {
  const event = normalizeEvent({
    title: 'National Day',
    country: 'EUR',
    date: '07-16-2026',
    time: 'All Day',
    impact: 'Holiday'
  });
  assert.equal(event.startMs, null);
  assert.equal(event.timeUnknown, true);
  assert.equal(event.dateKey, '2026-07-16');
  assert.equal(event.impact, 'holiday');
});

test('missing values stay null instead of being fabricated', () => {
  const event = normalizeEvent({
    title: 'Core CPI m/m',
    country: 'USD',
    date: '07-15-2026',
    time: '8:30am',
    impact: 'High',
    forecast: '0.3%',
    previous: '0.2%',
    actual: '',
    revised: ''
  });
  assert.equal(event.actual, null);
  assert.equal(event.revised, null);
  assert.equal(event.forecast, '0.3%');
  assert.equal(event.previous, '0.2%');
});

test('URLs are restricted to Forex Factory over https', () => {
  const base = { title: 'Test', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High' };
  assert.equal(normalizeEvent({ ...base, url: 'https://www.forexfactory.com/calendar?event=1' }).url, 'https://www.forexfactory.com/calendar?event=1');
  assert.equal(normalizeEvent({ ...base, url: 'https://forexfactory.com/x' }).url, 'https://forexfactory.com/x');
  assert.equal(normalizeEvent({ ...base, url: 'http://www.forexfactory.com/x' }).url, null, 'plain http is rejected');
  assert.equal(normalizeEvent({ ...base, url: 'https://evil.example/x' }).url, null);
  assert.equal(normalizeEvent({ ...base, url: 'javascript:alert(1)' }).url, null);
  assert.equal(normalizeEvent({ ...base, url: 'data:text/html,<script>' }).url, null);
});

test('impact values normalize to lowercase keywords', () => {
  const base = { title: 'Test', country: 'USD', date: '07-15-2026', time: '8:30am' };
  assert.equal(normalizeEvent({ ...base, impact: 'High' }).impact, 'high');
  assert.equal(normalizeEvent({ ...base, impact: 'Medium' }).impact, 'medium');
  assert.equal(normalizeEvent({ ...base, impact: 'Low' }).impact, 'low');
  assert.equal(normalizeEvent({ ...base, impact: 'Holiday' }).impact, 'holiday');
  assert.equal(normalizeEvent({ ...base, impact: 'Mystery' }).impact, 'unknown');
  assert.equal(normalizeEvent({ ...base, impact: '' }).impact, 'unknown');
});

test('currency is normalized and ALL/GLOBAL become null', () => {
  const base = { title: 'Test', date: '07-15-2026', time: '8:30am', impact: 'High' };
  assert.equal(normalizeEvent({ ...base, country: 'usd' }).currency, 'USD');
  assert.equal(normalizeEvent({ ...base, country: 'ALL' }).currency, null);
  assert.equal(normalizeEvent({ ...base, country: 'GLOBAL' }).currency, null);
  assert.equal(normalizeEvent({ ...base, country: '' }).currency, null);
});

test('missing titles produce no event', () => {
  assert.equal(normalizeEvent({ title: '', country: 'USD', date: '07-15-2026', time: '8:30am' }), null);
  assert.equal(normalizeEvent({ title: null }), null);
  assert.equal(normalizeEvent(null), null);
});

test('duplicate events dedupe by id and keep the most complete record', () => {
  const first = normalizeEvents([
    { title: 'CPI y/y', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High', forecast: '3.0%', previous: '3.1%' },
    { title: 'CPI y/y', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High', forecast: '3.0%', previous: '3.1%', actual: '2.9%' }
  ]);
  assert.equal(first.length, 1);
  assert.equal(first[0].actual, '2.9%', 'the record with an actual result wins');

  const revised = normalizeEvents([
    { title: 'GDP q/q', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High', forecast: '2.0%', actual: '2.1%' },
    { title: 'GDP q/q', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High', forecast: '2.0%', actual: '2.1%', revised: '2.0%', previous: '1.9%' }
  ]);
  assert.equal(revised.length, 1);
  assert.equal(revised[0].revised, '2.0%');
});

test('events sort chronologically with undated events last', () => {
  const sorted = normalizeEvents([
    { title: 'Late', country: 'USD', date: '07-17-2026', time: '8:30am', impact: 'High' },
    { title: 'Early', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High' },
    { title: 'No date', country: 'USD', date: '', time: '', impact: 'High' }
  ]);
  assert.deepEqual(sorted.map(e => e.title), ['Early', 'Late', 'No date']);
});

test('high-impact and keyword events map to XAUUSD relevance; low-impact does not', () => {
  const high = normalizeEvent({ title: 'Whatever', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'High' });
  assert.ok(high.relevance.includes('XAUUSD'));

  const keyword = normalizeEvent({ title: 'Core CPI m/m', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'Medium' });
  assert.ok(keyword.relevance.includes('XAUUSD'), 'CPI keyword maps medium events to XAUUSD');

  const low = normalizeEvent({ title: 'Housing Starts', country: 'USD', date: '07-15-2026', time: '8:30am', impact: 'Low' });
  assert.equal(low.relevance.includes('XAUUSD'), false);

  const eur = normalizeEvent({ title: 'CPI y/y', country: 'EUR', date: '07-15-2026', time: '8:30am', impact: 'High' });
  assert.deepEqual(eur.relevance, ['EURUSD']);
});

test('calendar serves cached events, refreshes on demand, and reports actualsPublished', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const fetchImpl = fakeFetchSequence([xmlResponse(XML_FEED)]);
  const calendar = createEconomicCalendar({ db, fetchImpl, now: clock.now });
  await calendar.ready;

  const first = await calendar.refresh({ force: true });
  assert.equal(first.events.length, 5);
  assert.equal(first.meta.actualsPublished, true, 'the feed contained an actual value');
  assert.equal(first.meta.stale, false);
  assert.equal(first.meta.error, null);
  assert.equal(first.meta.displayTimeZone, 'Asia/Kuala_Lumpur');
  assert.equal(first.meta.sourceTimeZone, 'America/New_York');
  assert.equal(fetchImpl.calls.length, 1);

  // A cached read within the TTL does not hit the network again.
  clock.advance(60_000);
  const cached = await calendar.refresh({ force: false });
  assert.equal(cached.events.length, 5);
  assert.equal(fetchImpl.calls.length, 1, 'cached read does not refetch');
});

test('stale cache is served with an error when the source fails; 503 with no cache', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const fetchImpl = fakeFetchSequence([xmlResponse(XML_FEED), new Error('network down')]);
  const calendar = createEconomicCalendar({ db, fetchImpl, now: clock.now, config: { refreshIntervalMs: 1000 } });
  await calendar.ready;

  await calendar.refresh({ force: true });
  clock.advance(20_000); // past both the refresh TTL and the 15s force cooldown
  const stale = await calendar.refresh({ force: true });
  assert.equal(stale.events.length, 5, 'cached events are still served');
  assert.equal(stale.meta.stale, true);
  assert.match(stale.meta.error, /network down/);
  assert.ok(['STALE', 'DELAYED'].includes(stale.meta.feedState));

  // A brand new calendar with no cache cannot recover from a failed fetch.
  const emptyDb = await makeDb();
  const failing = fakeFetchSequence([new Error('offline')]);
  const cold = createEconomicCalendar({ db: emptyDb, fetchImpl: failing, now: clock.now });
  await cold.ready;
  await assert.rejects(() => cold.refresh({ force: true }), /offline/);
});

test('non-OK upstream responses respect Retry-After and record the failure', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const response = xmlResponse('busy', {
    ok: false,
    status: 429,
    headers: { get: name => (name === 'retry-after' ? '60' : null) }
  });
  const fetchImpl = fakeFetchSequence([response]);
  const calendar = createEconomicCalendar({ db, fetchImpl, now: clock.now });
  await calendar.ready;

  await assert.rejects(() => calendar.refresh({ force: true }), /HTTP 429/);

  // Subsequent reads inside the block window do not hit the network again.
  clock.advance(10_000);
  const blocked = await calendar.refresh({ force: true });
  assert.equal(blocked.events.length, 0);
  assert.equal(fetchImpl.calls.length, 1, 'blocked window short-circuits the fetch');
});

test('oversized feeds are rejected', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const huge = '<weeklyevents>' + '<event><title>x</title></event>'.repeat(2100) + '</weeklyevents>';
  const fetchImpl = fakeFetchSequence([xmlResponse(huge)]);
  const calendar = createEconomicCalendar({ db, fetchImpl, now: clock.now });
  await calendar.ready;
  await assert.rejects(() => calendar.refresh({ force: true }), /too many events/);
});

test('HTTP routes require authentication and serve the calendar', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const fetchImpl = fakeFetchSequence([xmlResponse(XML_FEED)]);
  const calendar = createEconomicCalendar({ db, fetchImpl, now: clock.now });
  await calendar.ready;

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  calendar.registerRoutes(app, { verifyToken });
  const { server, base } = await listen(app);

  try {
    const unauth = await fetch(`${base}/api/economic-calendar`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${base}/api/economic-calendar`, { headers: { Authorization: 'Bearer 1' } });
    assert.equal(auth.status, 200);
    const body = await auth.json();
    assert.equal(body.events.length, 5);
    assert.equal(body.meta.feedState, 'LIVE');

    const refreshUnauth = await fetch(`${base}/api/economic-calendar/refresh`, { method: 'POST' });
    assert.equal(refreshUnauth.status, 401);

    const refreshAuth = await fetch(`${base}/api/economic-calendar/refresh`, { method: 'POST', headers: { Authorization: 'Bearer 1' } });
    assert.equal(refreshAuth.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('manual refresh cooldown and read responses stay JSON even when the source errors', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const fetchImpl = fakeFetchSequence([xmlResponse(XML_FEED), new Error('down')]);
  const calendar = createEconomicCalendar({ db, fetchImpl, now: clock.now, config: { refreshIntervalMs: 1000 } });
  await calendar.ready;

  const app = express();
  calendar.registerRoutes(app, { verifyToken });
  const { server, base } = await listen(app);

  try {
    await fetch(`${base}/api/economic-calendar/refresh`, { method: 'POST', headers: { Authorization: 'Bearer 1' } });

    // Force refresh immediately again: the 15s cooldown returns the cached snapshot without refetching.
    const again = await fetch(`${base}/api/economic-calendar/refresh`, { method: 'POST', headers: { Authorization: 'Bearer 1' } });
    assert.equal(again.status, 200);
    assert.equal(fetchImpl.calls.length, 1, 'cooldown prevented a second upstream call');

    // Let the cooldown lapse, then fail the upstream. The route must still answer 200 with stale data.
    clock.advance(20_000);
    const stale = await fetch(`${base}/api/economic-calendar/refresh`, { method: 'POST', headers: { Authorization: 'Bearer 1' } });
    assert.equal(stale.status, 200, 'stale refresh still returns 200 for the UI');
    const staleBody = await stale.json();
    assert.equal(staleBody.events.length, 5);
    assert.equal(staleBody.meta.stale, true);
    assert.match(staleBody.meta.error, /down/);

    // A plain read after the TTL also surfaces the stale snapshot.
    clock.advance(5000);
    const read = await fetch(`${base}/api/economic-calendar`, { headers: { Authorization: 'Bearer 1' } });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(readBody.meta.stale, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('events without a time are still listed with a dateKey for date-only filtering', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const xml = `<?xml version="1.0"?><weeklyevents>
    <event><title>National Day</title><country>EUR</country><date>07-16-2026</date><time>All Day</time><impact>Holiday</impact></event>
  </weeklyevents>`;
  const calendar = createEconomicCalendar({ db, fetchImpl: fakeFetchSequence([xmlResponse(xml)]), now: clock.now });
  await calendar.ready;
  const data = await calendar.refresh({ force: true });
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].startMs, null);
  assert.equal(data.events[0].dateKey, '2026-07-16');
  assert.equal(data.events[0].timeUnknown, true);
});

test('feeds that contain only empty actuals report actualsPublished false', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const xml = `<?xml version="1.0"?><weeklyevents>
    <event><title>Retail Sales m/m</title><country>USD</country><date>07-15-2026</date><time>8:30am</time><impact>High</impact><forecast>0.6%</forecast><previous>0.4%</previous><actual></actual></event>
  </weeklyevents>`;
  const calendar = createEconomicCalendar({ db, fetchImpl: fakeFetchSequence([xmlResponse(xml)]), now: clock.now });
  await calendar.ready;
  const data = await calendar.refresh({ force: true });
  assert.equal(data.events[0].actual, null);
  assert.equal(data.meta.actualsPublished, false, 'the UI must label actuals as unavailable');
});

test('database cache survives a new calendar instance', async () => {
  const clock = makeClock();
  const db = await makeDb();
  const first = createEconomicCalendar({ db, fetchImpl: fakeFetchSequence([xmlResponse(XML_FEED)]), now: clock.now });
  await first.ready;
  await first.refresh({ force: true });

  // A second instance on the same database loads the persisted snapshot.
  const second = createEconomicCalendar({ db, fetchImpl: fakeFetchSequence([new Error('should not be called')]), now: clock.now, config: { refreshIntervalMs: 60_000 } });
  await second.ready;
  const data = await second.refresh({ force: false });
  assert.equal(data.events.length, 5, 'persisted events load from the database');
  assert.equal(data.meta.error, null);
});
