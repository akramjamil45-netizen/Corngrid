const jwt = require('jsonwebtoken');
const { isSameOriginRequest, readAuthCredential } = require('./session-cookie');

function isVerifiedValue(value) {
  // Missing column (legacy database) is handled by the caller as verified.
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

function createUserAuth({ db, jwtSecret }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_account_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      suspended_until INTEGER NOT NULL,
      reason TEXT,
      updated_at INTEGER NOT NULL
    )
  `, error => {
    if (error) console.error('Failed to initialize user account access checks:', error.message);
  });

  return function verifyToken(req, res, next) {
    const credential = readAuthCredential(req);
    const token = credential && credential.token;

    if (!token) {
      return res.status(401).json({ error: 'Access denied. Authentication token is required.' });
    }
    if (
      credential.source === 'cookie' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !isSameOriginRequest(req)
    ) {
      return res.status(403).json({ error: 'This request must come from the same site.' });
    }

    jwt.verify(token, jwtSecret, (error, user) => {
      if (error || !user || !Number.isSafeInteger(user.id) || user.id < 1) {
        return res.status(403).json({ error: 'Token is invalid or has expired.' });
      }

      const now = Date.now();
      const baseSql = `
        SELECT
          (SELECT version FROM user_auth_versions WHERE user_id = ?) AS auth_version,
          (SELECT id FROM users WHERE id = ?) AS account_id,
          (SELECT suspended_until FROM user_account_access WHERE user_id = ? AND suspended_until > ?) AS suspended_until
      `;
      // Session version, account existence, suspension, and email verification
      // are read in a single query. They used to be three sequential round
      // trips on the shared sqlite connection, which queued behind every EA
      // write. The unverified-account guard runs on every protected endpoint,
      // so a pending registration cannot bypass verification by calling the
      // API directly.
      const sqlWithVerification = `${baseSql},
          (SELECT email_verified FROM users WHERE id = ?) AS email_verified
      `;
      const legacySql = baseSql;
      const params = [user.id, user.id, user.id, now];

      const handleRow = (lookupError, row, checkedVerification) => {
        if (lookupError) {
          console.error('Failed to verify the authenticated session:', lookupError.message);
          return res.status(500).json({ error: 'Unable to verify this session.' });
        }
        const currentVersion = (row && row.auth_version) || 0;
        if ((user.authVersion || 0) !== currentVersion) {
          return res.status(403).json({ error: 'This session is no longer valid. Please sign in again.' });
        }
        if (!row || !row.account_id) {
          return res.status(403).json({ error: 'This account is no longer available.' });
        }
        if (checkedVerification && !isVerifiedValue(row.email_verified)) {
          return res.status(403).json({
            error: 'Please verify your email address before accessing the dashboard.',
            code: 'EMAIL_NOT_VERIFIED'
          });
        }
        if (row.suspended_until !== null && row.suspended_until !== undefined) {
          res.set('Retry-After', String(Math.max(1, Math.ceil((row.suspended_until - now) / 1000))));
          return res.status(403).json({
            error: 'This account is temporarily suspended. Contact CornGrid support for assistance.',
            suspendedUntil: row.suspended_until
          });
        }
        req.user = user;
        return next();
      };

      db.get(sqlWithVerification, [...params, user.id], (lookupError, row) => {
        if (
          lookupError &&
          typeof lookupError.message === 'string' &&
          (/no such column/i.test(lookupError.message) || /column .* does not exist/i.test(lookupError.message))
        ) {
          // A legacy schema without the additive column. Existing accounts are
          // treated as verified so a deploy does not lock them out before the
          // startup migration runs.
          return db.get(legacySql, params, (legacyError, legacyRow) => {
            handleRow(legacyError, legacyRow, false);
          });
        }
        return handleRow(lookupError, row, true);
      });
    });
  };
}

module.exports = createUserAuth;
