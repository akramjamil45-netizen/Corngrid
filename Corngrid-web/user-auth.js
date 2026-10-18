const jwt = require('jsonwebtoken');
const { isSameOriginRequest, readAuthCredential } = require('./session-cookie');

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
      db.get('SELECT version FROM user_auth_versions WHERE user_id = ?', [user.id], (versionError, record) => {
        if (versionError) {
          console.error('Failed to verify the session version:', versionError.message);
          return res.status(500).json({ error: 'Unable to verify this session.' });
        }
        const currentVersion = record ? record.version : 0;
        if ((user.authVersion || 0) !== currentVersion) {
          return res.status(403).json({ error: 'This session is no longer valid. Please sign in again.' });
        }
        db.get('SELECT id FROM users WHERE id = ?', [user.id], (userError, account) => {
          if (userError) {
            console.error('Failed to verify the authenticated user:', userError.message);
            return res.status(500).json({ error: 'Unable to verify this account.' });
          }
          if (!account) return res.status(403).json({ error: 'This account is no longer available.' });
          db.get(
            'SELECT suspended_until FROM user_account_access WHERE user_id = ? AND suspended_until > ?',
            [user.id, Date.now()],
            (accessError, suspension) => {
              if (accessError) {
                console.error('Failed to check account access status:', accessError.message);
                return res.status(500).json({ error: 'Unable to verify account access.' });
              }
              if (suspension) {
                res.set('Retry-After', String(Math.max(1, Math.ceil((suspension.suspended_until - Date.now()) / 1000))));
                return res.status(403).json({
                  error: 'This account is temporarily suspended. Contact CornGrid support for assistance.',
                  suspendedUntil: suspension.suspended_until
                });
              }
              req.user = user;
              return next();
            }
          );
        });
      });
    });
  };
}

module.exports = createUserAuth;
