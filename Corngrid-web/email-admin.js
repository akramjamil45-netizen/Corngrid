'use strict';

// CornGrid administrator email management.
//
// This module owns SMTP configuration, reusable templates, drafts, the outbound
// queue and the email activity log. It is intentionally separate from the
// password-recovery transport in server.js:
//   * SMTP credentials live in the database, encrypted with AES-256-GCM.
//   * The plaintext password is never returned by any endpoint or written to a
//     log line.
//   * "sent" means the SMTP server accepted the message. It is NOT proof of
//     inbox delivery, so delivery_status stays "accepted_by_smtp".
//   * Bulk announcements are queued per recipient and drained in small batches
//     with a delay so one campaign cannot saturate the SMTP provider.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { dbAll, dbGet, dbRun, isPostgres, withTransaction } = require('./db-async');

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
const ENCRYPTIONS = new Set(['ssl', 'tls', 'starttls']);
const MAX_EMAILS_PER_MESSAGE = 100;
const MAX_BULK_RECIPIENTS = 2000;
const DEFAULT_QUEUE_BATCH = 10;
const DEFAULT_QUEUE_INTERVAL_MS = 5000;
const DEFAULT_QUEUE_DELAY_MS = 350;
const DEFAULT_MAX_ATTEMPTS = 3;

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS email_settings (
    id INTEGER PRIMARY KEY,
    smtp_host TEXT,
    smtp_port INTEGER NOT NULL DEFAULT 587,
    smtp_username TEXT,
    smtp_password_enc TEXT,
    smtp_password_iv TEXT,
    smtp_password_tag TEXT,
    from_email TEXT,
    from_name TEXT,
    encryption TEXT NOT NULL DEFAULT 'tls',
    smtp_enabled INTEGER NOT NULL DEFAULT 0,
    last_test_at INTEGER,
    last_test_status TEXT,
    last_test_message TEXT,
    updated_at INTEGER,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    subject TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    to_recipients TEXT NOT NULL,
    cc_recipients TEXT,
    bcc_recipients TEXT,
    subject TEXT NOT NULL,
    sender_email TEXT,
    sender_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    delivery_status TEXT,
    error_message TEXT,
    message_id TEXT,
    smtp_response TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    html_body TEXT,
    text_body TEXT,
    source TEXT NOT NULL DEFAULT 'composer',
    user_id INTEGER,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
  CREATE INDEX IF NOT EXISTS idx_email_logs_recipient ON email_logs(recipient);
  CREATE TABLE IF NOT EXISTS email_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    to_recipients TEXT,
    cc_recipients TEXT,
    bcc_recipients TEXT,
    subject TEXT,
    html_body TEXT,
    text_body TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER,
    user_id INTEGER,
    to_email TEXT NOT NULL,
    to_name TEXT,
    subject TEXT NOT NULL,
    html_body TEXT,
    text_body TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    scheduled_at INTEGER NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_email_queue_pending ON email_queue(status, scheduled_at);
  CREATE TABLE IF NOT EXISTS email_admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    actor TEXT,
    ip_address TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_audit_created ON email_admin_audit(created_at);
`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function nowMs() {
  return Date.now();
}

function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function parseBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) return '';
  if (/[\r\n]/.test(email)) return '';
  return email;
}

function parseAddressList(input, { field = 'recipient', allowEmpty = true } = {}) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,;]/)
      : [];
  const addresses = [];
  const seen = new Set();
  for (const item of raw) {
    const candidate = typeof item === 'string' ? item.trim() : '';
    if (!candidate) continue;
    if (candidate.length > 254 || /[\r\n]/.test(candidate)) {
      const error = new Error(`One of the ${field} addresses is not valid.`);
      error.status = 400;
      throw error;
    }
    const email = normalizeEmail(candidate);
    if (!email) {
      const error = new Error(`"${candidate.slice(0, 80)}" is not a valid ${field} email address.`);
      error.status = 400;
      throw error;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    addresses.push(email);
  }
  if (!allowEmpty && addresses.length === 0) {
    const error = new Error(`At least one ${field} is required.`);
    error.status = 400;
    throw error;
  }
  if (addresses.length > MAX_EMAILS_PER_MESSAGE) {
    const error = new Error(`A single email can have at most ${MAX_EMAILS_PER_MESSAGE} ${field} addresses.`);
    error.status = 400;
    throw error;
  }
  return addresses;
}

function normalizeSubject(value) {
  if (typeof value !== 'string') {
    const error = new Error('A subject is required.');
    error.status = 400;
    throw error;
  }
  if (/[\r\n]/.test(value)) {
    const error = new Error('The subject must not contain line breaks.');
    error.status = 400;
    throw error;
  }
  const subject = value.trim();
  if (!subject) {
    const error = new Error('A subject is required.');
    error.status = 400;
    throw error;
  }
  if (subject.length > 200) {
    const error = new Error('The subject must not exceed 200 characters.');
    error.status = 400;
    throw error;
  }
  return subject;
}

function normalizeBody(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    const error = new Error('Email content must be text.');
    error.status = 400;
    throw error;
  }
  if (value.length > maxLength) {
    const error = new Error('The email content is too large.');
    error.status = 400;
    throw error;
  }
  return value;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function parseFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) return { email: '', name: '' };
  const match = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: cleanText(match[1], 120), email: normalizeEmail(match[2]) };
  }
  return { name: '', email: normalizeEmail(raw) };
}

function sanitizeSmtpError(error) {
  const code = String(error && error.code ? error.code : '').toUpperCase();
  if (code === 'EAUTH') return 'Authentication failed. Check the SMTP username and password.';
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ECONNREFUSED') {
    return 'Could not connect to the SMTP server. Check the host, port, and encryption.';
  }
  if (code === 'ESOCKET') return 'The SMTP server closed the connection unexpectedly.';
  if (code === 'EDNS') return 'The SMTP host name could not be resolved.';
  const message = String((error && error.message) || 'The SMTP operation failed.')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
  return message || 'The SMTP operation failed.';
}

function sanitizeTemplateVariable(value) {
  return String(value ?? '').slice(0, 4000);
}

function renderTemplateString(template, variables, rawKeys) {
  return String(template || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return match;
    const value = sanitizeTemplateVariable(variables[key]);
    return rawKeys.has(key) ? value : escapeHtml(value);
  });
}

function brandShell(title, bodyHtml, footerHtml = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#080a0f;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080a0f;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#11151d;border:1px solid #252b36;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:26px 30px;border-bottom:1px solid #252b36;background:#0d1117;">
          <span style="font-size:19px;font-weight:700;letter-spacing:2px;color:#ffd400;">CORNGRID</span>
          <span style="display:block;margin-top:3px;font-size:10px;letter-spacing:2px;color:#7b8396;">EA TERMINAL</span>
        </td></tr>
        <tr><td style="padding:30px;">
          <h1 style="margin:0 0 18px;font-size:23px;line-height:1.3;color:#ffffff;">${escapeHtml(title)}</h1>
          <div style="font-size:14px;line-height:1.7;color:#c5cad4;">${bodyHtml}</div>
        </td></tr>
        <tr><td style="padding:20px 30px;border-top:1px solid #252b36;background:#0d1117;font-size:11px;line-height:1.6;color:#7b8396;">
          ${footerHtml || 'CornGrid EA · Professional trading automation<br>This is an automated message. Please do not reply directly to this email.'}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function defaultTemplates() {
  const support = '{{support_email}}';
  return [
    {
      slug: 'welcome',
      name: 'Welcome Email',
      description: 'Greets a new registered user.',
      subject: 'Welcome to CornGrid, {{username}}',
      html: brandShell('Welcome to CornGrid', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">Your CornGrid account is ready. You can now sign in to the Terminal, link your MT5 account, and explore the trading tools built for the CornGrid EA.</p>
        <p style="margin:0 0 22px;"><a href="{{login_url}}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#ffd400;color:#080a0f;font-weight:700;text-decoration:none;">Open CornGrid Terminal</a></p>
        <p style="margin:0;color:#7b8396;font-size:12px;">Need help? Contact us at ${support}.</p>`),
      text: 'Hello {{username}},\n\nWelcome to CornGrid. Your account is ready. Sign in at {{login_url}} to open the Terminal, link your MT5 account, and explore the trading tools built for the CornGrid EA.\n\nNeed help? Contact {{support_email}}.\n\nCornGrid EA'
    },
    {
      slug: 'registration_confirmation',
      name: 'Account Registration Confirmation',
      description: 'Confirms that a new account was created.',
      subject: 'Your CornGrid account has been created',
      html: brandShell('Account created', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">We have created your CornGrid account for <strong>{{email}}</strong>. If this was you, no further action is required.</p>
        <p style="margin:0 0 14px;">If you did not create this account, please contact us immediately at ${support}.</p>`),
      text: 'Hello {{username}},\n\nWe have created your CornGrid account for {{email}}. If this was you, no further action is required.\n\nIf you did not create this account, contact {{support_email}} immediately.\n\nCornGrid EA'
    },
    {
      slug: 'email_verification',
      name: 'Email Verification',
      description: 'Sends a verification code and link.',
      subject: 'Verify your CornGrid email address',
      html: brandShell('Verify your email', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">Use the verification code below to activate your CornGrid account.</p>
        <p style="margin:0 0 20px;font-size:30px;font-weight:700;letter-spacing:8px;color:#ffd400;">{{verification_code}}</p>
        <p style="margin:0 0 14px;">This code expires in {{expiry_minutes}} minutes.</p>
        <p style="margin:0;color:#7b8396;font-size:12px;">Never share this code. CornGrid will never ask for it by phone, chat, or social media.</p>`),
      text: 'Hello {{username}},\n\nYour CornGrid verification code is {{verification_code}}. It expires in {{expiry_minutes}} minutes.\n\nNever share this code.\n\nCornGrid EA'
    },
    {
      slug: 'subscription_confirmation',
      name: 'Subscription Confirmation',
      description: 'Confirms an activated subscription.',
      subject: 'Your CornGrid {{plan_name}} subscription is active',
      html: brandShell('Subscription activated', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">Your <strong>{{plan_name}}</strong> subscription is now active.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px;border:1px solid #252b36;border-radius:10px;">
          <tr><td style="padding:11px 14px;color:#7b8396;">Plan</td><td style="padding:11px 14px;text-align:right;color:#ffffff;">{{plan_name}}</td></tr>
          <tr><td style="padding:11px 14px;color:#7b8396;border-top:1px solid #252b36;">Expires</td><td style="padding:11px 14px;text-align:right;color:#ffffff;border-top:1px solid #252b36;">{{expiry_date}}</td></tr>
        </table>
        <p style="margin:0;">Thank you for choosing CornGrid.</p>`),
      text: 'Hello {{username}},\n\nYour {{plan_name}} subscription is now active. Expires: {{expiry_date}}.\n\nThank you for choosing CornGrid.\n\nCornGrid EA'
    },
    {
      slug: 'subscription_expiry',
      name: 'Subscription Expiry Reminder',
      description: 'Reminds a user before a subscription expires.',
      subject: 'Your CornGrid subscription expires on {{expiry_date}}',
      html: brandShell('Subscription expiring soon', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">Your <strong>{{plan_name}}</strong> subscription will expire on <strong>{{expiry_date}}</strong>.</p>
        <p style="margin:0 0 14px;">Renew before the expiry date to keep your EA downloads and terminal access uninterrupted.</p>
        <p style="margin:0 0 22px;"><a href="{{login_url}}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#ffd400;color:#080a0f;font-weight:700;text-decoration:none;">Manage subscription</a></p>`),
      text: 'Hello {{username}},\n\nYour {{plan_name}} subscription will expire on {{expiry_date}}. Renew before then to keep your EA downloads and terminal access uninterrupted.\n\nManage your subscription: {{login_url}}\n\nCornGrid EA'
    },
    {
      slug: 'payment_confirmation',
      name: 'Payment Confirmation',
      description: 'Confirms a received subscription payment.',
      subject: 'Payment received — {{amount}} {{currency}}',
      html: brandShell('Payment received', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">We have received your payment of <strong>{{amount}} {{currency}}</strong>.</p>
        <p style="margin:0 0 14px;">Reference: <strong>{{payment_reference}}</strong></p>
        <p style="margin:0;">Thank you for your continued support of CornGrid.</p>`),
      text: 'Hello {{username}},\n\nWe have received your payment of {{amount}} {{currency}}.\nReference: {{payment_reference}}\n\nThank you for your continued support of CornGrid.\n\nCornGrid EA'
    },
    {
      slug: 'account_suspension',
      name: 'Account Suspension Notification',
      description: 'Notifies a user that account access was suspended.',
      subject: 'Important: your CornGrid account access has been suspended',
      html: brandShell('Account access suspended', `
        <p style="margin:0 0 14px;">Hello {{username}},</p>
        <p style="margin:0 0 14px;">Access to your CornGrid account has been temporarily suspended.</p>
        <p style="margin:0 0 14px;"><strong>Reason:</strong> {{reason}}</p>
        <p style="margin:0 0 14px;"><strong>Access returns:</strong> {{suspended_until}}</p>
        <p style="margin:0;">If you believe this is a mistake, contact ${support}.</p>`),
      text: 'Hello {{username}},\n\nAccess to your CornGrid account has been temporarily suspended.\nReason: {{reason}}\nAccess returns: {{suspended_until}}\n\nIf you believe this is a mistake, contact {{support_email}}.\n\nCornGrid EA'
    },
    {
      slug: 'general_announcement',
      name: 'General Announcement',
      description: 'A branded announcement body for bulk sends.',
      subject: '{{announcement_title}}',
      html: brandShell('{{announcement_title}}', '<div style="margin:0;">{{announcement_body}}</div>'),
      text: '{{announcement_title}}\n\n{{announcement_body}}\n\nCornGrid EA'
    }
  ];
}

function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 2000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }
    const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 1, resetAt: now + windowMs };
      buckets.set(key, bucket);
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many email requests. Please wait before trying again.' });
    }
    return next();
  };
}

function registerEmailAdmin(app, db, verifyAdminToken, options = {}) {
  if (!app) throw new Error('registerEmailAdmin requires an Express app.');
  if (!db) throw new Error('registerEmailAdmin requires a database connection.');
  if (typeof verifyAdminToken !== 'function') {
    throw new Error('registerEmailAdmin requires the administrator token verifier.');
  }

  const logger = options.logger || console;
  const postgres = isPostgres(db);
  const secret = options.encryptionKey || process.env.EMAIL_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('EMAIL_ENCRYPTION_KEY or JWT_SECRET must be configured for email management.');
  }
  const encryptionKey = crypto.scryptSync(String(secret), 'corngrid-email-smtp-v1', 32);
  const createTransport = typeof options.createTransport === 'function'
    ? options.createTransport
    : nodemailer.createTransport.bind(nodemailer);
  const queueBatchSize = Math.max(1, Math.min(50, Number(options.queueBatchSize || process.env.EMAIL_QUEUE_BATCH_SIZE) || DEFAULT_QUEUE_BATCH));
  const queueIntervalMs = Math.max(1000, Number(options.queueIntervalMs || process.env.EMAIL_QUEUE_INTERVAL_MS) || DEFAULT_QUEUE_INTERVAL_MS);
  const queueDelayMs = (() => {
    const raw = options.queueDelayMs ?? process.env.EMAIL_QUEUE_DELAY_MS;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_QUEUE_DELAY_MS;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_QUEUE_DELAY_MS;
  })();
  const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || process.env.EMAIL_QUEUE_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS));
  const appBaseUrl = String(options.appBaseUrl || process.env.APP_BASE_URL || 'https://corngrid.com').replace(/\/+$/, '');
  const supportEmail = normalizeEmail(options.supportEmail || process.env.SUPPORT_EMAIL || process.env.SMTP_FROM || '') || 'support@corngrid.com';

  let hasVerifiedColumn = false;
  let queueTimer = null;
  let queueProcessing = false;

  function encryptSecret(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return {
      value: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    };
  }

  function decryptSecret(row) {
    if (!row || !row.smtp_password_enc || !row.smtp_password_iv || !row.smtp_password_tag) return '';
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        encryptionKey,
        Buffer.from(row.smtp_password_iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(row.smtp_password_tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(row.smtp_password_enc, 'base64')),
        decipher.final()
      ]);
      return decrypted.toString('utf8');
    } catch {
      logger.error('[email-admin] Stored SMTP credential could not be decrypted.');
      return '';
    }
  }

  async function audit(action, req, metadata) {
    try {
      await dbRun(db,
        'INSERT INTO email_admin_audit (action, actor, ip_address, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
        [
          action,
          'admin',
          cleanText(req.ip || req.socket?.remoteAddress || '', 80) || null,
          metadata ? JSON.stringify(metadata).slice(0, 4000) : null,
          nowMs()
        ]
      );
    } catch (error) {
      logger.error(`[email-admin] Failed to write audit entry (${action}): ${error.code || 'error'}`);
    }
  }

  async function ensureSchema() {
    if (postgres) {
      const tables = await dbAll(db, `
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('email_settings','email_templates','email_logs','email_drafts','email_queue','email_admin_audit')
      `);
      if ((tables || []).length < 6) {
        throw new Error('Email management migration 0004_email_management.sql has not been applied to PostgreSQL.');
      }
    } else {
      await new Promise((resolve, reject) => {
        db.exec(SQLITE_SCHEMA, error => (error ? reject(error) : resolve()));
      });
    }

    try {
      if (postgres) {
        const column = await dbGet(db, `
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'email_verified'
        `);
        hasVerifiedColumn = Boolean(column && column.column_name);
      } else {
        const columns = await dbAll(db, 'PRAGMA table_info(users)');
        hasVerifiedColumn = (columns || []).some(column => column.name === 'email_verified');
      }
    } catch {
      hasVerifiedColumn = false;
    }
  }

  async function seedSettings() {
    const existing = await dbGet(db, 'SELECT id FROM email_settings WHERE id = 1');
    if (existing) return;
    const from = parseFrom(options.envSettings?.from || process.env.SMTP_FROM);
    const host = cleanText(options.envSettings?.host || process.env.SMTP_HOST || '', 255);
    const port = Number(options.envSettings?.port || process.env.SMTP_PORT) || 587;
    const username = cleanText(options.envSettings?.username || process.env.SMTP_USER || '', 320);
    const password = String(options.envSettings?.password ?? process.env.SMTP_PASS ?? '');
    const secure = options.envSettings?.secure ?? (process.env.SMTP_SECURE === 'true');
    const encryption = ENCRYPTIONS.has(options.envSettings?.encryption)
      ? options.envSettings.encryption
      : secure ? 'ssl' : 'tls';
    const enabled = Boolean(host && from.email) ? 1 : 0;
    const encrypted = password ? encryptSecret(password) : null;
    await dbRun(db, `
      INSERT INTO email_settings
        (id, smtp_host, smtp_port, smtp_username, smtp_password_enc, smtp_password_iv, smtp_password_tag,
         from_email, from_name, encryption, smtp_enabled, updated_at, updated_by)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      host || null, port, username || null,
      encrypted ? encrypted.value : null,
      encrypted ? encrypted.iv : null,
      encrypted ? encrypted.tag : null,
      from.email || null, from.name || null, encryption, enabled,
      nowMs(), 'environment'
    ]);
  }

  async function seedTemplates() {
    const count = await dbGet(db, 'SELECT COUNT(*) AS total FROM email_templates');
    if (Number(count && count.total) > 0) return;
    const timestamp = nowMs();
    for (const template of defaultTemplates()) {
      await dbRun(db, `
        INSERT INTO email_templates (slug, name, description, subject, html_body, text_body, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `, [template.slug, template.name, template.description, template.subject, template.html, template.text, timestamp, timestamp]);
    }
  }

  const ready = (async () => {
    await withTransaction(db, async () => {
      await ensureSchema();
      await seedSettings();
      await seedTemplates();
    });
  })();
  ready.catch(() => {});

  function readyGuard(req, res, next) {
    ready.then(() => next(), error => {
      logger.error(`[email-admin] Initialisation failed: ${error.code || 'error'}`);
      res.status(503).json({ error: 'Email management is not ready. Please try again shortly.' });
    });
  }

  function adminRoute(handler) {
    return [verifyAdminToken, readyGuard, handler];
  }

  async function getSettingsRow() {
    return dbGet(db, 'SELECT * FROM email_settings WHERE id = 1');
  }

  function publicSettings(row) {
    if (!row) {
      return {
        smtpHost: '', smtpPort: 587, smtpUsername: '', fromEmail: '', fromName: '',
        encryption: 'tls', enabled: false, passwordConfigured: false,
        lastTestAt: null, lastTestStatus: null, lastTestMessage: null, updatedAt: null
      };
    }
    return {
      smtpHost: row.smtp_host || '',
      smtpPort: Number(row.smtp_port) || 587,
      smtpUsername: row.smtp_username || '',
      fromEmail: row.from_email || '',
      fromName: row.from_name || '',
      encryption: ENCRYPTIONS.has(row.encryption) ? row.encryption : 'tls',
      enabled: parseBoolean(row.smtp_enabled),
      passwordConfigured: Boolean(row.smtp_password_enc),
      lastTestAt: toMillis(row.last_test_at),
      lastTestStatus: row.last_test_status || null,
      lastTestMessage: row.last_test_message || null,
      updatedAt: toMillis(row.updated_at)
    };
  }

  function validateSettingsInput(body) {
    const host = cleanText(body?.smtpHost, 255);
    if (!host || !HOST_PATTERN.test(host) || host.startsWith('.') || host.endsWith('.')) {
      const error = new Error('Enter a valid SMTP host name (letters, numbers, dots, and hyphens only).');
      error.status = 400;
      throw error;
    }
    const port = Number(body?.smtpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const error = new Error('SMTP port must be a whole number between 1 and 65535.');
      error.status = 400;
      throw error;
    }
    const username = cleanText(body?.smtpUsername, 320);
    if (username && /[\r\n]/.test(String(body?.smtpUsername))) {
      const error = new Error('The SMTP username must not contain line breaks.');
      error.status = 400;
      throw error;
    }
    const fromEmail = normalizeEmail(body?.fromEmail);
    if (!fromEmail) {
      const error = new Error('Enter a valid sender email address.');
      error.status = 400;
      throw error;
    }
    const fromName = cleanText(body?.fromName, 120);
    if (/[\r\n]/.test(String(body?.fromName || ''))) {
      const error = new Error('The sender name must not contain line breaks.');
      error.status = 400;
      throw error;
    }
    const encryption = String(body?.encryption || '').toLowerCase();
    if (!ENCRYPTIONS.has(encryption)) {
      const error = new Error('Encryption must be SSL, TLS, or STARTTLS.');
      error.status = 400;
      throw error;
    }
    let password = null;
    if (body?.password !== undefined && body?.password !== null && body?.password !== '') {
      if (typeof body.password !== 'string' || body.password.length > 1024) {
        const error = new Error('The SMTP password is not valid.');
        error.status = 400;
        throw error;
      }
      password = body.password;
    }
    return {
      host,
      port,
      username,
      fromEmail,
      fromName,
      encryption,
      enabled: parseBoolean(body?.enabled),
      password
    };
  }

  function settingsRowFromInput(input, stored) {
    return {
      smtp_host: input.host,
      smtp_port: input.port,
      smtp_username: input.username || null,
      from_email: input.fromEmail,
      from_name: input.fromName || null,
      encryption: input.encryption,
      smtp_enabled: input.enabled ? 1 : 0,
      smtp_password_enc: stored?.smtp_password_enc || null,
      smtp_password_iv: stored?.smtp_password_iv || null,
      smtp_password_tag: stored?.smtp_password_tag || null,
      ...(input.password ? (() => {
        const encrypted = encryptSecret(input.password);
        return {
          smtp_password_enc: encrypted.value,
          smtp_password_iv: encrypted.iv,
          smtp_password_tag: encrypted.tag
        };
      })() : {})
    };
  }

  function validateRowForSending(row, passwordOverride) {
    if (!row) throw Object.assign(new Error('SMTP settings have not been configured.'), { status: 400 });
    if (!parseBoolean(row.smtp_enabled)) {
      throw Object.assign(new Error('SMTP is disabled. Enable it in Email settings before sending.'), { status: 400 });
    }
    if (!row.smtp_host || !HOST_PATTERN.test(row.smtp_host)) {
      throw Object.assign(new Error('The SMTP host is not configured correctly.'), { status: 400 });
    }
    const port = Number(row.smtp_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error('The SMTP port is not configured correctly.'), { status: 400 });
    }
    if (!normalizeEmail(row.from_email)) {
      throw Object.assign(new Error('The sender email is not configured correctly.'), { status: 400 });
    }
    const password = passwordOverride !== undefined && passwordOverride !== null
      ? passwordOverride
      : decryptSecret(row);
    if (row.smtp_username && !password) {
      throw Object.assign(new Error('The SMTP password is missing. Update the SMTP settings.'), { status: 400 });
    }
    return password;
  }

  function buildTransport(row, password) {
    const secure = row.encryption === 'ssl';
    const requireTLS = row.encryption === 'tls' || row.encryption === 'starttls';
    const auth = row.smtp_username ? { user: row.smtp_username, pass: password || '' } : undefined;
    return createTransport({
      host: row.smtp_host,
      port: Number(row.smtp_port),
      secure,
      requireTLS,
      auth,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      tls: { minVersion: 'TLSv1.2' }
    });
  }

  function fromHeader(row) {
    const safeName = String(row.from_name || '').replace(/[\r\n"]/g, ' ').trim();
    return safeName
      ? `"${safeName}" <${row.from_email}>`
      : row.from_email;
  }

  async function deliver(row, message) {
    const password = validateRowForSending(row);
    const transport = buildTransport(row, password);
    const info = await transport.sendMail({
      from: fromHeader(row),
      to: message.to,
      cc: message.cc && message.cc.length ? message.cc : undefined,
      bcc: message.bcc && message.bcc.length ? message.bcc : undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: { 'X-CornGrid-Email': 'administrator' }
    });
    return info || {};
  }

  function parseJsonArray(value) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  function publicLog(row) {
    return {
      id: row.id,
      recipient: row.recipient,
      to: parseJsonArray(row.to_recipients),
      cc: parseJsonArray(row.cc_recipients),
      bcc: parseJsonArray(row.bcc_recipients),
      subject: row.subject,
      senderEmail: row.sender_email || '',
      senderName: row.sender_name || '',
      status: row.status,
      deliveryStatus: row.delivery_status || null,
      errorMessage: row.error_message || null,
      messageId: row.message_id || null,
      attempts: Number(row.attempts) || 0,
      html: row.html_body || '',
      text: row.text_body || '',
      source: row.source,
      createdAt: toMillis(row.created_at),
      sentAt: toMillis(row.sent_at),
      updatedAt: toMillis(row.updated_at)
    };
  }

  function templateVariables(extra) {
    return {
      app_name: 'CornGrid',
      app_url: appBaseUrl,
      login_url: `${appBaseUrl}/login`,
      support_email: supportEmail,
      username: 'Trader',
      email: 'trader@example.com',
      plan_name: 'CornGrid Pro',
      expiry_date: new Date(nowMs() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB'),
      amount: '99.00',
      currency: 'MYR',
      payment_reference: 'CG-EXAMPLE-0001',
      reason: 'Account review',
      suspended_until: new Date(nowMs() + 24 * 60 * 60 * 1000).toLocaleString('en-GB'),
      verification_code: '123456',
      verification_url: `${appBaseUrl}/verify-email`,
      expiry_minutes: '10',
      announcement_title: 'CornGrid announcement',
      announcement_body: 'Your announcement content will appear here.',
      ...(extra && typeof extra === 'object' ? extra : {})
    };
  }

  function renderTemplate(template, extraVariables) {
    const variables = templateVariables(extraVariables);
    const rawKeys = new Set(['announcement_body', 'message', 'html', 'body_html']);
    const subject = renderTemplateString(template.subject, variables, rawKeys)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 200);
    return {
      subject,
      html: renderTemplateString(template.html_body, variables, rawKeys),
      text: renderTemplateString(template.text_body, variables, rawKeys)
    };
  }

  async function insertLog(entry) {
    const timestamp = nowMs();
    const result = await dbRun(db, `
      INSERT INTO email_logs
        (recipient, to_recipients, cc_recipients, bcc_recipients, subject, sender_email, sender_name,
         status, delivery_status, error_message, message_id, smtp_response, attempts, html_body, text_body,
         source, user_id, created_at, sent_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.recipient,
      JSON.stringify(entry.to),
      JSON.stringify(entry.cc || []),
      JSON.stringify(entry.bcc || []),
      entry.subject,
      entry.senderEmail || null,
      entry.senderName || null,
      entry.status || 'pending',
      entry.deliveryStatus || null,
      entry.errorMessage || null,
      entry.messageId || null,
      entry.smtpResponse || null,
      entry.attempts || 0,
      entry.html || null,
      entry.text || null,
      entry.source || 'composer',
      entry.userId || null,
      timestamp,
      entry.sentAt || null,
      timestamp
    ]);
    return result.lastID;
  }

  async function markLogSent(logId, info) {
    const messageId = info && info.messageId ? String(info.messageId).slice(0, 500) : null;
    const response = info && info.response ? String(info.response).replace(/[\r\n]+/g, ' ').slice(0, 1000) : null;
    await dbRun(db, `
      UPDATE email_logs
      SET status = 'sent', delivery_status = 'accepted_by_smtp', error_message = NULL,
          message_id = ?, smtp_response = ?, attempts = attempts + 1, sent_at = ?, updated_at = ?
      WHERE id = ?
    `, [messageId, response, nowMs(), nowMs(), logId]);
  }

  async function markLogFailed(logId, error) {
    await dbRun(db, `
      UPDATE email_logs
      SET status = 'failed', error_message = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `, [sanitizeSmtpError(error), nowMs(), logId]);
  }

  async function sendDirect({ req, row, to, cc, bcc, subject, html, text, source, userId }) {
    const recipient = to.join(', ');
    const logId = await insertLog({
      recipient,
      to,
      cc,
      bcc,
      subject,
      senderEmail: row.from_email,
      senderName: row.from_name,
      status: 'pending',
      html,
      text,
      source,
      userId
    });
    try {
      const info = await deliver(row, { to, cc, bcc, subject, html, text });
      await markLogSent(logId, info);
      await audit('email.send', req, { logId, recipients: to.length + (cc?.length || 0) + (bcc?.length || 0), source });
      return { logId, status: 'sent', deliveryStatus: 'accepted_by_smtp' };
    } catch (error) {
      await markLogFailed(logId, error);
      await audit('email.send_failed', req, { logId, source });
      const failure = new Error(sanitizeSmtpError(error));
      failure.status = 502;
      failure.logId = logId;
      throw failure;
    }
  }

  function eligibleCondition() {
    if (!hasVerifiedColumn) return '';
    return postgres
      ? 'AND (email_verified IS NULL OR email_verified = TRUE)'
      : 'AND (email_verified IS NULL OR email_verified = 1)';
  }

  async function findEligibleUsers({ userIds, search = '', limit, offset }) {
    const params = [];
    let where = "WHERE email IS NOT NULL AND TRIM(email) <> ''";
    where += ` ${eligibleCondition()}`;
    if (Array.isArray(userIds)) {
      if (!userIds.length) return [];
      const placeholders = userIds.map(() => '?').join(',');
      where += ` AND id IN (${placeholders})`;
      params.push(...userIds);
    }
    if (search) {
      where += ' AND (username LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE)';
      params.push(`%${search}%`, `%${search}%`);
    }
    let sql = `SELECT id, username, email, created_at AS "createdAt" FROM users ${where} ORDER BY id ASC`;
    if (limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset || 0);
    }
    return dbAll(db, sql, params);
  }

  async function countEligibleUsers({ userIds, search = '' } = {}) {
    const params = [];
    let where = "WHERE email IS NOT NULL AND TRIM(email) <> ''";
    where += ` ${eligibleCondition()}`;
    if (Array.isArray(userIds)) {
      if (!userIds.length) return 0;
      where += ` AND id IN (${userIds.map(() => '?').join(',')})`;
      params.push(...userIds);
    }
    if (search) {
      where += ' AND (username LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE)';
      params.push(`%${search}%`, `%${search}%`);
    }
    const row = await dbGet(db, `SELECT COUNT(*) AS total FROM users ${where}`, params);
    return Number(row && row.total) || 0;
  }

  function personalizeBulkContent(value, user, row, asHtml) {
    const username = asHtml ? escapeHtml(user.username || '') : String(user.username || '');
    const email = asHtml ? escapeHtml(user.email || '') : String(user.email || '');
    const sender = asHtml ? escapeHtml(row.from_email || '') : String(row.from_email || '');
    return String(value || '')
      .replace(/\{\{\s*username\s*\}\}/gi, username)
      .replace(/\{\{\s*email\s*\}\}/gi, email)
      .replace(/\{\{\s*app_name\s*\}\}/gi, 'CornGrid')
      .replace(/\{\{\s*app_url\s*\}\}/gi, appBaseUrl)
      .replace(/\{\{\s*login_url\s*\}\}/gi, `${appBaseUrl}/login`)
      .replace(/\{\{\s*support_email\s*\}\}/gi, sender);
  }

  async function enqueueBulk({ users, subject, html, text, req, source }) {
    const row = await getSettingsRow();
    validateRowForSending(row);
    const timestamp = nowMs();
    let queued = 0;
    await withTransaction(db, async () => {
      for (const user of users) {
        const email = normalizeEmail(user.email);
        if (!email) continue;
        const personalized = {
          subject: personalizeBulkContent(subject, user, row, false).replace(/[\r\n]+/g, ' ').slice(0, 200),
          html: personalizeBulkContent(html, user, row, true),
          text: personalizeBulkContent(text, user, row, false)
        };
        const recipient = email;
        const logId = await insertLog({
          recipient,
          to: [email],
          cc: [],
          bcc: [],
          subject: personalized.subject,
          senderEmail: row.from_email,
          senderName: row.from_name,
          status: 'pending',
          html: personalized.html,
          text: personalized.text,
          source,
          userId: user.id
        });
        await dbRun(db, `
          INSERT INTO email_queue
            (log_id, user_id, to_email, to_name, subject, html_body, text_body, status, attempts,
             max_attempts, scheduled_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
        `, [logId, user.id, email, user.username || null, personalized.subject, personalized.html, personalized.text, maxAttempts, timestamp, timestamp, timestamp]);
        queued += 1;
      }
    });
    await audit('email.bulk_enqueue', req, { queued, source });
    void processQueue();
    return queued;
  }

  async function processQueue() {
    if (queueProcessing) return { processed: 0, skipped: true };
    queueProcessing = true;
    let processed = 0;
    try {
      const row = await getSettingsRow();
      if (!row || !parseBoolean(row.smtp_enabled)) return { processed: 0, disabled: true };
      validateRowForSending(row);
      const items = await dbAll(db, `
        SELECT * FROM email_queue
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY id ASC
        LIMIT ?
      `, [nowMs(), queueBatchSize]);
      if (!items.length) return { processed: 0 };

      const transport = buildTransport(row, decryptSecret(row));
      for (const item of items) {
        const claim = await dbRun(db,
          "UPDATE email_queue SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
          [nowMs(), item.id]
        );
        if (!claim.changes) continue;
        try {
          const info = await transport.sendMail({
            from: fromHeader(row),
            to: item.to_email,
            subject: item.subject,
            html: item.html_body || undefined,
            text: item.text_body || undefined,
            headers: { 'X-CornGrid-Email': 'administrator-bulk' }
          });
          const messageId = info && info.messageId ? String(info.messageId).slice(0, 500) : null;
          const response = info && info.response ? String(info.response).replace(/[\r\n]+/g, ' ').slice(0, 1000) : null;
          await dbRun(db, `
            UPDATE email_queue
            SET status = 'sent', sent_at = ?, updated_at = ?, message_id = ?, last_error = NULL
            WHERE id = ?
          `, [nowMs(), nowMs(), messageId, item.id]);
          if (item.log_id) {
            await dbRun(db, `
              UPDATE email_logs
              SET status = 'sent', delivery_status = 'accepted_by_smtp', error_message = NULL,
                  message_id = ?, smtp_response = ?, attempts = attempts + 1, sent_at = ?, updated_at = ?
              WHERE id = ?
            `, [messageId, response, nowMs(), nowMs(), item.log_id]);
          }
        } catch (error) {
          const attempts = Number(item.attempts) + 1;
          const failure = sanitizeSmtpError(error);
          if (attempts < maxAttempts) {
            const backoffSeconds = Math.min(3600, 60 * Math.pow(2, attempts));
            await dbRun(db, `
              UPDATE email_queue
              SET status = 'pending', last_error = ?, scheduled_at = ?, updated_at = ?
              WHERE id = ?
            `, [failure, nowMs() + backoffSeconds * 1000, nowMs(), item.id]);
            if (item.log_id) {
              await dbRun(db, `
                UPDATE email_logs SET error_message = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?
              `, [failure, nowMs(), item.log_id]);
            }
          } else {
            await dbRun(db, `
              UPDATE email_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
            `, [failure, nowMs(), item.id]);
            if (item.log_id) {
              await dbRun(db, `
                UPDATE email_logs
                SET status = 'failed', error_message = ?, attempts = attempts + 1, updated_at = ?
                WHERE id = ?
              `, [failure, nowMs(), item.log_id]);
            }
          }
        }
        processed += 1;
        if (queueDelayMs) await new Promise(resolve => setTimeout(resolve, queueDelayMs));
      }
      return { processed };
    } catch (error) {
      logger.error(`[email-admin] Queue processing failed: ${error.code || 'error'}`);
      return { processed, error: true };
    } finally {
      queueProcessing = false;
    }
  }

  function startQueue() {
    if (queueTimer || options.autoStart === false) return;
    queueTimer = setInterval(() => { void processQueue(); }, queueIntervalMs);
    if (queueTimer.unref) queueTimer.unref();
  }

  // ------------------------------- Settings -------------------------------

  app.get('/api/admin/email/settings', ...adminRoute(async (_req, res) => {
    try {
      const row = await getSettingsRow();
      return res.json({ settings: publicSettings(row) });
    } catch (error) {
      logger.error(`[email-admin] Failed to load SMTP settings: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to load email settings.' });
    }
  }));

  app.put('/api/admin/email/settings', ...adminRoute(async (req, res) => {
    try {
      const input = validateSettingsInput(req.body);
      const stored = await getSettingsRow();
      const next = settingsRowFromInput(input, stored);
      await dbRun(db, `
        UPDATE email_settings
        SET smtp_host = ?, smtp_port = ?, smtp_username = ?,
            smtp_password_enc = ?, smtp_password_iv = ?, smtp_password_tag = ?,
            from_email = ?, from_name = ?, encryption = ?, smtp_enabled = ?,
            updated_at = ?, updated_by = ?
        WHERE id = 1
      `, [
        next.smtp_host, next.smtp_port, next.smtp_username,
        next.smtp_password_enc, next.smtp_password_iv, next.smtp_password_tag,
        next.from_email, next.from_name, next.encryption, next.smtp_enabled,
        nowMs(), 'admin'
      ]);
      await audit('email.settings_update', req, {
        host: input.host, port: input.port, encryption: input.encryption,
        enabled: input.enabled, passwordChanged: Boolean(input.password)
      });
      const saved = await getSettingsRow();
      return res.json({ message: 'SMTP settings saved.', settings: publicSettings(saved) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      logger.error(`[email-admin] Failed to save SMTP settings: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to save email settings.' });
    }
  }));

  const testLimiter = createRateLimiter({
    limit: Math.max(1, Number(process.env.EMAIL_TEST_RATE_LIMIT) || 10),
    windowMs: 60 * 1000
  });

  app.post('/api/admin/email/settings/test', verifyAdminToken, readyGuard, testLimiter, async (req, res) => {
    try {
      const stored = await getSettingsRow();
      const body = req.body || {};
      const hasOverrides = ['smtpHost', 'smtpPort', 'smtpUsername', 'fromEmail', 'fromName', 'encryption', 'enabled']
        .some(key => body[key] !== undefined);
      let row;
      if (hasOverrides) {
        const input = validateSettingsInput({
          smtpHost: body.smtpHost ?? stored?.smtp_host,
          smtpPort: body.smtpPort ?? stored?.smtp_port,
          smtpUsername: body.smtpUsername ?? stored?.smtp_username,
          fromEmail: body.fromEmail ?? stored?.from_email,
          fromName: body.fromName ?? stored?.from_name,
          encryption: body.encryption ?? stored?.encryption,
          enabled: body.enabled ?? true,
          password: body.password
        });
        row = settingsRowFromInput({ ...input, enabled: true }, stored);
      } else {
        row = stored;
      }
      const passwordOverride = body.password !== undefined && body.password !== null && body.password !== ''
        ? body.password
        : undefined;
      const password = validateRowForSending({ ...row, smtp_enabled: 1 }, passwordOverride);
      const transport = buildTransport(row, password);
      const verifyPromise = transport.verify();
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('SMTP verification timed out.'), { code: 'ETIMEDOUT' })), 20000);
        if (timer.unref) timer.unref();
      });
      await Promise.race([verifyPromise, timeout]);
      await dbRun(db, `
        UPDATE email_settings SET last_test_at = ?, last_test_status = 'success', last_test_message = ? WHERE id = 1
      `, [nowMs(), 'SMTP connection established successfully.']);
      await audit('email.smtp_test', req, { ok: true });
      return res.json({ ok: true, message: 'SMTP connection established successfully.' });
    } catch (error) {
      const message = sanitizeSmtpError(error);
      try {
        await dbRun(db, `
          UPDATE email_settings SET last_test_at = ?, last_test_status = 'failed', last_test_message = ? WHERE id = 1
        `, [nowMs(), message]);
      } catch { /* the response is still useful if the status write fails */ }
      await audit('email.smtp_test', req, { ok: false });
      return res.status(502).json({ ok: false, error: message });
    }
  });

  // ------------------------------- Templates ------------------------------

  app.get('/api/admin/email/templates', ...adminRoute(async (_req, res) => {
    try {
      const rows = await dbAll(db, 'SELECT * FROM email_templates ORDER BY is_system DESC, name ASC');
      return res.json({
        templates: rows.map(row => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description || '',
          subject: row.subject,
          html: row.html_body,
          text: row.text_body,
          isSystem: parseBoolean(row.is_system),
          createdAt: toMillis(row.created_at),
          updatedAt: toMillis(row.updated_at)
        }))
      });
    } catch (error) {
      logger.error(`[email-admin] Failed to load templates: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to load email templates.' });
    }
  }));

  function validateTemplateInput(body) {
    const name = cleanText(body?.name, 120);
    if (!name) throw Object.assign(new Error('A template name is required.'), { status: 400 });
    const subject = normalizeSubject(body?.subject);
    const html = normalizeBody(body?.html, 200000);
    const text = normalizeBody(body?.text, 100000);
    if (!html && !text) throw Object.assign(new Error('A template must include HTML or plain text content.'), { status: 400 });
    const slug = cleanText(body?.slug, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return {
      name,
      slug: slug || `template_${Date.now()}`,
      description: cleanText(body?.description, 300),
      subject,
      html: html || textToHtml(text),
      text: text || htmlToText(html)
    };
  }

  app.post('/api/admin/email/templates', ...adminRoute(async (req, res) => {
    try {
      const input = validateTemplateInput(req.body);
      const timestamp = nowMs();
      const result = await dbRun(db, `
        INSERT INTO email_templates (slug, name, description, subject, html_body, text_body, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      `, [input.slug, input.name, input.description, input.subject, input.html, input.text, timestamp, timestamp]);
      await audit('email.template_create', req, { id: result.lastID, slug: input.slug });
      return res.status(201).json({ id: result.lastID, slug: input.slug });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        return res.status(409).json({ error: 'A template with this slug already exists.' });
      }
      logger.error(`[email-admin] Failed to create template: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to create the email template.' });
    }
  }));

  app.put('/api/admin/email/templates/:id', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid template ID.' });
    try {
      const input = validateTemplateInput(req.body);
      const result = await dbRun(db, `
        UPDATE email_templates
        SET slug = ?, name = ?, description = ?, subject = ?, html_body = ?, text_body = ?, updated_at = ?
        WHERE id = ?
      `, [input.slug, input.name, input.description, input.subject, input.html, input.text, nowMs(), id]);
      if (!result.changes) return res.status(404).json({ error: 'Template not found.' });
      await audit('email.template_update', req, { id });
      return res.json({ message: 'Template updated.' });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (/UNIQUE constraint failed/i.test(String(error.message))) {
        return res.status(409).json({ error: 'A template with this slug already exists.' });
      }
      logger.error(`[email-admin] Failed to update template: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to update the email template.' });
    }
  }));

  app.delete('/api/admin/email/templates/:id', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid template ID.' });
    try {
      const result = await dbRun(db, 'DELETE FROM email_templates WHERE id = ?', [id]);
      if (!result.changes) return res.status(404).json({ error: 'Template not found.' });
      await audit('email.template_delete', req, { id });
      return res.json({ message: 'Template deleted.' });
    } catch (error) {
      logger.error(`[email-admin] Failed to delete template: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to delete the email template.' });
    }
  }));

  app.post('/api/admin/email/templates/:id/preview', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid template ID.' });
    try {
      const template = await dbGet(db, 'SELECT * FROM email_templates WHERE id = ?', [id]);
      if (!template) return res.status(404).json({ error: 'Template not found.' });
      const variables = {};
      if (req.body && typeof req.body.variables === 'object' && req.body.variables) {
        for (const [key, value] of Object.entries(req.body.variables)) {
          if (/^[A-Za-z0-9_]{1,40}$/.test(key)) variables[key] = sanitizeTemplateVariable(value);
        }
      }
      return res.json(renderTemplate(template, variables));
    } catch (error) {
      logger.error(`[email-admin] Failed to preview template: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to preview the email template.' });
    }
  }));

  // -------------------------------- Drafts --------------------------------

  app.get('/api/admin/email/drafts', ...adminRoute(async (_req, res) => {
    try {
      const rows = await dbAll(db, 'SELECT * FROM email_drafts ORDER BY updated_at DESC LIMIT 100');
      return res.json({
        drafts: rows.map(row => ({
          id: row.id,
          name: row.name || '',
          to: parseJsonArray(row.to_recipients),
          cc: parseJsonArray(row.cc_recipients),
          bcc: parseJsonArray(row.bcc_recipients),
          subject: row.subject || '',
          html: row.html_body || '',
          text: row.text_body || '',
          createdAt: toMillis(row.created_at),
          updatedAt: toMillis(row.updated_at)
        }))
      });
    } catch (error) {
      logger.error(`[email-admin] Failed to load drafts: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to load email drafts.' });
    }
  }));

  function validateDraftInput(body) {
    let to = [];
    let cc = [];
    let bcc = [];
    try {
      to = parseAddressList(body?.to, { field: 'recipient' });
      cc = parseAddressList(body?.cc, { field: 'CC recipient' });
      bcc = parseAddressList(body?.bcc, { field: 'BCC recipient' });
    } catch (error) {
      if (error.status) return { error };
      throw error;
    }
    return {
      name: cleanText(body?.name, 120),
      to,
      cc,
      bcc,
      subject: cleanText(body?.subject, 200),
      html: normalizeBody(body?.html, 200000),
      text: normalizeBody(body?.text, 100000)
    };
  }

  app.post('/api/admin/email/drafts', ...adminRoute(async (req, res) => {
    try {
      const input = validateDraftInput(req.body);
      if (input.error) return res.status(input.error.status).json({ error: input.error.message });
      const timestamp = nowMs();
      const result = await dbRun(db, `
        INSERT INTO email_drafts
          (name, to_recipients, cc_recipients, bcc_recipients, subject, html_body, text_body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.name || null, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
        input.subject || null, input.html, input.text, timestamp, timestamp
      ]);
      await audit('email.draft_create', req, { id: result.lastID });
      return res.status(201).json({ id: result.lastID, message: 'Draft saved.' });
    } catch (error) {
      logger.error(`[email-admin] Failed to save draft: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to save the email draft.' });
    }
  }));

  app.put('/api/admin/email/drafts/:id', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid draft ID.' });
    try {
      const input = validateDraftInput(req.body);
      if (input.error) return res.status(input.error.status).json({ error: input.error.message });
      const result = await dbRun(db, `
        UPDATE email_drafts
        SET name = ?, to_recipients = ?, cc_recipients = ?, bcc_recipients = ?, subject = ?,
            html_body = ?, text_body = ?, updated_at = ?
        WHERE id = ?
      `, [
        input.name || null, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
        input.subject || null, input.html, input.text, nowMs(), id
      ]);
      if (!result.changes) return res.status(404).json({ error: 'Draft not found.' });
      await audit('email.draft_update', req, { id });
      return res.json({ message: 'Draft updated.' });
    } catch (error) {
      logger.error(`[email-admin] Failed to update draft: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to update the email draft.' });
    }
  }));

  app.delete('/api/admin/email/drafts/:id', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid draft ID.' });
    try {
      const result = await dbRun(db, 'DELETE FROM email_drafts WHERE id = ?', [id]);
      if (!result.changes) return res.status(404).json({ error: 'Draft not found.' });
      await audit('email.draft_delete', req, { id });
      return res.json({ message: 'Draft deleted.' });
    } catch (error) {
      logger.error(`[email-admin] Failed to delete draft: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to delete the email draft.' });
    }
  }));

  // ------------------------------ Recipients ------------------------------

  app.get('/api/admin/email/recipients', ...adminRoute(async (req, res) => {
    try {
      const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
      const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
      const search = cleanText(req.query.search, 100);
      const total = await countEligibleUsers({ search });
      const users = await findEligibleUsers({ search, limit, offset: (page - 1) * limit });
      return res.json({
        users,
        total,
        eligibleTotal: await countEligibleUsers({}),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      });
    } catch (error) {
      logger.error(`[email-admin] Failed to load recipients: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to load registered recipients.' });
    }
  }));

  // -------------------------------- Sending -------------------------------

  const sendLimiter = createRateLimiter({
    limit: Math.max(1, Number(process.env.EMAIL_SEND_RATE_LIMIT) || 60),
    windowMs: 60 * 1000
  });
  const bulkLimiter = createRateLimiter({
    limit: Math.max(1, Number(process.env.EMAIL_BULK_RATE_LIMIT) || 5),
    windowMs: 15 * 60 * 1000
  });

  app.post('/api/admin/email/send', verifyAdminToken, readyGuard, sendLimiter, async (req, res) => {
    try {
      const row = await getSettingsRow();
      validateRowForSending(row);
      const to = parseAddressList(req.body?.to, { field: 'recipient', allowEmpty: false });
      const cc = parseAddressList(req.body?.cc, { field: 'CC recipient' });
      const bcc = parseAddressList(req.body?.bcc, { field: 'BCC recipient' });
      const subject = normalizeSubject(req.body?.subject);
      const html = normalizeBody(req.body?.html, 200000);
      const text = normalizeBody(req.body?.text, 100000);
      if (!html && !text) return res.status(400).json({ error: 'Add a message body before sending.' });
      const result = await sendDirect({
        req,
        row,
        to,
        cc,
        bcc,
        subject,
        html: html || textToHtml(text),
        text: text || htmlToText(html),
        source: 'composer'
      });
      return res.status(201).json({
        ...result,
        message: 'The SMTP server accepted the email. Inbox delivery is not confirmed.'
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, logId: error.logId });
      logger.error(`[email-admin] Send failed: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to send the email.' });
    }
  });

  app.post('/api/admin/email/bulk', verifyAdminToken, readyGuard, bulkLimiter, async (req, res) => {
    try {
      const row = await getSettingsRow();
      validateRowForSending(row);
      const subject = normalizeSubject(req.body?.subject);
      const html = normalizeBody(req.body?.html, 200000);
      const text = normalizeBody(req.body?.text, 100000);
      if (!html && !text) return res.status(400).json({ error: 'Add a message body before sending.' });
      const allEligible = parseBoolean(req.body?.allEligible);
      let userIds = [];
      if (!allEligible) {
        if (!Array.isArray(req.body?.userIds) || req.body.userIds.length === 0) {
          return res.status(400).json({ error: 'Select at least one registered user.' });
        }
        userIds = [...new Set(req.body.userIds
          .map(value => Number.parseInt(value, 10))
          .filter(value => Number.isSafeInteger(value) && value > 0))];
        if (!userIds.length) return res.status(400).json({ error: 'Select at least one registered user.' });
        if (userIds.length > MAX_BULK_RECIPIENTS) {
          return res.status(400).json({ error: `A bulk send can target at most ${MAX_BULK_RECIPIENTS} users at once.` });
        }
      }
      const users = await findEligibleUsers({ userIds: allEligible ? undefined : userIds });
      if (!users.length) return res.status(400).json({ error: 'No eligible registered users were found.' });
      if (users.length > MAX_BULK_RECIPIENTS) {
        return res.status(400).json({ error: `A bulk send can target at most ${MAX_BULK_RECIPIENTS} users at once.` });
      }
      const needsConfirmation = allEligible || users.length > 100;
      if (needsConfirmation && req.body?.confirm !== true) {
        return res.status(400).json({
          error: `Confirm the bulk send before continuing. This will queue ${users.length} email${users.length === 1 ? '' : 's'}.`,
          requiresConfirmation: true,
          recipientCount: users.length
        });
      }
      const queued = await enqueueBulk({
        users,
        subject,
        html: html || textToHtml(text),
        text: text || htmlToText(html),
        req,
        source: 'bulk'
      });
      return res.status(202).json({
        queued,
        recipientCount: users.length,
        message: `${queued} email${queued === 1 ? '' : 's'} queued for delivery. Status will update in Email history.`
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      logger.error(`[email-admin] Bulk send failed: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to queue the bulk email.' });
    }
  });

  // --------------------------------- Logs ---------------------------------

  app.get('/api/admin/email/logs', ...adminRoute(async (req, res) => {
    try {
      const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
      const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 20));
      const search = cleanText(req.query.search, 100);
      const status = ['sent', 'failed', 'pending'].includes(req.query.status) ? req.query.status : '';
      const conditions = [];
      const params = [];
      if (search) {
        conditions.push('(recipient LIKE ? COLLATE NOCASE OR subject LIKE ? COLLATE NOCASE)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (status) {
        conditions.push('status = ?');
        params.push(status);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const totalRow = await dbGet(db, `SELECT COUNT(*) AS total FROM email_logs ${where}`, params);
      const total = Number(totalRow && totalRow.total) || 0;
      const rows = await dbAll(db, `
        SELECT id, recipient, subject, sender_email, sender_name, status, delivery_status,
               error_message, attempts, source, created_at, sent_at
        FROM email_logs ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, (page - 1) * limit]);
      return res.json({
        logs: rows.map(row => ({
          id: row.id,
          recipient: row.recipient,
          subject: row.subject,
          senderEmail: row.sender_email || '',
          senderName: row.sender_name || '',
          status: row.status,
          deliveryStatus: row.delivery_status || null,
          errorMessage: row.error_message || null,
          attempts: Number(row.attempts) || 0,
          source: row.source,
          createdAt: toMillis(row.created_at),
          sentAt: toMillis(row.sent_at)
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      });
    } catch (error) {
      logger.error(`[email-admin] Failed to load email logs: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to load email history.' });
    }
  }));

  app.get('/api/admin/email/logs/:id', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid email ID.' });
    try {
      const row = await dbGet(db, 'SELECT * FROM email_logs WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: 'Email not found.' });
      return res.json({ email: publicLog(row) });
    } catch (error) {
      logger.error(`[email-admin] Failed to load email details: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to load this email.' });
    }
  }));

  app.post('/api/admin/email/logs/:id/retry', ...adminRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid email ID.' });
    try {
      const row = await getSettingsRow();
      validateRowForSending(row);
      const log = await dbGet(db, 'SELECT * FROM email_logs WHERE id = ?', [id]);
      if (!log) return res.status(404).json({ error: 'Email not found.' });
      if (log.status === 'sent') return res.status(400).json({ error: 'This email was already accepted by the SMTP server.' });
      const to = parseJsonArray(log.to_recipients);
      const cc = parseJsonArray(log.cc_recipients);
      const bcc = parseJsonArray(log.bcc_recipients);
      if (!to.length) return res.status(400).json({ error: 'This email has no recipient to retry.' });
      try {
        const info = await deliver(row, {
          to,
          cc,
          bcc,
          subject: log.subject,
          html: log.html_body || undefined,
          text: log.text_body || undefined
        });
        await markLogSent(id, info);
        await audit('email.retry', req, { id, ok: true });
        return res.json({ message: 'The SMTP server accepted the email on retry.', status: 'sent', deliveryStatus: 'accepted_by_smtp' });
      } catch (error) {
        await markLogFailed(id, error);
        await audit('email.retry', req, { id, ok: false });
        return res.status(502).json({ error: sanitizeSmtpError(error) });
      }
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      logger.error(`[email-admin] Retry failed: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to retry this email.' });
    }
  }));

  app.get('/api/admin/email/queue', ...adminRoute(async (_req, res) => {
    try {
      const row = await dbGet(db, `
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM email_queue
      `);
      return res.json({
        queue: {
          pending: Number(row && row.pending) || 0,
          sending: Number(row && row.sending) || 0,
          sent: Number(row && row.sent) || 0,
          failed: Number(row && row.failed) || 0
        }
      });
    } catch (error) {
      logger.error(`[email-admin] Failed to read queue status: ${error.code || 'error'}`);
      return res.status(500).json({ error: 'Unable to read the email queue.' });
    }
  }));

  startQueue();

  return {
    ready: () => ready,
    processQueue,
    close() {
      if (queueTimer) clearInterval(queueTimer);
      queueTimer = null;
    }
  };
}

module.exports = registerEmailAdmin;
