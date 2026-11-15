'use strict';

// Realtime hub for the sandbox system.
//
// Two WebSocket endpoints share one `ws` server attached to the HTTP server:
//
//   /ws/sandbox/node   — Windows Sandbox Agents. The agent authenticates with
//                        its node credentials in the first message, then sends
//                        heartbeats and receives commands instantly. HTTPS
//                        polling (sandbox-node-api.js) remains as fallback.
//
//   /ws/admin/sandbox  — Admin dashboards. Authenticated with the admin JWT
//                        (query param, since browsers cannot set WS headers).
//                        Receives every sandbox event plus periodic snapshots.

const { WebSocketServer } = require('ws');
const { readAuthCredential, isSameOriginRequest } = require('../session-cookie');

const NODE_AUTH_TIMEOUT_MS = 5000;
const ADMIN_SNAPSHOT_INTERVAL_MS = 15000;

function createSandboxRealtime({ db, nodes, events, adminAuth } = {}) {
  let wss = null;
  const adminSockets = new Map();

  function get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
    });
  }

  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
    });
  }

  function send(socket, message) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        console.error('WebSocket send failed:', error.message);
      }
    }
  }

  async function validAdmin(token) {
    try{return adminAuth?.verifyRealtimeSession?await adminAuth.verifyRealtimeSession(token):adminAuth?.verifySessionToken?.(token);}catch{return null;}
  }
  async function broadcastAdmins(message) {
    for (const [socket, token] of adminSockets) {
      if (!await validAdmin(token)) {
        adminSockets.delete(socket);
        socket.close(4003, 'Administrator session expired');
      } else {
        send(socket, message);
      }
    }
  }

  // Push every persisted sandbox event to connected admin dashboards.
  events.subscribe(record => {
    broadcastAdmins({ type: 'event', event: record }).catch(()=>{});
  });

  async function adminSnapshot() {
    const [nodeStats] = await all(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' AND last_heartbeat_at >= ? THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN status = 'active' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?) THEN 1 ELSE 0 END) AS offline,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
      FROM sandbox_nodes
    `, [Date.now() - nodes.NODE_OFFLINE_AFTER_MS, Date.now() - nodes.NODE_OFFLINE_AFTER_MS]);
    const [instanceStats] = await all(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('deploying','starting','allocating','requested') THEN 1 ELSE 0 END) AS pending
      FROM sandbox_instances WHERE deleted_at IS NULL
    `);
    const nodeList = await all(`
      SELECT n.id, n.node_uid, n.name, n.status, n.is_test_node, n.os_version, n.cpu_percent, n.memory_used_mb, n.ram_mb,
             n.disk_free_mb, n.running_instances, n.max_instances, n.last_heartbeat_at, n.agent_version,
             (SELECT COUNT(*) FROM sandbox_instances i WHERE i.node_id = n.id AND i.deleted_at IS NULL
               AND i.status IN ('requested','allocating','deploying','starting','running','stopping')) AS allocated_instances
      FROM sandbox_nodes n ORDER BY n.id ASC
    `);
    return {
      type: 'snapshot',
      stats: {
        nodes: {
          total: Number(nodeStats && nodeStats.total) || 0,
          online: Number(nodeStats && nodeStats.online) || 0,
          offline: Number(nodeStats && nodeStats.offline) || 0,
          disabled: Number(nodeStats && nodeStats.disabled) || 0
        },
        instances: {
          total: Number(instanceStats && instanceStats.total) || 0,
          running: Number(instanceStats && instanceStats.running) || 0,
          stopped: Number(instanceStats && instanceStats.stopped) || 0,
          failed: Number(instanceStats && instanceStats.failed) || 0,
          pending: Number(instanceStats && instanceStats.pending) || 0
        }
      },
      nodes: nodeList.map(node => ({
        ...node,
        placement:require('./node-admission').nodeAdmission(node,Number(node.allocated_instances)||0,nodes.admissionPolicy),
        online: Boolean(node.last_heartbeat_at && (Date.now() - node.last_heartbeat_at) < nodes.NODE_OFFLINE_AFTER_MS)
      })),
      serverTime: Date.now()
    };
  }

  function handleNodeConnection(socket, req) {
    let node = null;
    let authenticated = false;
    let nodeToken = '';

    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4001, 'Authentication timeout');
    }, NODE_AUTH_TIMEOUT_MS);

    socket.on('message', async raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (_error) {
        return;
      }

      if (!authenticated) {
        if (message.type !== 'auth' || !message.nodeUid || !message.token) {
          socket.close(4003, 'Authentication required');
          return;
        }
        if(process.env.CORNGRID_STAGING==='true'&&(!process.env.STAGING_DEMO_NODE_UID||message.nodeUid!==process.env.STAGING_DEMO_NODE_UID)){
          socket.close(4003,'Only the staging demo node may connect');return;
        }
        try {
          nodeToken = String(message.token);
          node = await nodes.authenticateNode(String(message.nodeUid), nodeToken);
        } catch (error) {
          console.error('Node WS authentication failed:', error.message);
          socket.close(1011, 'Server error');
          return;
        }
        if (!node) {
          socket.close(4003, 'Invalid node credentials');
          return;
        }
        if (socket.readyState !== socket.OPEN) return;
        authenticated = true;
        clearTimeout(authTimer);
        nodes.attachConnection(node.id, socket, node.auth_token_hash);
        send(socket, { type: 'authenticated', nodeUid: node.node_uid, serverTime: Date.now() });
        // Deliver anything queued while the agent was offline.
        const queued = await nodes.pendingCommands(node.id).catch(() => []);
        for (const command of queued) {
          if (!await nodes.authenticateNode(node.node_uid, nodeToken)) {
            nodes.detachConnection(node.id, socket);
            socket.close(4003, 'Node credentials revoked');
            return;
          }
          send(socket, { type: 'command', ...command });
        }
        return;
      }

      // Apply the same current-token policy as every authenticated HTTP request.
      try {
        const currentNode = await nodes.authenticateNode(node.node_uid, nodeToken);
        if (!currentNode) {
          nodes.detachConnection(node.id, socket);
          socket.close(4003, 'Node credentials revoked');
          return;
        }
        node = currentNode;
      } catch (error) {
        nodes.detachConnection(node.id, socket);
        socket.close(1011, 'Unable to verify node credentials');
        return;
      }

      if (message.type === 'heartbeat') {
        try {
          await nodes.recordHeartbeat(node, {
            agentVersion: message.agentVersion,
            machineName: message.machineName,
            osVersion: message.osVersion,
            cpuCount: message.cpuCount,
            ramMb: message.ramMb,
            diskFreeMb: message.diskFreeMb,
            cpuPercent: message.cpuPercent,
            memoryUsedMb: message.memoryUsedMb,
            runningInstances: message.runningInstances,
            instances: Array.isArray(message.instances) ? message.instances : [],
            ip: req.socket && req.socket.remoteAddress
          });
          send(socket, { type: 'heartbeat_ack', serverTime: Date.now() });
        } catch (error) {
          console.error('WS heartbeat processing failed:', error.message);
        }
      } else if (message.type === 'command_result') {
        try {
          await nodes.completeCommand(node.id, String(message.commandUid || ''), {
            success: message.success === true,
            result: message.result && typeof message.result === 'object' ? message.result : null,
            error: message.error == null ? null : String(message.error).slice(0, 1000)
          });
        } catch (error) {
          console.error('WS command result failed:', error.message);
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (node) nodes.detachConnection(node.id, socket);
    });
    socket.on('error', () => {
      clearTimeout(authTimer);
      if (node) nodes.detachConnection(node.id, socket);
    });
  }

  async function handleAdminConnection(socket, req) {
    // The browser sends the HttpOnly session cookie with the WS handshake, so
    // the admin JWT is read from the same credential sources as the HTTP API.
    // A query-string token remains as a fallback for non-browser tooling.
    const url = new URL(req.url, 'http://localhost');
    const credential = readAuthCredential(req);
    const token = (credential && credential.token) || url.searchParams.get('token') || '';
    if ((credential?.source === 'cookie' && !isSameOriginRequest(req)) || !await validAdmin(token)) {
      socket.close(4003, 'Admin authentication required');
      return;
    }
    adminSockets.set(socket, token);
    adminSnapshot()
      .then(async snapshot => {
        if (await validAdmin(token)) send(socket, snapshot);
        else { adminSockets.delete(socket); socket.close(4003, 'Administrator session expired'); }
      })
      .catch(error => console.error('Admin snapshot failed:', error.message));

    socket.on('close', () => adminSockets.delete(socket));
    socket.on('error', () => adminSockets.delete(socket));
  }

  function attach(server) {
    wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/ws/sandbox/node') {
        wss.handleUpgrade(req, socket, head, ws => handleNodeConnection(ws, req));
      } else if (url.pathname === '/ws/admin/sandbox') {
        wss.handleUpgrade(req, socket, head, ws => handleAdminConnection(ws, req).catch(()=>ws.close(1011,'Security verification unavailable')));
      }
      // Unknown upgrade paths are ignored so other tooling keeps working.
    });

    // Periodic admin snapshot broadcast.
    const interval = setInterval(async () => {
      if (!adminSockets.size) return;
      try {
        await broadcastAdmins(await adminSnapshot());
      } catch (error) {
        console.error('Admin snapshot broadcast failed:', error.message);
      }
    }, ADMIN_SNAPSHOT_INTERVAL_MS);
    interval.unref();

    // Periodic offline-node detection.
    const offlineInterval = setInterval(() => {
      nodes.markOfflineNodes().catch(error => console.error('Offline node sweep failed:', error.message));
    }, 30000);
    offlineInterval.unref();
  }

  return { attach, broadcastAdmins, adminSnapshot };
}

module.exports = { createSandboxRealtime };
