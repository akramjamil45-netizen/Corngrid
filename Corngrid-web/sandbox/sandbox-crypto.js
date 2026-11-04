'use strict';

// Authenticated encryption for sandbox secrets (MT5 passwords, partner payout
// details). AES-256-GCM with a random IV per record; the key comes from the
// SANDBOX_ENCRYPTION_KEY environment variable (64 hex chars = 32 bytes) and is
// never stored in the database.
//
// Cipher payload format: "v1.<base64 iv>.<base64 auth tag>.<base64 ciphertext>"
// The version prefix allows future key rotation: records carry the key version
// so a rotation can re-encrypt lazily without a flag day.

const crypto = require('crypto');

const PAYLOAD_VERSION = 'v1';
const IV_BYTES = 12; // recommended for GCM
const KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

function loadKey(rawKey) {
  if (typeof rawKey !== 'string' || !KEY_HEX_PATTERN.test(rawKey.trim())) {
    return null;
  }
  return Buffer.from(rawKey.trim(), 'hex');
}

function createSandboxCrypto({ encryptionKey, allowEphemeral = false } = {}) {
  let key = loadKey(encryptionKey || process.env.SANDBOX_ENCRYPTION_KEY || '');
  let ephemeral = false;

  if (!key) {
    if (process.env.NODE_ENV === 'production' && !allowEphemeral) {
      throw new Error(
        'SANDBOX_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) in production. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    // Development/test convenience: a random per-process key. Data encrypted
    // with it is unreadable after a restart, which is acceptable for local dev.
    key = crypto.randomBytes(32);
    ephemeral = true;
  }

  function encrypt(plaintext) {
    if (typeof plaintext !== 'string') {
      throw new TypeError('encrypt expects a string.');
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PAYLOAD_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
  }

  function decrypt(payload) {
    if (typeof payload !== 'string') return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) return null;
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const ciphertext = Buffer.from(parts[3], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (_error) {
      // Wrong key or tampered payload. Never leak which.
      return null;
    }
  }

  function encryptJson(value) {
    return encrypt(JSON.stringify(value));
  }

  function decryptJson(payload) {
    const plaintext = decrypt(payload);
    if (plaintext === null) return null;
    try {
      return JSON.parse(plaintext);
    } catch (_error) {
      return null;
    }
  }

  return { encrypt, decrypt, encryptJson, decryptJson, ephemeral, keyVersion: PAYLOAD_VERSION };
}

// Mask an MT5 account number for display: keep the last two digits.
function maskAccountNumber(accountNumber) {
  const text = String(accountNumber == null ? '' : accountNumber);
  if (text.length <= 2) return '*'.repeat(Math.max(text.length, 4));
  return '*'.repeat(Math.max(text.length - 2, 4)) + text.slice(-2);
}

module.exports = { createSandboxCrypto, maskAccountNumber };
