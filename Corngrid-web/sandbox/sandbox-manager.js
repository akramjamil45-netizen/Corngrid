'use strict';

// Sandbox Manager: orchestrates the user-facing sandbox lifecycle.
//
// Activation flow (all inside one exclusive write block where state changes):
//   1. validate input + active subscription (reuses subscription-api helpers)
//   2. allocate a node (load balanced, or admin-pinned)
//   3. create the sandbox_instances row (partial unique index makes repeated
//      Activate clicks idempotent) and AES-256-GCM-encrypted credentials
//   4. create/reuse the mt5_accounts row, an installation secret, and an
//      ea_license_activations row — the license is integrated automatically,
//      the user never enters a key
//   5. queue the `deploy` command for the node's agent
//
// The agent then builds the isolated MT5 environment and reports status back.

const crypto = require('crypto');
const { exclusive } = require('../db-write');
const { maskAccountNumber } = require('./sandbox-crypto');

const ACCOUNT_NUMBER_PATTERN = /^[0-9]{1,32}$/;
const MAX_PASSWORD_LENGTH = 128;

function createSandboxManager({ db, nodes, events, crypto: sandboxCrypto, subscriptions, now = () => Date.now() } = {}) {
  const isPostgres = typeof db.transaction === 'function';

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
      });
    });
  }

  async function withTransaction(task) {
    if (isPostgres) return db.transaction(task);
    return exclusive(db, async () => {
      await run('BEGIN IMMEDIATE');
      try {
        const result = await task();
        await run('COMMIT');
        return result;
      } catch (error) {
        await run('ROLLBACK').catch(() => {});
        throw error;
      }
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

  async function log(instanceId, nodeId, level, source, message) {
    try {
      await run(
        'INSERT INTO sandbox_logs (instance_id, node_id, level, source, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [instanceId, nodeId, level, source, String(message).slice(0, 2000), now()]
      );
    } catch (error) {
      console.error('Failed to write sandbox log:', error.message);
    }
  }

  function publicInstance(instance) {
    if (!instance) return null;
    return {
      instanceUid: instance.instance_uid,
      status: instance.status,
      brokerServer: instance.broker_server,
      mt5AccountNumber: instance.account_masked,
      strategyCode: instance.strategy_code,
      strategyName: instance.strategy_name,
      nodeUid: instance.node_uid,
      nodeName: instance.node_name,
      tradingPaused: Boolean(instance.trading_paused),
      lastHeartbeatAt: instance.last_heartbeat_at,
      lastError: instance.last_error,
      startedAt: instance.started_at,
      stoppedAt: instance.stopped_at,
      cpuPercent: instance.cpu_percent,
      memoryMb: instance.memory_mb,
      createdAt: instance.created_at
    };
  }

  async function getUserInstance(userId) {
    return get(
      `SELECT i.*, s.code AS strategy_code, s.name AS strategy_name, n.node_uid, n.name AS node_name
       FROM sandbox_instances i
       LEFT JOIN trading_strategies s ON s.id = i.strategy_id
       LEFT JOIN sandbox_nodes n ON n.id = i.node_id
       WHERE i.user_id = ? AND i.deleted_at IS NULL
       ORDER BY i.id DESC LIMIT 1`,
      [userId]
    );
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  async function activateSandbox(userId, {
    strategyCode = 'corngrid-ea',
    brokerServer,
    accountNumber,
    password,
    preferredNodeId = null,
    actorType = 'user',
    actorId = userId
  } = {}) {
    // --- Input validation ---------------------------------------------------
    if (typeof brokerServer !== 'string' || brokerServer.trim().length < 2 || brokerServer.trim().length > 100) {
      return { http: 400, body: { error: 'A valid broker server name is required.' } };
    }
    if (!ACCOUNT_NUMBER_PATTERN.test(String(accountNumber || ''))) {
      return { http: 400, body: { error: 'A valid MT5 account number is required.' } };
    }
    if (typeof password !== 'string' || password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
      return { http: 400, body: { error: 'A valid MT5 password is required.' } };
    }

    const strategy = await get(
      'SELECT * FROM trading_strategies WHERE code = ? AND is_active = TRUE AND is_published = TRUE',
      [String(strategyCode || '').trim()]
    );
    if (!strategy) {
      return { http: 400, body: { error: 'The selected trading strategy is not available.' } };
    }

    // --- Subscription gate --------------------------------------------------
    const subscription = await subscriptions.eligibleSubscription(userId);
    if (!subscription) {
      const fallback = (await subscriptions.currentSubscription(userId))
        || (await subscriptions.latestSubscription(userId));
      const status = fallback ? subscriptions.effectiveStatus(fallback) : 'none';
      return {
        http: 403,
        body: {
          error: 'An active CornGrid subscription is required to activate a sandbox.',
          code: 'SUBSCRIPTION_REQUIRED',
          subscriptionStatus: status
        }
      };
    }

    // --- Existing sandbox? (idempotency for repeated Activate clicks) -------
    const existing = await getUserInstance(userId);
    if (existing) {
      return { http: 200, body: { message: 'Sandbox already exists.', sandbox: publicInstance(existing), alreadyExists: true } };
    }

    // --- Allocate a node ------------------------------------------------------
    const node = await nodes.allocateNode({ preferredNodeId });
    if (!node) {
      return { http: 503, body: { error: 'No sandbox server capacity is available right now. Please try again shortly.', code: 'NO_CAPACITY' } };
    }

    const timestamp = now();
    const instanceUid = `sbx_${crypto.randomBytes(9).toString('hex')}`;
    const installationSecret = crypto.randomBytes(32).toString('hex');
    const installationSecretHash = crypto.createHash('sha256').update(installationSecret).digest('hex');
    const activationIdentifier = crypto.randomBytes(24).toString('hex');

    let instanceId;
    try {
      await withTransaction(async () => {
          const inserted = await run(
            `INSERT INTO sandbox_instances
               (instance_uid, user_id, node_id, strategy_id, status, broker_server, mt5_account_number, account_masked, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'allocating', ?, ?, ?, ?, ?)`,
            [instanceUid, userId, node.id, strategy.id, brokerServer.trim(), String(accountNumber).trim(),
             maskAccountNumber(accountNumber), timestamp, timestamp]
          );
          instanceId = inserted.lastID;

          await run(
            `INSERT INTO sandbox_credentials (instance_id, cipher, key_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [instanceId, sandboxCrypto.encryptJson({
              brokerServer: brokerServer.trim(),
              accountNumber: String(accountNumber).trim(),
              password
            }), sandboxCrypto.keyVersion, timestamp, timestamp]
          );

          // Link (or reuse) the MT5 account row so the EA's licence calls work.
          let account = await get(
            'SELECT * FROM mt5_accounts WHERE account_number = ? AND broker_server = ?',
            [String(accountNumber).trim(), brokerServer.trim()]
          );
          if (account && account.user_id !== userId) {
            const conflict = new Error('This MT5 account is already linked to a different CornGrid user.');
            conflict.statusCode = 409;
            throw conflict;
          }
          if (!account) {
            const created = await run(
              `INSERT INTO mt5_accounts (user_id, account_number, broker_server, currency, account_name, linked_at)
               VALUES (?, ?, ?, 'USD', 'CornGrid Sandbox', ?)`,
              [userId, String(accountNumber).trim(), brokerServer.trim(), timestamp]
            );
            account = { id: created.lastID };
          }
          await run(
            'INSERT INTO mt5_installations (account_id, secret_hash, created_at) VALUES (?, ?, ?)',
            [account.id, installationSecretHash, timestamp]
          );

          // Automatic licence activation bound to the verified subscription.
          const existingActivation = await get(
            'SELECT * FROM ea_license_activations WHERE user_id = ? AND mt5_account_number = ? AND broker_server = ?',
            [userId, String(accountNumber).trim(), brokerServer.trim()]
          );
          if (existingActivation) {
            await run(
              `UPDATE ea_license_activations
               SET subscription_id = ?, account_id = ?, activation_identifier = ?, license_status = 'active',
                   activated_at = ?, last_verified_at = ?, revoked_at = NULL, revocation_reason = NULL, updated_at = ?
               WHERE id = ?`,
              [subscription.id, account.id, activationIdentifier, timestamp, timestamp, timestamp, existingActivation.id]
            );
          } else {
            await run(
              `INSERT INTO ea_license_activations
                 (user_id, subscription_id, account_id, mt5_account_number, broker_server,
                  activation_identifier, license_status, activated_at, last_verified_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
              [userId, subscription.id, account.id, String(accountNumber).trim(), brokerServer.trim(),
               activationIdentifier, timestamp, timestamp, timestamp, timestamp]
            );
          }

          await run('UPDATE sandbox_instances SET status = ?, updated_at = ? WHERE id = ?', ['deploying', timestamp, instanceId]);
      });
    } catch (error) {
      if (error && error.statusCode === 409) {
        return { http: 409, body: { error: error.message } };
      }
      if (error && /UNIQUE constraint failed|duplicate key/i.test(error.message || '')) {
        // Concurrent activation won the race — return the existing sandbox.
        const winner = await getUserInstance(userId);
        if (winner) {
          return { http: 200, body: { message: 'Sandbox already exists.', sandbox: publicInstance(winner), alreadyExists: true } };
        }
      }
      console.error('Sandbox activation failed:', error.message);
      return { http: 500, body: { error: 'Unable to activate the sandbox. Please try again.' } };
    }

    // --- Dispatch the deploy command -----------------------------------------
    const deployPayload = {
      instanceUid,
      brokerServer: brokerServer.trim(),
      accountNumber: String(accountNumber).trim(),
      password,
      installationSecret,
      strategy: {
        code: strategy.code,
        name: strategy.name,
        version: strategy.version,
        eaFileName: strategy.ea_file_name
      },
      apiBaseUrl: process.env.APP_BASE_URL || null
    };
    const command = await nodes.queueCommand(node.id, 'deploy', { instanceId, payload: deployPayload });

    await events.emit('SANDBOX_REQUESTED', { actorType, actorId, instanceId, nodeId: node.id, payload: { instanceUid, strategy: strategy.code } });
    await events.emit('SANDBOX_ALLOCATED', { instanceId, nodeId: node.id, payload: { instanceUid, nodeUid: node.node_uid } });
    await events.emit('SANDBOX_DEPLOYING', { instanceId, nodeId: node.id, payload: { instanceUid, commandUid: command.commandUid } });
    await events.emit('LICENSE_VALIDATED', { actorType: 'system', instanceId, payload: { instanceUid, subscriptionId: subscription.id } });
    await log(instanceId, node.id, 'info', 'backend', `Sandbox ${instanceUid} allocated to node ${node.node_uid}; deploy command queued.`);

    const instance = await get('SELECT * FROM sandbox_instances WHERE id = ?', [instanceId]);
    return {
      http: 201,
      body: {
        message: 'Sandbox activation started. MT5 is being deployed on a sandbox server.',
        sandbox: publicInstance({ ...instance, strategy_code: strategy.code, strategy_name: strategy.name, node_uid: node.node_uid, node_name: node.name })
      }
    };
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  const CONTROL_COMMANDS = {
    start: { command: 'start', from: ['stopped', 'failed'], to: 'starting', event: 'SANDBOX_STARTED' },
    stop: { command: 'stop', from: ['running', 'starting', 'failed', 'deploying'], to: 'stopping', event: 'SANDBOX_STOPPED' },
    restart: { command: 'restart', from: ['running', 'stopped', 'failed'], to: 'starting', event: 'SANDBOX_STARTED' },
    pause: { command: 'pause_trading', from: ['running'], to: null, event: null },
    resume: { command: 'resume_trading', from: ['running'], to: null, event: null },
    reconnect: { command: 'reconnect', from: ['running', 'failed'], to: null, event: null }
  };

  async function controlSandbox(userId, action) {
    const spec = CONTROL_COMMANDS[action];
    if (!spec) {
      return { http: 400, body: { error: 'Unknown sandbox action.' } };
    }
    const instance = await getUserInstance(userId);
    if (!instance) {
      return { http: 404, body: { error: 'No sandbox exists for this account.' } };
    }
    if (instance.status === 'suspended') {
      return { http: 403, body: { error: 'This sandbox is suspended. Contact CornGrid support.' } };
    }
    if (!spec.from.includes(instance.status)) {
      return { http: 409, body: { error: `Cannot ${action} a sandbox that is ${instance.status}.`, status: instance.status } };
    }
    if (!instance.node_id) {
      return { http: 409, body: { error: 'This sandbox is not assigned to a node yet.' } };
    }

    const timestamp = now();
    if (action === 'pause') {
      await run('UPDATE sandbox_instances SET trading_paused = TRUE, updated_at = ? WHERE id = ?', [timestamp, instance.id]);
    } else if (action === 'resume') {
      await run('UPDATE sandbox_instances SET trading_paused = FALSE, updated_at = ? WHERE id = ?', [timestamp, instance.id]);
    } else if (spec.to) {
      await run('UPDATE sandbox_instances SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?', [spec.to, timestamp, instance.id]);
    }

    const command = await nodes.queueCommand(instance.node_id, spec.command, {
      instanceId: instance.id,
      payload: { instanceUid: instance.instance_uid }
    });
    if (spec.event) {
      await events.emit(spec.event, { actorType: 'user', actorId: userId, instanceId: instance.id, nodeId: instance.node_id, payload: { action } });
    }
    await log(instance.id, instance.node_id, 'info', 'backend', `User requested ${action}; command ${command.commandUid} queued.`);

    const updated = await getUserInstance(userId);
    return { http: 200, body: { message: `Sandbox ${action} requested.`, sandbox: publicInstance(updated) } };
  }

  async function deleteSandbox(userId, { actorType = 'user', actorId = userId } = {}) {
    const instance = await getUserInstance(userId);
    if (!instance) {
      return { http: 404, body: { error: 'No sandbox exists for this account.' } };
    }
    const timestamp = now();

    // Tell the agent to tear down the environment first (best effort — the
    // node may be offline; a janitor pass on the agent reconciles later).
    if (instance.node_id) {
      await nodes.queueCommand(instance.node_id, 'destroy', {
        instanceId: instance.id,
        payload: { instanceUid: instance.instance_uid, sandboxPath: instance.sandbox_path }
      });
    }

    await run('UPDATE sandbox_instances SET deleted_at = ?, status = ?, process_id = NULL, updated_at = ? WHERE id = ?',
      [timestamp, 'stopped', timestamp, instance.id]);
    await run('DELETE FROM sandbox_credentials WHERE instance_id = ?', [instance.id]);
    // Revoke the sandbox installation secrets so a leaked secret dies with the sandbox.
    await run(
      `UPDATE mt5_installations SET revoked_at = ?
       WHERE account_id IN (SELECT id FROM mt5_accounts WHERE account_number = ? AND broker_server = ?)
         AND revoked_at IS NULL`,
      [timestamp, instance.mt5_account_number || '', instance.broker_server || '']
    );

    await events.emit('SANDBOX_DELETED', { actorType, actorId, instanceId: instance.id, nodeId: instance.node_id, payload: { instanceUid: instance.instance_uid } });
    await log(instance.id, instance.node_id, 'info', 'backend', `Sandbox ${instance.instance_uid} deleted.`);
    return { http: 200, body: { message: 'Sandbox deleted. Your trading account configuration and subscription are unaffected.' } };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async function sandboxStatus(userId) {
    const instance = await getUserInstance(userId);
    if (!instance) {
      return { sandbox: null };
    }
    const subscription = await subscriptions.currentSubscription(userId);
    const subscriptionStatus = subscription ? subscriptions.effectiveStatus(subscription) : 'none';
    const node = instance.node_id
      ? await get('SELECT node_uid, name, last_heartbeat_at FROM sandbox_nodes WHERE id = ?', [instance.node_id])
      : null;
    const nodeOnline = Boolean(node && node.last_heartbeat_at && (now() - node.last_heartbeat_at) < nodes.NODE_OFFLINE_AFTER_MS);

    return {
      sandbox: publicInstance(instance),
      subscription: {
        status: subscriptionStatus,
        expiresAt: subscription ? subscription.expires_at : null,
        planName: subscription ? subscription.plan_name : null
      },
      node: node ? { nodeUid: node.node_uid, name: node.name, online: nodeOnline } : null,
      mt5Connection: instance.status === 'running' ? 'connected' : (instance.status === 'starting' || instance.status === 'deploying' ? 'connecting' : 'disconnected')
    };
  }

  return {
    activateSandbox,
    controlSandbox,
    deleteSandbox,
    sandboxStatus,
    getUserInstance,
    publicInstance,
    log
  };
}

module.exports = { createSandboxManager };
