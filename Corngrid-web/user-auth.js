const jwt = require('jsonwebtoken');
const { isSameOriginRequest, readAuthCredential } = require('./session-cookie');

function createUserAuth({ db, jwtSecret }) {
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
        req.user = user;
        return next();
      });
    });
  };
}

module.exports = createUserAuth;
