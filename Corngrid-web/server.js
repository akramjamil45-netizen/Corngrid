const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const ROOT_DIR = path.join(__dirname, '..');
const registerMt5Api = require('./mt5-api');
const registerMarketApi = require('./market-api');
const createMarketFeed = require('./market-feed');
const createEconomicCalendar = require('./economic-calendar');
const registerAvatarApi = require('./avatar-api');
const registerFeedApi = require('./feed-api');
const registerChatApi = require('./chat-api');
const createAdminAuth = require('./admin-auth');
const registerAdminApi = require('./admin-api');
const createUserAuth = require('./user-auth');
const {
  clearAuthCookie,
  isSameOriginRequest,
  readAuthCredential,
  setAuthCookie
} = require('./session-cookie');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_FROM = process.env.SMTP_FROM;
const mailTransport = SMTP_HOST && SMTP_FROM
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      ...(process.env.SMTP_USER && process.env.SMTP_PASS
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
        : {})
    })
  : null;
const SECRET_KEY = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex')
);

if (!SECRET_KEY) {
  throw new Error('JWT_SECRET must be set before starting the production server.');
}
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set; session tokens will expire when the server restarts.');
}
if (process.env.NODE_ENV === 'production' && !mailTransport) {
  throw new Error('SMTP_HOST and SMTP_FROM must be set for password recovery in production.');
}
if (SMTP_HOST && !SMTP_FROM) {
  throw new Error('SMTP_FROM mesti ditetapkan apabila SMTP_HOST digunakan.');
}
const adminAuth = createAdminAuth({
  email: process.env.ADMIN_EMAIL,
  passwordHash: process.env.ADMIN_PASSWORD_HASH,
  jwtSecret: SECRET_KEY
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/') ||
    ['/admin', '/admin.html', '/dashboard', '/dashboard.html', '/index.html', '/login', '/login.html', '/reset-password.html'].includes(req.path)
  ) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve root marketing static assets when running standalone
app.get('/mystyle.css', (req, res) => res.sendFile(path.join(ROOT_DIR, 'mystyle.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(ROOT_DIR, 'script.js')));
app.use('/download', express.static(path.join(ROOT_DIR, 'download')));
app.use('/files', express.static(path.join(ROOT_DIR, 'files')));
app.use('/video', express.static(path.join(ROOT_DIR, 'video')));
app.use('/images', express.static(path.join(ROOT_DIR, 'images')));
// Community feed uploads (written by feed-api.js with validated random filenames).
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// A rejected EA request or a dropped socket must never take the whole backend
// down. Without these handlers Node exits on the first unhandled rejection,
// which is exactly the "server down" symptom seen while EA clients were
// posting market data.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error instanceof Error ? error.stack : error);
});

// Connect to the SQLite database
const db = new sqlite3.Database(DATABASE_PATH, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite:', err.message);
  } else {
    console.log('Connected to the CornGrid SQLite database.');
    db.serialize(() => {
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA busy_timeout = 5000;');
      db.run('PRAGMA synchronous = NORMAL;');
      db.run('PRAGMA foreign_keys = ON;');
    });
  }
});

