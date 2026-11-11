'use strict';
const { exclusive } = require('../db-write');
const {withTransaction}=require('../db-async');
const {createPartnerAgreements}=require('./partner-agreements');
function registerPartnerApplications(app, db, verifyToken, verifyAdminToken, subscriptions, options={}) {
  const agreements=createPartnerAgreements(app,db,verifyToken,verifyAdminToken,options);
  const get = (sql, p=[]) => new Promise((resolve,reject)=>db.get(sql,p,(e,r)=>e?reject(e):resolve(r)));
  const all = (sql, p=[]) => new Promise((resolve,reject)=>db.all(sql,p,(e,r)=>e?reject(e):resolve(r||[])));
  const run = (sql, p=[]) => new Promise((resolve,reject)=>db.run(sql,p,function(e){e?reject(e):resolve(this);}));
  const publicApplication = row => row && ({ userId: row.user_id, displayName: row.display_name, company: row.company, website: row.website, status: row.status, reviewNotes: row.review_notes, createdAt: row.created_at, agreementId:row.agreement_id||null });
  app.post('/api/partner/register', verifyToken, async (req,res) => {
    const body=req.body||{}, displayName=typeof body.displayName==='string'?body.displayName.trim():'';
    if(displayName.length<2||displayName.length>80)return res.status(400).json({error:'A display name between 2 and 80 characters is required.'});
    const company=typeof body.company==='string'?body.company.trim().slice(0,120):null;
    const website=typeof body.website==='string'?body.website.trim().slice(0,200):null;
    if(website&&!/^https?:\/\/.+\..+/.test(website))return res.status(400).json({error:'The website must be a valid URL.'});
    try {
      await agreements.ready;
      agreements.validate(req.body?.agreement);
      const result=await withTransaction(db,async()=>{
      await run('UPDATE users SET id=id WHERE id=?',[req.user.id]);
      const profile=await get('SELECT status FROM partner_profiles WHERE user_id=?',[req.user.id]);
      if(profile)return {existing:true,profile:{status:profile.status}};
      const existing=await get('SELECT * FROM partner_applications WHERE user_id=?',[req.user.id]);
      if(existing&&existing.status!=='rejected'&&existing.agreement_id)return {application:existing};
      const agreementId=await agreements.accept(req,{displayName,company,website});
      const stamp=Date.now();
      await run(`INSERT INTO partner_applications(user_id,display_name,company,website,status,created_at,updated_at,agreement_id)
        VALUES(?,?,?,?,'pending',?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,company=excluded.company,website=excluded.website,status='pending',review_notes=NULL,reviewed_by=NULL,reviewed_at=NULL,updated_at=excluded.updated_at,agreement_id=excluded.agreement_id WHERE partner_applications.status='rejected' OR partner_applications.agreement_id IS NULL`,[req.user.id,displayName,company,website,stamp,stamp,agreementId]);
      const application=await get('SELECT * FROM partner_applications WHERE user_id=?',[req.user.id]);
      return {application};
      });
      if(result.existing)return res.json({message:'Partner profile already exists.',profile:result.profile});
      res.status(201).json({message:'Application submitted. Administrator approval is required before partner access is granted.',application:publicApplication(result.application),agreementId:result.application.agreement_id});
    }catch(error){if(error.status)return res.status(error.status).json({error:error.message,code:error.code});console.error('Partner application failed:',error.code||'storage-error');res.status(500).json({error:'Unable to submit partner application or save its agreement. Please retry.'});}
  });
  app.get('/api/partner/application',verifyToken,async(req,res)=>{
    try{await agreements.ready;res.json({application:publicApplication(await get('SELECT * FROM partner_applications WHERE user_id=?',[req.user.id]))||null});}
    catch(error){res.status(500).json({error:'Unable to load application.'});}
  });
  app.get('/api/admin/partner-applications',verifyAdminToken,async(_req,res)=>{
    try{await agreements.ready;const rows=await all(`SELECT a.*,u.email FROM partner_applications a JOIN users u ON u.id=a.user_id ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END,a.updated_at DESC LIMIT 200`);res.json({applications:rows.map(row=>({...publicApplication(row),email:row.email}))});}
    catch(error){res.status(500).json({error:'Unable to load partner applications.'});}
  });
  app.post('/api/admin/partner-applications/:userId/review',verifyAdminToken,async(req,res)=>{
    const userId=Number(req.params.userId),status=req.body&&req.body.status;
    if(!Number.isSafeInteger(userId)||userId<1||!['approved','rejected'].includes(status))return res.status(400).json({error:'Select approve or reject for a valid application.'});
    const notes=typeof req.body.reviewNotes==='string'?req.body.reviewNotes.trim().slice(0,1000):'';
    if(status==='rejected'&&!notes)return res.status(400).json({error:'A rejection reason is required.'});
    try {
      const task=async()=>{
        const row=await get('SELECT * FROM partner_applications WHERE user_id=?',[userId]);
        if(!row)return {http:404,error:'Application not found.'};
        if(row.status!=='pending')return {http:409,error:'Application has already been reviewed.'};
        const stamp=Date.now();
        const updated=await run(`UPDATE partner_applications SET status=?,review_notes=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE user_id=? AND status='pending'`,[status,notes,String(req.admin?.id||'admin'),stamp,stamp,userId]);
        if(!updated.changes)return {http:409,error:'Application has already been reviewed.'};
        if(status==='approved')await run(`INSERT INTO partner_profiles(user_id,display_name,company,website,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(user_id) DO NOTHING`,[userId,row.display_name,row.company,row.website,stamp,stamp]);
        return {http:200};
      };
      const result=typeof db.transaction==='function'?await db.transaction(task):await exclusive(db,async()=>{
        await run('BEGIN IMMEDIATE');try{const r=await task();await run('COMMIT');return r;}catch(e){await run('ROLLBACK').catch(()=>{});throw e;}
      });
      if(result.error)return res.status(result.http).json({error:result.error});
      await subscriptions.logAudit(null,'admin','partner_application_'+status,'partner',userId,null,notes,req.ip);
      res.json({message:'Partner application '+status+'.',status});
    }catch(error){console.error('Partner application review failed:',error.message);res.status(500).json({error:'Unable to review application.'});}
  });
  app.delete('/api/admin/partner-applications/:userId', verifyAdminToken, async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid application user ID.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm deletion of this rejected application.' });
    try {
      // Recheck status in the mutation itself: a resubmitted pending application is protected.
      const removed = await run("DELETE FROM partner_applications WHERE user_id = ? AND status = 'rejected'", [userId]);
      if (!removed.changes) {
        const existing = await get('SELECT status FROM partner_applications WHERE user_id = ?', [userId]);
        return res.status(existing ? 409 : 404).json({ error: existing ? 'Only rejected applications can be deleted. Refresh the list to see its current status.' : 'Application not found.' });
      }
      await subscriptions.logAudit(null, 'admin', 'partner_application_deleted', 'partner_application', userId, { status: 'rejected' }, null, req.ip);
      return res.json({ message: 'Rejected application deleted.', deleted: removed.changes });
    } catch (error) {
      console.error('Partner application deletion failed:', error.message);
      return res.status(500).json({ error: 'Unable to delete this application.' });
    }
  });
}
module.exports={registerPartnerApplications};
