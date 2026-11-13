'use strict';

// HTTP API used by the Windows Sandbox Agent running on remote nodes.
//
// Agents authenticate every request with the node credentials issued by an
// administrator (X-Node-Id + X-Node-Token headers). All traffic is outbound
// from the agent, so nodes never need publicly exposed inbound ports. When an
// agent also holds a WebSocket connection (sandbox-realtime.js), commands are
// pushed instantly; these polling endpoints remain as the resilient fallback.

const path = require('path');
const fs = require('fs');

const MAX_LOG_BATCH = 100;
const MAX_LOG_MESSAGE = 2000;
const MAX_INSTANCE_REPORTS = 200;

function createSandboxNodeApi({ db, nodes, events, manager, rateLimit, strategyStorageDir, updates } = {}) {
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

  // Node authentication middleware.
  async function authenticateNodeRequest(req, res, next) {
    const nodeUid = req.headers['x-node-id'];
    const token = req.headers['x-node-token'];
    if (typeof nodeUid !== 'string' || typeof token !== 'string' || !nodeUid || !token) {
      return res.status(401).json({ error: 'Node credentials are required.' });
    }
    try {
      const node = await nodes.authenticateNode(nodeUid.trim(), token.trim());
      if (!node) {
        return res.status(403).json({ error: 'Node credentials are invalid or the node is disabled.' });
      }
      req.node = node;
      return next();
    } catch (error) {
      console.error('Node authentication failed:', error.message);
      return res.status(500).json({ error: 'Unable to authenticate this node.' });
    }
  }

  function sanitizeInstanceReports(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_INSTANCE_REPORTS).map(report => ({
      instanceUid: typeof report.instanceUid === 'string' ? report.instanceUid.slice(0, 64) : null,
      status: typeof report.status === 'string' ? report.status.slice(0, 20) : null,
      processId: Number.isInteger(report.processId) ? report.processId : null,
      cpuPercent: typeof report.cpuPercent === 'number' && Number.isFinite(report.cpuPercent) ? report.cpuPercent : null,
      memoryMb: typeof report.memoryMb === 'number' && Number.isFinite(report.memoryMb) ? report.memoryMb : null,
      sandboxPath: typeof report.sandboxPath === 'string' ? report.sandboxPath.slice(0, 260) : null,
      lastError: report.lastError == null ? null : String(report.lastError).slice(0, 500)
    })).filter(report => report.instanceUid);
  }

  function registerRoutes(app) {
    const nodeRateLimit = rateLimit({ limit: 240, windowMs: 60 * 1000 });

    app.get('/api/sandbox/node/update', nodeRateLimit, authenticateNodeRequest, (_req, res) => {
      res.set('Cache-Control', 'private, no-store');
      const state = updates?.status() || { configured: false, enabled: false, release: null };
      res.json({ ...state, release: state.release ? { ...state.release, url: '/api/sandbox/node/updates/' + state.release.id } : null });
    });
    app.get('/api/sandbox/node/update-key', nodeRateLimit, authenticateNodeRequest, (_req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try { const publicKey = updates?.publicKey(); if (!publicKey) return res.status(503).json({ error: 'Agent update signing is not configured.' }); res.json({ publicKey }); }
      catch { res.status(503).json({ error: 'Agent update signing is not configured.' }); }
    });
    app.get('/api/sandbox/node/updates/:releaseId', nodeRateLimit, authenticateNodeRequest, (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      if (!updates?.status().enabled) return res.status(403).json({ error: 'Agent updates are paused.' });
      const file = updates.releaseFile(req.params.releaseId);
      if (!file) return res.status(404).json({ error: 'Agent release not found.' });
      res.type('application/json'); res.sendFile(file);
    });

    // Recover only assigned terminals that should be running, never stopped,
    // suspended or deleted instances. Local startup files retain credentials.
    app.get('/api/sandbox/node/instances', nodeRateLimit, authenticateNodeRequest, async (req, res) => {
      db.all(`SELECT instance_uid FROM sandbox_instances
        WHERE node_id = ? AND deleted_at IS NULL AND status IN ('running','starting')`,
      [req.node.id], (error, rows) => {
        if (error) return res.status(500).json({ error: 'Unable to load recovery state.' });
        res.json({ instances: rows.map(row => ({ instanceUid: row.instance_uid })) });
      });
    });

    // Heartbeat: resource report + instance states in, pending commands out.
    app.post('/api/sandbox/node/heartbeat', nodeRateLimit, authenticateNodeRequest, async (req, res) => {
      const body = req.body || {};
      try {
        await nodes.recordHeartbeat(req.node, {
          agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion.slice(0, 40) : null,
          machineName: typeof body.machineName === 'string' ? body.machineName.slice(0, 120) : null,
          osVersion: typeof body.osVersion === 'string' ? body.osVersion.slice(0, 120) : null,
          cpuCount: Number.isInteger(body.cpuCount) ? body.cpuCount : null,
          ramMb: Number.isInteger(body.ramMb) ? body.ramMb : null,
          diskFreeMb: typeof body.diskFreeMb === 'number' ? body.diskFreeMb : null,
          cpuPercent: typeof body.cpuPercent === 'number' ? body.cpuPercent : null,
          memoryUsedMb: typeof body.memoryUsedMb === 'number' ? body.memoryUsedMb : null,
          runningInstances: Number.isInteger(body.runningInstances) ? body.runningInstances : 0,
          instances: sanitizeInstanceReports(body.instances),
          ip: req.ip
        });
        const commands = await nodes.pendingCommands(req.node.id);
        res.json({ ok: true, serverTime: Date.now(), commands });
      } catch (error) {
        console.error('Node heartbeat failed:', error.message);
        res.status(500).json({ error: 'Heartbeat processing failed.' });
      }
    });

    // Explicit command poll (agents without a WebSocket connection).
    app.get('/api/sandbox/node/commands', nodeRateLimit, authenticateNodeRequest, async (req, res) => {
      try {
        const commands = await nodes.pendingCommands(req.node.id);
        res.json({ commands });
      } catch (error) {
        console.error('Node command poll failed:', error.message);
        res.status(500).json({ error: 'Unable to fetch commands.' });
      }
    });

    // Command result report.
    app.post('/api/sandbox/node/commands/:commandUid/result', nodeRateLimit, authenticateNodeRequest, async (req, res) => {
      const body = req.body || {};
      try {
        // completeCommand reflects the outcome on the instance row for both
        // the HTTPS and WebSocket transports.
        const completed = await nodes.completeCommand(req.node.id, req.params.commandUid, {
          success: body.success === true,
          result: body.result && typeof body.result === 'object' ? body.result : null,
          error: body.error == null ? null : String(body.error).slice(0, 1000)
        });
        if (!completed) return res.status(404).json({ error: 'Unknown command.' });
        res.json({ ok: true });
      } catch (error) {
        console.error('Command result processing failed:', error.message);
        res.status(500).json({ error: 'Unable to record the command result.' });
      }
    });

    // Batch log upload from the agent.
    app.post('/api/sandbox/node/logs', nodeRateLimit, authenticateNodeRequest, async (req, res) => {
      const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries.slice(0, MAX_LOG_BATCH) : [];
      try {
        for (const entry of entries) {
          if (!entry || typeof entry.message !== 'string' || !entry.message) continue;
          const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
          let instanceId = null;
          if (typeof entry.instanceUid === 'string' && entry.instanceUid) {
            const instance = await get('SELECT id FROM sandbox_instances WHERE instance_uid = ?', [entry.instanceUid.slice(0, 64)]);
            instanceId = instance ? instance.id : null;
          }
          await run(
            'INSERT INTO sandbox_logs (instance_id, node_id, level, source, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [instanceId, req.node.id, level, 'agent', entry.message.slice(0, MAX_LOG_MESSAGE), Date.now()]
          );
        }
        res.json({ ok: true });
      } catch (error) {
        console.error('Node log upload failed:', error.message);
        res.status(500).json({ error: 'Unable to store logs.' });
      }
    });

    // EA binary download for a strategy the node is deploying. The node only
    // ever receives binaries for published strategies, authenticated by token.
    app.get('/api/sandbox/node/strategies/:strategyCode/ea', nodeRateLimit, authenticateNodeRequest, async (req, res) => {
      try {
        const strategy = await get(
          'SELECT * FROM trading_strategies WHERE code = ? AND is_active = TRUE AND is_published = TRUE',
          [req.params.strategyCode]
        );
        if (!strategy || !strategy.ea_file_path) {
          return res.status(404).json({ error: 'No EA binary is published for this strategy.' });
        }
        const baseDir = path.resolve(strategyStorageDir||path.join(__dirname, '..', 'storage'));
        const absolute = path.resolve(baseDir, strategy.ea_file_path);
        const relative = path.relative(baseDir,absolute);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
          return res.status(404).json({ error: 'EA binary is not available.' });
        }
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${strategy.ea_file_name || 'strategy.ex5'}"`);
        fs.createReadStream(absolute).pipe(res);
      } catch (error) {
        console.error('EA download for node failed:', error.message);
        res.status(500).json({ error: 'Unable to download the EA binary.' });
      }
    });
  }

  return { registerRoutes, authenticateNodeRequest };
}

module.exports = { createSandboxNodeApi };
