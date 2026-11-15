'use strict';
const { createReportService } = require('./report-service');
module.exports = function registerReportApi(app, db, { verifyToken, verifyAdminToken, rateLimit }) {
  const service = createReportService(db, { heartbeatSeconds: Number(process.env.MT5_HEARTBEAT_TIMEOUT_SECONDS) || 180 });
  const limiter = rateLimit({ limit: 40, windowMs: 60000, message: 'Please wait before generating another report.' });
  for (const [role, prefix, auth] of [['user', '/api/reports', verifyToken], ['admin', '/api/admin/reports', verifyAdminToken]]) {
    app.get(prefix + '/options', auth, limiter, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(await service.options(role, req.user?.id)); }
      catch (error) { console.error('Report options failed:', error.code || error.name); res.status(503).json({ error: 'Report data is temporarily unavailable.' }); }
    });
    app.get(prefix, auth, limiter, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(await service.generate(role, req.user?.id, req.query)); }
      catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        console.error('Report generation failed:', error.code || error.name);
        res.status(503).json({ error: 'Unable to read report data. Please retry.' });
      }
    });
  }
  return service;
};