function rateLimit({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 1000) {
      for (const [key, bucket] of buckets) {
        if (bucket.expiresAt <= now) buckets.delete(key);
      }
    }
    const key = req.ip;
    const current = buckets.get(key);
    if (!current || current.expiresAt <= now) {
      buckets.set(key, { count: 1, expiresAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) {
      res.set('Retry-After', String(Math.ceil((current.expiresAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }
    return next();
  };
}

const loginRateLimit = rateLimit({ limit: 10, windowMs: 15 * 60 * 1000 });
const recoveryRateLimit = rateLimit({ limit: 5, windowMs: 15 * 60 * 1000 });
const downloadRateLimit = rateLimit({ limit: 30, windowMs: 15 * 60 * 1000 });

// Create the user table when needed
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    bio TEXT DEFAULT 'CornGrid EA Terminal user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  )
`);

const verifyToken = createUserAuth({ db, jwtSecret: SECRET_KEY });

const { authenticateInstallation } = registerMt5Api(app, db, verifyToken);
registerAvatarApi(app, db, verifyToken);
registerChatApi(app, db, verifyToken);
const marketFeed = createMarketFeed({ db, symbols: registerMarketApi.SYMBOLS });
marketFeed.registerRoutes(app, { verifyToken, authenticateInstallation });
registerMarketApi(app, db, verifyToken, marketFeed);
const economicCalendar = createEconomicCalendar({ db });
economicCalendar.registerRoutes(app, { verifyToken });
registerFeedApi(app, db, verifyToken, adminAuth.verifyToken);
registerAdminApi(
  app,
  db,
  adminAuth.verifyToken,
  Number(process.env.MT5_HEARTBEAT_TIMEOUT_SECONDS) || 180
);

const downloadableResources = Object.freeze({
  'setup-guide': {
    file: 'Corngrid Setup Guide v1.1.pdf',
    downloadName: 'CornGrid_Setup_Guide_v1.1.pdf'
  },
  'xauusd-v260': {
    file: path.join('v2.0 set file', 'xauusd v2.60 set file.set'),
    downloadName: 'CornGrid_XAUUSD_v2.60.set'
  },
  'xauusd-v25': {
    file: path.join('v2.0 set file', 'xauusd v2.5 set file.set'),
    downloadName: 'CornGrid_XAUUSD_v2.5.set'
  },
  'eurusd-m1-v200': {
    file: path.join('v2.0 set file', 'eurusd m1 v2.00 set file.set'),
    downloadName: 'CornGrid_EURUSD_M1_v2.00.set'
  },
  'gbpusd-m1-v200': {
    file: path.join('v2.0 set file', 'gbpusd m1 v2.00 set file.set'),
    downloadName: 'CornGrid_GBPUSD_M1_v2.00.set'
  },
  'usdjpy-m1-v200': {
    file: path.join('v2.0 set file', 'usdjpy m1 v2.00 set file.set'),
    downloadName: 'CornGrid_USDJPY_M1_v2.00.set'
  }
});

app.get('/api/downloads/:resourceId', verifyToken, downloadRateLimit, (req, res) => {
  if (!Object.hasOwn(downloadableResources, req.params.resourceId)) {
    return res.status(404).json({ error: 'The requested download was not found.' });
  }
  const resource = downloadableResources[req.params.resourceId];
  const filePath = path.join(__dirname, '..', 'files', resource.file);
  res.download(filePath, resource.downloadName, (error) => {
    if (!error) return;
    if (res.headersSent) return;
    if (error.code === 'ENOENT') {
      console.error(`Download resource is missing: ${resource.file}`);
      return res.status(404).json({ error: 'This download is temporarily unavailable.' });
    }
    console.error('Failed to serve a dashboard download:', error.message);
    return res.status(500).json({ error: 'The download could not be completed.' });
  });
});

// ------------------- ENDPOINTS LALUAN HALAMAN (ROUTING) -------------------

app.get('/', (req, res) => {
  const marketingPath = path.join(ROOT_DIR, 'index.html');
  if (fs.existsSync(marketingPath)) {
    return res.sendFile(marketingPath);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/portfolios', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'public-portfolios.html'));
});

app.get('/portfolio/:shareId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'public-portfolio.html'));
});

// Check auth service availability before rendering the login page.
app.get('/login', async (req, res) => {
  let available = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://localhost:${PORT}/api/health`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    available = resp.ok;
  } catch {
    // Network failure, timeout, or 5xx while trying to reach the auth layer.
    available = false;
  }

  if (!available) {
    // Preserve where the user came from for the "Return" action.
    const referrer = req.headers.referer || '/';
    const fallbackUrl =
      typeof referrer === 'string' && referrer.startsWith('/')
        ? referrer
        : '/';
    return res.redirect(
      302,
      `/service-unavailable?r=${encodeURIComponent(fallbackUrl)}`
    );
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Special case for explicit .html access as well.
app.get('/login.html', async (req, res) => {
  let available = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://localhost:${PORT}/api/health`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    available = resp.ok;
  } catch {
    available = false;
  }

  if (!available) {
    const referrer = req.headers.referer || '/';
    const fallbackUrl =
      typeof referrer === 'string' && referrer.startsWith('/')
        ? referrer
        : '/';
    return res.redirect(
      302,
      `/service-unavailable?r=${encodeURIComponent(fallbackUrl)}`
    );
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Service-unavailable fallback: rendered only when the auth layer is
// genuinely unavailable. The page is fully static and self-contained, so it
// can render even while the auth API is down.
app.get('/service-unavailable', (req, res) => {
  const fallbackUrl =
    typeof req.query.r === 'string' && req.query.r.startsWith('/')
      ? decodeURIComponent(req.query.r)
      : '/';

  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'service-unavailable.html'));
});

// Service-unavailable fallback assets
app.get('/service-unavailable.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'service-unavailable.css'));
});

app.get('/service-unavailable.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'service-unavailable.js'));
});



app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'sw.js'));
});

