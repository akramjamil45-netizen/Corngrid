'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { dbGet } = require('./db-async');
const {accountArchived}=require('./account-archive');

function defaultIsEmailVerified(user) {
  if (!user) return false;
  const value = user.email_verified;
  if (value === undefined || value === null) return true;
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

// Extracted from server.js so the login path (including the unverified-account
// guard) can be integration-tested without booting the whole application.
function createLoginHandler({
  db,
  jwtSecret,
  adminAuth,
  mfa,
  setAuthCookie,
  isSameOriginRequest,
  isEmailVerified = defaultIsEmailVerified,
  maskEmail = () => '',
  logger = console
}) {
  if (!db) throw new Error('createLoginHandler requires a database connection.');
  if (!jwtSecret) throw new Error('createLoginHandler requires a JWT secret.');
  if (!adminAuth) throw new Error('createLoginHandler requires adminAuth.');

  return async function loginHandler(req, res) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = req.body?.password;

    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Please enter your email and password.' });
    }

    const rememberMe = req.body && req.body.rememberMe !== false;
    const tokenDuration = rememberMe ? '30d' : '1d';
    const cookieDuration = rememberMe ? (30 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);

    if (adminAuth.matchesEmail(email)) {
      try {
        const token = await adminAuth.authenticate(email, password, tokenDuration, req.body?.mfaCode);
        if (!token) return res.status(400).json({ error: 'Email or password is incorrect.' });
        if (isSameOriginRequest(req)) setAuthCookie(res, token, req, cookieDuration);
        return res.json({
          message: 'Login successful!',
          token,
          user: { role: 'admin', username: 'Administrator' }
        });
      } catch (error) {
        if(/^MFA_/.test(error.code||''))return res.status(error.code==='MFA_RATE_LIMITED'?429:403).json({error:'Enter a current authenticator code or an unused recovery code. Wait for the next code if one was already used.',code:error.code});
        logger.error('Failed to verify administrator credentials:', error.message);
        return res.status(500).json({ error: 'Error occurred while verifying credentials.' });
      }
    }

    let user;
    try {
      // Bind the session version to the password snapshot being verified. A
      // concurrent reset must never stamp an old-password login with its new version.
      user = await dbGet(db, `SELECT users.*,
        COALESCE((SELECT version FROM user_auth_versions WHERE user_id = users.id), 0) AS login_auth_version
        FROM users WHERE email = ? COLLATE NOCASE`, [email]);
    } catch (error) {
      logger.error('Failed to search for account:', error.message);
      return res.status(500).json({ error: 'Server error during login.' });
    }
    if (!user) {
      return res.status(400).json({ error: 'Email or password is incorrect.' });
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Email or password is incorrect.' });
    }

    let isMatch;
    try {
      isMatch = await bcrypt.compare(password, user.password);
    } catch (error) {
      logger.error('Failed to verify password:', error.message);
      return res.status(500).json({ error: 'Error occurred while verifying password.' });
    }
    if (!isMatch) {
      return res.status(400).json({ error: 'Email or password is incorrect.' });
    }

    try{if(await accountArchived(db,user.id))return res.status(403).json({error:'This account is archived. Contact CornGrid support.',code:'ACCOUNT_ARCHIVED'});}catch{return res.status(503).json({error:'Account access checks are unavailable.'});}
    if (!isEmailVerified(user)) {
      // Only returned after the correct password is supplied, so it does not
      // disclose whether an address is registered to an anonymous caller.
      return res.status(403).json({
        error: 'Please verify your email address before signing in.',
        code: 'EMAIL_NOT_VERIFIED',
        emailMasked: maskEmail(user.email)
      });
    }

    try {
      const authVersion = user.login_auth_version;
      const proof=mfa?await mfa.authenticate('user:'+user.id,req.body?.mfaCode):null;
      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, authVersion, ...(proof?{mfaVersion:proof.version}:{}) },
        jwtSecret,
        { expiresIn: tokenDuration }
      );

      if (isSameOriginRequest(req)) setAuthCookie(res, token, req, cookieDuration);
      return res.json({
        message: 'Login successful!',
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          bio: user.bio
        }
      });
    } catch (error) {
      if(/^MFA_/.test(error.code||''))return res.status(error.code==='MFA_RATE_LIMITED'?429:403).json({error:'Enter a current authenticator code or an unused recovery code. Wait for the next code if one was already used.',code:error.code});
      logger.error('Failed to create the login session:', error.message);
      return res.status(500).json({ error: 'Server error during login.' });
    }
  };
}

module.exports = createLoginHandler;
module.exports.defaultIsEmailVerified = defaultIsEmailVerified;
