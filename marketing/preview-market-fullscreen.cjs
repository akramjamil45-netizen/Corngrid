const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../Corngrid-web/public');
http.createServer((req,res)=>{
 const route=req.url.split('?')[0];
 const assets={'/dashboard.css':'text/css','/market.js':'text/javascript','/vendor/lightweight-charts.standalone.production.js':'text/javascript'};
 if(assets[route]){res.setHeader('Content-Type',assets[route]);return res.end(fs.readFileSync(path.join(root,route.slice(1))));}
 if(route!=='/'){res.writeHead(404);return res.end();}
 let html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,m=>m.includes('dashboard.css')?m:'');
 html=html.replace('</body>','<script src="/vendor/lightweight-charts.standalone.production.js"></script><script src="/market.js"></script></body>');
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
}).listen(4321,'127.0.0.1',()=>console.log('Market preview http://127.0.0.1:4321'));
