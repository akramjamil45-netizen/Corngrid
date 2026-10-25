const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { avatarUrl, AVATAR_SCHEMA } = require('./avatar-api');
const { exclusive } = require('./db-write');

const configuredHeartbeatTimeout = process.env.MT5_HEARTBEAT_TIMEOUT_SECONDS === undefined
  ? 180
  : Number(process.env.MT5_HEARTBEAT_TIMEOUT_SECONDS);
if (!Number.isInteger(configuredHeartbeatTimeout) || configuredHeartbeatTimeout < 30 || configuredHeartbeatTimeout > 3600) {
  throw new Error('MT5_HEARTBEAT_TIMEOUT_SECONDS must be an integer between 30 and 3600.');
}
const HEARTBEAT_TIMEOUT_SECONDS = configuredHeartbeatTimeout;

// EA installation credentials are immutable per account (revocation deletes the
// row), so the auth lookup result can be cached briefly. This removes a SQLite
// query from every market/heartbeat request, which is the single hottest path
// under a large EA fleet. Set to 0 to always hit the database.
const configuredAuthCacheTtl = process.env.MT5_AUTH_CACHE_TTL_MS === undefined
  ? 5000 : Number(process.env.MT5_AUTH_CACHE_TTL_MS);
if (!Number.isInteger(configuredAuthCacheTtl) || configuredAuthCacheTtl < 0 || configuredAuthCacheTtl > 60000) {
  throw new Error('MT5_AUTH_CACHE_TTL_MS must be an integer between 0 and 60000.');
}
const AUTH_CACHE_TTL_MS = configuredAuthCacheTtl;

// Writing a snapshot on every heartbeat creates millions of rows a month for a
// large fleet. This throttles history writes per account without touching the
// live balance/equity on mt5_accounts. Set to 0 to store every heartbeat.
const configuredSnapshotInterval = process.env.MT5_SNAPSHOT_MIN_INTERVAL_SECONDS === undefined
  ? 60 : Number(process.env.MT5_SNAPSHOT_MIN_INTERVAL_SECONDS);
if (!Number.isInteger(configuredSnapshotInterval) || configuredSnapshotInterval < 0 || configuredSnapshotInterval > 86400) {
  throw new Error('MT5_SNAPSHOT_MIN_INTERVAL_SECONDS must be an integer between 0 and 86400.');
}
const SNAPSHOT_MIN_INTERVAL_MS = configuredSnapshotInterval * 1000;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_POSITION_COUNT = 2000;
const MAX_DEAL_COUNT = 500;
// A position row binds 14 columns. Chunking the writes keeps every statement
// well under SQLite's bound-parameter ceiling while using a single round trip.
const POSITION_COLUMNS = 14;
const DEAL_COLUMNS = 17;
const MAX_BIND_PARAMS = 900;
const POSITION_ROWS_PER_INSERT = Math.floor(MAX_BIND_PARAMS / POSITION_COLUMNS);
const DEAL_ROWS_PER_INSERT = Math.floor(MAX_BIND_PARAMS / DEAL_COLUMNS);

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  ${AVATAR_SCHEMA}
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_auth_versions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS user_account_access (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    suspended_until INTEGER NOT NULL,
    reason TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS public_portfolios (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    share_id TEXT NOT NULL UNIQUE,
    is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1)),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mt5_pairing_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mt5_pairing_codes_user ON mt5_pairing_codes(user_id);
  CREATE TABLE IF NOT EXISTS mt5_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_number TEXT NOT NULL,
    broker_server TEXT NOT NULL,
    currency TEXT NOT NULL,
    account_name TEXT NOT NULL DEFAULT 'CornGrid EA',
    balance REAL,
    equity REAL,
    margin REAL,
    free_margin REAL,
    floating_profit REAL,
    ea_name TEXT,
    ea_version TEXT,
    last_heartbeat INTEGER,
    last_sync INTEGER,
    linked_at INTEGER NOT NULL,
    auth_error_at INTEGER,
    UNIQUE(account_number, broker_server)
  );
  CREATE INDEX IF NOT EXISTS mt5_accounts_user ON mt5_accounts(user_id);
  CREATE TABLE IF NOT EXISTS public_portfolio_accounts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL UNIQUE REFERENCES mt5_accounts(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id, account_id)
  );
  CREATE TRIGGER IF NOT EXISTS public_portfolio_account_owner_insert
  BEFORE INSERT ON public_portfolio_accounts
  WHEN NOT EXISTS (
    SELECT 1 FROM mt5_accounts WHERE id = NEW.account_id AND user_id = NEW.user_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'Portfolio account owner mismatch.');
  END;
  CREATE TABLE IF NOT EXISTS mt5_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS mt5_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
    captured_at INTEGER NOT NULL,
    balance REAL NOT NULL,
    equity REAL NOT NULL,
    floating_profit REAL NOT NULL,
    UNIQUE(account_id, captured_at)
  );
  CREATE INDEX IF NOT EXISTS mt5_snapshots_account_time ON mt5_snapshots(account_id, captured_at);
  CREATE TABLE IF NOT EXISTS mt5_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
    ticket TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('BUY', 'SELL')),
    volume REAL NOT NULL,
    entry_price REAL NOT NULL,
    current_price REAL,
    stop_loss REAL,
    take_profit REAL,
    profit REAL NOT NULL,
    swap REAL,
    commission REAL,
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(account_id, ticket)
  );
  CREATE INDEX IF NOT EXISTS mt5_positions_account_symbol ON mt5_positions(account_id, symbol);
  CREATE TABLE IF NOT EXISTS mt5_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
    deal_id TEXT NOT NULL,
    position_id TEXT,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('BUY', 'SELL')),
    volume REAL NOT NULL,
    entry_price REAL,
    exit_price REAL,
    stop_loss REAL,
    take_profit REAL,
    profit REAL NOT NULL,
    commission REAL,
    swap REAL,
    closed_at INTEGER NOT NULL,
    duration_seconds INTEGER,
    magic_number TEXT,
    ea_version TEXT,
    UNIQUE(account_id, deal_id)
  );
  CREATE INDEX IF NOT EXISTS mt5_deals_account_time ON mt5_deals(account_id, closed_at);
