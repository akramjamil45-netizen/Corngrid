'use strict';

// Admin Sandbox Management API. Every route requires the existing admin JWT
// (adminAuth.verifyToken) and every mutation is written to the subscription
// audit log so administrative actions are traceable.

const crypto = require('crypto');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function createSandboxAdminApi({ db, nodes, events, manager, subscriptions, crypto: sandboxCrypto, now = () => Date.now() } = {}) {
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

  function pageParams(query) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
    return { page, pageSize, offset: (page - 1) * pageSize };
  }

  function publicNode(node) {
    return {
      id: node.id,
      nodeUid: node.node_uid,
      name: node.name,
      status: node.status,
      isTestNode: Boolean(node.is_test_node),
      maxInstances: node.max_instances,
      agentVersion: node.agent_version,
      machineName: node.machine_name,
      osVersion: node.os_version,
      cpuCount: node.cpu_count,
      ramMb: node.ram_mb,
      diskFreeMb: node.disk_free_mb,
      cpuPercent: node.cpu_percent,
      memoryUsedMb: node.memory_used_mb,
      runningInstances: node.running_instances,
      lastHeartbeatAt: node.last_heartbeat_at,
      lastSeenIp: node.last_seen_ip,
      online: Boolean(node.last_heartbeat_at && (now() - node.last_heartbeat_at) < nodes.NODE_OFFLINE_AFTER_MS),
      createdAt: node.created_at
    };
  }

  function registerRoutes(app, verifyAdminToken) {
    // -----------------------------------------------------------------------
    // Overview statistics
    // -----------------------------------------------------------------------
    app.get('/api/admin/sandbox/overview', verifyAdminToken, async (_req, res) => {
      try {
        const cutoff = now() - nodes.NODE_OFFLINE_AFTER_MS;
        const nodeStats = await get(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'active' AND last_heartbeat_at >= ? THEN 1 ELSE 0 END) AS online,
                 SUM(CASE WHEN status = 'active' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?) THEN 1 ELSE 0 END) AS offline
          FROM sandbox_nodes`, [cutoff, cutoff]);
        const instanceStats = await get(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
                 SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                 SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
          FROM sandbox_instances WHERE deleted_at IS NULL`);
        const userStats = await get(
          `SELECT COUNT(DISTINCT user_id) AS active_users FROM sandbox_instances WHERE deleted_at IS NULL AND status IN ('running','starting','deploying')`
        );
        const capacity = await get(`
          SELECT COALESCE(SUM(max_instances), 0) AS total_slots,
                 COALESCE(SUM((SELECT COUNT(*) FROM sandbox_instances i
                   WHERE i.node_id = n.id AND i.deleted_at IS NULL
                     AND i.status IN ('deploying','starting','running','stopping'))), 0) AS used_slots
          FROM sandbox_nodes n WHERE n.status = 'active' AND n.is_test_node = FALSE`);

        res.json({
          nodes: {
            total: Number(nodeStats.total) || 0,
            online: Number(nodeStats.online) || 0,
            offline: Number(nodeStats.offline) || 0
          },
          instances: {
            total: Number(instanceStats.total) || 0,
            running: Number(instanceStats.running) || 0,
            stopped: Number(instanceStats.stopped) || 0,
            failed: Number(instanceStats.failed) || 0,
            suspended: Number(instanceStats.suspended) || 0
          },
          activeUsers: Number(userStats.active_users) || 0,
          capacity: {
            totalSlots: Number(capacity.total_slots) || 0,
            usedSlots: Number(capacity.used_slots) || 0,
            availableSlots: Math.max(0, (Number(capacity.total_slots) || 0) - (Number(capacity.used_slots) || 0))
          }
        });
      } catch (error) {
        console.error('Sandbox overview failed:', error.message);
        res.status(500).json({ error: 'Unable to load the sandbox overview.' });
      }
    });

    // -----------------------------------------------------------------------
    // Node management
    // -----------------------------------------------------------------------
    app.get('/api/admin/sandbox/nodes', verifyAdminToken, async (_req, res) => {
      try {
        const rows = await all('SELECT * FROM sandbox_nodes ORDER BY id ASC');
        res.json({ nodes: rows.map(publicNode) });
      } catch (error) {
        console.error('Failed to list nodes:', error.message);
        res.status(500).json({ error: 'Unable to list sandbox nodes.' });
      }
    });

    app.post('/api/admin/sandbox/nodes', verifyAdminToken, async (req, res) => {
      const body = req.body || {};
      try {
        const maxInstances = Number.isInteger(body.maxInstances) ? Math.min(200, Math.max(1, body.maxInstances)) : 10;
        const node = await nodes.createNode({
          name: body.name,
          isTestNode: body.isTestNode === true,
          maxInstances
        });
        await subscriptions.logAudit(null, 'admin', 'sandbox_node_created', 'sandbox_node', node.id,
          { name: node.name, nodeUid: node.nodeUid }, null, req.ip);
        // The plaintext token is returned exactly once.
        res.status(201).json({
          message: 'Sandbox node created. Store the authentication token securely — it is shown only once.',
          node: { id: node.id, nodeUid: node.nodeUid, name: node.name },
          token: node.token
        });
      } catch (error) {
        console.error('Failed to create node:', error.message);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to create the sandbox node.' });
      }
    });

    app.post('/api/admin/sandbox/nodes/:id/status', verifyAdminToken, async (req, res) => {
      const nodeId = Number.parseInt(req.params.id, 10);
      const status = req.body && req.body.status;
      if (!Number.isSafeInteger(nodeId) || nodeId < 1) return res.status(400).json({ error: 'Invalid node.' });
      if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Status must be active or disabled.' });
      try {
        const node = await get('SELECT * FROM sandbox_nodes WHERE id = ?', [nodeId]);
        if (!node) return res.status(404).json({ error: 'Node not found.' });
        await run('UPDATE sandbox_nodes SET status = ?, updated_at = ? WHERE id = ?', [status, now(), nodeId]);
        await subscriptions.logAudit(null, 'admin', `sandbox_node_${status}`, 'sandbox_node', nodeId,
          { nodeUid: node.node_uid }, null, req.ip);
        res.json({ message: `Node ${status}.`, node: publicNode({ ...node, status }) });
      } catch (error) {
        console.error('Failed to update node status:', error.message);
        res.status(500).json({ error: 'Unable to update the node status.' });
      }
    });

    app.post('/api/admin/sandbox/nodes/:id/rotate-token', verifyAdminToken, async (req, res) => {
      const nodeId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(nodeId) || nodeId < 1) return res.status(400).json({ error: 'Invalid node.' });
      try {
        const rotated = await nodes.rotateNodeToken(nodeId);
        if (!rotated) return res.status(404).json({ error: 'Node not found.' });
        await subscriptions.logAudit(null, 'admin', 'sandbox_node_token_rotated', 'sandbox_node', nodeId, null, null, req.ip);
        res.json({ message: 'Node token rotated. Update the agent configuration — the old token no longer works.', token: rotated.token });
      } catch (error) {
        console.error('Failed to rotate node token:', error.message);
        res.status(500).json({ error: 'Unable to rotate the node token.' });
      }
    });

    app.post('/api/admin/sandbox/nodes/:id/restart-agent', verifyAdminToken, async (req, res) => {
      const nodeId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(nodeId) || nodeId < 1) return res.status(400).json({ error: 'Invalid node.' });
      try {
        const node = await get('SELECT * FROM sandbox_nodes WHERE id = ?', [nodeId]);
        if (!node) return res.status(404).json({ error: 'Node not found.' });
        await nodes.queueCommand(nodeId, 'restart_agent', { payload: {} });
        await subscriptions.logAudit(null, 'admin', 'sandbox_node_agent_restart', 'sandbox_node', nodeId, { nodeUid: node.node_uid }, null, req.ip);
        res.json({ message: 'Agent restart command queued.' });
      } catch (error) {
        console.error('Failed to queue agent restart:', error.message);
        res.status(500).json({ error: 'Unable to restart the agent.' });
      }
    });

    app.delete('/api/admin/sandbox/nodes/:id', verifyAdminToken, async (req, res) => {
      const nodeId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(nodeId) || nodeId < 1) return res.status(400).json({ error: 'Invalid node.' });
      try {
        const node = await get('SELECT * FROM sandbox_nodes WHERE id = ?', [nodeId]);
        if (!node) return res.status(404).json({ error: 'Node not found.' });
        const hosted = await get(
          `SELECT COUNT(*) AS count FROM sandbox_instances WHERE node_id = ? AND deleted_at IS NULL`,
          [nodeId]
        );
        if (Number(hosted.count) > 0) {
          return res.status(409).json({ error: 'This node still hosts sandboxes. Reassign or delete them first.' });
        }
        await run('DELETE FROM sandbox_nodes WHERE id = ?', [nodeId]);
        await subscriptions.logAudit(null, 'admin', 'sandbox_node_removed', 'sandbox_node', nodeId, { nodeUid: node.node_uid, name: node.name }, null, req.ip);
        res.json({ message: 'Node removed.' });
      } catch (error) {
        console.error('Failed to remove node:', error.message);
        res.status(500).json({ error: 'Unable to remove the node.' });
      }
    });

    // -----------------------------------------------------------------------
    // User instance management
    // -----------------------------------------------------------------------
    app.get('/api/admin/sandbox/instances', verifyAdminToken, async (req, res) => {
      try {
        const { page, pageSize, offset } = pageParams(req.query);
        const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';

        const conditions = ['i.deleted_at IS NULL'];
        const params = [];
        if (search) {
          conditions.push('(u.username LIKE ? OR u.email LIKE ? OR i.mt5_account_number LIKE ?)');
          const like = `%${search}%`;
          params.push(like, like, like);
        }
        if (status) {
          conditions.push('i.status = ?');
          params.push(status);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const total = await get(`SELECT COUNT(*) AS count FROM sandbox_instances i JOIN users u ON u.id = i.user_id ${where}`, params);
        const rows = await all(
          `SELECT i.*, u.username, u.email, s.name AS strategy_name, s.code AS strategy_code, n.node_uid, n.name AS node_name
           FROM sandbox_instances i
           JOIN users u ON u.id = i.user_id
           LEFT JOIN trading_strategies s ON s.id = i.strategy_id
           LEFT JOIN sandbox_nodes n ON n.id = i.node_id
           ${where}
           ORDER BY i.id DESC LIMIT ? OFFSET ?`,
          [...params, pageSize, offset]
        );
        res.json({
          instances: rows.map(row => ({
            ...manager.publicInstance(row),
            id: row.id,
            userId: row.user_id,
            username: row.username,
            email: row.email,
            nodeId: row.node_id
          })),
          page,
          pageSize,
          total: Number(total.count) || 0
        });
      } catch (error) {
        console.error('Failed to list sandbox instances:', error.message);
        res.status(500).json({ error: 'Unable to list sandbox instances.' });
      }
    });

    app.post('/api/admin/sandbox/instances/:id/control', verifyAdminToken, async (req, res) => {
      const instanceId = Number.parseInt(req.params.id, 10);
      const action = req.body && req.body.action;
      if (!Number.isSafeInteger(instanceId) || instanceId < 1) return res.status(400).json({ error: 'Invalid instance.' });
      if (!['start', 'stop', 'restart', 'suspend', 'unsuspend'].includes(action)) {
        return res.status(400).json({ error: 'Unsupported action.' });
      }
      try {
        const instance = await get('SELECT * FROM sandbox_instances WHERE id = ? AND deleted_at IS NULL', [instanceId]);
        if (!instance) return res.status(404).json({ error: 'Sandbox not found.' });

        if (action === 'suspend') {
          await run(`UPDATE sandbox_instances SET status = 'suspended', updated_at = ? WHERE id = ?`, [now(), instanceId]);
          if (instance.node_id) {
            await nodes.queueCommand(instance.node_id, 'stop', { instanceId, payload: { instanceUid: instance.instance_uid } });
          }
          await events.emit('SANDBOX_SUSPENDED', { actorType: 'admin', instanceId, nodeId: instance.node_id });
        } else if (action === 'unsuspend') {
          await run(`UPDATE sandbox_instances SET status = 'stopped', updated_at = ? WHERE id = ? AND status = 'suspended'`, [now(), instanceId]);
        } else {
          const result = await manager.controlSandbox(instance.user_id, action);
          if (result.http !== 200) return res.status(result.http).json(result.body);
        }
        await subscriptions.logAudit(null, 'admin', `sandbox_instance_${action}`, 'sandbox_instance', instanceId,
          { instanceUid: instance.instance_uid, userId: instance.user_id }, null, req.ip);
        res.json({ message: `Sandbox ${action} completed.` });
      } catch (error) {
        console.error('Admin sandbox control failed:', error.message);
        res.status(500).json({ error: 'Unable to control the sandbox.' });
      }
    });

    app.post('/api/admin/sandbox/instances/:id/reassign', verifyAdminToken, async (req, res) => {
      const instanceId = Number.parseInt(req.params.id, 10);
      const targetNodeId = req.body && req.body.nodeId;
      if (!Number.isSafeInteger(instanceId) || instanceId < 1) return res.status(400).json({ error: 'Invalid instance.' });
      if (!Number.isSafeInteger(targetNodeId) || targetNodeId < 1) return res.status(400).json({ error: 'A target node is required.' });
      try {
        const instance = await get('SELECT * FROM sandbox_instances WHERE id = ? AND deleted_at IS NULL', [instanceId]);
        if (!instance) return res.status(404).json({ error: 'Sandbox not found.' });
        const target = await get('SELECT * FROM sandbox_nodes WHERE id = ?', [targetNodeId]);
        if (!target || target.status !== 'active') return res.status(400).json({ error: 'The target node is not available.' });

        // Tear down on the old node, then redeploy on the new one with the
        // stored credentials (decrypted in memory only, never logged).
        if (instance.node_id) {
          await nodes.queueCommand(instance.node_id, 'destroy', {
            instanceId,
            payload: { instanceUid: instance.instance_uid, sandboxPath: instance.sandbox_path }
          });
        }
        const credential = await get('SELECT * FROM sandbox_credentials WHERE instance_id = ?', [instanceId]);
        if (!credential) return res.status(409).json({ error: 'Sandbox credentials are missing; the user must re-activate.' });
        // Decrypted in memory only and sent to the authenticated node over the
        // encrypted channel — never logged, never stored on the node in plain
        // text beyond the MT5 config the terminal itself requires.
        const secrets = sandboxCrypto.decryptJson(credential.cipher);
        if (!secrets || !secrets.password) {
          return res.status(409).json({ error: 'Sandbox credentials could not be decrypted. The user must re-activate.' });
        }

        await run(
          `UPDATE sandbox_instances SET node_id = ?, status = 'deploying', process_id = NULL, sandbox_path = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
          [targetNodeId, now(), instanceId]
        );
        const strategy = await get('SELECT * FROM trading_strategies WHERE id = ?', [instance.strategy_id]);
        await nodes.queueCommand(targetNodeId, 'deploy', {
          instanceId,
          payload: {
            instanceUid: instance.instance_uid,
            brokerServer: secrets.brokerServer || instance.broker_server,
            accountNumber: secrets.accountNumber || instance.mt5_account_number,
            password: secrets.password,
            strategy: strategy ? { code: strategy.code, name: strategy.name, version: strategy.version, eaFileName: strategy.ea_file_name } : null,
            apiBaseUrl: process.env.APP_BASE_URL || null
          }
        });
        await subscriptions.logAudit(null, 'admin', 'sandbox_instance_reassigned', 'sandbox_instance', instanceId,
          { fromNodeId: instance.node_id, toNodeId: targetNodeId }, null, req.ip);
        res.json({ message: 'Sandbox reassignment started.' });
      } catch (error) {
        console.error('Sandbox reassignment failed:', error.message);
        res.status(500).json({ error: 'Unable to reassign the sandbox.' });
      }
    });

    app.delete('/api/admin/sandbox/instances/:id', verifyAdminToken, async (req, res) => {
      const instanceId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(instanceId) || instanceId < 1) return res.status(400).json({ error: 'Invalid instance.' });
      try {
        const instance = await get('SELECT * FROM sandbox_instances WHERE id = ? AND deleted_at IS NULL', [instanceId]);
        if (!instance) return res.status(404).json({ error: 'Sandbox not found.' });
        const result = await manager.deleteSandbox(instance.user_id, { actorType: 'admin', actorId: null });
        await subscriptions.logAudit(null, 'admin', 'sandbox_instance_deleted', 'sandbox_instance', instanceId,
          { instanceUid: instance.instance_uid, userId: instance.user_id }, null, req.ip);
        res.status(result.http).json(result.body);
      } catch (error) {
        console.error('Admin sandbox deletion failed:', error.message);
        res.status(500).json({ error: 'Unable to delete the sandbox.' });
      }
    });

    // -----------------------------------------------------------------------
    // Logs, events, monitoring
    // -----------------------------------------------------------------------
    app.get('/api/admin/sandbox/logs', verifyAdminToken, async (req, res) => {
      try {
        const { page, pageSize, offset } = pageParams(req.query);
        const conditions = [];
        const params = [];
        if (req.query.instanceId) {
          conditions.push('l.instance_id = ?');
          params.push(Number.parseInt(req.query.instanceId, 10) || 0);
        }
        if (req.query.nodeId) {
          conditions.push('l.node_id = ?');
          params.push(Number.parseInt(req.query.nodeId, 10) || 0);
        }
        if (req.query.level && ['debug', 'info', 'warn', 'error'].includes(req.query.level)) {
          conditions.push('l.level = ?');
          params.push(req.query.level);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const total = await get(`SELECT COUNT(*) AS count FROM sandbox_logs l ${where}`, params);
        const rows = await all(
          `SELECT l.*, i.instance_uid, n.node_uid
           FROM sandbox_logs l
           LEFT JOIN sandbox_instances i ON i.id = l.instance_id
           LEFT JOIN sandbox_nodes n ON n.id = l.node_id
           ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
          [...params, pageSize, offset]
        );
        res.json({ logs: rows, page, pageSize, total: Number(total.count) || 0 });
      } catch (error) {
        console.error('Failed to load sandbox logs:', error.message);
        res.status(500).json({ error: 'Unable to load sandbox logs.' });
      }
    });

    app.get('/api/admin/sandbox/events', verifyAdminToken, async (req, res) => {
      try {
        const { page, pageSize, offset } = pageParams(req.query);
        const conditions = [];
        const params = [];
        if (req.query.type) {
          conditions.push('event_type = ?');
          params.push(String(req.query.type).slice(0, 40));
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const total = await get(`SELECT COUNT(*) AS count FROM sandbox_events ${where}`, params);
        const rows = await all(
          `SELECT * FROM sandbox_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
          [...params, pageSize, offset]
        );
        res.json({ events: rows, page, pageSize, total: Number(total.count) || 0 });
      } catch (error) {
        console.error('Failed to load sandbox events:', error.message);
        res.status(500).json({ error: 'Unable to load sandbox events.' });
      }
    });

    function deleteAllRecords(resource) {
      const table = resource === 'logs' ? 'sandbox_logs' : 'sandbox_events';
      return async (req, res) => {
        if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm permanent deletion of all records.' });
        try {
          const removed = await run('DELETE FROM ' + table);
          const deleted = Number(removed.changes) || 0;
          await subscriptions.logAudit(null, 'admin', 'sandbox_' + resource + '_cleared', 'sandbox_' + resource, null, { deleted }, null, req.ip);
          res.json({ message: 'All records deleted.', deleted });
        } catch (error) {
          console.error('Failed to clear sandbox ' + resource + ':', error.message);
          res.status(500).json({ error: 'Unable to delete all records.' });
        }
      };
    }
    app.delete('/api/admin/sandbox/logs', verifyAdminToken, deleteAllRecords('logs'));
    app.delete('/api/admin/sandbox/events', verifyAdminToken, deleteAllRecords('events'));

    app.get('/api/admin/sandbox/monitoring', verifyAdminToken, async (req, res) => {
      try {
        const hours = Math.min(72, Math.max(1, Number.parseInt(req.query.hours, 10) || 1));
        const since = now() - hours * 60 * 60 * 1000;
        const nodeMetrics = await all(
          `SELECT node_id, AVG(cpu_percent) AS cpu_avg, AVG(memory_mb) AS memory_avg,
                  MIN(recorded_at) AS window_start, MAX(recorded_at) AS window_end, COUNT(*) AS samples
           FROM sandbox_metrics WHERE instance_id IS NULL AND recorded_at >= ?
           GROUP BY node_id`,
          [since]
        );
        const recentDeployments = await all(
          `SELECT d.*, i.instance_uid, n.node_uid
           FROM sandbox_deployments d
           LEFT JOIN sandbox_instances i ON i.id = d.instance_id
           LEFT JOIN sandbox_nodes n ON n.id = d.node_id
           ORDER BY d.id DESC LIMIT 50`
        );
        res.json({ nodeMetrics, recentDeployments, windowHours: hours });
      } catch (error) {
        console.error('Failed to load sandbox monitoring:', error.message);
        res.status(500).json({ error: 'Unable to load monitoring data.' });
      }
    });
  }

  return { registerRoutes, publicNode };
}

module.exports = { createSandboxAdminApi };
