'use strict';

// Sandbox node registry and command dispatch.
//
// Nodes are remote Windows machines running the CornGrid Sandbox Agent. They
// authenticate with a per-node bearer token (stored as a SHA-256 hash), send
// heartbeats with resource usage, and receive commands (deploy/start/stop/...)
// through a persistent WebSocket when connected, falling back to HTTPS polling
// of the queued rows in sandbox_deployments.

const crypto = require('crypto');

const NODE_OFFLINE_AFTER_MS = 90 * 1000;
const COMMAND_EXPIRE_AFTER_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSandboxNodes({ db, events, now = () => Date.now() } = {}) {
  // Live WebSocket connections keyed by node id, populated by sandbox-realtime.
  const liveConnections = new Map();
  // Last heartbeat timestamp keyed by node id (the DB row object goes stale).
  const lastHeartbeatByNode = new Map();

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
      });
    });
  }

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

  // -------------------------------------------------------------------------
  // Node registration & authentication
  // -------------------------------------------------------------------------

  async function createNode({ name, isTestNode = false, maxInstances = 10 }) {
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
      const error = new Error('Node name must be between 2 and 80 characters.');
      error.statusCode = 400;
      throw error;
    }
    const timestamp = now();
    const nodeUid = `node_${crypto.randomBytes(9).toString('hex')}`;
    // The plaintext token is returned exactly once to the administrator.
    const token = `cgn_${crypto.randomBytes(32).toString('hex')}`;
    const result = await run(
      `INSERT INTO sandbox_nodes (node_uid, name, auth_token_hash, status, is_test_node, max_instances, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [nodeUid, name.trim(), hashToken(token), Boolean(isTestNode), maxInstances, timestamp, timestamp]
    );
    await events.emit('NODE_REGISTERED', { actorType: 'admin', nodeId: result.lastID, payload: { name: name.trim(), nodeUid } });
    return { id: result.lastID, nodeUid, name: name.trim(), token };
  }

  async function rotateNodeToken(nodeId) {
    const node = await get('SELECT id, node_uid FROM sandbox_nodes WHERE id = ?', [nodeId]);
    if (!node) return null;
    const token = `cgn_${crypto.randomBytes(32).toString('hex')}`;
    await run('UPDATE sandbox_nodes SET auth_token_hash = ?, updated_at = ? WHERE id = ?', [hashToken(token), now(), nodeId]);
    disconnectNode(nodeId, 'Node token rotated');
    return { token };
  }

  async function authenticateNode(nodeUid, token) {
    if (!nodeUid || !token) return null;
    const node = await get('SELECT * FROM sandbox_nodes WHERE node_uid = ?', [nodeUid]);
    if (!node || !node.auth_token_hash) return null;
    const presented = hashToken(token);
    const expected = node.auth_token_hash;
    const presentedBuffer = Buffer.from(presented, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (presentedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(presentedBuffer, expectedBuffer)) {
      return null;
    }
    if (node.status === 'disabled') return null;
    return node;
  }

  // -------------------------------------------------------------------------
  // Heartbeats & status
  // -------------------------------------------------------------------------

  async function recordHeartbeat(node, {
    agentVersion, machineName, osVersion, cpuCount, ramMb, diskFreeMb,
    cpuPercent, memoryUsedMb, runningInstances, instances = [], ip = null
  } = {}) {
    const timestamp = now();
    // The node row object is captured at authentication time and goes stale;
    // track the last heartbeat in memory so NODE_ONLINE fires once per
    // offline→online transition, not on every heartbeat.
    const previousHeartbeat = lastHeartbeatByNode.get(node.id) ?? node.last_heartbeat_at ?? null;
    const wasOffline = !previousHeartbeat || (timestamp - previousHeartbeat) > NODE_OFFLINE_AFTER_MS;
    lastHeartbeatByNode.set(node.id, timestamp);
    await run(
      `UPDATE sandbox_nodes SET
         agent_version = COALESCE(?, agent_version),
         machine_name = COALESCE(?, machine_name),
         os_version = COALESCE(?, os_version),
         cpu_count = COALESCE(?, cpu_count),
         ram_mb = COALESCE(?, ram_mb),
         disk_free_mb = COALESCE(?, disk_free_mb),
         cpu_percent = ?,
         memory_used_mb = ?,
         running_instances = ?,
         last_heartbeat_at = ?,
         last_seen_ip = COALESCE(?, last_seen_ip),
         updated_at = ?
       WHERE id = ?`,
      [
        agentVersion || null, machineName || null, osVersion || null,
        cpuCount || null, ramMb || null, diskFreeMb || null,
        typeof cpuPercent === 'number' ? cpuPercent : null,
        typeof memoryUsedMb === 'number' ? memoryUsedMb : null,
        Number.isInteger(runningInstances) ? runningInstances : 0,
        timestamp, ip, timestamp, node.id
      ]
    );

    await run(
      'INSERT INTO sandbox_metrics (node_id, cpu_percent, memory_mb, disk_free_mb, recorded_at) VALUES (?, ?, ?, ?, ?)',
      [node.id, typeof cpuPercent === 'number' ? cpuPercent : null,
        typeof memoryUsedMb === 'number' ? memoryUsedMb : null,
        typeof diskFreeMb === 'number' ? diskFreeMb : null, timestamp]
    );

    // Reconcile per-instance status reported by the agent.
    for (const report of instances) {
      if (!report || !report.instanceUid) continue;
      await applyInstanceReport(node, report, timestamp);
    }

    if (wasOffline) {
      await events.emit('NODE_ONLINE', { nodeId: node.id, payload: { nodeUid: node.node_uid } });
    }
    return { ok: true, offlineAfterMs: NODE_OFFLINE_AFTER_MS };
  }

  async function applyInstanceReport(node, report, timestamp) {
    const instance = await get(
      'SELECT * FROM sandbox_instances WHERE instance_uid = ? AND deleted_at IS NULL',
      [report.instanceUid]
    );
    if (!instance || instance.node_id !== node.id) return;

    const updates = [];
    const params = [];

    if (typeof report.cpuPercent === 'number') { updates.push('cpu_percent = ?'); params.push(report.cpuPercent); }
    if (typeof report.memoryMb === 'number') { updates.push('memory_mb = ?'); params.push(report.memoryMb); }
    if (Number.isInteger(report.processId)) { updates.push('process_id = ?'); params.push(report.processId); }
    if (typeof report.sandboxPath === 'string' && report.sandboxPath) { updates.push('sandbox_path = ?'); params.push(report.sandboxPath.slice(0, 260)); }
    if (report.lastError !== undefined) { updates.push('last_error = ?'); params.push(report.lastError ? String(report.lastError).slice(0, 500) : null); }

    const statusMap = {
      running: 'running',
      stopped: 'stopped',
      starting: 'starting',
      failed: 'failed'
    };
    const reportedStatus = statusMap[report.status];
    if (reportedStatus && !['suspended'].includes(instance.status)) {
      // Never let a stale agent report resurrect a deleted/suspended instance,
      // and never regress a terminal state backwards through a heartbeat.
      const allowedTransitions = {
        requested: ['deploying', 'failed'],
        allocating: ['deploying', 'failed'],
        deploying: ['starting', 'running', 'failed', 'stopped'],
        starting: ['running', 'failed', 'stopped'],
        running: ['running', 'stopped', 'failed'],
        stopping: ['stopped', 'failed'],
        stopped: ['stopped', 'starting', 'running', 'failed'],
        failed: ['failed', 'starting', 'running', 'stopped']
      };
      const allowed = allowedTransitions[instance.status] || [];
      if (allowed.includes(reportedStatus) && reportedStatus !== instance.status) {
        updates.push('status = ?');
        params.push(reportedStatus);
        if (reportedStatus === 'running' && !instance.started_at) {
          updates.push('started_at = ?');
          params.push(timestamp);
        }
        if (reportedStatus === 'stopped') {
          updates.push('stopped_at = ?', 'process_id = NULL');
          params.push(timestamp);
        }
      }
    }

    updates.push('last_heartbeat_at = ?', 'updated_at = ?');
    params.push(timestamp, timestamp, instance.id);
    await run(`UPDATE sandbox_instances SET ${updates.join(', ')} WHERE id = ?`, params);

    if (typeof report.cpuPercent === 'number' || typeof report.memoryMb === 'number') {
      await run(
        'INSERT INTO sandbox_metrics (node_id, instance_id, cpu_percent, memory_mb, recorded_at) VALUES (?, ?, ?, ?, ?)',
        [node.id, instance.id, report.cpuPercent ?? null, report.memoryMb ?? null, timestamp]
      );
    }
  }

  async function markOfflineNodes() {
    const cutoff = now() - NODE_OFFLINE_AFTER_MS;
    const stale = await all(
      `SELECT id, node_uid FROM sandbox_nodes
       WHERE status = 'active' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?`,
      [cutoff]
    );
    for (const node of stale) {
      if (liveConnections.has(node.id)) continue; // still connected over WS
      await run('UPDATE sandbox_nodes SET disconnected_at = ?, updated_at = ? WHERE id = ?', [now(), now(), node.id]);
      await events.emit('NODE_OFFLINE', { nodeId: node.id, payload: { nodeUid: node.node_uid } });
      // Instances on an offline node are not necessarily stopped, but their
      // state is unknown; surface that to operators via a log entry.
      await run(
        `UPDATE sandbox_instances SET last_error = 'Node offline', updated_at = ?
         WHERE node_id = ? AND status IN ('running','starting','deploying') AND deleted_at IS NULL`,
        [now(), node.id]
      );
    }
    return stale.length;
  }

  // -------------------------------------------------------------------------
  // Command dispatch
  // -------------------------------------------------------------------------

  async function queueCommand(nodeId, command, { instanceId = null, payload = null, deferDelivery = false } = {}) {
    const timestamp = now();
    const commandUid = `cmd_${crypto.randomBytes(12).toString('hex')}`;
    const result = await run(
      `INSERT INTO sandbox_deployments (command_uid, instance_id, node_id, command, status, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [commandUid, instanceId, nodeId, command, payload == null ? null : JSON.stringify(payload), timestamp, timestamp]
    );
    const record = { id: result.lastID, commandUid, command, instanceId, nodeId, payload };
    return deferDelivery ? record : dispatchCommand(record);
  }

  async function dispatchCommand(record) {
    const { nodeId, commandUid, command, instanceId, payload } = record;
    // Push immediately when the agent is connected over WebSocket.
    const connection = liveConnections.get(nodeId);
    if (connection) {
      try {
        const current = await get('SELECT status, auth_token_hash FROM sandbox_nodes WHERE id = ?', [nodeId]);
        // A newer authenticated session may have replaced this socket while
        // the lookup was pending. Never disconnect that replacement.
        if (liveConnections.get(nodeId) !== connection) return record;
        if (!current || current.status === 'disabled' || current.auth_token_hash !== connection.nodeAuthTokenHash) {
          disconnectNode(nodeId, 'Node credentials revoked');
          return record;
        }
        connection.send(JSON.stringify({
          type: 'command',
          commandUid,
          command,
          instanceId,
          payload
        }));
        await run("UPDATE sandbox_deployments SET status = ?, updated_at = ? WHERE id = ? AND status = 'queued'", ['sent', now(), record.id]);
        record.status = 'sent';
      } catch (error) {
        console.error(`Failed to push command ${commandUid} to node ${nodeId}:`, error.message);
      }
    }
    return record;
  }

  // Commands an agent picks up when polling (or re-syncing after reconnect).
  async function pendingCommands(nodeId) {
    const timestamp = now();
    await run(
      `UPDATE sandbox_deployments SET status = 'expired', updated_at = ?
       WHERE node_id = ? AND status IN ('queued','sent') AND created_at < ?`,
      [timestamp, nodeId, timestamp - COMMAND_EXPIRE_AFTER_MS]
    );
    const rows = await all(
      `SELECT id, command_uid, instance_id, command, payload_json
       FROM sandbox_deployments
       WHERE node_id = ? AND status = 'queued'
       ORDER BY id ASC
       LIMIT 50`,
      [nodeId]
    );
    if (rows.length) {
      const ids = rows.map(row => row.id);
      await run(
        `UPDATE sandbox_deployments SET status = 'sent', updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [timestamp, ...ids]
      );
    }
    return rows.map(row => ({
      commandUid: row.command_uid,
      command: row.command,
      instanceId: row.instance_id,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null
    }));
  }

  async function completeCommand(nodeId, commandUid, { success, result = null, error = null } = {}) {
    const row = await get(
      'SELECT * FROM sandbox_deployments WHERE command_uid = ? AND node_id = ?',
      [commandUid, nodeId]
    );
    if (!row) return null;
    const status = success ? 'completed' : 'failed';
    await run(
      'UPDATE sandbox_deployments SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?',
      [status, result == null ? null : JSON.stringify(result), error ? String(error).slice(0, 1000) : null, now(), row.id]
    );

    // Reflect the outcome on the instance row. This lives here (not in the
    // transport routes) so the WebSocket and HTTPS paths behave identically.
    if (row.instance_id) {
      await applyCommandOutcome(row, { success, result, error });
    }
    return { id: row.id, instanceId: row.instance_id, command: row.command, status };
  }

  async function applyCommandOutcome(deployment, { success, result, error }) {
    const instance = await get('SELECT * FROM sandbox_instances WHERE id = ?', [deployment.instance_id]);
    if (!instance || instance.deleted_at !== null) return;
    const timestamp = now();
    const command = deployment.command;
    const errorText = error ? String(error).slice(0, 500) : null;

    if (command === 'deploy' && success) {
      // A heartbeat can report running before the deploy acknowledgement is persisted.
      // Keep the current terminal state rather than regressing it to starting.
      await run(
        `UPDATE sandbox_instances SET status = CASE WHEN status IN ('requested','allocating','deploying') THEN 'starting' ELSE status END, sandbox_path = COALESCE(?, sandbox_path), updated_at = ? WHERE id = ?`,
        [result && typeof result.sandboxPath === 'string' ? result.sandboxPath.slice(0, 260) : null, timestamp, instance.id]
      );
      await events.emit('SANDBOX_DEPLOYING', { instanceId: instance.id, nodeId: deployment.node_id, payload: { stage: 'environment_ready' } });
    } else if (command === 'deploy' && !success) {
      await run(`UPDATE sandbox_instances SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
        [errorText || 'Deployment failed.', timestamp, instance.id]);
      await events.emit('SANDBOX_FAILED', { instanceId: instance.id, nodeId: deployment.node_id, payload: { error: (errorText || 'Deployment failed.').slice(0, 200) } });
    } else if (command === 'stop' && success) {
      await run(`UPDATE sandbox_instances SET status = 'stopped', stopped_at = ?, process_id = NULL, updated_at = ? WHERE id = ?`,
        [timestamp, timestamp, instance.id]);
    } else if ((command === 'start' || command === 'restart') && success) {
      await run(`UPDATE sandbox_instances SET status = 'running', started_at = COALESCE(started_at, ?), last_error = NULL, updated_at = ? WHERE id = ?`,
        [timestamp, timestamp, instance.id]);
    } else if (!success && command !== 'deploy') {
      await run(`UPDATE sandbox_instances SET last_error = ?, updated_at = ? WHERE id = ?`,
        [`${command} failed: ${(errorText || 'unknown').slice(0, 400)}`, timestamp, instance.id]);
    }
  }

  // -------------------------------------------------------------------------
  // Allocation (load balancing)
  // -------------------------------------------------------------------------

  // Pick the active, non-test node with the most free capacity. Manual
  // assignment passes preferredNodeId; the node must still have capacity.
  async function allocateNode({ preferredNodeId = null, excludeInstanceId = null } = {}) {
    const cutoff = now() - NODE_OFFLINE_AFTER_MS;
    const candidates = await all(
      `SELECT n.*,
              (SELECT COUNT(*) FROM sandbox_instances i
               WHERE i.node_id = n.id AND i.deleted_at IS NULL
                 AND i.status IN ('requested','allocating','deploying','starting','running','stopping')) AS active_instances
       FROM sandbox_nodes n
       WHERE n.status = 'active' AND n.is_test_node = FALSE
         AND n.last_heartbeat_at IS NOT NULL AND n.last_heartbeat_at >= ?
       ORDER BY (n.max_instances - (SELECT COUNT(*) FROM sandbox_instances i
               WHERE i.node_id = n.id AND i.deleted_at IS NULL
                 AND i.status IN ('requested','allocating','deploying','starting','running','stopping'))) DESC,
               COALESCE(n.cpu_percent, 9999) ASC`,
      [cutoff]
    );

    // The caller holds its transaction until its instance is reserved. Re-read
    // capacity after locking the node so other users/processes cannot overbook.
    for (const candidate of candidates) {
      if (preferredNodeId != null && candidate.id !== preferredNodeId) continue;
      const node = await get('SELECT * FROM sandbox_nodes WHERE id = ?' + (typeof db.transaction === 'function' ? ' FOR UPDATE SKIP LOCKED' : ''), [candidate.id]);
      if (!node || node.status !== 'active' || node.is_test_node || node.last_heartbeat_at < cutoff) continue;
      const usage = await get(`SELECT COUNT(*) AS count FROM sandbox_instances
        WHERE node_id = ? AND deleted_at IS NULL ${excludeInstanceId == null ? '' : 'AND id <> ?'}
          AND status IN ('requested','allocating','deploying','starting','running','stopping')`,
        excludeInstanceId == null ? [node.id] : [node.id, excludeInstanceId]);
      if (Number(usage.count) < node.max_instances) return node;
    }
    return null;
  }

  function attachConnection(nodeId, connection, tokenHash) {
    disconnectNode(nodeId, 'Node connected from another session');
    connection.nodeAuthTokenHash = tokenHash;
    liveConnections.set(nodeId, connection);
  }

  function disconnectNode(nodeId, reason = 'Node access revoked') {
    const connection = liveConnections.get(nodeId);
    liveConnections.delete(nodeId);
    if (connection) {
      try { connection.close(4003, reason); } catch (_error) { /* already closed */ }
    }
  }

  function detachConnection(nodeId, connection) {
    if (liveConnections.get(nodeId) === connection) {
      liveConnections.delete(nodeId);
    }
  }

  function isConnected(nodeId) {
    return liveConnections.has(nodeId);
  }

  return {
    createNode,
    rotateNodeToken,
    authenticateNode,
    recordHeartbeat,
    markOfflineNodes,
    queueCommand,
    dispatchCommand,
    pendingCommands,
    completeCommand,
    allocateNode,
    attachConnection,
    disconnectNode,
    detachConnection,
    isConnected,
    hashToken,
    NODE_OFFLINE_AFTER_MS
  };
}

module.exports = { createSandboxNodes };
