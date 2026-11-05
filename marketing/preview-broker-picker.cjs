const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../Corngrid-web/public');
http.createServer((req,res) => {
  const file = req.url.split('?')[0];
  const types = {'/dashboard.css':'text/css','/sandbox.js':'text/javascript','/mt5-brokers.json':'application/json'};
  if (types[file]) { res.setHeader('Content-Type',types[file]); return res.end(fs.readFileSync(path.join(root,file.slice(1)))); }
  if (file !== '/') { res.writeHead(404); return res.end(); }
  const html = fs.readFileSync(path.join(root,'dashboard.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi, m => /dashboard\.css/.test(m) ? m : '').replace('</body>','<script src="/sandbox.js"></script><script>document.querySelectorAll(".page").forEach(p=>p.hidden=true); const p=document.getElementById("page-sandbox");p.hidden=false;p.style.display="block";CornGridSandbox.onOpen();</script></body>');
  res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html);
}).listen(4320,'127.0.0.1',()=>console.log('Broker preview http://127.0.0.1:4320'));
