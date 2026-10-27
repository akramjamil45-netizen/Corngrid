'use strict';

// Email-verification (registration OTP) service.
//
// Security invariants:
//   * A 6-digit PIN is generated with crypto.randomInt(), never Math.random().
//   * Only an HMAC-SHA256 hash of the PIN is stored, keyed by a server secret.
//   * PINs expire after OTP_TTL_SECONDS, allow OTP_MAX_ATTEMPTS failures, and
//     are consumed atomically inside a transaction.
//   * Resends invalidate the previous PIN (one code row per user) and are
//     rate-limited per email and per IP.
//   * PINs, passwords, and SMTP credentials are never logged or returned.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { dbAll, dbGet, dbRun, isPostgres, withTransaction } = require('./db-async');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_. -]+$/;
const GENERIC_INVALID_CODE = 'The verification code is invalid or has expired.';
const GENERIC_RESEND_MESSAGE = 'If this email needs verification, a new PIN has been sent.';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function isEmailVerified(user) {
  if (!user) return false;
  const value = user.email_verified;
  // Rows created before this feature existed are treated as verified so
  // existing accounts keep working after the additive migration.
  if (value === undefined || value === null) return true;
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

function readNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function hashPin(pin, salt, pepper) {
  return crypto.createHmac('sha256', pepper).update(`${salt}:${pin}`).digest('hex');
}

function hashesMatch(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
  } catch {
    return false;
  }
}

function generatePin() {
  // crypto.randomInt is uniformly distributed and cryptographically secure.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function createWindowLimiter(limit, windowMs) {
  const buckets = new Map();
  return {
    take(key) {
      if (!limit || limit < 1) return { allowed: true };
      const now = Date.now();
      if (buckets.size > 5000) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(bucketKey);
        }
      }
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 1, resetAt: now + windowMs };
        buckets.set(key, bucket);
        return { allowed: true };
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
      }
      return { allowed: true };
    },
    clear() {
      buckets.clear();
    }
  };
}