`;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function validNumber(value, { min = -1e15, max = 1e15 } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validText(value, maxLength, pattern = null) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength && (!pattern || pattern.test(value.trim()));
}

function timestamp(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function maskedAccount(accountNumber) {
  const value = String(accountNumber);
  if (value.length <= 4) return '•'.repeat(value.length);
  const tail = value.slice(-4);
  return `${'•'.repeat(Math.min(value.length - tail.length, 8))}${tail}`;
}

function formatTimestamp(value) {
  return value == null ? null : new Date(value).toISOString();
}

function dateKeyInTimeZone(value, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateStartInTimeZone(dateKey, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]));
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const adjustment = target - localAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return guess;
}

function pageParams(req) {
  const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit, offset: (page - 1) * limit };
}

function rateLimiter({ limit, windowMs, key }) {
  const requests = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (requests.size > 1000) {
      for (const [bucketKey, bucket] of requests) {
        if (bucket.expiresAt <= now) requests.delete(bucketKey);
      }
    }
    const bucketKey = key(req);
    const bucket = requests.get(bucketKey);
    if (!bucket || bucket.expiresAt <= now) {
      requests.set(bucketKey, { count: 1, expiresAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.expiresAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }
    return next();
  };
}

function ownerId(req) {
  return req.user.id;
}

async function overviewAccountScope(db, req) {
  if (req.query.accountId === undefined) return { account: null };
  if (typeof req.query.accountId !== 'string' || !/^[1-9]\d*$/.test(req.query.accountId)) {
    return { error: { status: 400, message: 'Account ID must be a positive integer.' } };
  }
  const accountId = Number(req.query.accountId);
  if (!Number.isSafeInteger(accountId)) {
    return { error: { status: 400, message: 'Account ID must be a positive integer.' } };
  }
  const account = await get(db, `
    SELECT id, currency FROM mt5_accounts WHERE id = ? AND user_id = ?
  `, [accountId, ownerId(req)]);
  return account
    ? { account }
    : { error: { status: 404, message: 'MT5 account not found.' } };
}

const SNAPSHOT_RETENTION_DAYS = Number(process.env.MT5_SNAPSHOT_RETENTION_DAYS) || 90;

async function performDataRetentionCleanup(db) {
  try {
    const now = Date.now();
    const snapshotCutoff = now - (SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const expiredCutoff = now - (24 * 60 * 60 * 1000);

    const prunedSnapshots = await run(db, 'DELETE FROM mt5_snapshots WHERE captured_at < ?', [snapshotCutoff]).catch(() => ({ changes: 0 }));
    const prunedCodes = await run(db, 'DELETE FROM mt5_pairing_codes WHERE (expires_at < ? OR used_at IS NOT NULL) AND created_at < ?', [now, expiredCutoff]).catch(() => ({ changes: 0 }));
    const prunedTokens = await run(db, 'DELETE FROM password_reset_tokens WHERE (expires_at < ? OR used_at IS NOT NULL) AND created_at < ?', [now, expiredCutoff]).catch(() => ({ changes: 0 }));

    if ((prunedSnapshots && prunedSnapshots.changes > 0) || (prunedCodes && prunedCodes.changes > 0) || (prunedTokens && prunedTokens.changes > 0)) {
      console.log(`[Retention Cleanup] Pruned ${prunedSnapshots.changes} snapshots (> ${SNAPSHOT_RETENTION_DAYS}d), ${prunedCodes.changes} pairing codes, and ${prunedTokens.changes} tokens.`);
    }
  } catch (cleanupError) {
    console.error('[Retention Cleanup Error]:', cleanupError.message);
  }
}

function registerMt5Api(app, db, verifyToken) {
  db.exec(schema, (error) => {
    if (error) {
      console.error('Unable to initialize MT5 dashboard tables:', error.message);
    } else {
      performDataRetentionCleanup(db);
    }
  });

  const retentionTimer = setInterval(() => performDataRetentionCleanup(db), 24 * 60 * 60 * 1000);
  if (retentionTimer.unref) retentionTimer.unref();

  const authenticated = verifyToken;
  const pairingLimit = rateLimiter({ limit: 5, windowMs: 15 * 60 * 1000, key: req => `pair:${ownerId(req)}` });
  const passwordLimit = rateLimiter({ limit: 5, windowMs: 15 * 60 * 1000, key: req => `password:${ownerId(req)}` });
  const eaPairLimit = rateLimiter({ limit: 20, windowMs: 60 * 1000, key: req => `pair-ip:${req.ip}` });
  // Behind a reverse proxy every EA shares one IP, so the EA data limit is
  // keyed by the installation instead of the IP. A few busy accounts could
  // otherwise lock every other account out with HTTP 429. The coarse IP cap
  // still guards the unauthenticated request path.
  // Coarse pre-auth IP cap. Behind a proxy that does not forward the real client
  // IP (TRUST_PROXY not set) every EA shares one address, so this must stay high
  // enough for the whole fleet; the per-installation limit below is the real
  // guard. Raise it further with MT5_EA_IP_LIMIT for very large fleets.
  const eaIpLimitValue = Number(process.env.MT5_EA_IP_LIMIT) > 0 ? Number(process.env.MT5_EA_IP_LIMIT) : 600;
  const eaIpLimit = rateLimiter({ limit: eaIpLimitValue, windowMs: 60 * 1000, key: req => `ea-ip:${req.ip}` });
  const eaDataLimit = rateLimiter({ limit: 120, windowMs: 60 * 1000, key: req => `ea:${req.installation ? req.installation.installation_id : req.ip}` });
  const publicReadLimit = rateLimiter({ limit: 60, windowMs: 60 * 1000, key: req => `public-portfolio:${req.ip}` });

  // Installation auth cache (see AUTH_CACHE_TTL_MS). Keyed by the SHA-256 of the
  // supplied secret; each entry records the account so it can be purged when the
  // account is unlinked.
  const authCache = new Map();
  const MAX_AUTH_CACHE_ENTRIES = 50000;
  function rememberInstallation(secretHash, installation) {
    if (AUTH_CACHE_TTL_MS <= 0) return;
    if (authCache.size >= MAX_AUTH_CACHE_ENTRIES) {
      const now = Date.now();
      for (const [key, entry] of authCache) if (entry.expiresAt <= now) authCache.delete(key);
      if (authCache.size >= MAX_AUTH_CACHE_ENTRIES) authCache.clear();
    }
    authCache.set(secretHash, { installation, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  }
  function forgetAccount(accountId) {
    for (const [key, entry] of authCache) {
      if (entry.installation.account_id === accountId) authCache.delete(key);
    }
  }

  // Per-account write-throttling state (see SNAPSHOT_MIN_INTERVAL_MS and the
  // position fingerprint in the heartbeat handler).
  const lastSnapshotAt = new Map();
  const positionFingerprints = new Map();

  app.get('/api/me', authenticated, async (req, res) => {
    try {
      const user = await get(db, 'SELECT id, username, email, bio, created_at FROM users WHERE id = ?', [ownerId(req)]);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const avatarRow = await get(db, 'SELECT file FROM user_avatars WHERE user_id = ?', [ownerId(req)]);
      const row = await get(db, 'SELECT preferences_json FROM user_preferences WHERE user_id = ?', [ownerId(req)]);
      let preferences = {};
      if (row) {
        try { preferences = JSON.parse(row.preferences_json); }
        catch (parseError) {
          console.error('Unable to parse saved user preferences:', parseError.message);
          return res.status(500).json({ error: 'Saved preferences could not be read.' });
        }
      }
      if (preferences.timezone) {
        try { new Intl.DateTimeFormat('en', { timeZone: preferences.timezone }); }
        catch {
          console.error('Saved user time zone preference is invalid.');
          return res.status(500).json({ error: 'The saved time zone preference is invalid. Update it in settings.' });
        }
      }
      return res.json({ ...user, preferences, avatarUrl: avatarUrl(avatarRow && avatarRow.file) });
    } catch (databaseError) {
      console.error('Failed to load the authenticated user profile:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load profile data.' });
    }
  });

  app.patch('/api/user/preferences', authenticated, async (req, res) => {
    const input = req.body || {};
    const allowed = new Set(['theme', 'currency', 'timezone', 'dateFormat', 'economicNews']);
    if (Object.keys(input).some(key => !allowed.has(key))) return res.status(400).json({ error: 'Unsupported preference provided.' });
    if (input.theme !== undefined && !['dark', 'light', 'system'].includes(input.theme)) return res.status(400).json({ error: 'Theme must be dark, light, or system.' });
    if (input.currency !== undefined && !['account', 'USD', 'EUR', 'GBP'].includes(input.currency)) return res.status(400).json({ error: 'Unsupported display currency.' });
    if (input.economicNews !== undefined) {
      const economicNews = input.economicNews;
      if (!economicNews || typeof economicNews !== 'object' || Array.isArray(economicNews)) {
        return res.status(400).json({ error: 'Economic news preferences must be an object.' });
      }
      const allowedNews = new Set(['enabled', 'alertWindow', 'browserNotifications', 'relevance']);
      if (Object.keys(economicNews).some(key => !allowedNews.has(key))) {
        return res.status(400).json({ error: 'Unsupported economic news preference provided.' });
      }
      if (economicNews.enabled !== undefined && typeof economicNews.enabled !== 'boolean') {
        return res.status(400).json({ error: 'Economic news alerts must be enabled or disabled.' });
      }
      if (economicNews.browserNotifications !== undefined && typeof economicNews.browserNotifications !== 'boolean') {
        return res.status(400).json({ error: 'Browser notification preference must be enabled or disabled.' });
      }
      if (economicNews.alertWindow !== undefined && ![5, 15, 30, 60].includes(economicNews.alertWindow)) {
        return res.status(400).json({ error: 'Alert window must be 5, 15, 30, or 60 minutes.' });
      }
      if (economicNews.relevance !== undefined && !['all', 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'].includes(economicNews.relevance)) {
        return res.status(400).json({ error: 'Unsupported market relevance filter.' });
      }
    }
    if (input.timezone !== undefined) {
      if (!validText(input.timezone, 64)) return res.status(400).json({ error: 'Time zone must be between 1 and 64 characters.' });
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); }
      catch { return res.status(400).json({ error: 'Time zone must be a valid IANA time-zone name.' }); }
    }
    if (input.dateFormat !== undefined && !['locale', 'en-US', 'en-GB', 'iso'].includes(input.dateFormat)) return res.status(400).json({ error: 'Unsupported date format.' });

    try {
      const existing = await get(db, 'SELECT preferences_json FROM user_preferences WHERE user_id = ?', [ownerId(req)]);
      const preferences = existing ? JSON.parse(existing.preferences_json) : {};
      const nextPreferences = { ...preferences, ...input };
      if (input.economicNews) {
        nextPreferences.economicNews = { ...(preferences.economicNews || {}), ...input.economicNews };
      }
      await run(
        db,
        `INSERT INTO user_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at`,
        [ownerId(req), JSON.stringify(nextPreferences), Date.now()]
      );
      return res.json({ preferences: nextPreferences });
    } catch (databaseError) {
      console.error('Failed to save user preferences:', databaseError.message);
      return res.status(500).json({ error: 'Unable to save preferences.' });
    }
  });

  app.post('/api/user/change-password', authenticated, passwordLimit, async (req, res) => {
    const currentPassword = req.body && req.body.currentPassword;
    const newPassword = req.body && req.body.newPassword;
    if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Current and new passwords are required.' });
    }
    if (newPassword.length < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) return res.status(400).json({ error: 'The new password must be at least 8 characters and no more than 72 UTF-8 bytes.' });
    try {
      const user = await get(db, 'SELECT password FROM users WHERE id = ?', [ownerId(req)]);
      if (!user || !(await bcrypt.compare(currentPassword, user.password))) return res.status(400).json({ error: 'Current password is incorrect.' });
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await run(db, 'UPDATE users SET password = ? WHERE id = ?', [passwordHash, ownerId(req)]);
      await run(db, `
        INSERT INTO user_auth_versions (user_id, version) VALUES (?, 1)
        ON CONFLICT(user_id) DO UPDATE SET version = version + 1
      `, [ownerId(req)]);
      return res.json({ message: 'Password changed. Please sign in again.', requireLogin: true });
    } catch (databaseError) {
      console.error('Failed to change account password:', databaseError.message);
      return res.status(500).json({ error: 'Unable to change password.' });
    }
  });

  app.get('/api/mt5/accounts', authenticated, async (req, res) => {
    try {
      const rows = await all(db, `
        SELECT a.id, a.account_number, a.broker_server, a.currency, a.account_name,
               a.balance, a.equity, a.floating_profit, a.ea_name, a.ea_version,
               a.last_heartbeat, a.last_sync, a.linked_at, a.auth_error_at,
               (SELECT COUNT(*) FROM mt5_positions p WHERE p.account_id = a.id) AS open_positions
        FROM mt5_accounts a WHERE a.user_id = ? ORDER BY a.linked_at DESC
      `, [ownerId(req)]);
      const now = Date.now();
      const accounts = rows.map(row => {
        const heartbeatFresh = row.last_heartbeat !== null &&
          row.last_heartbeat <= now + 60 * 1000 &&
          now - row.last_heartbeat <= HEARTBEAT_TIMEOUT_SECONDS * 1000;
        const status = row.auth_error_at && (!row.last_heartbeat || row.auth_error_at > row.last_heartbeat)
          ? 'Authentication error'
          : heartbeatFresh ? 'Online' : row.last_heartbeat ? 'Offline' : 'Waiting for data';
        return {
          id: row.id,
          maskedAccount: maskedAccount(row.account_number),
          brokerServer: row.broker_server,
          currency: row.currency,
          accountName: row.account_name,
          balance: row.balance,
          equity: row.equity,
          floatingProfit: row.floating_profit,
          eaName: row.ea_name,
          eaVersion: row.ea_version,
          lastHeartbeat: formatTimestamp(row.last_heartbeat),
          lastSync: formatTimestamp(row.last_sync),
          linkedAt: formatTimestamp(row.linked_at),
          status,
          openPositions: row.open_positions
        };
      });
      return res.json({ accounts, heartbeatTimeoutSeconds: HEARTBEAT_TIMEOUT_SECONDS });
    } catch (databaseError) {
      console.error('Failed to load MT5 accounts:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load MT5 accounts.' });
    }
  });

  app.post('/api/mt5/pairing-code', authenticated, pairingLimit, async (req, res) => {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    try {
      await run(db, 'DELETE FROM mt5_pairing_codes WHERE user_id = ?', [ownerId(req)]);
      await run(db, 'INSERT INTO mt5_pairing_codes (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [codeHash, ownerId(req), expiresAt, now]);
      return res.status(201).json({ code, expiresAt: formatTimestamp(expiresAt) });
    } catch (databaseError) {
      console.error('Failed to create MT5 pairing code:', databaseError.message);
      return res.status(500).json({ error: 'Unable to generate a pairing code.' });
    }
  });

  app.post('/api/mt5/pair', eaPairLimit, async (req, res) => {
    const body = req.body || {};
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const accountNumber = typeof body.accountNumber === 'string' ? body.accountNumber.trim() : '';
    const brokerServer = typeof body.brokerServer === 'string' ? body.brokerServer.trim() : '';
    const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    const eaVersion = body.eaVersion === undefined ? null : body.eaVersion;
    if (!/^[A-F0-9]{8}$/.test(code)) return res.status(400).json({ error: 'A valid 8-character pairing code is required.' });
    if (!/^[0-9]{1,32}$/.test(accountNumber)) return res.status(400).json({ error: 'A valid MT5 account identifier is required.' });
    if (!validText(brokerServer, 100)) return res.status(400).json({ error: 'A valid broker/server name is required.' });
    if (!/^[A-Z]{3,8}$/.test(currency)) return res.status(400).json({ error: 'A valid account currency is required.' });
    if (eaVersion !== null && !validText(eaVersion, 40)) return res.status(400).json({ error: 'EA version must be between 1 and 40 characters.' });

    const now = Date.now();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
    try {
      const pairing = await get(db, 'SELECT user_id FROM mt5_pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [codeHash, now]);
      if (!pairing) return res.status(400).json({ error: 'Pairing code is invalid, expired, or already used.' });
      const consumed = await run(db, 'UPDATE mt5_pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [now, codeHash, now]);
      if (consumed.changes !== 1) return res.status(400).json({ error: 'Pairing code is invalid, expired, or already used.' });

      let account;
      try {
        account = await run(
          db,
          `INSERT INTO mt5_accounts (user_id, account_number, broker_server, currency, ea_version, linked_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [pairing.user_id, accountNumber, brokerServer, currency, eaVersion, now]
        );
        await run(db, 'INSERT INTO mt5_installations (account_id, secret_hash, created_at) VALUES (?, ?, ?)', [account.lastID, secretHash, now]);
      } catch (insertError) {
        if (account && account.lastID) await run(db, 'DELETE FROM mt5_accounts WHERE id = ? AND user_id = ?', [account.lastID, pairing.user_id]).catch(() => {});
        if (insertError.message.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'This MT5 account is already linked.' });
        throw insertError;
      }
      return res.status(201).json({ message: 'MT5 account paired successfully.', installationSecret: secret });
    } catch (databaseError) {
      console.error('Failed to pair MT5 account:', databaseError.message);
      return res.status(500).json({ error: 'Unable to pair this MT5 account.' });
    }
  });

  async function authenticateInstallation(req, res, next) {
    const header = req.headers.authorization || '';
    const suppliedSecret = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!/^[a-f0-9]{64}$/i.test(suppliedSecret)) return res.status(401).json({ error: 'Valid EA installation credentials are required.' });
    const secretHash = crypto.createHash('sha256').update(suppliedSecret).digest('hex');

    // Fast path: a valid installation was authenticated moments ago. Credentials
    // are immutable per account and unlink purges the cache, so this is safe.
    const cached = AUTH_CACHE_TTL_MS > 0 ? authCache.get(secretHash) : null;
    if (cached && cached.expiresAt > Date.now()) {
      req.installation = cached.installation;
      return next();
    }
    try {
      const installation = await get(db, `
        SELECT i.id AS installation_id, i.account_id, a.user_id, a.last_heartbeat, a.broker_server
        FROM mt5_installations i
        JOIN mt5_accounts a ON a.id = i.account_id
        WHERE i.secret_hash = ? AND i.revoked_at IS NULL
      `, [secretHash]);
      if (!installation) return res.status(401).json({ error: 'EA installation credentials are invalid or revoked.' });
      rememberInstallation(secretHash, installation);
      req.installation = installation;
      next();
    } catch (databaseError) {
      console.error('Failed to authenticate EA installation:', databaseError.message);
      return res.status(500).json({ error: 'Unable to authenticate this EA installation.' });
    }
  }

  app.post('/api/mt5/heartbeat', eaIpLimit, authenticateInstallation, eaDataLimit, async (req, res) => {
    const body = req.body || {};
    const balance = body.balance;
    const equity = body.equity;
    const margin = body.margin ?? null;
    const freeMargin = body.freeMargin ?? null;
    const floatingProfit = body.floatingProfit;
    const capturedAt = timestamp(body.timestamp);
    const eaName = body.eaName === undefined ? null : body.eaName;
    const eaVersion = body.eaVersion === undefined ? null : body.eaVersion;
    if (![balance, equity, floatingProfit].every(value => validNumber(value))) return res.status(400).json({ error: 'Balance, equity, and floating profit must be finite numeric values.' });
    if (margin !== null && !validNumber(margin, { min: 0 })) return res.status(400).json({ error: 'Margin must be a non-negative number.' });
    if (freeMargin !== null && !validNumber(freeMargin, { min: -1e15 })) return res.status(400).json({ error: 'Free margin must be a valid number.' });
    if (!capturedAt || capturedAt > Date.now() + 60 * 1000) return res.status(400).json({ error: 'Snapshot timestamp is invalid or too far in the future.' });
    if (eaName !== null && !validText(eaName, 100)) return res.status(400).json({ error: 'EA name must be between 1 and 100 characters.' });
    if (eaVersion !== null && !validText(eaVersion, 40)) return res.status(400).json({ error: 'EA version must be between 1 and 40 characters.' });
    const positions = body.positions;
    if (positions !== undefined && (!Array.isArray(positions) || positions.length > MAX_POSITION_COUNT)) return res.status(400).json({ error: `Positions must be an array of no more than ${MAX_POSITION_COUNT} entries.` });
    const validatedPositions = [];
    if (positions) {
      const seenTickets = new Set();
      for (const position of positions) {
        if (!position || !validText(String(position.ticket ?? ''), 64) || !validText(position.symbol, 32) ||
          !['BUY', 'SELL'].includes(position.direction) || !validNumber(position.volume, { min: 0, max: 1e8 }) ||
          !validNumber(position.entryPrice, { min: 0 }) || !validNumber(position.profit) ||
          (position.currentPrice != null && !validNumber(position.currentPrice, { min: 0 })) ||
          (position.stopLoss != null && !validNumber(position.stopLoss, { min: 0 })) ||
          (position.takeProfit != null && !validNumber(position.takeProfit, { min: 0 })) ||
          (position.swap != null && !validNumber(position.swap)) ||
          (position.commission != null && !validNumber(position.commission))) {
          return res.status(400).json({ error: 'An open position contains invalid fields.' });
        }
        const ticket = String(position.ticket);
        if (seenTickets.has(ticket)) return res.status(400).json({ error: 'Position tickets must be unique within a heartbeat.' });
        seenTickets.add(ticket);
        const openedAt = timestamp(position.openedAt, null);
        if (!openedAt || openedAt > Date.now() + 60 * 1000) return res.status(400).json({ error: 'Position opening timestamp is invalid.' });
        validatedPositions.push({ ...position, ticket, openedAt });
      }
    }
    if (req.installation.last_heartbeat && capturedAt < req.installation.last_heartbeat) {
      return res.status(202).json({ accepted: false, message: 'Out-of-order heartbeat ignored.' });
    }
    try {
      const now = Date.now();
      // The whole heartbeat write runs through the shared write queue so it can
      // never be absorbed into another module's open transaction on the same
      // sqlite connection.
      const outOfOrder = await exclusive(db, async () => {
        const accountUpdate = await run(db, `
          UPDATE mt5_accounts
          SET balance = ?, equity = ?, margin = ?, free_margin = ?, floating_profit = ?,
              ea_name = COALESCE(?, ea_name), ea_version = COALESCE(?, ea_version),
              last_heartbeat = ?, last_sync = ?, auth_error_at = NULL
          WHERE id = ? AND (last_heartbeat IS NULL OR last_heartbeat <= ?)
        `, [balance, equity, margin, freeMargin, floatingProfit, eaName, eaVersion, capturedAt, now, req.installation.account_id, capturedAt]);
        if (accountUpdate.changes !== 1) return true;
        const accountId = req.installation.account_id;
        // Balance history is throttled: at one heartbeat every 30s for a large
        // fleet, storing every tick would add millions of rows per month. Live
        // balance/equity on mt5_accounts is still updated on every heartbeat.
        const lastSnapshot = lastSnapshotAt.get(accountId);
        if (SNAPSHOT_MIN_INTERVAL_MS <= 0 || lastSnapshot === undefined || capturedAt - lastSnapshot >= SNAPSHOT_MIN_INTERVAL_MS) {
          await run(db, `
            INSERT OR IGNORE INTO mt5_snapshots (account_id, captured_at, balance, equity, floating_profit)
            VALUES (?, ?, ?, ?, ?)
          `, [accountId, capturedAt, balance, equity, floatingProfit]);
          lastSnapshotAt.set(accountId, capturedAt);
        }
        // Positions are only rewritten when the set actually changed; most
        // heartbeats repeat an identical book, so this skips the expensive
        // upsert + cleanup entirely.
        const positionFingerprint = positions !== undefined
          ? crypto.createHash('sha256').update(JSON.stringify(validatedPositions)).digest('hex')
          : null;
        if (positions !== undefined && positionFingerprints.get(accountId) !== positionFingerprint) {
          // Positions are written in batches. One statement per position meant up
          // to 2,000 sequential round trips on the shared sqlite connection, which
          // delayed the EA's market post past its timeout.
          for (let offset = 0; offset < validatedPositions.length; offset += POSITION_ROWS_PER_INSERT) {
            const chunk = validatedPositions.slice(offset, offset + POSITION_ROWS_PER_INSERT);
            const values = [];
            const params = [];
            for (const position of chunk) {
              values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
              params.push(accountId, position.ticket, position.symbol.trim(), position.direction, position.volume,
                position.entryPrice, position.currentPrice ?? null, position.stopLoss ?? null, position.takeProfit ?? null,
                position.profit, position.swap ?? null, position.commission ?? null, position.openedAt, now);
            }
            await run(db, `
              INSERT INTO mt5_positions
                (account_id, ticket, symbol, direction, volume, entry_price, current_price, stop_loss, take_profit, profit, swap, commission, opened_at, updated_at)
              VALUES ${values.join(', ')}
              ON CONFLICT(account_id, ticket) DO UPDATE SET
                symbol = excluded.symbol, direction = excluded.direction, volume = excluded.volume,
                entry_price = excluded.entry_price, current_price = excluded.current_price,
                stop_loss = excluded.stop_loss, take_profit = excluded.take_profit, profit = excluded.profit,
                swap = excluded.swap, commission = excluded.commission, opened_at = excluded.opened_at,
                updated_at = excluded.updated_at
            `, params);
          }
          if (validatedPositions.length === 0) {
            await run(db, 'DELETE FROM mt5_positions WHERE account_id = ?', [accountId]);
          } else {
            // The kept tickets travel as one JSON array instead of thousands of
            // bound parameters, so the statement stays valid at any position count.
            const keptTickets = JSON.stringify(validatedPositions.map(position => position.ticket));
            await run(db, 'DELETE FROM mt5_positions WHERE account_id = ? AND ticket NOT IN (SELECT value FROM json_each(?))',
              [accountId, keptTickets]);
          }
          positionFingerprints.set(accountId, positionFingerprint);
        }
        return false;
      });
      if (outOfOrder) return res.status(202).json({ accepted: false, message: 'Out-of-order heartbeat ignored.' });
      return res.json({ accepted: true, serverTime: new Date(now).toISOString() });
    } catch (databaseError) {
      console.error('Failed to store authenticated MT5 heartbeat:', databaseError.message);
      const status = databaseError && databaseError.statusCode ? databaseError.statusCode : 500;
      return res.status(status).json({ error: status === 503 ? 'Server is busy. Please retry.' : 'Unable to store the account snapshot.' });
    }
  });

  app.post('/api/mt5/trades', eaIpLimit, authenticateInstallation, eaDataLimit, async (req, res) => {
    const deals = req.body && req.body.deals;
    if (!Array.isArray(deals) || deals.length > MAX_DEAL_COUNT) return res.status(400).json({ error: `Deals must be an array of no more than ${MAX_DEAL_COUNT} entries.` });
    const validated = [];
    for (const deal of deals) {
      if (!deal || !validText(String(deal.dealId ?? ''), 64) || !validText(deal.symbol, 32) ||
        !['BUY', 'SELL'].includes(deal.direction) || !validNumber(deal.volume, { min: 0, max: 1e8 }) ||
        !validNumber(deal.profit) || (deal.commission !== undefined && !validNumber(deal.commission)) ||
        (deal.swap !== undefined && !validNumber(deal.swap)) ||
        (deal.entryPrice != null && !validNumber(deal.entryPrice, { min: 0 })) ||
        (deal.exitPrice != null && !validNumber(deal.exitPrice, { min: 0 })) ||
        (deal.stopLoss != null && !validNumber(deal.stopLoss, { min: 0 })) ||
        (deal.takeProfit != null && !validNumber(deal.takeProfit, { min: 0 })) ||
        (deal.durationSeconds != null && (!Number.isInteger(deal.durationSeconds) || deal.durationSeconds < 0 || deal.durationSeconds > 315360000))) {
        return res.status(400).json({ error: 'A trade deal contains invalid fields.' });
      }
      const dealId = String(deal.dealId);
      const closedAt = timestamp(deal.closedAt, null);
      if (!closedAt || closedAt > Date.now() + 60 * 1000) return res.status(400).json({ error: 'A deal close timestamp is invalid.' });
      if (deal.magicNumber != null && !validText(String(deal.magicNumber), 32)) return res.status(400).json({ error: 'A magic number is invalid.' });
      if (deal.eaVersion != null && !validText(deal.eaVersion, 40)) return res.status(400).json({ error: 'An EA version is invalid.' });
      validated.push({ ...deal, dealId, closedAt });
    }
    try {
      let inserted = 0;
      // Deals are written in batches for the same reason as positions: one
      // statement per deal meant hundreds of sequential round trips.
      for (let offset = 0; offset < validated.length; offset += DEAL_ROWS_PER_INSERT) {
        const chunk = validated.slice(offset, offset + DEAL_ROWS_PER_INSERT);
        const values = [];
        const params = [];
        for (const deal of chunk) {
          values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
          params.push(req.installation.account_id, deal.dealId, deal.positionId == null ? null : String(deal.positionId).slice(0, 64),
            deal.symbol.trim(), deal.direction, deal.volume, deal.entryPrice ?? null, deal.exitPrice ?? null,
            deal.stopLoss ?? null, deal.takeProfit ?? null, deal.profit, deal.commission ?? null, deal.swap ?? null,
            deal.closedAt, deal.durationSeconds ?? null, deal.magicNumber == null ? null : String(deal.magicNumber), deal.eaVersion ?? null);
        }
        const result = await run(db, `
          INSERT OR IGNORE INTO mt5_deals
            (account_id, deal_id, position_id, symbol, direction, volume, entry_price, exit_price, stop_loss, take_profit, profit, commission, swap, closed_at, duration_seconds, magic_number, ea_version)
          VALUES ${values.join(', ')}
        `, params);
        inserted += result.changes;
      }
      await run(db, 'UPDATE mt5_accounts SET last_sync = ? WHERE id = ?', [Date.now(), req.installation.account_id]);
      return res.json({ received: validated.length, inserted, duplicatesIgnored: validated.length - inserted });
    } catch (databaseError) {
      console.error('Failed to store MT5 deal imports:', databaseError.message);
      const status = databaseError && databaseError.statusCode ? databaseError.statusCode : 500;
      return res.status(status).json({ error: status === 503 ? 'Server is busy. Please retry.' : 'Unable to store trade records.' });
    }
  });

  app.delete('/api/mt5/accounts/:id', authenticated, async (req, res) => {
    const accountId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(accountId) || accountId < 1) return res.status(400).json({ error: 'Invalid account identifier.' });
    try {
      const owned = await get(db, 'SELECT id FROM mt5_accounts WHERE id = ? AND user_id = ?', [accountId, ownerId(req)]);
      if (!owned) return res.status(404).json({ error: 'MT5 account not found.' });
      // The unlink removes rows from six tables, so it must be atomic. The
      // transaction runs through the shared write queue: the sqlite connection
      // is shared with the market feed, and two open transactions on one
      // connection fail with "cannot start a transaction within a transaction".
      await exclusive(db, async () => {
        await run(db, 'BEGIN IMMEDIATE');
        try {
          await run(db, 'DELETE FROM public_portfolio_accounts WHERE account_id = ?', [accountId]);
          await run(db, 'DELETE FROM mt5_installations WHERE account_id = ?', [accountId]);
          await run(db, 'DELETE FROM mt5_snapshots WHERE account_id = ?', [accountId]);
          await run(db, 'DELETE FROM mt5_positions WHERE account_id = ?', [accountId]);
          await run(db, 'DELETE FROM mt5_deals WHERE account_id = ?', [accountId]);
          await run(db, 'DELETE FROM mt5_accounts WHERE id = ?', [accountId]);
          await run(db, 'COMMIT');
        } catch (transactionError) {
          await run(db, 'ROLLBACK').catch(() => {});
          throw transactionError;
        }
      });
      forgetAccount(accountId);
      lastSnapshotAt.delete(accountId);
      positionFingerprints.delete(accountId);
      return res.json({ message: 'MT5 account unlinked.' });
    } catch (databaseError) {
      console.error('Failed to unlink MT5 account:', databaseError.message);
      return res.status(500).json({ error: 'Unable to unlink the MT5 account.' });
    }
  });

  app.patch('/api/mt5/accounts/:id', authenticated, async (req, res) => {
    const accountId = Number.parseInt(req.params.id, 10);
    const accountName = req.body && req.body.accountName;
    if (!Number.isSafeInteger(accountId) || accountId < 1) return res.status(400).json({ error: 'Invalid account identifier.' });
    if (!validText(accountName, 64)) return res.status(400).json({ error: 'Account name must be between 1 and 64 characters.' });
    try {
      const result = await run(db, 'UPDATE mt5_accounts SET account_name = ? WHERE id = ? AND user_id = ?', [accountName.trim(), accountId, ownerId(req)]);
      if (result.changes !== 1) return res.status(404).json({ error: 'MT5 account not found.' });
      return res.json({ message: 'Account name updated.' });
    } catch (databaseError) {
      console.error('Failed to rename MT5 account:', databaseError.message);
      return res.status(500).json({ error: 'Unable to rename the MT5 account.' });
    }
  });

  app.get('/api/user/portfolio-sharing', authenticated, async (req, res) => {
    try {
      const sharing = await get(db, 'SELECT share_id, is_public, updated_at FROM public_portfolios WHERE user_id = ?', [ownerId(req)]);
      const accounts = await all(db, `
        SELECT a.id, a.account_name, a.currency, a.balance, a.equity, a.floating_profit,
               a.last_heartbeat, a.linked_at, a.account_number,
               CASE WHEN ppa.account_id IS NULL THEN 0 ELSE 1 END AS is_selected_public
        FROM mt5_accounts a
        LEFT JOIN public_portfolio_accounts ppa ON ppa.account_id = a.id AND ppa.user_id = a.user_id
        WHERE a.user_id = ? ORDER BY a.linked_at DESC
      `, [ownerId(req)]);
      const selectedAccountIds = accounts.filter(account => account.is_selected_public).map(account => account.id);
      const isPublic = Boolean(sharing && sharing.is_public && selectedAccountIds.length);
      return res.json({
        isPublic,
        shareUrl: isPublic ? `/portfolio/${sharing.share_id}` : null,
        updatedAt: sharing ? formatTimestamp(sharing.updated_at) : null,
        accounts: accounts.map(account => ({
          id: account.id,
          accountName: account.account_name,
          maskedAccount: maskedAccount(account.account_number),
          currency: account.currency,
          balance: account.balance,
          equity: account.equity,
          floatingProfit: account.floating_profit,
          lastHeartbeat: formatTimestamp(account.last_heartbeat),
          linkedAt: formatTimestamp(account.linked_at),
          selectedPublic: Boolean(account.is_selected_public)
        })),
        selectedAccountIds
      });
    } catch (databaseError) {
      console.error('Failed to load portfolio sharing settings:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load portfolio sharing settings.' });
    }
  });

  app.patch('/api/user/portfolio-sharing', authenticated, async (req, res) => {
    if (!req.body || typeof req.body.isPublic !== 'boolean' ||
      !Array.isArray(req.body.accountIds) || req.body.accountIds.length > 100 ||
      req.body.accountIds.some(id => !Number.isSafeInteger(id) || id < 1) ||
      new Set(req.body.accountIds).size !== req.body.accountIds.length) {
      return res.status(400).json({ error: 'Choose a valid list of MT5 accounts and set portfolio visibility to public or private.' });
    }
    try {
      const selectedIds = req.body.accountIds;
      if (req.body.isPublic && selectedIds.length === 0) {
        return res.status(400).json({ error: 'Select at least one MT5 account to publish.' });
      }
      if (selectedIds.length) {
        const placeholders = selectedIds.map(() => '?').join(', ');
        const owned = await get(db, `SELECT COUNT(*) AS count FROM mt5_accounts WHERE user_id = ? AND id IN (${placeholders})`, [ownerId(req), ...selectedIds]);
        if (owned.count !== selectedIds.length) return res.status(400).json({ error: 'One or more selected MT5 accounts are not available in your account.' });
      }
      const now = Date.now();
      const shareId = crypto.randomBytes(16).toString('hex');
      // The sharing update touches three tables, so it must be atomic. It runs
      // through the shared write queue so it can never overlap another module's
      // transaction on the same sqlite connection.
      await exclusive(db, async () => {
        await run(db, 'BEGIN IMMEDIATE');
        try {
          await run(db, 'DELETE FROM public_portfolio_accounts WHERE user_id = ?', [ownerId(req)]);
          for (const id of selectedIds) {
            await run(db, 'INSERT INTO public_portfolio_accounts (user_id, account_id) VALUES (?, ?)', [ownerId(req), id]);
          }
          await run(db, `
            INSERT INTO public_portfolios (user_id, share_id, is_public, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              is_public = excluded.is_public,
              updated_at = excluded.updated_at;
          `, [ownerId(req), shareId, Boolean(req.body.isPublic), now]);
          await run(db, 'COMMIT');
        } catch (transactionError) {
          await run(db, 'ROLLBACK').catch(() => {});
          throw transactionError;
        }
      });
      const sharing = await get(db, 'SELECT share_id FROM public_portfolios WHERE user_id = ?', [ownerId(req)]);
      return res.json({
        isPublic: req.body.isPublic,
        selectedAccountIds: selectedIds,
        shareUrl: req.body.isPublic ? `/portfolio/${sharing.share_id}` : null,
        updatedAt: formatTimestamp(now)
      });
    } catch (databaseError) {
      console.error('Failed to update portfolio sharing settings:', databaseError.message);
      return res.status(500).json({ error: 'Unable to update portfolio sharing settings.' });
    }
  });

  app.get('/api/public/portfolios', publicReadLimit, async (req, res) => {
    try {
      const rows = await all(db, `
        SELECT p.share_id, u.username,
               COUNT(a.id) AS account_count,
               COUNT(DISTINCT a.currency) AS currency_count,
               MIN(a.currency) AS currency,
               SUM(CASE WHEN a.balance IS NULL OR a.equity IS NULL OR a.floating_profit IS NULL THEN 1 ELSE 0 END) AS incomplete_count,
               SUM(a.balance) AS balance,
               SUM(a.equity) AS equity,
               SUM(a.floating_profit) AS floating_profit,
               MAX(a.last_sync) AS last_sync,
               MAX(a.last_heartbeat) AS last_heartbeat
        FROM public_portfolios p
        JOIN users u ON u.id = p.user_id
        JOIN public_portfolio_accounts ppa ON ppa.user_id = p.user_id
        JOIN mt5_accounts a ON a.id = ppa.account_id AND a.user_id = p.user_id
        WHERE p.is_public
        GROUP BY p.user_id, p.share_id, u.username, p.updated_at
        ORDER BY p.updated_at DESC
        LIMIT 100
      `);
      return res.json({
        portfolios: rows.map(row => {
          const valuesAvailable = row.account_count > 0 && row.currency_count === 1 && row.incomplete_count === 0;
          return {
            shareId: row.share_id,
            displayName: row.username,
            accountCount: row.account_count,
            currency: row.currency_count === 1 ? row.currency : null,
            balanceAvailable: valuesAvailable,
            balance: valuesAvailable ? row.balance : null,
            equityAvailable: valuesAvailable,
            equity: valuesAvailable ? row.equity : null,
            floatingProfitAvailable: valuesAvailable,
            floatingProfit: valuesAvailable ? row.floating_profit : null,
            lastUpdate: formatTimestamp(Math.max(row.last_sync || 0, row.last_heartbeat || 0) || null)
          };
        })
      });
    } catch (databaseError) {
      console.error('Failed to list public portfolios:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load public portfolios.' });
    }
  });

  app.get('/api/public/portfolios/:shareId', publicReadLimit, async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.shareId)) return res.status(404).json({ error: 'Public portfolio not found.' });
    try {
      const portfolio = await getPublicPortfolio(db, req.params.shareId);
      if (!portfolio) return res.status(404).json({ error: 'Public portfolio not found.' });
      return res.json(portfolio);
    } catch (databaseError) {
      console.error('Failed to load a public portfolio:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load this public portfolio.' });
    }
  });

  app.get('/api/portfolio', authenticated, async (req, res) => {
    try {
      const scope = await overviewAccountScope(db, req);
      if (scope.error) return res.status(scope.error.status).json({ error: scope.error.message });
      const accountFilter = scope.account ? 'AND id = ?' : '';
      const accountParams = scope.account ? [scope.account.id] : [];
      const accounts = await all(db, `
        SELECT id, currency, balance, equity, floating_profit, last_heartbeat, last_sync
        FROM mt5_accounts WHERE user_id = ? ${accountFilter}
      `, [ownerId(req), ...accountParams]);
      const currencies = [...new Set(accounts.map(account => account.currency))];
      const singleCurrency = currencies.length === 1;
      const complete = accounts.length > 0 && accounts.every(account => account.balance !== null && account.equity !== null && account.floating_profit !== null);
      const now = Date.now();
      const online = accounts.filter(account => account.last_heartbeat !== null &&
        account.last_heartbeat <= now + 60 * 1000 && now - account.last_heartbeat <= HEARTBEAT_TIMEOUT_SECONDS * 1000);
      const heartbeatTimes = accounts.map(account => account.last_heartbeat).filter(Number.isFinite);
      const syncTimes = accounts.map(account => account.last_sync).filter(Number.isFinite);
      return res.json({
        balanceAvailable: singleCurrency && complete,
        equityAvailable: singleCurrency && complete,
        floatingAvailable: singleCurrency && complete,
        balance: singleCurrency && complete ? accounts.reduce((sum, account) => sum + account.balance, 0) : null,
        equity: singleCurrency && complete ? accounts.reduce((sum, account) => sum + account.equity, 0) : null,
        floatingProfit: singleCurrency && complete ? accounts.reduce((sum, account) => sum + account.floating_profit, 0) : null,
        currency: singleCurrency ? currencies[0] : null,
        activeAccounts: online.length,
        accountCount: accounts.length,
        selectedAccountId: scope.account?.id ?? null,
        accounts: (await getAccountSummaries(db, ownerId(req))).map(account => {
          const lastHeartbeat = account.lastHeartbeat ? new Date(account.lastHeartbeat).getTime() : null;
          account.status = account.authErrorAt && (!lastHeartbeat || new Date(account.authErrorAt).getTime() > lastHeartbeat)
            ? 'Authentication error'
            : lastHeartbeat !== null && lastHeartbeat <= now + 60 * 1000 && now - lastHeartbeat <= HEARTBEAT_TIMEOUT_SECONDS * 1000
              ? 'Online'
              : lastHeartbeat !== null ? 'Offline' : 'Waiting for data';
          return account;
        }),
        lastUpdate: syncTimes.length ? formatTimestamp(Math.max(...syncTimes)) : heartbeatTimes.length ? formatTimestamp(Math.max(...heartbeatTimes)) : null
      });
    } catch (databaseError) {
      console.error('Failed to calculate portfolio overview:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load portfolio data.' });
    }
  });

  app.get('/api/portfolio/performance', authenticated, async (req, res) => {
    const period = ['today', '7d', '30d', '90d', 'all', 'custom'].includes(req.query.period) ? req.query.period : '30d';
    let timeZone = 'UTC';
    try {
      const preferencesRow = await get(db, 'SELECT preferences_json FROM user_preferences WHERE user_id = ?', [ownerId(req)]);
      const preferences = preferencesRow ? JSON.parse(preferencesRow.preferences_json) : {};
      if (preferences.timezone) {
        new Intl.DateTimeFormat('en', { timeZone: preferences.timezone });
        timeZone = preferences.timezone;
      }
    } catch (preferenceError) {
      console.error('Failed to resolve performance time zone:', preferenceError.message);
      return res.status(500).json({ error: 'Unable to load the performance time zone.' });
    }
    const now = Date.now();
    const todayDateKey = dateKeyInTimeZone(now, timeZone);
    const monthDateKey = `${todayDateKey.slice(0, 7)}-01`;
    const todayStart = dateStartInTimeZone(todayDateKey, timeZone);
    const monthStart = dateStartInTimeZone(monthDateKey, timeZone);
    let since = 0;
    let until = now + 1;
    if (period === 'today') {
      since = todayStart;
    } else if (period === 'custom') {
      const from = timestamp(req.query.from, null);
      const to = timestamp(req.query.to, null);
      if (!from || !to || from > to || to > now) return res.status(400).json({ error: 'A valid custom date range is required.' });
      since = from;
      until = to + 24 * 60 * 60 * 1000;
    } else if (period !== 'all') {
      const days = Number.parseInt(period, 10);
      since = now - days * 24 * 60 * 60 * 1000;
    }
    try {
      const scope = await overviewAccountScope(db, req);
      if (scope.error) return res.status(scope.error.status).json({ error: scope.error.message });
      const accountFilter = scope.account ? 'AND id = ?' : '';
      const accountParams = scope.account ? [scope.account.id] : [];
      const currencies = await all(db, `SELECT DISTINCT currency FROM mt5_accounts WHERE user_id = ? ${accountFilter}`, [ownerId(req), ...accountParams]);
      const accountCount = await get(db, `SELECT COUNT(*) AS count FROM mt5_accounts WHERE user_id = ? ${accountFilter}`, [ownerId(req), ...accountParams]);
      const sameCurrency = currencies.length === 1;
      const singleAccount = scope.account ? true : accountCount.count === 1;
      const dealAccountFilter = scope.account ? 'AND a.id = ?' : '';
      const dealParams = scope.account ? [scope.account.id] : [];
      const deals = await all(db, `
        SELECT d.profit, d.commission, d.swap, d.closed_at, d.duration_seconds
        FROM mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id
        WHERE a.user_id = ? ${dealAccountFilter} AND d.closed_at >= ? AND d.closed_at < ? ORDER BY d.closed_at ASC
      `, [ownerId(req), ...dealParams, since, until]);
      const dailyDeals = await all(db, `
        SELECT d.profit, d.commission, d.swap FROM mt5_deals d
        JOIN mt5_accounts a ON a.id = d.account_id WHERE a.user_id = ? ${dealAccountFilter} AND d.closed_at >= ? AND d.closed_at < ?
      `, [ownerId(req), ...dealParams, todayStart, now + 1]);
      const monthlyDeals = await all(db, `
        SELECT d.profit, d.commission, d.swap FROM mt5_deals d
        JOIN mt5_accounts a ON a.id = d.account_id WHERE a.user_id = ? ${dealAccountFilter} AND d.closed_at >= ? AND d.closed_at < ?
      `, [ownerId(req), ...dealParams, monthStart, now + 1]);
      const snapshots = singleAccount ? await all(db, `
        WITH ordered_snapshots AS (
          SELECT s.captured_at, s.balance, s.equity,
                 ROW_NUMBER() OVER (ORDER BY s.captured_at ASC) AS row_number,
                 COUNT(*) OVER () AS row_count
          FROM mt5_snapshots s
          JOIN mt5_accounts a ON a.id = s.account_id
          WHERE a.user_id = ? ${dealAccountFilter} AND s.captured_at >= ? AND s.captured_at < ?
        )
        SELECT captured_at, balance, equity
        FROM ordered_snapshots
        WHERE row_number = 1 OR row_number = row_count
          OR row_number % CAST((row_count + 499) / 500 AS INTEGER) = 0
        ORDER BY captured_at ASC
      `, [ownerId(req), ...dealParams, since, until]) : [];

      const value = deal => deal.profit + deal.commission + deal.swap;
      const costsComplete = deals.every(deal => deal.commission !== null && deal.swap !== null);
      const wins = costsComplete ? deals.filter(deal => value(deal) > 0) : [];
      const losses = costsComplete ? deals.filter(deal => value(deal) < 0) : [];
      const grossProfit = deals.reduce((sum, deal) => sum + Math.max(deal.profit, 0), 0);
      const grossLoss = deals.reduce((sum, deal) => sum + Math.abs(Math.min(deal.profit, 0)), 0);
      const netProfit = costsComplete ? deals.reduce((sum, deal) => sum + value(deal), 0) : null;
      const drawdowns = [];
      let peak = null;
      for (const snapshot of snapshots) {
        if (peak === null || snapshot.equity > peak) peak = snapshot.equity;
        drawdowns.push({ amount: peak - snapshot.equity, percent: peak > 0 ? ((peak - snapshot.equity) / peak) * 100 : null });
      }
      const maxDrawdown = drawdowns.length > 1 ? Math.max(...drawdowns.map(point => point.amount)) : null;
      const maxDrawdownPoint = maxDrawdown === null ? null : drawdowns.find(point => point.amount === maxDrawdown);
      const currentDrawdown = drawdowns.length > 1 ? drawdowns[drawdowns.length - 1] : null;
      const durations = deals.map(deal => deal.duration_seconds).filter(Number.isFinite);
      const moneyAvailable = sameCurrency && deals.length > 0 && costsComplete;
      return res.json({
        period,
        selectedAccountId: scope.account?.id ?? null,
        currency: sameCurrency ? currencies[0].currency : null,
        closedDeals: deals.length,
        closedDealsAvailable: deals.length > 0,
        netProfitAvailable: moneyAvailable,
        netProfit: moneyAvailable ? netProfit : null,
        grossProfitAvailable: sameCurrency && deals.length > 0,
        grossProfit: sameCurrency && deals.length ? grossProfit : null,
        grossLossAvailable: sameCurrency && deals.length > 0,
        grossLoss: sameCurrency && deals.length ? grossLoss : null,
        winRateAvailable: deals.length > 0 && costsComplete,
        winRate: deals.length > 0 && costsComplete ? wins.length / deals.length * 100 : null,
        profitFactorAvailable: sameCurrency && deals.length > 0 && grossLoss > 0,
        profitFactor: sameCurrency && deals.length > 0 && grossLoss > 0 ? grossProfit / grossLoss : null,
        averageWinAvailable: sameCurrency && costsComplete && wins.length > 0,
        averageWin: sameCurrency && costsComplete && wins.length ? wins.reduce((sum, deal) => sum + value(deal), 0) / wins.length : null,
        averageLossAvailable: sameCurrency && costsComplete && losses.length > 0,
        averageLoss: sameCurrency && costsComplete && losses.length ? losses.reduce((sum, deal) => sum + value(deal), 0) / losses.length : null,
        largestWinAvailable: sameCurrency && costsComplete && wins.length > 0,
        largestWin: sameCurrency && costsComplete && wins.length ? Math.max(...wins.map(value)) : null,
        largestLossAvailable: sameCurrency && costsComplete && losses.length > 0,
        largestLoss: sameCurrency && costsComplete && losses.length ? Math.min(...losses.map(value)) : null,
        dailyProfitAvailable: sameCurrency && dailyDeals.length > 0 && dailyDeals.every(deal => deal.commission !== null && deal.swap !== null),
        dailyProfit: sameCurrency && dailyDeals.length > 0 && dailyDeals.every(deal => deal.commission !== null && deal.swap !== null) ? dailyDeals.reduce((sum, deal) => sum + value(deal), 0) : null,
        monthlyProfitAvailable: sameCurrency && monthlyDeals.length > 0 && monthlyDeals.every(deal => deal.commission !== null && deal.swap !== null),
        monthlyProfit: sameCurrency && monthlyDeals.length > 0 && monthlyDeals.every(deal => deal.commission !== null && deal.swap !== null) ? monthlyDeals.reduce((sum, deal) => sum + value(deal), 0) : null,
        maxDrawdownAvailable: singleAccount && maxDrawdown !== null,
        maxDrawdown: singleAccount ? maxDrawdown : null,
        maxDrawdownPercentAvailable: singleAccount && maxDrawdownPoint?.percent != null,
        maxDrawdownPercent: singleAccount ? maxDrawdownPoint?.percent ?? null : null,
        currentDrawdownAvailable: singleAccount && currentDrawdown !== null,
        currentDrawdown: singleAccount ? currentDrawdown?.amount ?? null : null,
        currentDrawdownPercentAvailable: singleAccount && currentDrawdown?.percent != null,
        currentDrawdownPercent: singleAccount ? currentDrawdown?.percent ?? null : null,
        recoveryFactorAvailable: moneyAvailable && singleAccount && maxDrawdown > 0,
        recoveryFactor: moneyAvailable && singleAccount && maxDrawdown > 0 ? netProfit / maxDrawdown : null,
        averageDurationAvailable: durations.length > 0,
        averageDurationSeconds: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length : null,
        snapshots: singleAccount ? snapshots.map(snapshot => ({ capturedAt: formatTimestamp(snapshot.captured_at), balance: snapshot.balance, equity: snapshot.equity })) : [],
        snapshotUnavailableReason: singleAccount
          ? snapshots.length ? null : 'Equity history will appear after the first account snapshots are received.'
          : accountCount.count > 1 ? 'A combined equity curve is not shown for multiple accounts because their historical snapshots are not synchronized.'
            : 'Equity history is not available yet.'
      });
    } catch (databaseError) {
      console.error('Failed to calculate portfolio performance:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load performance analytics.' });
    }
  });

  app.get('/api/portfolio/positions', authenticated, async (req, res) => {
    const { page, limit, offset } = pageParams(req);
    const filters = ['a.user_id = ?'];
    const params = [ownerId(req)];
    try {
      const scope = await overviewAccountScope(db, req);
      if (scope.error) return res.status(scope.error.status).json({ error: scope.error.message });
      if (scope.account) {
        filters.push('a.id = ?');
        params.push(scope.account.id);
      }
    } catch (databaseError) {
      console.error('Failed to validate selected account for open positions:', databaseError.message);
      return res.status(500).json({ error: 'Unable to validate the selected MT5 account.' });
    }
    if (req.query.search !== undefined) {
      if (typeof req.query.search !== 'string' || req.query.search.length > 64) return res.status(400).json({ error: 'Position search must be 64 characters or fewer.' });
      const search = `%${req.query.search.trim()}%`;
      filters.push('(p.symbol LIKE ? OR p.ticket LIKE ?)');
      params.push(search, search);
    }
    if (req.query.symbol !== undefined) {
      if (!validText(req.query.symbol, 32)) return res.status(400).json({ error: 'Invalid position symbol filter.' });
      filters.push('p.symbol = ?');
      params.push(req.query.symbol.trim());
    }
    if (req.query.direction !== undefined && req.query.direction !== '') {
      if (!['BUY', 'SELL'].includes(req.query.direction)) return res.status(400).json({ error: 'Direction must be BUY or SELL.' });
      filters.push('p.direction = ?');
      params.push(req.query.direction);
    }
    const orderBy = {
      'opened-desc': 'p.opened_at DESC',
      'profit-desc': 'p.profit DESC',
      'profit-asc': 'p.profit ASC',
      'symbol-asc': 'p.symbol ASC, p.opened_at DESC'
    }[req.query.sort] || 'p.opened_at DESC';
    try {
      if (req.query.sort === 'profit-desc' || req.query.sort === 'profit-asc') {
        const currencies = await get(db, 'SELECT COUNT(DISTINCT currency) AS count FROM mt5_accounts WHERE user_id = ?', [ownerId(req)]);
        if (currencies.count > 1) return res.status(400).json({ error: 'Profit sorting is unavailable across different account currencies.' });
      }
      const where = filters.join(' AND ');
      const [items, count] = await Promise.all([
        all(db, `
        SELECT p.ticket, p.symbol, p.direction, p.volume, p.entry_price, p.current_price,
               p.stop_loss, p.take_profit, p.profit, p.swap, p.commission, p.opened_at, a.currency
        FROM mt5_positions p JOIN mt5_accounts a ON a.id = p.account_id
        WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
      `, [...params, limit, offset]),
        get(db, `SELECT COUNT(*) AS total FROM mt5_positions p JOIN mt5_accounts a ON a.id = p.account_id WHERE ${where}`, params)
      ]);
      return res.json({ page, limit, total: count.total, items: items.map(position => ({
        ticket: position.ticket, symbol: position.symbol, direction: position.direction, volume: position.volume,
        entryPrice: position.entry_price, currentPrice: position.current_price, stopLoss: position.stop_loss,
        takeProfit: position.take_profit, profit: position.profit, swap: position.swap, commission: position.commission,
        openedAt: formatTimestamp(position.opened_at), currency: position.currency
      })) });
    } catch (databaseError) {
      console.error('Failed to load open positions:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load open positions.' });
    }
  });

  app.get('/api/portfolio/trades', authenticated, async (req, res) => {
    const { page, limit, offset } = pageParams(req);
    const filters = ['a.user_id = ?'];
    const params = [ownerId(req)];
    if (req.query.search !== undefined) {
      if (typeof req.query.search !== 'string' || req.query.search.length > 64) return res.status(400).json({ error: 'Trade search must be 64 characters or fewer.' });
      const search = `%${req.query.search.trim()}%`;
      filters.push('(d.symbol LIKE ? OR d.deal_id LIKE ?)');
      params.push(search, search);
    }
    if (req.query.symbol !== undefined) {
      if (!validText(req.query.symbol, 32)) return res.status(400).json({ error: 'Invalid trade symbol filter.' });
      filters.push('d.symbol = ?');
      params.push(req.query.symbol.trim());
    }
    if (req.query.result === 'win' || req.query.result === 'loss') {
      filters.push('d.commission IS NOT NULL AND d.swap IS NOT NULL');
      filters.push(req.query.result === 'win' ? '(d.profit + d.commission + d.swap) > 0' : '(d.profit + d.commission + d.swap) < 0');
    } else if (req.query.result && req.query.result !== 'all') {
      return res.status(400).json({ error: 'Trade result filter must be win or loss.' });
    }
    if (req.query.from) {
      const from = timestamp(req.query.from, null);
      if (!from) return res.status(400).json({ error: 'Invalid start date.' });
      filters.push('d.closed_at >= ?');
      params.push(from);
    }
    if (req.query.to) {
      const to = timestamp(req.query.to, null);
      if (!to) return res.status(400).json({ error: 'Invalid end date.' });
      filters.push('d.closed_at < ?');
      params.push(to + 24 * 60 * 60 * 1000);
    }
    const orderBy = {
      'closed-desc': 'd.closed_at DESC',
      'net-desc': 'CASE WHEN d.commission IS NULL OR d.swap IS NULL THEN NULL ELSE (d.profit + d.commission + d.swap) END DESC',
      'net-asc': 'CASE WHEN d.commission IS NULL OR d.swap IS NULL THEN NULL ELSE (d.profit + d.commission + d.swap) END ASC',
      'symbol-asc': 'd.symbol ASC, d.closed_at DESC'
    }[req.query.sort] || 'd.closed_at DESC';
    try {
      if (req.query.sort === 'net-desc' || req.query.sort === 'net-asc') {
        const currencies = await get(db, 'SELECT COUNT(DISTINCT currency) AS count FROM mt5_accounts WHERE user_id = ?', [ownerId(req)]);
        if (currencies.count > 1) return res.status(400).json({ error: 'Net profit sorting is unavailable across different account currencies.' });
      }
      const where = filters.join(' AND ');
      const [rows, count, symbols] = await Promise.all([
        all(db, `
          SELECT d.deal_id, d.position_id, d.symbol, d.direction, d.volume, d.entry_price, d.exit_price, d.stop_loss, d.take_profit,
                 d.profit, d.commission, d.swap, d.closed_at, d.duration_seconds, d.magic_number,
                 d.ea_version, a.currency
          FROM mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id
          WHERE ${where}
          ORDER BY ${orderBy} LIMIT ? OFFSET ?
        `, [...params, limit, offset]),
        get(db, `SELECT COUNT(*) AS total FROM mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id WHERE ${where}`, params),
        all(db, `SELECT DISTINCT d.symbol FROM mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id WHERE a.user_id = ? ORDER BY d.symbol`, [ownerId(req)])
      ]);
      return res.json({ page, limit, total: count.total, symbols: symbols.map(row => row.symbol), items: rows.map(deal => ({
        dealId: deal.deal_id, positionId: deal.position_id, symbol: deal.symbol, direction: deal.direction,
        volume: deal.volume, entryPrice: deal.entry_price, exitPrice: deal.exit_price, stopLoss: deal.stop_loss, takeProfit: deal.take_profit, profit: deal.profit,
        commission: deal.commission, swap: deal.swap, closedAt: formatTimestamp(deal.closed_at),
        durationSeconds: deal.duration_seconds, magicNumber: deal.magic_number, eaVersion: deal.ea_version,
        currency: deal.currency
      })) });
    } catch (databaseError) {
      console.error('Failed to load imported trade records:', databaseError.message);
      return res.status(500).json({ error: 'Unable to load trade history.' });
    }
  });

  return { authenticateInstallation };
}

