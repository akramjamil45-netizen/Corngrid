'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../Corngrid-web/public');
http.createServer((req, res) => {
  const file = req.url.split('?')[0];
  const allowed = { '/admin.css': 'text/css', '/dashboard.css': 'text/css', '/admin-sandbox.js': 'text/javascript' };
  if (allowed[file]) { res.setHeader('Content-Type', allowed[file]); return res.end(fs.readFileSync(path.join(root, file.slice(1)))); }
  if (file !== '/') { res.writeHead(404); return res.end(); }
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, match => /(?:admin|dashboard)\.css/.test(match) ? match : '')
    .replace('</body>', '<script src="/admin-sandbox.js"></script></body>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');res.end(html);
}).on('upgrade', (_req, socket) => socket.destroy()).listen(4319, '127.0.0.1', () => console.log('Node capacity preview: http://127.0.0.1:4319'));