// ------------------- ENDPOINTS API -------------------

// Health check endpoint - lightweight availability probe for fallback flows.
// Deliberately NOT an auth endpoint: it never requires a token, credentials,
// or any session data. It only confirms that the web/API layer is reachable
// and the auth service is accepting requests.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'auth',
    timestamp: Date.now()
  });
});

// 1. API Pendaftaran Pengguna
app.post('/api/register', loginRateLimit, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const { password } = req.body;

  if (!username || !email || typeof password !== 'string') {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }
  if (adminAuth.matchesEmail(email)) {
    return res.status(400).json({ error: 'This email address is reserved.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'The password must be at least 8 characters long.' });
  }
  if (Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'The password must not exceed 72 UTF-8 bytes.' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const query = `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`;

    db.run(query, [username, email, hashedPassword], function (err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Username or email has already been taken.' });
        }
        console.error('Failed to register user:', err.message);
        return res.status(500).json({ error: 'Server error during registration.' });
      }
      if (this.changes !== 1) {
        console.error('User registration did not add a record.');
        return res.status(500).json({ error: 'Server error during registration.' });
      }
      res.json({ message: 'Registration successful! Please log in.' });
    });
  } catch (error) {
    console.error('Failed to prepare registration:', error.message);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// 2. Login API
app.post('/api/login', loginRateLimit, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const { password } = req.body;

  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }

  const rememberMe = req.body && req.body.rememberMe !== false;
  const tokenDuration = rememberMe ? '30d' : '1d';
  const cookieDuration = rememberMe ? (30 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);

  if (adminAuth.matchesEmail(email)) {
    try {
      const token = await adminAuth.authenticate(email, password, tokenDuration);
      if (!token) return res.status(400).json({ error: 'Email or password is incorrect.' });
      if (isSameOriginRequest(req)) setAuthCookie(res, token, req, cookieDuration);
      return res.json({
        message: 'Login successful!',
        token,
        user: { role: 'admin', username: 'Administrator' }
      });
    } catch (error) {
      console.error('Failed to verify administrator credentials:', error.message);
      return res.status(500).json({ error: 'Error occurred while verifying credentials.' });
    }
  }

  const query = `SELECT * FROM users WHERE email = ? COLLATE NOCASE`;
  db.get(query, [email], async (err, user) => {
    if (err) {
      console.error('Failed to search for account:', err.message);
      return res.status(500).json({ error: 'Server error during login.' });
    }
    if (!user) {
      return res.status(400).json({ error: 'Email or password is incorrect.' });
    }

    try {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(400).json({ error: 'Email or password is incorrect.' });
      }
      if (Buffer.byteLength(password, 'utf8') > 72) {
        return res.status(400).json({ error: 'Email or password is incorrect.' });
      }

      const authVersion = await new Promise((resolve, reject) => {
        db.get('SELECT version FROM user_auth_versions WHERE user_id = ?', [user.id], (versionErr, record) => {
          if (versionErr) reject(versionErr);
          else resolve(record ? record.version : 0);
        });
      });
      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, authVersion },
        SECRET_KEY,
        { expiresIn: tokenDuration }
      );

      if (isSameOriginRequest(req)) setAuthCookie(res, token, req, cookieDuration);
      res.json({
        message: 'Login successful!',
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          bio: user.bio
        }
      });
    } catch (bcryptErr) {
      res.status(500).json({ error: 'Error occurred while verifying password.' });
    }
  });
});

