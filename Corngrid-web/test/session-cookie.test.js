const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  AUTH_COOKIE_NAME,
  clearAuthCookie,
  isSameOriginRequest,
  readAuthCredential,
  setAuthCookie
} = require('../session-cookie');

test('reads bearer tokens and HttpOnly cookie credentials', () => {
  assert.deepEqual(
    readAuthCredential({ headers: { authorization: 'Bearer existing-token', cookie: `${AUTH_COOKIE_NAME}=cookie-token` } }),
    { token: 'existing-token', source: 'bearer' }
  );
  assert.deepEqual(
    readAuthCredential({ headers: { cookie: `theme=dark; ${AUTH_COOKIE_NAME}=cookie.token.value` } }),
    { token: 'cookie.token.value', source: 'cookie' }
  );
  assert.equal(readAuthCredential({ headers: {} }), null);
});

test('auth cookies are HttpOnly, same-site and scoped to the site', () => {
  let cookie;
  let cookieOptions;
  setAuthCookie({
    cookie(name, value, options) {
      cookie = { name, value };
      cookieOptions = options;
    }
  }, 'signed-token');

  assert.deepEqual(cookie, { name: AUTH_COOKIE_NAME, value: 'signed-token' });
  assert.equal(cookieOptions.httpOnly, true);
  assert.equal(cookieOptions.secure, process.env.NODE_ENV === 'production');
  assert.equal(cookieOptions.sameSite, 'lax');
  assert.equal(cookieOptions.path, '/');
  assert.equal(cookieOptions.maxAge, 2 * 60 * 60 * 1000);

  let clearedCookie;
  clearAuthCookie({
    clearCookie(name, options) {
      clearedCookie = { name, options };
    }
  });
  assert.equal(clearedCookie.name, AUTH_COOKIE_NAME);
  assert.equal(clearedCookie.options.httpOnly, true);
  assert.equal(clearedCookie.options.path, '/');
});

test('cookie-authenticated writes require a same-origin browser request', () => {
  assert.equal(
    isSameOriginRequest({ headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }),
    process.env.NODE_ENV !== 'production'
  );
  assert.equal(
    isSameOriginRequest({ headers: { origin: 'https://corngrid.com', host: 'corngrid.com' } }),
    process.env.NODE_ENV === 'production'
  );
  assert.equal(
    isSameOriginRequest({ headers: { origin: 'https://attacker.example', host: 'corngrid.com' } }),
    false
  );
  assert.equal(isSameOriginRequest({ headers: { host: 'corngrid.com' } }), false);
});

test('configured HTTPS origin supports secure cookie login behind a development proxy', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.NODE_ENV = 'development';
  process.env.APP_BASE_URL = 'https://corngrid.com';

  try {
    const req = {
      headers: {
        origin: 'https://corngrid.com',
        host: '127.0.0.1:3000'
      }
    };
    let cookieOptions;
    setAuthCookie({
      cookie(_name, _value, options) {
        cookieOptions = options;
      }
    }, 'signed-token', req);

    assert.equal(isSameOriginRequest(req), true);
    assert.equal(cookieOptions.secure, true);

    let clearOptions;
    clearAuthCookie({
      clearCookie(_name, options) {
        clearOptions = options;
      }
    }, req);
    assert.equal(clearOptions.secure, true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});