function createEmailVerification(options = {}) {
  if (!options.db) throw new Error('createEmailVerification requires a database connection.');

  const db = options.db;
  const logger = options.logger || console;
  const postgres = isPostgres(db);
  const pepper = options.otpPepper || process.env.OTP_PEPPER || process.env.JWT_SECRET;
  if (!pepper || typeof pepper !== 'string') {
    throw new Error('OTP_PEPPER (or JWT_SECRET) must be configured for email verification.');
  }

  const otpTtlSeconds = readNumber(options.otpTtlSeconds ?? process.env.OTP_TTL_SECONDS, 600, { min: 60, max: 3600 });
  const maxAttempts = readNumber(options.maxAttempts ?? process.env.OTP_MAX_ATTEMPTS, 5, { min: 1, max: 20 });
  const resendCooldownSeconds = readNumber(
    options.resendCooldownSeconds ?? process.env.OTP_RESEND_COOLDOWN_SECONDS,
    60,
    { min: 1, max: 3600 }
  );
  const hourlyLimitPerEmail = readNumber(
    options.hourlyLimitPerEmail ?? process.env.OTP_HOURLY_LIMIT_PER_EMAIL,
    5,
    { min: 1, max: 1000 }
  );
  const hourlyLimitPerIp = readNumber(
    options.hourlyLimitPerIp ?? process.env.OTP_HOURLY_LIMIT_PER_IP,
    20,
    { min: 1, max: 10000 }
  );
  const bcryptRounds = readNumber(options.bcryptRounds ?? process.env.BCRYPT_ROUNDS, 10, { min: 4, max: 15 });
  const smtpFrom = options.smtpFrom || process.env.SMTP_FROM || '';
  const sendMail = typeof options.sendMail === 'function' ? options.sendMail : null;
  const isReservedEmail = typeof options.isReservedEmail === 'function' ? options.isReservedEmail : null;
  const getClientIp = typeof options.getClientIp === 'function'
    ? options.getClientIp
    : req => req.ip || req.socket?.remoteAddress || '';

  const registerRule = options.registerRateLimit || {
    limit: readNumber(process.env.REGISTER_RATE_LIMIT, 10, { min: 1 }),
    windowMs: readNumber(process.env.REGISTER_RATE_WINDOW_MS, 15 * 60 * 1000, { min: 1000 })
  };
  const verifyRule = options.verifyRateLimit || {
    limit: readNumber(process.env.VERIFY_RATE_LIMIT, 20, { min: 1 }),
    windowMs: readNumber(process.env.VERIFY_RATE_WINDOW_MS, 15 * 60 * 1000, { min: 1000 })
  };
  const resendRule = options.resendRateLimit || {
    limit: readNumber(process.env.RESEND_RATE_LIMIT, 10, { min: 1 }),
    windowMs: readNumber(process.env.RESEND_RATE_WINDOW_MS, 15 * 60 * 1000, { min: 1000 })
  };

  const registerLimiter = createWindowLimiter(registerRule.limit, registerRule.windowMs);
  const verifyLimiter = createWindowLimiter(verifyRule.limit, verifyRule.windowMs);
  const resendLimiter = createWindowLimiter(resendRule.limit, resendRule.windowMs);

  let cleanupTimer = null;

  function logFailure(message, error) {
    const code = error && error.code ? ` (${String(error.code).slice(0, 40)})` : '';
    logger.error(`[email-verification] ${message}${code}`);
  }

  async function ensureSchema() {
    if (postgres) {
      // PostgreSQL DDL belongs in migrations. Fail fast if the operator forgot
      // to run the additive migration instead of serving broken registration.
      const columns = await dbAll(
        db,
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('email_verified', 'email_verified_at')"
      );
      const names = new Set((columns || []).map(row => row.column_name));
      const table = await dbGet(db, "SELECT to_regclass('public.email_verification_codes') AS table_name");
      if (names.size < 2 || !table || !table.table_name) {
        throw new Error('Email verification migration 0002_email_verification.sql has not been applied to PostgreSQL.');
      }
      return;
    }

    // SQLite is migrated additively at startup. Existing users receive the
    // default (verified) value, so their accounts keep working.
    const columns = await dbAll(db, 'PRAGMA table_info(users)');
    if (!columns.length) {
      throw new Error('The users table must exist before email verification is enabled.');
    }
    const names = new Set(columns.map(column => column.name));
    // The column check and ALTER are not atomic across processes. If another
    // instance added the column first, treat the duplicate-column error as a
    // successful migration instead of failing startup.
    async function addColumnIfMissing(name, definition) {
      if (names.has(name)) return;
      try {
        await dbRun(db, `ALTER TABLE users ADD COLUMN ${definition}`);
      } catch (error) {
        if (!/duplicate column name/i.test(String(error && error.message))) throw error;
      }
    }
    await addColumnIfMissing('email_verified', 'email_verified INTEGER NOT NULL DEFAULT 1');
    await addColumnIfMissing('email_verified_at', 'email_verified_at BIGINT');

    await dbRun(db, `
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        otp_salt TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        sent_at BIGINT,
        consumed_at BIGINT,
        request_ip TEXT
      )
    `);
    await dbRun(db, `
      CREATE TABLE IF NOT EXISTS email_verification_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        ip TEXT,
        kind TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS email_verification_requests_email ON email_verification_requests(email, created_at)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS email_verification_requests_ip ON email_verification_requests(ip, created_at)');
  }

  // Schema initialisation is queued through the same write queue as normal
  // writes, so it runs after the server's users-table CREATE statement.
  const ready = (async () => {
    return withTransaction(db, async () => ensureSchema());
  })();
  // The server and the readyGuard below both await this promise. Attach a
  // no-op catch so a startup failure cannot surface as an unhandled rejection
  // before the startup barrier has a chance to report it.
  ready.catch(() => {});

  async function acquireEmailLock(email) {
    if (!postgres) return;
    await dbGet(db, 'SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`email-verification:${email}`]);
  }

  async function countRequests(database, sql, params, windowMs, now) {
    const row = await dbGet(database, sql, params);
    const count = Number(row && row.count) || 0;
    const oldest = row && row.oldest !== null && row.oldest !== undefined ? Number(row.oldest) : now;
    return {
      count,
      retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    };
  }

  function buildEmail({ username, email, pin }) {
    const safeUsername = escapeHtml(username);
    const safeEmail = escapeHtml(email);
    const minutes = Math.max(1, Math.round(otpTtlSeconds / 60));
    const text = [
      `Hello ${username},`,
      '',
      'Use the verification PIN below to activate your CornGrid EA account.',
      '',
      `    ${pin}`,
      '',
      `This PIN expires in ${minutes} minutes.`,
      '',
      'Security warning: never share this PIN. CornGrid EA will never ask for it by phone, chat, or social media. If you did not create this account, you can ignore this email.',
      '',
      'CornGrid EA'
    ].join('\n');
    const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#080a0f;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080a0f;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0d1117;border:1px solid #2a2f3a;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#080a0f;border-bottom:2px solid #ffd400;padding:24px 30px;">
                <span style="font-size:20px;font-weight:800;letter-spacing:2px;color:#ffd400;">CORNGRID EA</span>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 30px 10px;">
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.3;color:#ffffff;">Verify your email address</h1>
                <p style="margin:0;color:#aab2c0;font-size:15px;line-height:1.7;">Hello ${safeUsername}, use the PIN below to activate the CornGrid EA account registered to ${safeEmail}.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:26px 30px;">
                <div style="display:inline-block;background:#141822;border:1px solid #ffd400;border-radius:12px;padding:18px 30px;font-size:34px;font-weight:800;letter-spacing:10px;color:#ffd400;font-family:Consolas,monospace;">${pin}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 26px;">
                <p style="margin:0 0 10px;color:#aab2c0;font-size:14px;line-height:1.6;">This PIN expires in <strong style="color:#ffffff;">${minutes} minutes</strong>. You have a limited number of attempts.</p>
                <p style="margin:0;color:#8a92a6;font-size:12px;line-height:1.6;">Security warning: never share this PIN. CornGrid EA will never ask for it by phone, chat, or social media. If you did not create this account, ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="background:#080a0f;padding:18px 30px;color:#586072;font-size:11px;line-height:1.5;">CornGrid EA &middot; Automated security message. Please do not reply to this email.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
    return {
      from: smtpFrom || undefined,
      to: email,
      subject: 'Verify Your CornGrid EA Account',
      text,
      html
    };
  }

  async function deliverCode({ username, email, pin }) {
    if (!sendMail) throw new Error('Email delivery is not configured.');
    await sendMail(buildEmail({ username, email, pin }));
  }

  async function upsertCode(userId, generated, expiresAt, now, ip) {
    await dbRun(db, `
      INSERT INTO email_verification_codes
        (user_id, otp_salt, otp_hash, expires_at, attempts, created_at, sent_at, consumed_at, request_ip)
      VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        otp_salt = excluded.otp_salt,
        otp_hash = excluded.otp_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        created_at = excluded.created_at,
        sent_at = NULL,
        consumed_at = NULL,
        request_ip = excluded.request_ip
    `, [userId, generated.salt, generated.hash, expiresAt, now, ip || null]);
  }

  async function deleteUnsentCode(userId, hash) {
    try {
      await dbRun(db, 'DELETE FROM email_verification_codes WHERE user_id = ? AND otp_hash = ?', [userId, hash]);
    } catch (error) {
      logFailure('Could not remove an unsent verification code.', error);
    }
  }

  function rateLimitMiddleware(limiter, req, res) {
    const key = getClientIp(req) || 'unknown';
    req.emailVerificationIp = key;
    const result = limiter.take(key);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter));
      res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
      return false;
    }
    return true;
  }

  function trustedOrigin(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !origin) return true;
    try {
      const parsed = new URL(origin);
      const forwardedHost = req.headers['x-forwarded-host'];
      const host = typeof forwardedHost === 'string'
        ? forwardedHost.split(',')[0].trim()
        : req.headers.host;
      if (host && parsed.host === host) return true;
      if (process.env.APP_BASE_URL) {
        try {
          if (parsed.origin === new URL(process.env.APP_BASE_URL).origin) return true;
        } catch {
          // Ignore an unparseable APP_BASE_URL and fall through.
        }
      }
      if (parsed.protocol === 'capacitor:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function originGuard(req, res, next) {
    if (trustedOrigin(req)) return next();
    return res.status(403).json({ error: 'This request must come from the CornGrid site.' });
  }

  function readyGuard(req, res, next) {
    ready.then(() => next(), () => res.status(503).json({
      error: 'Email verification is temporarily unavailable. Please try again later.'
    }));
  }

  async function registerHandler(req, res) {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!username || username.length < 3 || username.length > 60 || !USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: 'Choose a username between 3 and 60 characters using letters, numbers, spaces, dots, underscores, or hyphens.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'The password must be at least 8 characters long.' });
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'The password must not exceed 72 UTF-8 bytes.' });
    }
    if (isReservedEmail && isReservedEmail(email)) {
      return res.status(400).json({ error: 'This email address is reserved.' });
    }
    if (!sendMail) {
      return res.status(503).json({ error: 'Email verification is temporarily unavailable. Please try again later.' });
    }

    const ip = req.emailVerificationIp || '';
    const now = Date.now();
    const expiresAt = now + otpTtlSeconds * 1000;
    const generated = { pin: generatePin(), salt: crypto.randomBytes(16).toString('hex') };
    generated.hash = hashPin(generated.pin, generated.salt, pepper);

    try {
      const passwordHash = await bcrypt.hash(password, bcryptRounds);
      const outcome = await withTransaction(db, async () => {
        if (ip) {
          const ipCounts = await countRequests(
            db,
            'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM email_verification_requests WHERE ip = ? AND created_at > ?',
            [ip, now - 60 * 60 * 1000],
            60 * 60 * 1000,
            now
          );
          if (ipCounts.count >= hourlyLimitPerIp) {
            return { status: 'limited', retryAfter: ipCounts.retryAfter };
          }
        }

        const verifiedValue = postgres ? false : 0;
        const inserted = await dbRun(
          db,
          'INSERT INTO users (username, email, password, email_verified, email_verified_at) VALUES (?, ?, ?, ?, NULL)',
          [username, email, passwordHash, verifiedValue]
        );
        if (inserted.changes !== 1 || !inserted.lastID) {
          throw new Error('User registration did not add a record.');
        }

        await dbRun(
          db,
          'INSERT INTO email_verification_requests (email, ip, kind, created_at) VALUES (?, ?, ?, ?)',
          [email, ip || null, 'registration', now]
        );
        await upsertCode(inserted.lastID, generated, expiresAt, now, ip);
        return { status: 'created', userId: inserted.lastID };
      });

      if (outcome.status === 'limited') {
        res.set('Retry-After', String(outcome.retryAfter));
        return res.status(429).json({ error: 'Too many verification emails have been requested. Please try again later.' });
      }

      let emailSent = true;
      try {
        await deliverCode({ username, email, pin: generated.pin });
        await dbRun(
          db,
          'UPDATE email_verification_codes SET sent_at = ? WHERE user_id = ? AND otp_hash = ?',
          [Date.now(), outcome.userId, generated.hash]
        );
      } catch (error) {
        emailSent = false;
        await deleteUnsentCode(outcome.userId, generated.hash);
        logFailure('Registration verification email could not be delivered.', error);
      }

      return res.status(201).json({
        message: emailSent
          ? 'Account created. Check your email for a 6-digit verification PIN.'
          : 'Account created, but the verification email could not be delivered. Use Resend PIN to try again.',
        emailMasked: maskEmail(email),
        emailSent,
        expiresAt: emailSent ? expiresAt : null,
        resendCooldownSeconds
      });
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({
          error: 'An account with these details already exists. Please sign in or reset your password.'
        });
      }
      logFailure('Registration failed.', error);
      return res.status(500).json({ error: 'Registration could not be completed. Please try again.' });
    }
  }

  async function verifyHandler(req, res) {
    const email = normalizeEmail(req.body?.email);
    const rawPin = req.body?.pin;
    const pin = typeof rawPin === 'string' ? rawPin.trim() : String(rawPin ?? '').trim();

    if (!isValidEmail(email) || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ error: GENERIC_INVALID_CODE });
    }

    try {
      const outcome = await withTransaction(db, async () => {
        await acquireEmailLock(email);

        const user = await dbGet(
          db,
          'SELECT id, email, email_verified FROM users WHERE email = ? COLLATE NOCASE',
          [email]
        );
        if (!user || isEmailVerified(user)) return { verified: false };

        const codeSql = postgres
          ? 'SELECT otp_salt, otp_hash, expires_at, attempts, consumed_at FROM email_verification_codes WHERE user_id = ? FOR UPDATE'
          : 'SELECT otp_salt, otp_hash, expires_at, attempts, consumed_at FROM email_verification_codes WHERE user_id = ?';
        const code = await dbGet(db, codeSql, [user.id]);
        const now = Date.now();
        if (
          !code ||
          code.consumed_at !== null && code.consumed_at !== undefined ||
          Number(code.expires_at) <= now ||
          Number(code.attempts) >= maxAttempts
        ) {
          return { verified: false };
        }

        const matches = hashesMatch(hashPin(pin, code.otp_salt, pepper), code.otp_hash);
        if (!matches) {
          const nextAttempts = Number(code.attempts) + 1;
          if (nextAttempts >= maxAttempts) {
            await dbRun(
              db,
              'UPDATE email_verification_codes SET attempts = ?, consumed_at = ?, otp_hash = ? WHERE user_id = ? AND consumed_at IS NULL',
              [nextAttempts, now, '', user.id]
            );
          } else {
            await dbRun(
              db,
              'UPDATE email_verification_codes SET attempts = ? WHERE user_id = ? AND consumed_at IS NULL',
              [nextAttempts, user.id]
            );
          }
          return { verified: false };
        }

        const consumed = await dbRun(
          db,
          'UPDATE email_verification_codes SET attempts = attempts + 1, consumed_at = ?, otp_hash = ? WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < ?',
          [now, '', user.id, now, maxAttempts]
        );
        if (consumed.changes !== 1) return { verified: false };

        const verifiedValue = postgres ? true : 1;
        await dbRun(
          db,
          'UPDATE users SET email_verified = ?, email_verified_at = ? WHERE id = ?',
          [verifiedValue, now, user.id]
        );
        return { verified: true };
      });

      if (!outcome.verified) {
        return res.status(400).json({ error: GENERIC_INVALID_CODE });
      }
      return res.json({
        message: 'Email verified successfully. You can now sign in.',
        verified: true
      });
    } catch (error) {
      logFailure('Email verification failed.', error);
      return res.status(500).json({ error: 'Email verification could not be completed. Please try again.' });
    }
  }

  async function resendHandler(req, res) {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const ip = req.emailVerificationIp || '';
    const now = Date.now();
    const cooldownMs = resendCooldownSeconds * 1000;
    const hourMs = 60 * 60 * 1000;

    try {
      const outcome = await withTransaction(db, async () => {
        await acquireEmailLock(email);

        const latest = await dbGet(
          db,
          'SELECT created_at FROM email_verification_requests WHERE email = ? ORDER BY created_at DESC, id DESC LIMIT 1',
          [email]
        );
        if (latest) {
          const elapsed = now - Number(latest.created_at);
          if (elapsed >= 0 && elapsed < cooldownMs) {
            return { status: 'cooldown', retryAfter: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)) };
          }
        }

        const perEmail = await countRequests(
          db,
          'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM email_verification_requests WHERE email = ? AND created_at > ?',
          [email, now - hourMs],
          hourMs,
          now
        );
        if (perEmail.count >= hourlyLimitPerEmail) {
          return { status: 'limited', retryAfter: perEmail.retryAfter };
        }

        if (ip) {
          const perIp = await countRequests(
            db,
            'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM email_verification_requests WHERE ip = ? AND created_at > ?',
            [ip, now - hourMs],
            hourMs,
            now
          );
          if (perIp.count >= hourlyLimitPerIp) {
            return { status: 'limited', retryAfter: perIp.retryAfter };
          }
        }

        // Record the request even when the address is unknown, so cooldown and
        // hourly limits behave identically and cannot be used for enumeration.
        await dbRun(
          db,
          'INSERT INTO email_verification_requests (email, ip, kind, created_at) VALUES (?, ?, ?, ?)',
          [email, ip || null, 'resend', now]
        );

        const user = await dbGet(
          db,
          'SELECT id, username, email, email_verified FROM users WHERE email = ? COLLATE NOCASE',
          [email]
        );
        if (!user || isEmailVerified(user)) return { status: 'generic' };

        const generated = { pin: generatePin(), salt: crypto.randomBytes(16).toString('hex') };
        generated.hash = hashPin(generated.pin, generated.salt, pepper);
        const expiresAt = now + otpTtlSeconds * 1000;
        await upsertCode(user.id, generated, expiresAt, now, ip);

        return {
          status: 'send',
          userId: user.id,
          username: user.username,
          email: user.email,
          pin: generated.pin,
          hash: generated.hash,
          expiresAt
        };
      });

      if (outcome.status === 'cooldown' || outcome.status === 'limited') {
        res.set('Retry-After', String(outcome.retryAfter));
        return res.status(429).json({ error: 'Please wait before requesting another verification PIN.' });
      }

      if (outcome.status === 'send') {
        try {
          await deliverCode({ username: outcome.username, email: outcome.email, pin: outcome.pin });
          await dbRun(
            db,
            'UPDATE email_verification_codes SET sent_at = ? WHERE user_id = ? AND otp_hash = ?',
            [Date.now(), outcome.userId, outcome.hash]
          );
        } catch (error) {
          await deleteUnsentCode(outcome.userId, outcome.hash);
          logFailure('Resend verification email could not be delivered.', error);
        }
      }

      return res.json({ message: GENERIC_RESEND_MESSAGE });
    } catch (error) {
      logFailure('Resend request failed.', error);
      return res.status(500).json({ error: 'The verification PIN could not be requested right now. Please try again later.' });
    }
  }

  async function cleanup() {
    const now = Date.now();
    const codeCutoff = now - 24 * 60 * 60 * 1000;
    const requestCutoff = now - 48 * 60 * 60 * 1000;
    await withTransaction(db, async () => {
      await dbRun(
        db,
        'DELETE FROM email_verification_codes WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?',
        [codeCutoff, codeCutoff]
      );
      await dbRun(
        db,
        'DELETE FROM email_verification_requests WHERE created_at < ?',
        [requestCutoff]
      );
    });
  }

  function startCleanup(intervalMs = 30 * 60 * 1000) {
    if (cleanupTimer || !(intervalMs > 0)) return;
    cleanupTimer = setInterval(() => {
      cleanup().catch(error => logFailure('Verification cleanup failed.', error));
    }, intervalMs);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  }

  function close() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function registerRoutes(app) {
    app.post(
      '/api/register',
      originGuard,
      (req, res, next) => (rateLimitMiddleware(registerLimiter, req, res) ? next() : undefined),
      readyGuard,
      registerHandler
    );
    app.post(
      '/api/verify-email',
      originGuard,
      (req, res, next) => (rateLimitMiddleware(verifyLimiter, req, res) ? next() : undefined),
      readyGuard,
      verifyHandler
    );
    app.post(
      '/api/resend-verification',
      originGuard,
      (req, res, next) => (rateLimitMiddleware(resendLimiter, req, res) ? next() : undefined),
      readyGuard,
      resendHandler
    );
    startCleanup();
  }

  return {
    cleanup,
    close,
    isEmailVerified,
    maskEmail,
    normalizeEmail,
    ready: () => ready,
    registerRoutes,
    resendCooldownSeconds
  };
}

module.exports = createEmailVerification;
module.exports.isEmailVerified = isEmailVerified;
module.exports.maskEmail = maskEmail;
module.exports.normalizeEmail = normalizeEmail;
