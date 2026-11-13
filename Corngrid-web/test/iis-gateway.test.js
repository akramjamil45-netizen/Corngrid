'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createGateway, endToEndHeaders } = require('../service/iis-gateway');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('gateway isolates API, streams bodies and SSE, preserves auth/Origin and leaves static routing to IIS', async () => {
  const paths = [];
  const backend = http.createServer((req,res) => {
    paths.push(req.url);
    if (req.headers.cookie !== 'session=fixture' || req.headers.origin !== 'https://example.test') { res.writeHead(403); res.end('denied'); return; }
    if (req.url === '/api/market/stream') { res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write('data: first\n\n'); setTimeout(()=>res.end('data: last\n\n'),20); return; }
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({body,path:req.url,method:req.method}));});
  });
  const staticServer = http.createServer((req,res)=>res.end('static:'+req.url));
  const backendPort=await listen(backend),staticPort=await listen(staticServer),gateway=createGateway({backendPort,staticPort}),port=await listen(gateway.server),origin='http://127.0.0.1:'+port;
  try {
    const response=await fetch(origin+'/api/admin/sandbox/nodes/4/capacity',{method:'PATCH',headers:{Cookie:'session=fixture',Origin:'https://example.test','Content-Type':'application/json'},body:JSON.stringify({maxInstances:5,expectedMaxInstances:2})});
    assert.equal(response.status,200);const data=await response.json();assert.deepEqual(JSON.parse(data.body),{maxInstances:5,expectedMaxInstances:2});assert.equal(data.method,'PATCH');
    assert.equal((await fetch(origin+'/api/private')).status,403,'backend authorization remains authoritative');
    assert.equal(await fetch(origin+'/en/?lang=ms').then(r=>r.text()),'static:/en/?lang=ms');
    const sse=await fetch(origin+'/api/market/stream',{headers:{Cookie:'session=fixture',Origin:'https://example.test'}});assert.match(await sse.text(),/first[\s\S]*last/);
    assert.ok(!paths.includes('/en/?lang=ms'));
    const headers=endToEndHeaders({connection:'keep-alive, x-hop','x-hop':'remove',cookie:'preserve',origin:'https://example.test'});
    assert.equal(headers['x-hop'],undefined);assert.equal(headers.cookie,'preserve');assert.equal(headers.origin,'https://example.test');
  }finally{await gateway.close();await Promise.all([new Promise(r=>backend.close(r)),new Promise(r=>staticServer.close(r))]);}
});

test('gateway supports many simultaneous authenticated sockets without consuming static/IIS request slots', async () => {
  const backend=http.createServer((req,res)=>{if(req.headers.cookie!=='session=fixture'){res.writeHead(403);res.end();return;}res.end('api available');}),wss=new WebSocketServer({noServer:true});
  backend.on('upgrade',(req,socket,head)=>{
    if(req.headers.cookie!=='session=fixture'){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,client=>{client.on('message',message=>client.send(message));});
  });
  const backendPort=await listen(backend),gateway=createGateway({backendPort,staticPort:1}),port=await listen(gateway.server),clients=[];
  try{
    await Promise.all(Array.from({length:12},()=>new Promise((resolve,reject)=>{const ws=new WebSocket('ws://127.0.0.1:'+port+'/ws/admin/sandbox',{headers:{Cookie:'session=fixture'}});clients.push(ws);ws.once('open',()=>ws.send('fixture'));ws.once('message',msg=>{assert.equal(msg.toString(),'fixture');resolve();});ws.once('error',reject);})));assert.equal(clients.length,12);
    const response=await fetch('http://127.0.0.1:'+port+'/api/admin/sandbox/nodes/4/capacity',{method:'PATCH',headers:{Cookie:'session=fixture','Content-Type':'application/json'},body:'{"maxInstances":5}',signal:AbortSignal.timeout(1000)});
    assert.equal(response.status,200,'API writes remain available while 12 sockets occupy no IIS slots');
    assert.equal(await response.text(),'api available');
    await new Promise(resolve=>{const ws=new WebSocket('ws://127.0.0.1:'+port+'/ws/admin/sandbox');ws.once('error',()=>resolve());});
  }finally{for(const client of clients)client.terminate();await gateway.close();await new Promise(r=>wss.close(r));await new Promise(r=>backend.close(r));}
});

test('an unavailable upstream produces bounded safe errors and the gateway remains usable', async () => {
  const gateway=createGateway({backendPort:1,staticPort:1}),port=await listen(gateway.server);
  try{const r=await fetch('http://127.0.0.1:'+port+'/api/test');assert.equal(r.status,502);assert.match((await r.json()).error,/temporarily unavailable/);}finally{await gateway.close();}
});

test('gateway preserves raw webhook/upload bytes and multiple response cookies', async () => {
  const backend=http.createServer((req,res)=>{
    const parts=[];req.on('data',chunk=>parts.push(chunk));req.on('end',()=>{
      res.setHeader('Set-Cookie',['one=fixture; HttpOnly','two=fixture; Secure']);
      res.end(crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
    });
  });
  const backendPort=await listen(backend),gateway=createGateway({backendPort,staticPort:1}),port=await listen(gateway.server);
  const raw=Buffer.concat([Buffer.from('{ "fixture": "raw UTF-8 🌽" }\n'),Buffer.from([0,1,2,255])]);
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:raw});
    assert.equal(await response.text(),crypto.createHash('sha256').update(raw).digest('hex'));
    assert.equal(response.headers.getSetCookie().length,2);
  }finally{await gateway.close();await new Promise(resolve=>backend.close(resolve));}
});
