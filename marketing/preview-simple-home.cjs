const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=process.cwd();
http.createServer((req,res)=>{
 let route=decodeURIComponent(req.url.split('?')[0]);if(route==='/')route='/index.html';if(route==='/en/')route='/en/index.html';
 const allowed=['/index.html','/en/index.html','/mystyle.css','/infrastructure.css','/site.js','/cookie-consent.js','/cookie-consent.css','/locales/en.json','/locales/ms.json'];
 if(!allowed.includes(route)&&!route.startsWith('/images/')){res.writeHead(404);return res.end();}
 const target=path.resolve(root,'.'+route);
 if(!target.startsWith(root+path.sep)||!fs.existsSync(target)){res.writeHead(404);return res.end();}
 const types={'.css':'text/css','.js':'text/javascript','.json':'application/json','.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg'};
 res.setHeader('Content-Type',types[path.extname(route)]||'application/octet-stream');res.end(fs.readFileSync(target));
}).listen(4328,'127.0.0.1',()=>console.log('Homepage review http://127.0.0.1:4328'));
