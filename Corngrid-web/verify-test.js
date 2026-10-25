const http = require('http');
const BASE = 'http://localhost:3000';

function req(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${p}`, { method, headers }, (res) => {
      let c = ''; res.on('data', d => c += d); res.on('end', () => {
        let b = c; try { b = JSON.parse(c); } catch (e) {}
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p, t) => req('GET', p, null, t);
const post = (p, b, t) => req('POST', p, b, t);
const patch = (p, b, t) => req('PATCH', p, b, t);

(async () => {
  const r = [];
  const ts = Date.now();
  const reg = await post('/api/register', { username: `v${ts}`, email: `v${ts}@t.com`, password: 'TestPass123!' });
  r.push(`[${reg.status}] POST /api/register`);
  const login = await post('/api/login', { email: `v${ts}@t.com`, password: 'TestPass123!' });
  const token = login.body?.token;
  r.push(`[${login.status}] POST /api/login -> ${token ? 'token OK' : 'NO TOKEN'}`);

  const feed = await get('/api/feed?filter=latest&limit=10', token);
  r.push(`[${feed.status}] GET /api/feed (auth)`);

  const accounts = await get('/api/mt5/accounts', token);
  r.push(`[${accounts.status}] GET /api/mt5/accounts (auth)`);

  const ps = await get('/api/user/portfolio-sharing', token);
  r.push(`[${ps.status}] GET /api/user/portfolio-sharing (auth)`);

  const pp = await patch('/api/user/portfolio-sharing', { isPublic: false, accountIds: [] }, token);
  r.push(`[${pp.status}] PATCH /api/user/portfolio-sharing (auth)`);

  const fna = await get('/api/feed?filter=latest&limit=10');
  r.push(`[${fna.status}] GET /api/feed (no auth)`);

  const ana = await get('/api/mt5/accounts');
  r.push(`[${ana.status}] GET /api/mt5/accounts (no auth)`);

  const pna = await get('/api/user/portfolio-sharing');
  r.push(`[${pna.status}] GET /api/user/portfolio-sharing (no auth)`);

  console.log('═══ VERIFICATION RESULTS ═══');
  r.forEach((x, i) => console.log(`${i+1}. ${x}`));
  const fails = r.filter(x => x.includes('[500]'));
  console.log(fails.length === 0 ? '✅ NO 500 ERRORS' : `❌ ${fails.length} 500 ERRORS:\n${fails.join('\n')}`);
})();
