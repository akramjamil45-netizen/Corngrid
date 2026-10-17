const AUTH_COOKIE_NAME = 'corngrid_session';
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000;

function secureCookies(req) {
  if (process.env.NODE_ENV === 'production') return true;
  if (!req || typeof req.headers.origin !== 'string' || !process.env.APP_BASE_URL) return false;

  try {
    const publicUrl = new URL(process.env.APP_BASE_URL);
    return publicUrl.protocol === 'https:' && new URL(req.headers.origin).origin === publicUrl.origin;
  } catch {
    return false;
  }
}

function readAuthCredential(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return { token, source: 'bearer' };
  }

  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== AUTH_COOKIE_NAME) continue;
    const token = part.slice(separator + 1).trim();
    if (token) return { token, source: 'cookie' };
  }
  return null;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;

  try {
    const parsedOrigin = new URL(origin);
    const useSecureOrigin = secureCookies(req);
    const expectedProtocol = useSecureOrigin ? 'https:' : 'http:';
    const forwardedHost = req.headers['x-forwarded-host'];
    const expectedHost = useSecureOrigin && process.env.APP_BASE_URL
      ? new URL(process.env.APP_BASE_URL).host
      : typeof forwardedHost === 'string'
        ? forwardedHost.split(',')[0].trim()
        : host;
    return parsedOrigin.protocol === expectedProtocol && parsedOrigin.host === expectedHost;
  } catch {
    return false;
  }
}

function setAuthCookie(res, token, req) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_MS
  });
}

function clearAuthCookie(res, req) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/'
  });
}

module.exports = {
  AUTH_COOKIE_NAME,
  clearAuthCookie,
  isSameOriginRequest,
  readAuthCredential,
  setAuthCookie
};
