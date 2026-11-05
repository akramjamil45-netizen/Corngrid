'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../Corngrid-web/public');
http.createServer((req, res) => {
  const file = req.url.split('?')[0];
  if (file === '/dashboard.css') {
    res.setHeader('Content-Type', 'text/css');
    return res.end(fs.readFileSync(path.join(root, 'dashboard.css')));
  }
  if (file !== '/') { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, match => match.includes('dashboard.css') ? match : ''));
}).listen(4318, '127.0.0.1', () => console.log('Overview preview: http://127.0.0.1:4318'));