app.post('/api/logout', (req, res) => {
  const credential = readAuthCredential(req);
  if (credential?.source === 'cookie' && !isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'This request must come from the same site.' });
  }
  clearAuthCookie(res, req);
  res.json({ message: 'Signed out successfully.' });
});

// 3. API Dapatkan Profil Pengguna
app.get('/api/user/profile', verifyToken, (req, res) => {
  const query = `SELECT id, username, email, bio, created_at FROM users WHERE id = ?`;
  db.get(query, [req.user.id], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(user);
  });
});

// 4. API Kemas Kini Data Pengguna
app.put('/api/user/profile', verifyToken, (req, res) => {
  const { username, bio } = req.body;

  if (typeof username !== 'string' || !username.trim() || username.trim().length > 60) {
    return res.status(400).json({ error: 'Username cannot be empty.' });
  }
  if (bio !== undefined && (typeof bio !== 'string' || bio.length > 500)) {
    return res.status(400).json({ error: 'Bio must be text and no longer than 500 characters.' });
  }

  const query = `UPDATE users SET username = ?, bio = ? WHERE id = ?`;
  db.run(query, [username.trim(), typeof bio === 'string' ? bio : '', req.user.id], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'This username is already taken.' });
      }
      return res.status(500).json({ error: 'Failed to update profile.' });
    }
    res.json({ message: 'Profile updated successfully!' });
  });
});

// 5. Forgot Password API
app.post('/api/forgot-password', recoveryRateLimit, (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const responseMessage = 'If your email is registered, a recovery link will be sent. In development mode without SMTP, check the server terminal.';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const query = `SELECT id, email FROM users WHERE email = ? COLLATE NOCASE`;
  db.get(query, [email], (err, user) => {
    if (err) {
      console.error('Failed to find the account for password recovery:', err.message);
      return res.status(500).json({ error: 'Error occurred while requesting password recovery.' });
    }
    if (!user) {
      return res.json({ message: responseMessage });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000;

    db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id], (deleteErr) => {
      if (deleteErr) {
        console.error('Failed to replace the previous recovery token:', deleteErr.message);
        return res.status(500).json({ error: 'Error occurred while requesting password recovery.' });
      }

      db.run(
        'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [tokenHash, user.id, expiresAt, Date.now()],
        (insertErr) => {
          if (insertErr) {
            console.error('Failed to save the recovery token:', insertErr.message);
            return res.status(500).json({ error: 'Error occurred while requesting password recovery.' });
          }

          const baseUrl = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
          const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;

          if (!mailTransport) {
            console.log(`[PASSWORD RESET LINK]: ${resetUrl}`);
            return res.json({ message: responseMessage });
          }

          mailTransport.sendMail({
            from: SMTP_FROM,
            to: user.email,
            subject: 'Reset Your CornGrid Password',
            text: `We have received a request to reset the password for your CornGrid account. Please click the link below to reset your password within 15 minutes: ${resetUrl}\n\nIf you did not request this change, please ignore this email.`,
            html: `<p>We have received a request to reset the password for your CornGrid account.</p><p><a href="${resetUrl}">Reset Your Password</a></p><p>This link will expire in 15 minutes. If you did not request this change, please ignore this email.</p>`
          }, (mailErr) => {
            if (mailErr) {
              console.error('Failed to send the recovery email:', mailErr.message);
              return db.run(
                'DELETE FROM password_reset_tokens WHERE token_hash = ?',
                [tokenHash],
                (cleanupErr) => {
                  if (cleanupErr) console.error('Failed to remove the unsent recovery token:', cleanupErr.message);
                  res.status(503).json({ error: 'The recovery email cannot be sent right now. Please try again later.' });
                }
              );
            }
            return res.json({ message: responseMessage });
          });
        }
      );
    });
  });
});

