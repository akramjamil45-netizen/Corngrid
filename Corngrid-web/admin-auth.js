const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { isSameOriginRequest, readAuthCredential } = require('./session-cookie');

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function createAdminAuth({ email, passwordHash, jwtSecret }) {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedHash = typeof passwordHash === 'string' ? passwordHash.trim() : '';

  if (Boolean(normalizedEmail) !== Boolean(normalizedHash)) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD_HASH must both be configured.');
  }
  if (normalizedEmail && !BCRYPT_HASH_PATTERN.test(normalizedHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a valid bcrypt hash.');
  }
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('ADMIN_EMAIL must be a valid email address.');
  }

  const enabled = Boolean(normalizedEmail);
  const adminVersion = enabled
    ? crypto.createHash('sha256').update(`${normalizedEmail}\0${normalizedHash}`).digest('hex')
    : '';
  const matchesEmail = value => enabled && typeof value === 'string' && value.trim().toLowerCase() === normalizedEmail;

  return {
    isConfigured: enabled,
    matchesEmail,
    async authenticate(value, password, expiresIn = '30d') {
      if (!matchesEmail(value) || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72) {
        return null;
      }
      if (!(await bcrypt.compare(password, normalizedHash))) return null;
      return jwt.sign(
        { sub: 'admin', role: 'admin', adminVersion },
        jwtSecret,
        { expiresIn }
      );
    },
    verifyToken(req, res, next) {
      const credential = readAuthCredential(req);
      const token = credential && credential.token;
      if (!token) return res.status(401).json({ error: 'Administrator authentication is required.' });
      if (
        credential.source === 'cookie' &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        !isSameOriginRequest(req)
      ) {
        return res.status(403).json({ error: 'This request must come from the same site.' });
      }

      jwt.verify(token, jwtSecret, (error, claims) => {
        if (
          error ||
          !enabled ||
          claims?.sub !== 'admin' ||
          claims?.role !== 'admin' ||
          claims?.adminVersion !== adminVersion
        ) {
          return res.status(403).json({ error: 'Administrator session is invalid or has expired.' });
        }
        req.admin = true;
        return next();
      });
    }
  };
}

module.exports = createAdminAuth;
