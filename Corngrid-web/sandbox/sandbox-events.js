'use strict';

// Sandbox event bus.
//
// Every meaningful state change (sandbox requested/allocated/started/failed,
// node online/offline, EA submitted/approved, commission generated, ...) is
// persisted to sandbox_events for admin inspection AND broadcast to in-process
// listeners (the realtime hub pushes them to admin dashboards over WebSocket).

const EVENT_TYPES = Object.freeze([
  'SANDBOX_REQUESTED',
  'SANDBOX_ALLOCATED',
  'SANDBOX_DEPLOYING',
  'SANDBOX_STARTED',
  'SANDBOX_STOPPED',
  'SANDBOX_FAILED',
  'SANDBOX_DELETED',
  'SANDBOX_SUSPENDED',
  'MT5_CONNECTED',
  'MT5_DISCONNECTED',
  'LICENSE_VALIDATED',
  'NODE_ONLINE',
  'NODE_OFFLINE',
  'NODE_REGISTERED',
  'EA_SUBMITTED',
  'EA_APPROVED',
  'EA_REJECTED',
  'EA_PUBLISHED',
  'EA_TEST_STARTED',
  'EA_TEST_FINISHED',
  'COMMISSION_GENERATED',
  'PAYOUT_REQUESTED',
  'PAYOUT_APPROVED',
  'PAYOUT_PAID'
]);

function createSandboxEvents({ db, now = () => Date.now() } = {}) {
  const listeners = new Set();

  function run(sql, params) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
      });
    });
  }

  async function emit(eventType, {
    actorType = null,
    actorId = null,
    instanceId = null,
    nodeId = null,
    payload = null
  } = {}) {
    const record = {
      event_type: eventType,
      actor_type: actorType,
      actor_id: actorId,
      instance_id: instanceId,
      node_id: nodeId,
      payload_json: payload == null ? null : JSON.stringify(payload),
      created_at: now()
    };

    try {
      const result = await run(
        `INSERT INTO sandbox_events (event_type, actor_type, actor_id, instance_id, node_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.event_type, record.actor_type, record.actor_id, record.instance_id, record.node_id, record.payload_json, record.created_at]
      );
      record.id = result && result.lastID;
    } catch (error) {
      // Event persistence must never break the operation that raised it.
      console.error(`Failed to persist sandbox event ${eventType}:`, error.message);
    }

    for (const listener of listeners) {
      try {
        listener(record);
      } catch (error) {
        console.error('Sandbox event listener failed:', error.message);
      }
    }
    return record;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { emit, subscribe, EVENT_TYPES };
}

module.exports = { createSandboxEvents, EVENT_TYPES };
