'use strict';
// One-use loopback bridge for the authorized browser check. It never prints or
// persists the short-lived admin cookie. Closed automatically after use/60s.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const modules = path.resolve(__dirname, '../Corngrid-web/node_modules');
const env = require(path.join(modules, 'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
const nonce = crypto.randomBytes(24).toString('hex');
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/' + nonce) { res.writeHead(404); res.end(); return; }
  const adminVersion = crypto.createHash('sha256').update(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
  const token = require(path.join(modules, 'jsonwebtoken')).sign({ sub:'admin', role:'admin', adminVersion }, env.JWT_SECRET, { expiresIn:'3m' });
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ name:'corngrid_session', value:token, domain:'corngrid.com', path:'/', httpOnly:true, secure:true, sameSite:'Lax' }));
  server.close(); clearTimeout(expiry);
});
const expiry = setTimeout(() => server.close(), 60000);
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ localBrowserBootstrap: 'http://127.0.0.1:'+server.address().port+'/'+nonce, expiresSeconds:60 })));
