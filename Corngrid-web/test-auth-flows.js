const http = require('http');

async function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request('http://localhost:3000' + path, {
      method,
      headers
    }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b, setCookie: r.headers['set-cookie'] }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== REGISTER ===');
  const reg = await request('POST', '/api/register', { username: 'autotest_user', email: 'autotest@test.com', password: 'TestPass123!' });
  console.log('Status:', reg.status);
  console.log('Body:', reg.body);
  console.log('Set-Cookie:', reg.setCookie);

  console.log('\n=== LOGIN (correct password) ===');
  const login = await request('POST', '/api/login', { email: 'autotest@test.com', password: 'TestPass123!' });
  console.log('Status:', login.status);
  console.log('Body:', login.body);
  console.log('Set-Cookie:', login.setCookie);

  let token = null;
  try { token = JSON.parse(login.body).token; } catch (e) { console.log('Token parse error:', e.message); }
  console.log('\n=== LOGIN (wrong password) ===');
  const loginWrong = await request('POST', '/api/login', { email: 'autotest@test.com', password: 'wrongpass' });
  console.log('Status:', loginWrong.status);
  console.log('Body:', loginWrong.body);

  console.log('\n=== /api/me (with token) ===');
  const req2 = await new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request('http://localhost:3000/api/me', { method: 'GET', headers }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });
  console.log('Status:', req2.status);
  console.log('Body:', req2.body);

  console.log('\n=== /api/me (no token) ===');
  const req3 = await new Promise((resolve, reject) => {
    const req = http.request('http://localhost:3000/api/me', { method: 'GET', headers: { 'Content-Type': 'application/json' } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });
  console.log('Status:', req3.status);
  console.log('Body:', req3.body);

  console.log('\n=== FORGOT PASSWORD ===');
  const forgot = await request('POST', '/api/forgot-password', { email: 'autotest@test.com' });
  console.log('Status:', forgot.status);
  console.log('Body:', forgot.body);

  console.log('\n=== LOGOUT ===');
  const logout = await request('POST', '/api/logout');
  console.log('Status:', logout.status);
  console.log('Body:', logout.body);
})().catch(e => console.error('ERR:', e.message));
