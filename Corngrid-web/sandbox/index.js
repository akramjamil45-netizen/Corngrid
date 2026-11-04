'use strict';

// Sandbox subsystem composer. Wires schema, crypto, events, node registry,
// manager, and the HTTP/WS APIs into the main Express app — following the same
// module pattern as mt5-api.js and subscriptions/subscription-api.js.

const { ensureSchema, seedDefaultStrategy } = require('./sandbox-schema');
const { createSandboxCrypto } = require('./sandbox-crypto');
const { createSandboxEvents } = require('./sandbox-events');
const { createSandboxNodes } = require('./sandbox-nodes');
const { createSandboxManager } = require('./sandbox-manager');
const { createSandboxApi } = require('./sandbox-api');
const { createSandboxAdminApi } = require('./sandbox-admin-api');
const { createSandboxNodeApi } = require('./sandbox-node-api');
const { createSandboxRealtime } = require('./sandbox-realtime');

function createSandboxSystem(app, db, { verifyToken, adminAuth, subscriptionApi, rateLimit, jwtSecret }) {
  const crypto = createSandboxCrypto();
  const events = createSandboxEvents({ db });
  const nodes = createSandboxNodes({ db, events });
  const manager = createSandboxManager({ db, nodes, events, crypto, subscriptions: subscriptionApi });
  const api = createSandboxApi({ db, manager, rateLimit });
  const adminApi = createSandboxAdminApi({ db, nodes, events, manager, subscriptions: subscriptionApi, crypto });
  const nodeApi = createSandboxNodeApi({ db, nodes, events, manager, rateLimit });
  const realtime = createSandboxRealtime({ db, nodes, events, jwtSecret });

  // SQLite: self-apply the schema (idempotent). PostgreSQL: migrations are
  // applied by scripts/apply-postgres-migrations.js; verify presence instead.
  const ready = (async () => {
    if (typeof db.transaction === 'function') {
      try {
        await new Promise((resolve, reject) => {
          db.get('SELECT 1 AS ok FROM sandbox_nodes LIMIT 1', [], error => (error ? reject(error) : resolve()));
        });
      } catch (_error) {
        console.error('Sandbox tables are missing. Apply migrations/postgres/0005_sandbox.sql before using the sandbox system.');
        return;
      }
      await seedDefaultStrategy(db);
    } else {
      await ensureSchema(db);
      await seedDefaultStrategy(db);
    }
  })();

  api.registerRoutes(app, verifyToken);
  adminApi.registerRoutes(app, adminAuth.verifyToken);
  nodeApi.registerRoutes(app);

  return { ready, crypto, events, nodes, manager, realtime, nodeApi };
}

module.exports = { createSandboxSystem };
