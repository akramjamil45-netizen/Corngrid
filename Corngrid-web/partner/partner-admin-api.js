'use strict';

// Admin API for the Partner Program: submission review, isolated EA testing,
// approval/publishing, commission configuration, and payout management.
// Every mutation is written to the subscription audit log.

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exclusive } = require('../db-write');

function createPartnerAdminApi({ db, nodes, events, subscriptions, commissionService, storageDir, publication, rateLimit, now = () => Date.now() } = {}) {
  const SUBMISSIONS_DIR = storageDir || path.join(__dirname, '..', 'storage', 'ea-submissions');

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

  async function withTransaction(task) {
    if (typeof db.transaction === 'function') return db.transaction(task);
    return exclusive(db, async () => {
      await run('BEGIN IMMEDIATE');
      try { const result = await task(); await run('COMMIT'); return result; }
      catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
    });
  }

  function publicSubmissionAdmin(row) {
    return {
      id: row.id,
      submissionUid: row.submission_uid,
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      partnerEmail: row.partner_email,
      name: row.name,
      description: row.description,
      version: row.version,
      symbols: row.symbols,
      strategyDescription: row.strategy_description,
      riskDescription: row.risk_description,
      documentation: row.documentation,
      status: row.status,
      reviewNotes: row.review_notes,
      rejectionReason: row.rejection_reason,
      reviewedAt: row.reviewed_at,
      publishedAt: row.published_at,
      strategyId: row.strategy_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function registerRoutes(app, verifyAdminToken, authenticateNodeRequest) {
    // -----------------------------------------------------------------------
    // Partners
    // -----------------------------------------------------------------------
    app.get('/api/admin/partners', verifyAdminToken, async (_req, res) => {
      try {
        const rows = await all(`
          SELECT p.*, u.username, u.email,
                 (SELECT COUNT(*) FROM ea_submissions s WHERE s.partner_id = p.user_id AND s.deleted_at IS NULL) AS submission_count,
                 (SELECT COALESCE(SUM(t.commission_amount), 0) FROM partner_transactions t WHERE t.partner_id = p.user_id AND t.status IN ('approved','paid')) AS earnings_total
          FROM partner_profiles p JOIN users u ON u.id = p.user_id
          ORDER BY p.created_at DESC`);
        res.json({
          partners: rows.map(row => ({
            userId: row.user_id,
            displayName: row.display_name,
            company: row.company,
            website: row.website,
            status: row.status,
            username: row.username,
            email: row.email,
            submissionCount: Number(row.submission_count) || 0,
            earningsTotal: Number(row.earnings_total) || 0,
            createdAt: row.created_at
          }))
        });
      } catch (error) {
        console.error('Failed to list partners:', error.message);
        res.status(500).json({ error: 'Unable to list partners.' });
      }
    });

    app.post('/api/admin/partners/:userId/status', verifyAdminToken, async (req, res) => {
      const userId = Number.parseInt(req.params.userId, 10);
      const status = req.body && req.body.status;
      if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid partner.' });
      if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Status must be active or suspended.' });
      try {
        const result = await run('UPDATE partner_profiles SET status = ?, updated_at = ? WHERE user_id = ?', [status, now(), userId]);
        if (!result.changes) return res.status(404).json({ error: 'Partner not found.' });
        await subscriptions.logAudit(null, 'admin', `partner_${status}`, 'partner', userId, null, req.body.reason || null, req.ip);
        res.json({ message: `Partner ${status}.` });
      } catch (error) {
        console.error('Failed to update partner status:', error.message);
        res.status(500).json({ error: 'Unable to update the partner.' });
      }
    });

    // -----------------------------------------------------------------------
    // EA submissions review
    // -----------------------------------------------------------------------
    app.get('/api/admin/ea-submissions', verifyAdminToken, async (req, res) => {
      try {
        const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
        const conditions = ['s.deleted_at IS NULL'];
        const params = [];
        if (status) {
          conditions.push('s.status = ?');
          params.push(status);
        }
        const rows = await all(
          `SELECT s.*, p.display_name AS partner_name, u.email AS partner_email
           FROM ea_submissions s
           JOIN partner_profiles p ON p.user_id = s.partner_id
           JOIN users u ON u.id = s.partner_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY s.id DESC LIMIT 200`,
          params
        );
        res.json({ submissions: rows.map(publicSubmissionAdmin) });
      } catch (error) {
        console.error('Failed to list EA submissions:', error.message);
        res.status(500).json({ error: 'Unable to list submissions.' });
      }
    });

    app.get('/api/admin/ea-submissions/:id', verifyAdminToken, async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission.' });
      try {
        const row = await get(
          `SELECT s.*, p.display_name AS partner_name, u.email AS partner_email
           FROM ea_submissions s
           JOIN partner_profiles p ON p.user_id = s.partner_id
           JOIN users u ON u.id = s.partner_id
           WHERE s.id = ? AND s.deleted_at IS NULL`,
          [id]
        );
        if (!row) return res.status(404).json({ error: 'Submission not found.' });
        const versions = await all('SELECT * FROM ea_versions WHERE submission_id = ? ORDER BY id DESC', [id]);
        const reports = await all('SELECT * FROM ea_test_reports WHERE submission_id = ? ORDER BY id DESC LIMIT 20', [id]);
        // List source file names (not contents) for the review screen.
        const dir = path.join(SUBMISSIONS_DIR, row.submission_uid);
        let files = [];
        try {
          files = fs.readdirSync(dir).map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }));
        } catch { /* directory missing */ }
        res.json({ submission: publicSubmissionAdmin(row), publication: await publication.inspect(id),
          presets: await all('SELECT symbol,file_name AS name,content_text AS text FROM ea_submission_presets WHERE submission_id=?',[id]), versions, testReports: reports, files });
      } catch (error) {
        console.error('Failed to load submission detail:', error.message);
        res.status(500).json({ error: 'Unable to load the submission.' });
      }
    });

    // Download a single source file for review. Admin-only, path-sanitized.
    app.get('/api/admin/ea-submissions/:id/files/:filename', verifyAdminToken, async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission.' });
      try {
        const row = await get('SELECT submission_uid FROM ea_submissions WHERE id = ? AND deleted_at IS NULL', [id]);
        if (!row) return res.status(404).json({ error: 'Submission not found.' });
        const filename = path.basename(String(req.params.filename));
        const base = path.resolve(SUBMISSIONS_DIR, row.submission_uid);
        const absolute = path.resolve(base, filename);
        if (!absolute.startsWith(base + path.sep) || !fs.existsSync(absolute)) {
          return res.status(404).json({ error: 'File not found.' });
        }
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        fs.createReadStream(absolute).pipe(res);
      } catch (error) {
        console.error('Failed to download submission file:', error.message);
        res.status(500).json({ error: 'Unable to download the file.' });
      }
    });

    // Transition helper for the review workflow.
    async function transition(req, res, { id, from, to, extra = {}, auditAction, eventType, buildUpdates = () => ({}) }) {
      const row = await get('SELECT * FROM ea_submissions WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!row) return res.status(404).json({ error: 'Submission not found.' });
      if (from && !from.includes(row.status)) {
        return res.status(409).json({ error: `Cannot move a submission from ${row.status} to ${to}.` });
      }
      const timestamp = now();
      const updates = { status: to, updated_at: timestamp, ...buildUpdates(row) };
      const assignments = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const changed=await run(`UPDATE ea_submissions SET ${assignments} WHERE id = ? AND status = ? AND deleted_at IS NULL`, [...Object.values(updates), id, row.status]);
      if(!changed.changes)return res.status(409).json({error:'The submission changed. Refresh the review.'});
      await subscriptions.logAudit(null, 'admin', auditAction, 'ea_submission', id,
        { submissionUid: row.submission_uid, from: row.status, to, ...extra }, extra.reason || null, req.ip);
      if (eventType) {
        await events.emit(eventType, { actorType: 'admin', payload: { submissionUid: row.submission_uid, name: row.name, ...extra } });
      }
      return res.json({ message: `Submission ${to.replace(/_/g, ' ')}.`, status: to });
    }

    app.post('/api/admin/ea-submissions/:id/review', verifyAdminToken, async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission.' });
      try {
        await transition(req, res, {
          id, from: ['pending_review', 'testing_failed'], to: 'under_review',
          auditAction: 'ea_review_started',
          buildUpdates: () => ({ reviewed_by: null, reviewed_at: now() })
        });
      } catch (error) {
        console.error('Failed to start review:', error.message);
        res.status(500).json({ error: 'Unable to start the review.' });
      }
    });

    const publicationError = (res,error) => {
      if(error.status)return res.status(error.status).json({error:error.message,code:error.code});
      console.error('EA publication failed:',error.code||error.name);
      res.status(500).json({error:'Unable to publish the reviewed EA release. Please retry.'});
    };
    app.post('/api/admin/ea-submissions/:id/approve',verifyAdminToken,async(req,res)=>{
      try { res.json(await publication.approve(Number(req.params.id),{actor:{role:'admin',id:req.admin?.id||'admin'},reviewDigest:req.body?.reviewDigest})); }
      catch(error){publicationError(res,error);}
    });
    app.post('/api/admin/ea-submissions/:id/publish',verifyAdminToken,async(req,res)=>{
      try { res.json(await publication.approve(Number(req.params.id),{actor:{role:'admin',id:req.admin?.id||'admin'},reviewDigest:req.body?.reviewDigest})); }
      catch(error){publicationError(res,error);}
    });
    app.post('/api/admin/ea-submissions/:id/reject',verifyAdminToken,async(req,res)=>{
      try {await publication.reject(Number(req.params.id),{actor:{role:'admin',id:req.admin?.id||'admin'},reason:req.body?.reason});res.json({message:'EA release rejected.'});}
      catch(error){publicationError(res,error);}
    });
    app.get('/api/admin/ea-submissions/:id/artifact',verifyAdminToken,async(req,res)=>{
      try {const a=await publication.artifactFile(Number(req.params.id));res.set('Content-Type','application/octet-stream');res.set('Content-Disposition','attachment; filename="reviewed.ex5"');res.send(await fs.promises.readFile(a.path));}
      catch(error){publicationError(res,error);}
    });
    app.post('/api/admin/ea-submissions/:id/artifact',verifyAdminToken,rateLimit({limit:20,windowMs:3600000}),express.raw({type:'application/octet-stream',limit:'10mb'}),async(req,res)=>{
      try {res.status(201).json(await publication.attachArtifact(Number(req.params.id),req.body,{origin:'admin',actor:{role:'admin',id:req.admin?.id||'admin'}}));}
      catch(error){publicationError(res,error);}
    });

    // -----------------------------------------------------------------------
    // Isolated EA testing on designated test nodes
    // -----------------------------------------------------------------------
    app.post('/api/admin/ea-submissions/:id/test', verifyAdminToken, async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission.' });
      try {
        const row = await get('SELECT * FROM ea_submissions WHERE id = ? AND deleted_at IS NULL', [id]);
        if (!row) return res.status(404).json({ error: 'Submission not found.' });
        if (!['under_review', 'testing_failed', 'testing_passed'].includes(row.status)) {
          return res.status(409).json({ error: `Cannot test a submission that is ${row.status}. Start the review first.` });
        }

        // Testing only ever happens on nodes flagged as test nodes — never on
        // production nodes hosting real user sandboxes.
        const cutoff = now() - nodes.NODE_OFFLINE_AFTER_MS;
        const testNode = await get(
          `SELECT * FROM sandbox_nodes
           WHERE status = 'active' AND is_test_node = TRUE AND last_heartbeat_at >= ?
           ORDER BY COALESCE(cpu_percent, 9999) ASC LIMIT 1`,
          [cutoff]
        );
        if (!testNode) {
          return res.status(503).json({ error: 'No online test node is available. Register and activate a test node first.', code: 'NO_TEST_NODE' });
        }

        let report,command;
        await withTransaction(async()=>{
          const current=await get('SELECT * FROM ea_submissions WHERE id=?'+(typeof db.transaction==='function'?' FOR UPDATE':''),[id]);
          if(!current||!['under_review','testing_failed','testing_passed'].includes(current.status))throw Object.assign(Error('The submission is no longer available for compilation.'),{status:409});
          const release=await publication.inspect(id);
          if(!release?.current||!release.entryFile||!/\.mq5$/i.test(release.entryFile))throw Object.assign(Error('Compile requires the current MQ5 source submission. Review uploaded EX5 files directly.'),{status:409});
          const timestamp=now();
          report=await run(`INSERT INTO ea_test_reports(submission_id,version_id,node_id,kind,status,started_at,created_at) VALUES(?,?,?,'compile','running',?,?)`,[id,release.versionId,testNode.id,timestamp,timestamp]);
          await run(`UPDATE ea_submissions SET status='testing',updated_at=? WHERE id=?`,[timestamp,id]);
          command=await nodes.queueCommand(testNode.id,'test_ea',{deferDelivery:true,payload:{testInstanceUid:'eatest_'+crypto.randomBytes(9).toString('hex'),submissionId:id,submissionUid:row.submission_uid,versionId:release.versionId,reportId:report.lastID}});
        });
        await nodes.dispatchCommand(command);

        await subscriptions.logAudit(null, 'admin', 'ea_test_started', 'ea_submission', id,
          { submissionUid: row.submission_uid, nodeId: testNode.id, reportId: report.lastID }, null, req.ip);
        await events.emit('EA_TEST_STARTED', { actorType: 'admin', nodeId: testNode.id, payload: { submissionUid: row.submission_uid, reportId: report.lastID } });
        res.json({ message: `Source compilation started on test node ${testNode.name}.`, reportId: report.lastID });
      } catch (error) {
        if(error.status)return res.status(error.status).json({error:error.message});
        console.error('Failed to start EA test:', error.code||error.name);
        res.status(500).json({ error: 'Unable to start the test.' });
      }
    });

    // Source bundle download used by the TEST NODE agent (node token auth is
    // enforced by the caller mounting this with authenticateNodeRequest).
    function registerTestNodeRoutes(app, authenticateNodeRequest) {
      function requireTestNode(req, res, next) {
        if (req.node?.status !== 'active' || ![true, 1, '1', 't', 'true'].includes(req.node?.is_test_node)) {
          return res.status(403).json({ error: 'An active assigned test node is required.' });
        }
        next();
      }
      function assignedSource(id, nodeId) {
        return get(`SELECT s.submission_uid FROM ea_submissions s
          WHERE s.id = ? AND s.deleted_at IS NULL AND s.status = 'testing'
          AND EXISTS (SELECT 1 FROM ea_test_reports r
            WHERE r.submission_id = s.id AND r.node_id = ? AND r.status = 'running'
            AND r.id = (SELECT MAX(latest.id) FROM ea_test_reports latest WHERE latest.submission_id = s.id))`, [id, nodeId]);
      }
      app.get('/api/admin/ea-testing/:id/source', authenticateNodeRequest, requireTestNode, async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission.' });
        try {
          const row = await assignedSource(id, req.node.id);
          if (!row) return res.status(404).json({ error: 'Submission not found.' });
          const dir = path.resolve(SUBMISSIONS_DIR, row.submission_uid);
          if (!dir.startsWith(path.resolve(SUBMISSIONS_DIR) + path.sep) || !fs.existsSync(dir)) {
            return res.status(404).json({ error: 'Source files are missing.' });
          }
          // Send a manifest + each file; the agent downloads individually.
          const files = fs.readdirSync(dir).map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }));
          res.json({ submissionUid: row.submission_uid, files, publication:await publication.inspect(id) });
        } catch (error) {
          console.error('Failed to list test source:', error.message);
          res.status(500).json({ error: 'Unable to list source files.' });
        }
      });

      app.get('/api/admin/ea-testing/:id/source/:filename', authenticateNodeRequest, requireTestNode, async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission.' });
        try {
          const row = await assignedSource(id, req.node.id);
          if (!row) return res.status(404).json({ error: 'Submission not found.' });
          const filename = path.basename(String(req.params.filename));
          const base = path.resolve(SUBMISSIONS_DIR, row.submission_uid);
          const absolute = path.resolve(base, filename);
          if (!absolute.startsWith(base + path.sep) || !fs.existsSync(absolute)) {
            return res.status(404).json({ error: 'File not found.' });
          }
          res.set('Content-Type', 'application/octet-stream');
          fs.createReadStream(absolute).pipe(res);
        } catch (error) {
          console.error('Failed to serve test source file:', error.message);
          res.status(500).json({ error: 'Unable to serve the file.' });
        }
      });

      app.post('/api/admin/ea-testing/reports/:reportId/artifact',authenticateNodeRequest,requireTestNode,express.raw({type:'application/octet-stream',limit:'10mb'}),async(req,res)=>{
        try {
          const report=await get('SELECT * FROM ea_test_reports WHERE id=? AND node_id=?',[Number(req.params.reportId),req.node.id]);
          if(!report)return res.status(404).json({error:'Test report not found.'});
          res.status(201).json(await publication.attachArtifact(report.submission_id,req.body,{origin:'test_node',reportId:report.id,actor:{role:'test_node',id:req.node.id}}));
        }catch(error){publicationError(res,error);}
      });

      // Test report callback from the test node agent.
      app.post('/api/admin/ea-testing/reports/:reportId/complete', authenticateNodeRequest, requireTestNode, async (req, res) => {
        const reportId = Number.parseInt(req.params.reportId, 10);
        if (!Number.isSafeInteger(reportId) || reportId < 1) return res.status(400).json({ error: 'Invalid report.' });
        const body = req.body || {};
        try {
          const report = await get('SELECT * FROM ea_test_reports WHERE id = ? AND node_id = ?', [reportId, req.node.id]);
          if (!report) return res.status(404).json({ error: 'Report not found.' });
          if (report.status !== 'running') return res.status(409).json({ error: 'This report is already finished.' });

          const success = body.success === true;
          const publicationInfo=await publication.inspect(report.submission_id);
          if(publicationInfo&&(!publicationInfo.current||publicationInfo.versionId!==report.version_id))return res.status(409).json({error:'The compile assignment was superseded.'});
          if(success&&publicationInfo&&!publicationInfo.artifactReady)return res.status(409).json({error:'A successful compile report requires the exact uploaded EX5 artifact.'});
          const timestamp = now();
          const completed = await withTransaction(async () => {
            const updated = await run(
              `UPDATE ea_test_reports
               SET status = ?, compile_log = ?, runtime_log = ?, cpu_avg = ?, memory_peak_mb = ?, error_count = ?, finished_at = ?
               WHERE id = ? AND node_id = ? AND status = 'running'`,
              [success ? 'passed' : 'failed',
                typeof body.compileLog === 'string' ? body.compileLog.slice(0, 20000) : null,
                typeof body.runtimeLog === 'string' ? body.runtimeLog.slice(0, 20000) : null,
                typeof body.cpuAvg === 'number' ? body.cpuAvg : null,
                typeof body.memoryPeakMb === 'number' ? body.memoryPeakMb : null,
                Number.isInteger(body.errorCount) ? body.errorCount : 0,
                timestamp, reportId, req.node.id]
            );
            if (!updated.changes) return false;
            await run(
              `UPDATE ea_submissions SET status = ?, updated_at = ? WHERE id = ? AND status = 'testing'
               AND NOT EXISTS (SELECT 1 FROM ea_test_reports later WHERE later.submission_id = ? AND later.id > ?)`,
              [success ? 'testing_passed' : 'testing_failed', timestamp, report.submission_id, report.submission_id, reportId]
            );
            return true;
          });
          if (!completed) return res.status(409).json({ error: 'This report is already finished.' });
          await events.emit('EA_TEST_FINISHED', {
            actorType: 'system', nodeId: req.node.id,
            payload: { reportId, submissionId: report.submission_id, success }
          });
          res.json({ ok: true });
        } catch (error) {
          console.error('Failed to complete test report:', error.message);
          res.status(500).json({ error: 'Unable to record the test report.' });
        }
      });
    }

    // -----------------------------------------------------------------------
    // Commission configuration
    // -----------------------------------------------------------------------
    app.get('/api/admin/commissions', verifyAdminToken, async (_req, res) => {
      try {
        const rows = await all(`
          SELECT c.*, p.display_name AS partner_name, s.name AS strategy_name
          FROM partner_commissions c
          JOIN partner_profiles p ON p.user_id = c.partner_id
          LEFT JOIN trading_strategies s ON s.id = c.strategy_id
          ORDER BY c.id DESC`);
        res.json({
          commissions: rows.map(row => ({
            id: row.id,
            partnerId: row.partner_id,
            partnerName: row.partner_name,
            strategyId: row.strategy_id,
            strategyName: row.strategy_name,
            model: row.model,
            percent: row.percent,
            fixedAmount: row.fixed_amount,
            currency: row.currency,
            appliesTo: row.applies_to,
            minPayoutThreshold: row.min_payout_threshold,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            isActive: Boolean(row.is_active),
            createdAt: row.created_at
          }))
        });
      } catch (error) {
        console.error('Failed to list commissions:', error.message);
        res.status(500).json({ error: 'Unable to list commission rules.' });
      }
    });

    app.post('/api/admin/commissions', verifyAdminToken, async (req, res) => {
      const body = req.body || {};
      const partnerId = Number.parseInt(body.partnerId, 10);
      if (!Number.isSafeInteger(partnerId) || partnerId < 1) return res.status(400).json({ error: 'A partner is required.' });
      const model = body.model === 'fixed' ? 'fixed' : 'percent';
      const percent = model === 'percent' ? Number(body.percent) : null;
      const fixedAmount = model === 'fixed' ? Number(body.fixedAmount) : null;
      if (model === 'percent' && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
        return res.status(400).json({ error: 'Percent must be between 0 and 100.' });
      }
      if (model === 'fixed' && (!Number.isFinite(fixedAmount) || fixedAmount <= 0)) {
        return res.status(400).json({ error: 'Fixed amount must be positive.' });
      }
      const appliesTo = ['subscription', 'renewal', 'both'].includes(body.appliesTo) ? body.appliesTo : 'both';
      const threshold = Number.isFinite(Number(body.minPayoutThreshold)) && Number(body.minPayoutThreshold) >= 0
        ? Number(body.minPayoutThreshold) : 100;
      const strategyId = Number.isSafeInteger(Number(body.strategyId)) && Number(body.strategyId) > 0 ? Number(body.strategyId) : null;
      try {
        const partner = await get('SELECT user_id FROM partner_profiles WHERE user_id = ?', [partnerId]);
        if (!partner) return res.status(404).json({ error: 'Partner not found.' });
        const timestamp = now();
        const inserted = await run(
          `INSERT INTO partner_commissions
             (partner_id, strategy_id, model, percent, fixed_amount, currency, applies_to, min_payout_threshold, effective_from, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'MYR', ?, ?, ?, TRUE, ?, ?)`,
          [partnerId, strategyId, model, percent, fixedAmount, appliesTo, threshold, timestamp, timestamp, timestamp]
        );
        await subscriptions.logAudit(null, 'admin', 'commission_rule_created', 'partner_commission', inserted.lastID,
          { partnerId, strategyId, model, percent, fixedAmount, appliesTo }, null, req.ip);
        res.status(201).json({ message: 'Commission rule created.', id: inserted.lastID });
      } catch (error) {
        console.error('Failed to create commission rule:', error.message);
        res.status(500).json({ error: 'Unable to create the commission rule.' });
      }
    });

    app.put('/api/admin/commissions/:id', verifyAdminToken, async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid commission rule.' });
      const body = req.body || {};
      try {
        const rule = await get('SELECT * FROM partner_commissions WHERE id = ?', [id]);
        if (!rule) return res.status(404).json({ error: 'Commission rule not found.' });
        const model = body.model === 'fixed' ? 'fixed' : (body.model === 'percent' ? 'percent' : rule.model);
        const percent = body.percent !== undefined ? Number(body.percent) : rule.percent;
        const fixedAmount = body.fixedAmount !== undefined ? Number(body.fixedAmount) : rule.fixed_amount;
        if (model === 'percent' && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
          return res.status(400).json({ error: 'Percent must be between 0 and 100.' });
        }
        if (model === 'fixed' && (!Number.isFinite(fixedAmount) || fixedAmount <= 0)) {
          return res.status(400).json({ error: 'Fixed amount must be positive.' });
        }
        const isActive = body.isActive === undefined ? Boolean(rule.is_active) : Boolean(body.isActive);
        const threshold = body.minPayoutThreshold !== undefined && Number.isFinite(Number(body.minPayoutThreshold))
          ? Number(body.minPayoutThreshold) : rule.min_payout_threshold;
        const appliesTo = ['subscription', 'renewal', 'both'].includes(body.appliesTo) ? body.appliesTo : rule.applies_to;
        await run(
          `UPDATE partner_commissions SET model = ?, percent = ?, fixed_amount = ?, applies_to = ?,
             min_payout_threshold = ?, is_active = ?, updated_at = ? WHERE id = ?`,
          [model, percent, fixedAmount, appliesTo, threshold, isActive, now(), id]
        );
        await subscriptions.logAudit(null, 'admin', 'commission_rule_updated', 'partner_commission', id,
          { model, percent, fixedAmount, appliesTo, isActive: Boolean(isActive) }, null, req.ip);
        res.json({ message: 'Commission rule updated.' });
      } catch (error) {
        console.error('Failed to update commission rule:', error.message);
        res.status(500).json({ error: 'Unable to update the commission rule.' });
      }
    });

    // -----------------------------------------------------------------------
    // Commission ledger & payouts
    // -----------------------------------------------------------------------
    app.get('/api/admin/commissions/transactions', verifyAdminToken, async (req, res) => {
      try {
        const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
        const conditions = [];
        const params = [];
        if (status) {
          conditions.push('t.status = ?');
          params.push(status);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await all(
          `SELECT t.*, p.display_name AS partner_name, s.name AS strategy_name
           FROM partner_transactions t
           JOIN partner_profiles p ON p.user_id = t.partner_id
           LEFT JOIN trading_strategies s ON s.id = t.strategy_id
           ${where} ORDER BY t.id DESC LIMIT 500`,
          params
        );
        res.json({
          transactions: rows.map(row => ({
            id: row.id,
            reference: row.reference,
            partnerId: row.partner_id,
            partnerName: row.partner_name,
            strategyName: row.strategy_name,
            subscriptionPaymentId: row.subscription_payment_id,
            grossAmount: row.gross_amount,
            commissionAmount: row.commission_amount,
            currency: row.currency,
            status: row.status,
            notes: row.notes,
            createdAt: row.created_at
          }))
        });
      } catch (error) {
        console.error('Failed to list commission transactions:', error.message);
        res.status(500).json({ error: 'Unable to list transactions.' });
      }
    });

    app.post('/api/admin/commissions/transactions/:id/status', verifyAdminToken, async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      const status = req.body && req.body.status;
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid transaction.' });
      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Status must be approved or rejected.' });
      }
      try {
        // Only pending rows can transition; amounts are immutable.
        const result = await run(
          `UPDATE partner_transactions SET status = ?, status_updated_at = ? WHERE id = ? AND status = 'pending'`,
          [status, now(), id]
        );
        if (!result.changes) {
          const existing = await get('SELECT status FROM partner_transactions WHERE id = ?', [id]);
          if (!existing) return res.status(404).json({ error: 'Transaction not found.' });
          return res.status(409).json({ error: `Transaction is already ${existing.status}.` });
        }
        await subscriptions.logAudit(null, 'admin', `commission_${status}`, 'partner_transaction', id, null, req.body.reason || null, req.ip);
        res.json({ message: `Commission ${status}.` });
      } catch (error) {
        console.error('Failed to update commission status:', error.message);
        res.status(500).json({ error: 'Unable to update the commission.' });
      }
    });

    // Mount the test-node routes (agent callbacks authenticated by node token).
    if (typeof authenticateNodeRequest === 'function') {
      registerTestNodeRoutes(app, authenticateNodeRequest);
    }
  }

  return { registerRoutes };
}

module.exports = { createPartnerAdminApi };
