'use strict';

// Backend transport: WebSocket primary, HTTPS polling fallback.
//
// The agent only ever makes OUTBOUND connections, so the node needs no
// inbound firewall rules. If the WebSocket drops (proxy timeout, network
// interruption), heartbeats and command polling continue over HTTPS while the
// socket reconnects with exponential backoff.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');

function createTransport({ config, onCommand, onOpen, onClose }) {
  let socket = null;
  let reconnectDelay = config.reconnectMinMs;
  let reconnectTimer = null;
  let stopped = false;
  let authenticated = false;
  let watchdog = null;
  let lastPong = 0;

  // -------------------------------------------------------------------------
  // HTTPS helpers (fallback channel + file download)
  // -------------------------------------------------------------------------
  function httpRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(config.backendUrl + path);
      const client = url.protocol === 'https:' ? https : http;
      const payload = body ? JSON.stringify(body) : null;
      const req = client.request({
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'X-Node-Id': config.nodeUid,
          'X-Node-Token': config.nodeToken,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: 30000
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* non-JSON */ }
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${(json && json.error) || text.slice(0, 200)}`));
          }
          resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error('Request timed out.')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function downloadFile(path, targetPath) {
    return new Promise((resolve, reject) => {
      const url = new URL(config.backendUrl + path);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: { 'X-Node-Id': config.nodeUid, 'X-Node-Token': config.nodeToken },
        timeout: 120000
      }, res => {
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
        }
        const fs = require('fs');
        const out = fs.createWriteStream(targetPath);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Download timed out.')));
      req.on('error', reject);
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket channel
  // -------------------------------------------------------------------------
  function wsSend(message) {
    if (authenticated && socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch (_error) {
        return false;
      }
    }
    return false;
  }

  function connect() {
    if (stopped) return;
    try {
      socket = new WebSocket(config.wsUrl, { handshakeTimeout: 15000 });
    } catch (_error) {
      scheduleReconnect();
      return;
    }

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'auth', nodeUid: config.nodeUid, token: config.nodeToken }));
      lastPong = Date.now();
      watchdog = setInterval(() => {
        if (!socket) return;
        if (Date.now() - lastPong > 60000) return socket.terminate();
        socket.ping();
      }, 15000);
    });
    socket.on('pong', () => { lastPong = Date.now(); });

    socket.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (_error) {
        return;
      }
      if (message.type === 'authenticated') {
        authenticated = true;
        reconnectDelay = config.reconnectMinMs;
        if (onOpen) onOpen();
      } else if (message.type === 'command') {
        if (onCommand) onCommand(message, 'ws');
      }
    });

    socket.on('close', () => {
      authenticated = false;
      clearInterval(watchdog);
      socket = null;
      if (onClose) onClose();
      scheduleReconnect();
    });

    socket.on('error', () => {
      // 'close' follows and handles the reconnect.
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(config.reconnectMaxMs, reconnectDelay * 2);
      connect();
    }, reconnectDelay);
  }

  // -------------------------------------------------------------------------
  // Unified senders: WS first, HTTPS fallback.
  // -------------------------------------------------------------------------
  async function sendHeartbeat(payload) {
    if (wsSend({ type: 'heartbeat', ...payload })) return { channel: 'ws' };
    const response = await httpRequest('POST', '/api/sandbox/node/heartbeat', payload);
    // Commands piggy-back on the HTTPS heartbeat response.
    if (response && Array.isArray(response.commands)) {
      for (const command of response.commands) {
        if (onCommand) onCommand(command, 'http');
      }
    }
    return { channel: 'http' };
  }

  async function sendCommandResult(commandUid, outcome) {
    const message = { type: 'command_result', commandUid, ...outcome };
    if (wsSend(message)) return;
    await httpRequest('POST', `/api/sandbox/node/commands/${encodeURIComponent(commandUid)}/result`, outcome);
  }

  async function sendLogs(entries) {
    if (!entries.length) return;
    await httpRequest('POST', '/api/sandbox/node/logs', { entries });
  }

  function start() {
    connect();
  }

  function stop() {
    stopped = true;
    authenticated = false;
    clearInterval(watchdog);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
  }

  return { start, stop, sendHeartbeat, sendCommandResult, sendLogs, downloadFile, httpRequest };
}

module.exports = { createTransport };
