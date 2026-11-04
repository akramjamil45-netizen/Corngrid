'use strict';

// User-facing Sandbox API. All routes require the existing CornGrid user JWT
// (verifyToken) and only ever touch the caller's own sandbox row.

function createSandboxApi({ db, manager, rateLimit } = {}) {
  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
    });
  }

  function registerRoutes(app, verifyToken) {
    const activateRateLimit = rateLimit({ limit: 10, windowMs: 15 * 60 * 1000 });
    const controlRateLimit = rateLimit({ limit: 60, windowMs: 15 * 60 * 1000 });

    // Strategies available for sandbox deployment (published only).
    app.get('/api/sandbox/strategies', verifyToken, async (_req, res) => {
      try {
        const strategies = await all(
          `SELECT code, name, description, version
           FROM trading_strategies
           WHERE is_active = TRUE AND is_published = TRUE
           ORDER BY id ASC`
        );
        res.json({ strategies });
      } catch (error) {
        console.error('Failed to list strategies:', error.message);
        res.status(500).json({ error: 'Unable to load trading strategies.' });
      }
    });

    // Full live status for the dashboard.
    app.get('/api/sandbox/status', verifyToken, async (req, res) => {
      try {
        res.json(await manager.sandboxStatus(req.user.id));
      } catch (error) {
        console.error('Failed to load sandbox status:', error.message);
        res.status(500).json({ error: 'Unable to load sandbox status.' });
      }
    });

    // Activate a sandbox. Idempotent: repeated calls return the existing one.
    app.post('/api/sandbox/activate', activateRateLimit, verifyToken, async (req, res) => {
      const body = req.body || {};
      const result = await manager.activateSandbox(req.user.id, {
        strategyCode: body.strategyCode,
        brokerServer: body.brokerServer,
        accountNumber: body.accountNumber,
        password: body.password,
        actorType: 'user',
        actorId: req.user.id
      });
      res.status(result.http).json(result.body);
    });

    // Controls. `pause`/`resume` toggle trading; the rest manage the process.
    // Registered as literal routes (not a loop) so the static route analysis
    // in test/client-api-paths.test.js can see them.
    const controlHandler = action => async (req, res) => {
      const result = await manager.controlSandbox(req.user.id, action);
      res.status(result.http).json(result.body);
    };
    app.post('/api/sandbox/start', controlRateLimit, verifyToken, controlHandler('start'));
    app.post('/api/sandbox/stop', controlRateLimit, verifyToken, controlHandler('stop'));
    app.post('/api/sandbox/restart', controlRateLimit, verifyToken, controlHandler('restart'));
    app.post('/api/sandbox/pause', controlRateLimit, verifyToken, controlHandler('pause'));
    app.post('/api/sandbox/resume', controlRateLimit, verifyToken, controlHandler('resume'));
    app.post('/api/sandbox/reconnect', controlRateLimit, verifyToken, controlHandler('reconnect'));

    // Delete. The client must ask for confirmation; the backend additionally
    // requires the explicit flag so a stray call cannot wipe a sandbox.
    app.delete('/api/sandbox', controlRateLimit, verifyToken, async (req, res) => {
      if (!req.body || req.body.confirm !== true) {
        return res.status(400).json({ error: 'Deletion requires explicit confirmation.', code: 'CONFIRMATION_REQUIRED' });
      }
      const result = await manager.deleteSandbox(req.user.id, { actorType: 'user', actorId: req.user.id });
      res.status(result.http).json(result.body);
    });
  }

  return { registerRoutes };
}

module.exports = { createSandboxApi };
