'use strict';
// Read-only deployment evidence. Never issues control, deploy or trading commands.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const production = 'C:/Website/Website/Corngrid-web/';
const env = require(production + 'node_modules/dotenv').parse(fs.readFileSync(production + '.env'));
const { Client } = require(production + 'node_modules/pg');
const mode = process.argv[2];
if (!['before', 'after', 'status'].includes(mode)) throw new Error('Usage: verify-sandbox-node-release.cjs before|after|status');
const beforeFile = path.join(__dirname, 'node-sandbox-release-before-result.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

(async () => {
  const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  await db.connect();
  let report;
  try {
    await db.query('BEGIN READ ONLY');
    const nodes = (await db.query('SELECT id,name,status,agent_version,last_heartbeat_at,running_instances FROM sandbox_nodes ORDER BY id')).rows.map(n => ({
      id: n.id, name: n.name, status: n.status, version: n.agent_version,
      online: Date.now() - Number(n.last_heartbeat_at) < 60000,
      heartbeatAt: Number(n.last_heartbeat_at), runningInstances: n.running_instances
    }));
    const instances = (await db.query(`SELECT i.id,i.node_id,i.status,i.process_id,i.last_heartbeat_at,a.last_heartbeat ea_heartbeat,a.auth_error_at
      FROM sandbox_instances i LEFT JOIN mt5_accounts a ON a.user_id=i.user_id AND a.account_number=i.mt5_account_number AND lower(a.broker_server)=lower(i.broker_server)
      WHERE i.deleted_at IS NULL ORDER BY i.id`)).rows.map(i => ({ id: i.id, nodeId: i.node_id, status: i.status,
        pid: i.process_id, heartbeatAt: Number(i.last_heartbeat_at), eaHeartbeatAt: Number(i.ea_heartbeat), authErrorAt: i.auth_error_at }));
    const channel = JSON.parse(fs.readFileSync(path.join(env.SANDBOX_NODE_UPDATE_DIR || 'C:/ProgramData/CornGrid/NodeUpdates', 'channel.json'), 'utf8'));
    report = { checkedAt: new Date().toISOString(), mode, release: channel.release, updatesEnabled: channel.enabled !== false, nodes, instances };
    await db.query('ROLLBACK');
  } finally { await db.end(); }
  if (mode === 'after') {
    const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '../Corngrid-web/agent/RELEASE.json'), 'utf8'));
    assert.equal(report.release.id, expected.id, 'Central signed release does not match project manifest.');
    const targets = before.nodes.filter(n => n.online && n.status === 'active');
    report.pendingNodes = targets.filter(n => !report.nodes.some(current => current.id === n.id && current.online && current.version === expected.version + '+' + expected.id.slice(0, 12))).map(n => n.id);
    report.processesPreserved = before.instances.filter(i => i.status === 'running').every(i => report.instances.some(current =>
      current.id === i.id && current.status === 'running' && current.nodeId === i.nodeId && current.pid === i.pid &&
      (i.nodeId !== 3 || alive(i.pid))));
    assert.equal(report.processesPreserved, true, 'A previously running sandbox changed process/status; inspect before accepting this release.');
    const peter = report.instances.find(i => i.id === 17);
    report.peterHealthy = !!peter && peter.status === 'running' && Date.now() - peter.heartbeatAt < 60000 && Date.now() - peter.eaHeartbeatAt < 120000 && !peter.authErrorAt;
    assert.equal(report.peterHealthy, true, 'Peter sandbox/EA telemetry is not fresh.');
    const response = await fetch('https://corngrid.com/api/health/ready', { signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer(); report.websiteReady = response.status === 200;
    assert.equal(report.websiteReady, true);
    report.complete = report.pendingNodes.length === 0;
  }
  if (mode !== 'status') fs.writeFileSync(path.join(__dirname, 'node-sandbox-release-' + mode + '-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error('Release verification failed:', error.code === 'ERR_ASSERTION' ? error.message : error.code || error.name); process.exitCode = 1; });