async function getPublicPortfolio(db, shareId) {
  const owner = await get(db, `
    SELECT p.user_id, u.username
    FROM public_portfolios p
    JOIN users u ON u.id = p.user_id
    WHERE p.share_id = ? AND p.is_public
  `, [shareId]);
  if (!owner) return null;

  const selectedAccounts = await all(db, `
    SELECT a.id FROM public_portfolio_accounts ppa
    JOIN mt5_accounts a ON a.id = ppa.account_id AND a.user_id = ppa.user_id
    WHERE ppa.user_id = ? ORDER BY a.linked_at DESC
  `, [owner.user_id]);
  if (!selectedAccounts.length) return null;
  const accountIds = selectedAccounts.map(account => account.id);
  const accountPlaceholders = accountIds.map(() => '?').join(', ');

  const accounts = await all(db, `
    SELECT id, account_number, currency, account_name, balance, equity, floating_profit,
           ea_name, ea_version, last_heartbeat, last_sync, linked_at, auth_error_at
    FROM mt5_accounts WHERE user_id = ? AND id IN (${accountPlaceholders}) ORDER BY linked_at DESC
  `, [owner.user_id, ...accountIds]);
  const now = Date.now();
  const currencies = [...new Set(accounts.map(account => account.currency))];
  const singleCurrency = currencies.length === 1;
  const valuesAvailable = accounts.length > 0 && singleCurrency &&
    accounts.every(account => account.balance !== null && account.equity !== null && account.floating_profit !== null);
  const onlineCount = accounts.filter(account => account.last_heartbeat !== null &&
    account.last_heartbeat <= now + 60 * 1000 && now - account.last_heartbeat <= HEARTBEAT_TIMEOUT_SECONDS * 1000).length;
  const heartbeatTimes = accounts.map(account => account.last_heartbeat).filter(Number.isFinite);
  const syncTimes = accounts.map(account => account.last_sync).filter(Number.isFinite);
  const currency = singleCurrency ? currencies[0] : null;
  const dailyStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const performanceStart = now - 30 * 24 * 60 * 60 * 1000;

  const deals = await all(db, `
    SELECT d.symbol, d.direction, d.volume, d.entry_price, d.exit_price, d.profit,
           d.commission, d.swap, d.closed_at, d.duration_seconds, a.currency, a.account_name
    FROM mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id
    WHERE a.user_id = ? AND a.id IN (${accountPlaceholders}) AND d.closed_at >= ?
    ORDER BY d.closed_at DESC
  `, [owner.user_id, ...accountIds, Math.min(performanceStart, monthStart)]);
  const periodDeals = deals.filter(deal => deal.closed_at >= performanceStart);
  const costsComplete = periodDeals.length > 0 && periodDeals.every(deal => deal.commission !== null && deal.swap !== null);
  const netValue = deal => deal.profit + deal.commission + deal.swap;
  const winners = costsComplete ? periodDeals.filter(deal => netValue(deal) > 0) : [];
  const losers = costsComplete ? periodDeals.filter(deal => netValue(deal) < 0) : [];
  const grossProfit = periodDeals.reduce((sum, deal) => sum + Math.max(deal.profit, 0), 0);
  const grossLoss = periodDeals.reduce((sum, deal) => sum + Math.abs(Math.min(deal.profit, 0)), 0);
  const netProfit = costsComplete ? periodDeals.reduce((sum, deal) => sum + netValue(deal), 0) : null;
  const dailyDeals = deals.filter(deal => deal.closed_at >= dailyStart);
  const monthlyDeals = deals.filter(deal => deal.closed_at >= monthStart);
  const dealCostsAvailable = items => items.length > 0 && items.every(deal => deal.commission !== null && deal.swap !== null);
  const dailyProfitAvailable = singleCurrency && dealCostsAvailable(dailyDeals);
  const monthlyProfitAvailable = singleCurrency && dealCostsAvailable(monthlyDeals);

  let snapshots = [];
  let maxDrawdown = null;
  let maxDrawdownPercent = null;
  let currentDrawdown = null;
  if (accounts.length === 1) {
    snapshots = await all(db, `
      WITH ordered_snapshots AS (
        SELECT captured_at, balance, equity,
               ROW_NUMBER() OVER (ORDER BY captured_at ASC) AS row_number,
               COUNT(*) OVER () AS row_count
        FROM mt5_snapshots WHERE account_id = ?
      )
      SELECT captured_at, balance, equity FROM ordered_snapshots
      WHERE row_number = 1 OR row_number = row_count
        OR row_number % CAST((row_count + 499) / 500 AS INTEGER) = 0
      ORDER BY captured_at ASC
    `, [accounts[0].id]);
    let peak = null;
    const drawdowns = snapshots.map(snapshot => {
      if (peak === null || snapshot.equity > peak) peak = snapshot.equity;
      return { amount: peak - snapshot.equity, percent: peak > 0 ? (peak - snapshot.equity) / peak * 100 : null };
    });
    if (drawdowns.length > 1) {
      maxDrawdown = Math.max(...drawdowns.map(point => point.amount));
      const drawdownPercentages = drawdowns.filter(point => point.percent !== null).map(point => point.percent);
      maxDrawdownPercent = drawdownPercentages.length ? Math.max(...drawdownPercentages) : null;
      currentDrawdown = drawdowns[drawdowns.length - 1].amount;
    }
  }

  const positions = await all(db, `
    SELECT p.symbol, p.direction, p.volume, p.entry_price, p.current_price,
           p.stop_loss, p.take_profit, p.profit, p.swap, p.commission, p.opened_at,
           a.currency, a.account_name
    FROM mt5_positions p JOIN mt5_accounts a ON a.id = p.account_id
    WHERE a.user_id = ? AND a.id IN (${accountPlaceholders}) ORDER BY p.opened_at DESC LIMIT 50
  `, [owner.user_id, ...accountIds]);
  const latestDeals = deals.slice(0, 50);
  const updateTimes = [...syncTimes, ...heartbeatTimes];
  const lastUpdate = updateTimes.length ? Math.max(...updateTimes) : null;

  return {
    displayName: owner.username,
    currency,
    accountCount: accounts.length,
    activeAccounts: onlineCount,
    balanceAvailable: valuesAvailable,
    balance: valuesAvailable ? accounts.reduce((sum, account) => sum + account.balance, 0) : null,
    equityAvailable: valuesAvailable,
    equity: valuesAvailable ? accounts.reduce((sum, account) => sum + account.equity, 0) : null,
    floatingProfitAvailable: valuesAvailable,
    floatingProfit: valuesAvailable ? accounts.reduce((sum, account) => sum + account.floating_profit, 0) : null,
    closedDeals: periodDeals.length,
    netProfitAvailable: singleCurrency && costsComplete,
    netProfit: singleCurrency && costsComplete ? netProfit : null,
    grossProfitAvailable: singleCurrency && periodDeals.length > 0,
    grossProfit: singleCurrency && periodDeals.length ? grossProfit : null,
    grossLossAvailable: singleCurrency && periodDeals.length > 0,
    grossLoss: singleCurrency && periodDeals.length ? grossLoss : null,
    winRateAvailable: singleCurrency && costsComplete,
    winRate: singleCurrency && costsComplete ? winners.length / periodDeals.length * 100 : null,
    profitFactorAvailable: singleCurrency && costsComplete && grossLoss > 0,
    profitFactor: singleCurrency && costsComplete && grossLoss > 0 ? grossProfit / grossLoss : null,
    averageWinAvailable: singleCurrency && winners.length > 0,
    averageWin: singleCurrency && winners.length ? winners.reduce((sum, deal) => sum + netValue(deal), 0) / winners.length : null,
    averageLossAvailable: singleCurrency && losers.length > 0,
    averageLoss: singleCurrency && losers.length ? losers.reduce((sum, deal) => sum + netValue(deal), 0) / losers.length : null,
    dailyProfitAvailable,
    dailyProfit: dailyProfitAvailable ? dailyDeals.reduce((sum, deal) => sum + netValue(deal), 0) : null,
    monthlyProfitAvailable,
    monthlyProfit: monthlyProfitAvailable ? monthlyDeals.reduce((sum, deal) => sum + netValue(deal), 0) : null,
    drawdownAvailable: maxDrawdown !== null,
    maxDrawdown,
    maxDrawdownPercent,
    currentDrawdown,
    snapshots: snapshots.map(snapshot => ({
      capturedAt: formatTimestamp(snapshot.captured_at),
      balance: snapshot.balance,
      equity: snapshot.equity
    })),
    accounts: accounts.map(account => {
      const heartbeatIsOnline = account.last_heartbeat !== null &&
        account.last_heartbeat <= now + 60 * 1000 && now - account.last_heartbeat <= HEARTBEAT_TIMEOUT_SECONDS * 1000;
      return {
        maskedAccount: maskedAccount(account.account_number),
        accountName: account.account_name,
        currency: account.currency,
        balance: account.balance,
        equity: account.equity,
        floatingProfit: account.floating_profit,
        eaName: account.ea_name,
        eaVersion: account.ea_version,
        status: account.auth_error_at && (!account.last_heartbeat || account.auth_error_at > account.last_heartbeat)
          ? 'Authentication error'
          : heartbeatIsOnline ? 'Online' : account.last_heartbeat ? 'Offline' : 'Waiting for data',
        lastHeartbeat: formatTimestamp(account.last_heartbeat),
        lastSync: formatTimestamp(account.last_sync),
        linkedAt: formatTimestamp(account.linked_at)
      };
    }),
    positions: positions.map(position => ({
      symbol: position.symbol,
      direction: position.direction,
      volume: position.volume,
      entryPrice: position.entry_price,
      currentPrice: position.current_price,
      stopLoss: position.stop_loss,
      takeProfit: position.take_profit,
      profit: position.profit,
      swap: position.swap,
      commission: position.commission,
      openedAt: formatTimestamp(position.opened_at),
      currency: position.currency,
      accountName: position.account_name
    })),
    trades: latestDeals.map(deal => ({
      symbol: deal.symbol,
      direction: deal.direction,
      volume: deal.volume,
      entryPrice: deal.entry_price,
      exitPrice: deal.exit_price,
      grossProfit: deal.profit,
      commission: deal.commission,
      swap: deal.swap,
      netProfit: deal.commission !== null && deal.swap !== null ? deal.profit + deal.commission + deal.swap : null,
      closedAt: formatTimestamp(deal.closed_at),
      durationSeconds: deal.duration_seconds,
      currency: deal.currency,
      accountName: deal.account_name
    })),
    lastUpdate: formatTimestamp(lastUpdate)
  };
}

