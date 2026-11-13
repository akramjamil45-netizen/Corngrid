'use strict';

// Partner Program API (EA developers). Partners are ordinary CornGrid users
// with a partner_profiles row; authentication reuses the existing user JWT.

const fs = require('fs');
const path = require('path');

function createPartnerApi({ db, events, crypto: sandboxCrypto, rateLimit, storageDir, publication } = {}) {
  const SUBMISSIONS_DIR = storageDir || path.join(__dirname, '..', 'storage', 'ea-submissions');
  fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });

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

  const now = () => Date.now();

  // -------------------------------------------------------------------------
  // Static source scan (heuristic). Real safety comes from isolated testing on
  // dedicated test nodes; this catches obviously dangerous constructs early.
  // -------------------------------------------------------------------------
  const SUSPICIOUS_PATTERNS = [
    { pattern: /#import\s+"(?!kernel32\.dll|user32\.dll|gdi32\.dll|wininet\.dll|shell32\.dll|advapi32\.dll|ws2_32\.dll)/i, label: 'imports a non-system DLL' },
    { pattern: /\bShellExecute(Ex)?[AW]?\b/i, label: 'launches external processes (ShellExecute)' },
    { pattern: /\bWinExec\b/i, label: 'launches external processes (WinExec)' },
    { pattern: /\bCreateProcess[AW]?\b/i, label: 'creates external processes' },
    { pattern: /\bURLDownloadToFile[AW]?\b/i, label: 'downloads remote files' },
    { pattern: /\bInternetOpen[AW]?\b/i, label: 'uses raw WinINet networking' },
    { pattern: /\bReg(Open|Create|Set)Key/i, label: 'writes to the Windows registry' },
    { pattern: /\bDeleteFile[AW]?\b|\bRemoveDirectory[AW]?\b/i, label: 'deletes files or directories' },
    { pattern: /\bMoveFile[AW]?\b|\bCopyFile[AW]?\b/i, label: 'manipulates arbitrary files' }
  ];

  function scanSource(filename, content) {
    const findings = [];
    for (const { pattern, label } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(content)) findings.push(`${filename}: ${label}`);
    }
    return findings;
  }

  function publicSubmission(row) {
    return {
      submissionUid: row.submission_uid,
      name: row.name,
      description: row.description,
      version: row.version,
      symbols: row.symbols,
      status: row.status,
      reviewNotes: row.review_notes,
      rejectionReason: row.rejection_reason,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async function requirePartner(req, res) {
    const profile = await get('SELECT * FROM partner_profiles WHERE user_id = ?', [req.user.id]);
    if (!profile) {
      res.status(403).json({ error: 'Partner registration is required.', code: 'NOT_A_PARTNER' });
      return null;
    }
    if (profile.status !== 'active') {
      res.status(403).json({ error: 'This partner account is suspended.', code: 'PARTNER_SUSPENDED' });
      return null;
    }
    return profile;
  }

  function registerRoutes(app, verifyToken) {
    const uploadRateLimit = rateLimit({ limit: 20, windowMs: 60 * 60 * 1000 });

    // -----------------------------------------------------------------------
    // Profile
    // -----------------------------------------------------------------------
    app.get('/api/partner/profile', verifyToken, async (req, res) => {
      try {
        const profile = await get('SELECT * FROM partner_profiles WHERE user_id = ?', [req.user.id]);
        if (!profile) return res.json({ partner: null });
        res.json({
          partner: {
            displayName: profile.display_name,
            company: profile.company,
            website: profile.website,
            status: profile.status,
            payoutMethod: profile.payout_method,
            createdAt: profile.created_at
          }
        });
      } catch (error) {
        console.error('Failed to load partner profile:', error.message);
        res.status(500).json({ error: 'Unable to load the partner profile.' });
      }
    });

    app.put('/api/partner/profile', verifyToken, async (req, res) => {
      const profile = await requirePartner(req, res);
      if (!profile) return;
      const body = req.body || {};
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : profile.display_name;
      if (displayName.length < 2 || displayName.length > 80) {
        return res.status(400).json({ error: 'A display name between 2 and 80 characters is required.' });
      }
      const payoutMethod = typeof body.payoutMethod === 'string' ? body.payoutMethod.trim().slice(0, 60) : profile.payout_method;
      const payoutDetails = typeof body.payoutDetails === 'string' ? body.payoutDetails.trim().slice(0, 500) : null;
      try {
        await run(
          `UPDATE partner_profiles SET display_name = ?, company = ?, website = ?, payout_method = ?,
             payout_details_cipher = COALESCE(?, payout_details_cipher), updated_at = ? WHERE user_id = ?`,
          [displayName,
            typeof body.company === 'string' ? body.company.trim().slice(0, 120) : profile.company,
            typeof body.website === 'string' ? body.website.trim().slice(0, 200) : profile.website,
            payoutMethod,
            payoutDetails ? sandboxCrypto.encrypt(payoutDetails) : null,
            now(), req.user.id]
        );
        res.json({ message: 'Partner profile updated.' });
      } catch (error) {
        console.error('Failed to update partner profile:', error.message);
        res.status(500).json({ error: 'Unable to update the partner profile.' });
      }
    });

    // -----------------------------------------------------------------------
    // Overview
    // -----------------------------------------------------------------------
    app.get('/api/partner/overview', verifyToken, async (req, res) => {
      const profile = await requirePartner(req, res);
      if (!profile) return;
      try {
        const earnings = await get(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('approved','paid') THEN commission_amount ELSE 0 END), 0) AS approved_total,
                  COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_amount ELSE 0 END), 0) AS pending_total,
                  COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) AS paid_total
           FROM partner_transactions WHERE partner_id = ?`,
          [req.user.id]
        );
        const payouts = await get(
          `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_total
           FROM partner_payouts WHERE partner_id = ?`,
          [req.user.id]
        );
        const submissions = await get(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published
           FROM ea_submissions WHERE partner_id = ? AND deleted_at IS NULL`,
          [req.user.id]
        );
        res.json({
          earnings: {
            approvedTotal: Number(earnings.approved_total) || 0,
            pendingTotal: Number(earnings.pending_total) || 0,
            paidTotal: Number(payouts.paid_total) || 0,
            currency: 'MYR'
          },
          payouts: { count: Number(payouts.count) || 0, paidTotal: Number(payouts.paid_total) || 0 },
          submissions: { total: Number(submissions.total) || 0, published: Number(submissions.published) || 0 }
        });
      } catch (error) {
        console.error('Failed to load partner overview:', error.message);
        res.status(500).json({ error: 'Unable to load the partner overview.' });
      }
    });

    // -----------------------------------------------------------------------
    // EA submissions
    // -----------------------------------------------------------------------
    app.get('/api/partner/submissions', verifyToken, async (req, res) => {
      const profile = await requirePartner(req, res);
      if (!profile) return;
      try {
        const rows = await all(
          'SELECT * FROM ea_submissions WHERE partner_id = ? AND deleted_at IS NULL ORDER BY id DESC',
          [req.user.id]
        );
        res.json({ submissions: await Promise.all(rows.map(async row => ({ ...publicSubmission(row), presets: await all('SELECT symbol,file_name AS name FROM ea_submission_presets WHERE submission_id=? ORDER BY symbol',[row.id]) }))) });
      } catch (error) {
        console.error('Failed to list submissions:', error.message);
        res.status(500).json({ error: 'Unable to list submissions.' });
      }
    });

    app.get('/api/partner/submissions/:uid', verifyToken, async (req, res) => {
      const profile = await requirePartner(req, res);
      if (!profile) return;
      try {
        const row = await get(
          'SELECT * FROM ea_submissions WHERE submission_uid = ? AND partner_id = ? AND deleted_at IS NULL',
          [req.params.uid, req.user.id]
        );
        if (!row) return res.status(404).json({ error: 'Submission not found.' });
        const versions = await all('SELECT id, version, file_count, status, created_at FROM ea_versions WHERE submission_id = ? ORDER BY id DESC', [row.id]);
        const reports = await all(
          `SELECT id, kind, status, error_count, cpu_avg, memory_peak_mb, started_at, finished_at, created_at
           FROM ea_test_reports WHERE submission_id = ? ORDER BY id DESC LIMIT 20`,
          [row.id]
        );
        res.json({ submission: publicSubmission(row), versions, testReports: reports, presets: await all('SELECT symbol,file_name AS name FROM ea_submission_presets WHERE submission_id=?',[row.id]) });
      } catch (error) {
        console.error('Failed to load submission:', error.message);
        res.status(500).json({ error: 'Unable to load the submission.' });
      }
    });

    // Files arrive as base64 JSON (same pattern as payment proofs).
    app.post('/api/partner/submissions', uploadRateLimit, verifyToken, async (req, res) => {
      const profile = await requirePartner(req,res); if (!profile) return;
      try {
        const result = await publication().createSubmission(req.user.id,req.body||{});
        res.status(result.alreadyCreated?200:201).json(result);
      } catch (error) {
        if (error.status) return res.status(error.status).json({error:error.message,code:error.code});
        console.error('EA submission failed:',error.code||error.name);
        res.status(500).json({error:'Unable to store the EA release. Please retry.'});
      }
    });

    // -----------------------------------------------------------------------
    // Commissions & payouts (read side)
    // -----------------------------------------------------------------------
    app.get('/api/partner/transactions', verifyToken, async (req, res) => {
      const profile = await requirePartner(req, res);
      if (!profile) return;
      try {
        const rows = await all(
          `SELECT t.reference, t.gross_amount, t.commission_amount, t.currency, t.status, t.created_at, s.name AS strategy_name
           FROM partner_transactions t
           LEFT JOIN trading_strategies s ON s.id = t.strategy_id
           WHERE t.partner_id = ? ORDER BY t.id DESC LIMIT 200`,
          [req.user.id]
        );
        res.json({
          transactions: rows.map(row => ({
            reference: row.reference,
            grossAmount: row.gross_amount,
            commissionAmount: row.commission_amount,
            currency: row.currency,
            status: row.status,
            strategyName: row.strategy_name,
            createdAt: row.created_at
          }))
        });
      } catch (error) {
        console.error('Failed to list partner transactions:', error.message);
        res.status(500).json({ error: 'Unable to list transactions.' });
      }
    });


  }

  return { registerRoutes, scanSource, SUBMISSIONS_DIR };
}

module.exports = { createPartnerApi };