// 6. Reset Password API
app.post('/api/reset-password', recoveryRateLimit, async (req, res) => {
  const { token, newPassword } = req.body;

  if (typeof token !== 'string' || !/^[a-f\d]{64}$/i.test(token) || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'A reset token and new password are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'The new password must be at least 8 characters long.' });
  }
  if (Buffer.byteLength(newPassword, 'utf8') > 72) return res.status(400).json({ error: 'The new password must not exceed 72 UTF-8 bytes.' });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.get('SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?', [tokenHash], (lookupErr, resetRecord) => {
    if (lookupErr) {
      console.error('Failed to read the password recovery token:', lookupErr.message);
      return res.status(500).json({ error: 'A server error occurred while resetting the password.' });
    }
    if (!resetRecord || resetRecord.used_at || resetRecord.expires_at <= Date.now()) {
      return res.status(400).json({ error: 'The reset link is invalid, has already been used, or has expired.' });
    }

    bcrypt.hash(newPassword, 10).then((hashedPassword) => {
      const now = Date.now();
      db.run(
        'UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL',
        [now, tokenHash, now],
        function (tokenErr) {
          if (tokenErr) {
            console.error('Failed to validate the password recovery token:', tokenErr.message);
            return res.status(500).json({ error: 'A server error occurred while resetting the password.' });
          }
          if (this.changes !== 1) {
            return res.status(400).json({ error: 'The reset link is invalid, has already been used, or has expired.' });
          }

          db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, resetRecord.user_id], function (updateErr) {
            if (updateErr) {
              console.error('Failed to save the new password:', updateErr.message);
              return res.status(500).json({ error: 'Failed to update the password.' });
            }
            if (this.changes !== 1) {
              return res.status(400).json({ error: 'The account for this reset link could not be found.' });
            }

            db.run(`
              INSERT INTO user_auth_versions (user_id, version) VALUES (?, 1)
              ON CONFLICT(user_id) DO UPDATE SET version = version + 1
            `, [resetRecord.user_id], (versionErr) => {
              if (versionErr) {
                console.error('Failed to invalidate sessions after password reset:', versionErr.message);
                return res.status(500).json({ error: 'Password was updated, but active sessions could not be invalidated.' });
              }
              db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [resetRecord.user_id], (deleteErr) => {
                if (deleteErr) console.error('Failed to remove used password recovery tokens:', deleteErr.message);
                return res.json({ message: 'Password updated successfully. Please sign in again.' });
              });
            });
          });
        }
      );
    }).catch((hashErr) => {
      console.error('Failed to hash the new password:', hashErr.message);
      return res.status(500).json({ error: 'A server error occurred while resetting the password.' });
    });
  });
});

// ------------------- FALLBACK HANDLER & SERVER LISTEN -------------------

let lastAbortedRequestLogAt = 0;

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request payload is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body contains invalid JSON.' });

  // The client disconnected before the request body finished arriving (page
  // navigation, closed tab, client timeout, unstable EA connection, etc.).
  // This is not a server fault and there is no one left to respond to.
  if (err.type === 'request.aborted' || err.code === 'ECONNABORTED' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    const now = Date.now();
    if (now - lastAbortedRequestLogAt > 30000) {
      lastAbortedRequestLogAt = now;
      const expected = Number.isFinite(err.expected) ? err.expected : null;
      const received = Number.isFinite(err.received) ? err.received : null;
      // The bytes that never arrived are the useful part: a body that stopped
      // short usually means the client gave up waiting (an EA WebRequest
      // timeout, for example) rather than a genuine network drop.
      const detail = expected !== null && received !== null
        ? ` (${received}/${expected} bytes received before the client disconnected)`
        : '';
      console.warn(`Ignored a client-aborted request (${req.method} ${req.path})${detail}.`);
    }
    return;
  }

  console.error(`Unhandled request error (${req.method} ${req.path}):`, err.message);
  return res.status(500).json({ error: 'An internal server error occurred.' });
});

// Fallback 404 handler (must appear after all API and page routes)
app.use((req, res) => {
  res.status(404).json({ error: 'Page not found.' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`CornGrid backend is running at http://localhost:${PORT}`);
});