async function getAccountSummaries(db, userId) {
  const rows = await all(db, `
    SELECT a.id, a.account_number, a.broker_server, a.currency, a.account_name, a.balance,
           a.equity, a.floating_profit, a.ea_name, a.ea_version, a.last_heartbeat, a.last_sync,
           a.linked_at, a.auth_error_at,
           (SELECT COUNT(*) FROM mt5_positions p WHERE p.account_id = a.id) AS open_positions
    FROM mt5_accounts a WHERE a.user_id = ? ORDER BY a.linked_at DESC
  `, [userId]);
  return rows.map(row => ({
    id: row.id,
    maskedAccount: maskedAccount(row.account_number),
    brokerServer: row.broker_server,
    currency: row.currency,
    accountName: row.account_name,
    balance: row.balance,
    equity: row.equity,
    floatingProfit: row.floating_profit,
    eaName: row.ea_name,
    eaVersion: row.ea_version,
    lastHeartbeat: formatTimestamp(row.last_heartbeat),
    lastSync: formatTimestamp(row.last_sync),
    linkedAt: formatTimestamp(row.linked_at),
    authErrorAt: formatTimestamp(row.auth_error_at),
    openPositions: row.open_positions
  }));
}

registerMt5Api.performDataRetentionCleanup = performDataRetentionCleanup;
module.exports = registerMt5Api;
