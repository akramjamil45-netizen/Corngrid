'use strict';
// Fixed loopback gateway: operational traffic goes directly to Express; IIS
// handles static/marketing routes without holding long-lived API/WS requests.
const http = require('node:http');
const net = require('node:net');

const HOP_HEADERS = ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'];
function endToEndHeaders(input) {
  const headers = { ...input };
  for (const name of String(headers.connection || '').split(',')) delete headers[name.trim().toLowerCase()];
  for (const name of HOP_HEADERS) delete headers[name];
  return headers;
}
function createGateway({ backendPort = 3000, staticPort = 18080 } = {}) {
  for (const port of [backendPort, staticPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid fixed target port');
  const sockets = new Set();
  const apiAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 8 });
  // Windows client IIS has a low concurrent-request quota. Static files should
  // not flood it either; API/SSE traffic has a separate pool and target.
  const staticAgent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
    const operational = /^\/(?:api|ws)(?:\/|\?|$)/i.test(req.url);
    const upstream = http.request({ hostname: '127.0.0.1', port: operational ? backendPort : staticPort,
      method: req.method, path: req.url, headers: endToEndHeaders(req.headers), agent: operational ? apiAgent : staticAgent
    }, response => {
      res.writeHead(response.statusCode, endToEndHeaders(response.headers));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(502, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end('{"error":"Service temporarily unavailable. Please retry."}'); }
      else res.destroy();
    });
    // SSE has intentional long idle periods. Other upstream calls have a
    // bounded socket deadline; application validation/auth remains in Express.
    upstream.setTimeout(/^\/api\/market\/stream(?:\?|$)/i.test(req.url) ? 0 : 30000, () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (req, client, head) => {
    if (!/^\/ws\//.test(req.url)) { client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    // Forward the handshake and every byte directly. The existing backend
    // validates admin cookies, Origin, node tokens and socket message roles.
    const upstream = net.connect({ host: '127.0.0.1', port: backendPort });
    sockets.add(upstream); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i=0; i<req.rawHeaders.length; i+=2) lines.push(req.rawHeaders[i]+': '+req.rawHeaders[i+1]);
      upstream.write(lines.join('\r\n')+'\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
  });
  function close() {
    apiAgent.destroy(); staticAgent.destroy(); for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  }
  return { server, close };
}
if (require.main === module) {
  const gateway = createGateway();
  gateway.server.listen(8080, '127.0.0.1', () => console.log('CornGrid loopback gateway ready.'));
  gateway.server.on('error', error => { console.error('Gateway listener failed:', error.code || 'ERROR'); process.exit(1); });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => gateway.close().finally(() => process.exit(0)));
}
module.exports = { createGateway, endToEndHeaders };
