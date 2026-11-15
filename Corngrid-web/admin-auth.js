const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { isSameOriginRequest, readAuthCredential } = require('./session-cookie');

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function createAdminAuth({ email, passwordHash, jwtSecret, mfa = () => null }) {
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
  const mfaSubject='admin:'+crypto.createHash('sha256').update(normalizedEmail).digest('hex');
  function verifySessionToken(token) {
    if (!enabled || typeof token !== 'string' || !token) return null;
    try {
      const claims = jwt.verify(token, jwtSecret);
      if (claims?.sub !== 'admin' || claims?.role !== 'admin' || claims?.adminVersion !== adminVersion) return null;
      return claims;
    } catch (_error) {
      return null;
    }
  }

  return {
    isConfigured: enabled,
    mfaSubject,
    checkPassword: async password => enabled&&typeof password==='string'&&Buffer.byteLength(password,'utf8')<=72&&await bcrypt.compare(password,normalizedHash),
    matchesEmail,
    verifySessionToken,
    async verifyRealtimeSession(token) {
      const claims=verifySessionToken(token);if(!claims)return null;
      try{return !mfa()||await mfa().sessionValid(mfaSubject,claims)?claims:null;}catch{return null;}
    },
    async authenticate(value, password, expiresIn = '30d', code) {
      if (!matchesEmail(value) || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72) {
        return null;
      }
      if (!(await bcrypt.compare(password, normalizedHash))) return null;
      const proof=mfa()?await mfa().authenticate(mfaSubject,code):null;
      return jwt.sign(
        { sub: 'admin', role: 'admin', adminVersion, ...(proof?{mfaVersion:proof.version}:{}) },
        jwtSecret,
        { expiresIn }
      );
    },
    async verifyToken(req, res, next) {
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

      const claims=verifySessionToken(token);
      if (!claims) {
        return res.status(403).json({ error: 'Administrator session is invalid or has expired.' });
      }
      try{if(mfa()&&!await mfa().sessionValid(mfaSubject,claims))return res.status(403).json({error:'Please sign in again to verify your security settings.',code:'MFA_SESSION_EXPIRED'});}
      catch{return res.status(503).json({error:'Security verification is temporarily unavailable.'});}
      req.admin = true;
      return next();
    }
  };
}

module.exports = createAdminAuth;
