'use strict';

/*
 * Repeatable CornGrid EA load test.
 *
 * The server under test runs in a separate child process against an isolated
 * temporary SQLite file (never the production database.sqlite). The parent
 * process generates the same traffic a fleet of CornGrid EA installations
 * produces and measures latency/throughput, while the child reports its own
 * CPU, RSS and event-loop lag over IPC.
 *
 *   - POST /api/mt5/market     every `--quote-interval` ms (default 2000),
 *                              carrying quotes plus, every `--candle-interval`,
 *                              a small candle series (one payload, like the EA)
 *   - POST /api/mt5/heartbeat  account + positions every `--heartbeat-interval` ms (default 30000)
 *
 * Each virtual EA sends a unique X-Forwarded-For so a trusted-proxy deployment
 * keys its per-IP limits correctly, mirroring production behind IIS/Cloudflare.
 *
 * Usage:
 *   node scripts/loadtest.js
 *   node scripts/loadtest.js --levels 10,50,100,250,500 --duration 20
 *   node scripts/loadtest.js --users 100 --duration 30 --verbose
 *
 * Safety: it binds to 127.0.0.1 on an ephemeral port with its own temp
 * database, so it can never reach production data.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

// ---------------------------------------------------------------------------
// Child: the actual CornGrid server under test.
// ---------------------------------------------------------------------------
if (args.serve) {
  runServerChild();
} else {
  runCoordinator();
}

function runServerChild() {
  const express = require('express');
  const registerMt5Api = require('../mt5-api');
  const createMarketFeed = require('../market-feed');
  const registerMarketApi = require('../market-api');
  const createUserAuth = require('../user-auth');

  const count = Number(args.seed) || 100;

  const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));

  // --pg runs the server against a PostgreSQL database instead of a temp
  // SQLite file. The URL comes from --database-url or LOADTEST_DATABASE_URL
  // and MUST name a dedicated throwaway database: the child resets its public
  // schema before seeding. Anything not ending in _test/_loadtest is refused
  // so this can never touch production data.
  const usePg = Boolean(args.pg);
  const databaseUrl = args['database-url'] || process.env.LOADTEST_DATABASE_URL;
  let db;
  let dbFile = null;
  if (usePg) {
    if (!databaseUrl) {
      console.error('--pg requires --database-url or LOADTEST_DATABASE_URL.');
      process.exit(1);
    }
    let dbName = '';
    try { dbName = new URL(databaseUrl).pathname.replace(/^\//, ''); } catch { /* unparsable */ }
    if (!/(_test|_loadtest)$/i.test(dbName)) {
      console.error(`Refusing to load-test against database "${dbName || databaseUrl}": use a dedicated *_test or *_loadtest database.`);
      process.exit(1);
    }
    db = require('../db-postgres')(databaseUrl);
  } else {
    const sqlite3 = require('sqlite3').verbose();
    dbFile = args.db || path.join(os.tmpdir(), `corngrid-loadtest-${process.pid}.sqlite`);
    db = new sqlite3.Database(dbFile);
  }
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));

  const jwtSecret = 'load-test-secret';
  const verifyToken = createUserAuth({ db, jwtSecret });
  const { authenticateInstallation } = registerMt5Api(app, db, verifyToken);
  const marketFeed = createMarketFeed({ db, symbols: registerMarketApi.SYMBOLS });
  marketFeed.registerRoutes(app, { verifyToken, authenticateInstallation });
  registerMarketApi(app, db, verifyToken, marketFeed);

  const waitFor = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(25);
    }
    return false;
  };

  (async () => {
    if (usePg) {
      // Fresh, isolated schema: reset the public schema of the dedicated test
      // database and re-apply the PostgreSQL migration before seeding.
      const { Client } = require('pg');
      const admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await admin.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'postgres', '0001_initial.sql'), 'utf8'));
      await admin.end();
      await waitFor(() => new Promise(resolve => db.get(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mt5_accounts'",
        (error, row) => resolve(!error && !!row))));
    } else {
      await new Promise((resolve, reject) => db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;', error => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT);', error => error ? reject(error) : resolve()));
      await waitFor(() => new Promise(resolve => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='mt5_accounts'", (error, row) => resolve(!error && !!row))));
    }

    const ts = Date.now();
    await run(db, 'BEGIN IMMEDIATE');
    for (let i = 1; i <= count; i += 1) {
      const secret = crypto.createHash('sha256').update(`loadtest-secret-${i}`).digest('hex');
      await run(db, 'INSERT INTO users (id, username, email, password, bio, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', [i, `LoadUser${i}`, `load${i}@example.test`, 'x', '']);
      await run(db, 'INSERT INTO mt5_accounts (id, user_id, account_number, broker_server, currency, ea_name, ea_version, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [i, i, String(100000 + i), `Broker-${String(i).padStart(4, '0')}`, 'USD', 'CornGrid EA', '2.60', ts]);
      await run(db, 'INSERT INTO mt5_installations (account_id, secret_hash, created_at) VALUES (?, ?, ?)', [i, crypto.createHash('sha256').update(secret).digest('hex'), ts]);
    }
    await run(db, 'COMMIT');

    const server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    let maxLag = 0;
    let last = now();
    const lagTimer = setInterval(() => {
      const current = now();
      maxLag = Math.max(maxLag, current - last - 200);
      last = current;
    }, 200);

    let cpuBaseline = process.cpuUsage();
    process.on('message', message => {
      if (!message || message.type !== 'snapshot') return;
      const cpu = process.cpuUsage(cpuBaseline);
      cpuBaseline = process.cpuUsage();
      const lag = maxLag;
      maxLag = 0;
      process.send({
        type: 'snapshot', id: message.id, cpu, rss: process.memoryUsage().rss, maxLag: lag,
        pool: typeof db.poolStats === 'function' ? db.poolStats() : undefined
      });
    });

    process.send({ type: 'ready', origin: `http://127.0.0.1:${server.address().port}`, dbFile });

    const shutdown = () => {
      clearInterval(lagTimer);
      marketFeed.close();
      server.close(() => db.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('disconnect', shutdown);
    process.on('SIGTERM', shutdown);
  })().catch(error => {
    console.error('server child failed:', error);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Parent: traffic generator + reporter.
// ---------------------------------------------------------------------------
function runCoordinator() {
  const { fork } = require('child_process');

  // The generator keeps many concurrent sockets to the server. The Node global
  // fetch dispatcher limits per-origin connections by default, which would add
  // artificial queueing latency to the measurement.
  try {
    const { Agent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new Agent({ connections: 2000, pipelining: 0 }));
  } catch { /* fall back to the default dispatcher */ }

  const LEVELS = String(args.levels || '10,50,100,250,500')
    .split(',').map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value > 0);
  const DURATION_MS = (Number(args.duration) || 20) * 1000;
  const WARMUP_MS = (Number(args.warmup) || 3) * 1000;
  const QUOTE_INTERVAL_MS = Number(args['quote-interval']) || 2000;
  const CANDLE_INTERVAL_MS = Number(args['candle-interval']) || 8000;
  const HEARTBEAT_INTERVAL_MS = Number(args['heartbeat-interval']) || 30000;
  const POSITIONS = Number(args.positions) || 0;
  const SINGLE = args.users ? [Number(args.users) || 50] : null;
  const VERBOSE = Boolean(args.verbose);
  const MAX_ERROR_RATE = Number(args['max-error-rate']) || 0.25;
  const MAX_P99_MS = Number(args['max-p99']) || 8000;
  const BARS_PER_CANDLE = 2;

  const percentile = (sorted, p) => {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  };
  const statsFor = samples => {
    const sorted = samples.slice().sort((a, b) => a - b);
    return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.length ? sorted[sorted.length - 1] : 0 };
  };
  const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';

  function printResult(result) {
    console.log(`\n== ${result.users} users (${result.durationMs} ms measured) ==`);
    console.log(`  throughput : ${fmt(result.rps)} req/s   total ${result.totalRequests}   error rate ${fmt(result.errorRate * 100, 2)}%`);
    console.log(`  market     : n=${result.market.count}  p50 ${fmt(result.market.p50)}ms  p95 ${fmt(result.market.p95)}ms  p99 ${fmt(result.market.p99)}ms  status ${JSON.stringify(result.market.status)}  (w/ candles ${result.marketWithCandles})`);
    console.log(`  heartbeat  : n=${result.heartbeat.count}  p50 ${fmt(result.heartbeat.p50)}ms  p95 ${fmt(result.heartbeat.p95)}ms  p99 ${fmt(result.heartbeat.p99)}ms  status ${JSON.stringify(result.heartbeat.status)}`);
    console.log(`  server cpu : ${fmt(result.cpuPercentOfCore)}% of one core`);
    console.log(`  server rss : ${fmt(result.rssMB)}MB`);
    console.log(`  server lag : max event-loop lag ${fmt(result.maxEventLoopLagMs)}ms`);
    if (result.pool) console.log(`  db pool    : total ${result.pool.total}  idle ${result.pool.idle}  waiting ${result.pool.waiting}  max ${result.pool.max}`);
    if (result.aborted) console.log(`  !! aborted early: ${result.abortReason}`);
  }

  async function phase(origin, clients, { quoteInterval, candleInterval, heartbeatInterval }) {
    const metrics = {
      endAt: Date.now() + WARMUP_MS + DURATION_MS,
      warmupUntil: Date.now() + WARMUP_MS,
      market: [], heartbeat: [], marketStatus: {}, heartbeatStatus: {},
      marketWithCandles: 0, aborted: false, abortReason: null
    };
    let failures = 0;

    const call = async (url, headers, body) => {
      const started = now();
      let status = 0;
      try {
        const response = await fetch(url, { method: 'POST', headers, body });
        status = response.status;
        await response.arrayBuffer().catch(() => {});
      } catch (error) {
        status = -1;
        if (VERBOSE) console.error(`request failed: ${error.message}`);
      }
      return { status, latency: now() - started };
    };
    const record = (bucket, statusBucket, result) => {
      if (Date.now() < metrics.warmupUntil) return;
      bucket.push(result.latency);
      statusBucket[result.status] = (statusBucket[result.status] || 0) + 1;
      if (result.status !== 200 && result.status !== 202) failures += 1;
    };

    const candleEvery = candleInterval > 0 ? Math.max(1, Math.round(candleInterval / quoteInterval)) : 0;

    const runMarket = async (client) => {
      const start = Date.now();
      let tick = 0;
      while (!metrics.aborted) {
        const wait = start + tick * quoteInterval - Date.now();
        if (wait > 0) await sleep(wait);
        if (Date.now() >= metrics.endAt) break;
        const receivedNow = Date.now();
        const sentAt = receivedNow > client.lastSentAtMs ? receivedNow : client.lastSentAtMs + 1;
        client.lastSentAtMs = sentAt;
        const price = 2000 + (tick % 50) / 100;
        const payload = {
          schema: 1, sentAtMs: sentAt, serverUtcOffsetSec: 0,
          quotes: [{ symbol: 'XAUUSD.a', bid: price, ask: price + 0.2, last: null, spreadPoints: 20, digits: 2, tickTimeMs: receivedNow - 200, tickVolume: 5 + (tick % 10), volume: null }]
        };
        if (candleEvery && tick % candleEvery === 0) {
          const base = Math.floor(receivedNow / 1000 / 60) * 60;
          payload.candles = [{
            symbol: 'XAUUSD.a', tf: 'M1',
            bars: Array.from({ length: BARS_PER_CANDLE }, (_, b) => {
              const t = base - (BARS_PER_CANDLE - 1 - b) * 60;
              const o = 2000 + (tick % 40) / 100;
              return { t, o, h: o + 1, l: o - 1, c: o + 0.5, tv: 50 };
            })
          }];
          metrics.marketWithCandles += 1;
        }
        record(metrics.market, metrics.marketStatus, await call(`${origin}/api/mt5/market`, client.headers, JSON.stringify(payload)));
        if (failures > 300 && !metrics.aborted) { metrics.aborted = true; metrics.abortReason = `${failures} non-success responses`; }
        tick += 1;
      }
    };

    const runHeartbeat = async (client) => {
      if (!(heartbeatInterval > 0)) return;
      // Stagger phases so a short measurement window still observes heartbeats.
      const start = Date.now() + Math.random() * heartbeatInterval;
      let beat = 0;
      while (!metrics.aborted) {
        const wait = start + beat * heartbeatInterval - Date.now();
        if (wait > 0) await sleep(wait);
        if (Date.now() >= metrics.endAt) break;
        const receivedNow = Date.now();
        const positions = Array.from({ length: POSITIONS }, (_, p) => ({
          ticket: String(beat * 100 + p), symbol: 'XAUUSD', direction: p % 2 ? 'SELL' : 'BUY',
          volume: 0.1, entryPrice: 1990 + p, currentPrice: 2000, profit: 1.25 + p,
          swap: -0.1, openedAt: new Date(receivedNow - 3600000).toISOString()
        }));
        const body = JSON.stringify({
          timestamp: new Date(receivedNow).toISOString(),
          balance: 10000, equity: 10005, floatingProfit: 5,
          margin: 20, freeMargin: 9980, eaName: 'CornGrid EA', eaVersion: '2.60', positions
        });
        record(metrics.heartbeat, metrics.heartbeatStatus, await call(`${origin}/api/mt5/heartbeat`, client.headers, body));
        beat += 1;
      }
    };

    const wallStart = now();
    const before = await snapshot();
    await Promise.all(clients.map(client => Promise.all([runMarket(client), runHeartbeat(client)])));
    const wallMs = now() - wallStart;
    const after = await snapshot();

    const measuredMs = Math.max(1, Math.min(wallMs, metrics.endAt - metrics.warmupUntil));
    const totalRequests = metrics.market.length + metrics.heartbeat.length;
    const totalErrors = [...Object.entries(metrics.marketStatus), ...Object.entries(metrics.heartbeatStatus)]
      .filter(([status]) => status !== '200' && status !== '202')
      .reduce((sum, [, count]) => sum + count, 0);

    return {
      users: clients.length,
      durationMs: Math.round(measuredMs),
      rps: totalRequests / (measuredMs / 1000),
      totalRequests,
      errorRate: totalRequests ? totalErrors / totalRequests : 0,
      market: { ...statsFor(metrics.market), status: metrics.marketStatus },
      heartbeat: { ...statsFor(metrics.heartbeat), status: metrics.heartbeatStatus },
      marketWithCandles: metrics.marketWithCandles,
      cpuPercentOfCore: ((after.cpu.user + after.cpu.system) / 1000) / wallMs * 100,
      rssMB: after.rss / 1048576,
      rssDeltaMB: (after.rss - before.rss) / 1048576,
      maxEventLoopLagMs: after.maxLag,
      pool: after.pool || undefined,
      aborted: metrics.aborted,
      abortReason: metrics.abortReason
    };
  }

  // --- IPC helpers ---------------------------------------------------------
  let child = null;
  let nextId = 1;
  const pending = new Map();
  const makeClients = users => users.map(user => ({
    headers: { Authorization: `Bearer ${user.secret}`, 'Content-Type': 'application/json', 'X-Forwarded-For': user.ip },
    lastSentAtMs: 0
  }));
  async function snapshot() {
    const id = nextId++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      child.send({ type: 'snapshot', id });
    });
  }

  async function main() {
    const levels = SINGLE || LEVELS;
    const maxUsers = Math.max(...levels);
    const dbFile = path.join(os.tmpdir(), `corngrid-loadtest-${process.pid}-${Date.now()}.sqlite`);

    const childArgs = ['--serve', '--seed', String(maxUsers)];
    if (args.pg) {
      childArgs.push('--pg');
      if (args['database-url']) childArgs.push('--database-url', args['database-url']);
    } else {
      childArgs.push('--db', dbFile);
    }
    child = fork(__filename, childArgs, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    child.on('message', message => {
      if (message && message.type === 'snapshot' && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });

    const users = [];
    const baseClient = [];
    const origin = await new Promise((resolve, reject) => {
      child.on('message', message => {
        if (message && message.type === 'ready') resolve(message.origin);
      });
      child.on('exit', code => reject(new Error(`server child exited early (${code})`)));
      setTimeout(() => reject(new Error('server child did not become ready')), 30000);
    });
    const readyMessage = { origin };
    for (let i = 1; i <= maxUsers; i += 1) {
      const secret = crypto.createHash('sha256').update(`loadtest-secret-${i}`).digest('hex');
      users.push({ secret, ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });
    }
    const clients = makeClients(users);

    console.log('CornGrid EA load test');
    console.log(`  target      : ${readyMessage.origin} (${args.pg ? 'PostgreSQL ' + (args['database-url'] || process.env.LOADTEST_DATABASE_URL || '').replace(/\/\/.*@/, '//***@') : 'isolated temp DB ' + dbFile})`);
    console.log(`  workload    : market every ${QUOTE_INTERVAL_MS}ms (candles every ${CANDLE_INTERVAL_MS}ms), heartbeat every ${HEARTBEAT_INTERVAL_MS}ms, positions ${POSITIONS}`);
    console.log(`  levels      : ${levels.join(', ')} users`);
    console.log(`  warmup/dur  : ${WARMUP_MS / 1000}s / ${DURATION_MS / 1000}s per level`);

    const results = [];
    for (const level of levels) {
      const result = await phase(readyMessage.origin, clients.slice(0, level), {
        quoteInterval: QUOTE_INTERVAL_MS, candleInterval: CANDLE_INTERVAL_MS, heartbeatInterval: HEARTBEAT_INTERVAL_MS
      });
      results.push(result);
      printResult(result);
      if (result.errorRate > MAX_ERROR_RATE || result.market.p99 > MAX_P99_MS) {
        console.log(`\nAborting remaining levels: error rate ${fmt(result.errorRate * 100, 2)}% or p99 ${fmt(result.market.p99)}ms exceeded thresholds.`);
        break;
      }
    }

    const summaryFile = path.join(__dirname, 'load-test-results.json');
    fs.writeFileSync(summaryFile, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
    console.log(`\nRaw results written to ${summaryFile}`);

    child.disconnect();
    if (!args.pg) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbFile + suffix); } catch { /* ignore */ }
      }
    }
    process.exit(results.some(result => result.aborted) ? 1 : 0);
  }

  main().catch(error => {
    console.error('Load test failed:', error);
    if (child) child.kill();
    process.exit(1);
  });
}
