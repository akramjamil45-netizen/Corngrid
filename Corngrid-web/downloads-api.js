'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function registerDownloadsApi(app, db, verifyUser, verifyAdmin, resources, root, downloadGuard = (req,res,next)=>next()) {
  db.exec(`CREATE TABLE IF NOT EXISTS download_updates (
    resource_id TEXT PRIMARY KEY, filename TEXT NOT NULL, version TEXT NOT NULL,
    data BLOB NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`, error => { if (error) console.error('Downloads schema:', error.message); });
  const get = (sql, args = []) => new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
  const run = (sql, args = []) => new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
  const valid = (req,res,next) => Object.hasOwn(resources,req.params.id) ? next() : res.status(404).json({error:'Resource not found.'});
  async function list(req,res) {
    try {
      const rows = await Promise.all(Object.entries(resources).map(async ([id,item])=>{
        const row = await get('SELECT filename,version,length(data) AS size,updated_at,sha256 FROM download_updates WHERE resource_id=?',[id]);
        let size = null;
        if (!row) { try { size = fs.statSync(path.join(root,item.file)).size; } catch {} }
        return { id, type:id==='setup-guide'?'guide':'preset', filename:row?.filename || item.downloadName,
          version:row?.version || 'Original', size:row?.size ?? size, updatedAt:row ? Number(row.updated_at) : null,
          available:!!row || size!==null, custom:!!row, sha256:row?.sha256 || null };
      }));
      res.set('Cache-Control','no-store').json({resources:rows});
    } catch (error) { console.error('Failed to list downloads:', error.message); res.status(500).json({error:'Unable to load downloads. Please retry or refresh the page.'}); }
  }
  app.get('/api/admin/downloads',verifyAdmin,list);
  app.get('/api/downloads',verifyUser,list);
  app.put('/api/admin/downloads/:id',verifyAdmin,valid,express.raw({type:'application/octet-stream',limit:'10mb'}),async(req,res)=>{
    const guide=req.params.id==='setup-guide';
    try {
      let filename;
      try { filename=decodeURIComponent(req.get('X-File-Name')||''); } catch { return res.status(400).json({error:'Invalid filename.'}); }
      const version=String(req.get('X-Resource-Version')||'').trim();
      const data=req.body;
      if (!/^[\w .()-]{1,140}$/.test(filename) || !filename.toLowerCase().endsWith(guide?'.pdf':'.set') || !version || version.length>40 || /[\x00-\x1f]/.test(version)) return res.status(400).json({error:'Choose a valid filename and version (maximum 40 characters).'});
      if (!Buffer.isBuffer(data) || !data.length || data.length>(guide?10*1024*1024:128*1024)) return res.status(400).json({error:guide?'PDF must be 10 MB or smaller.':'Preset must be 128 KB or smaller.'});
      if (guide) {
        if (!data.subarray(0,5).equals(Buffer.from('%PDF-')) || !data.subarray(-2048).includes(Buffer.from('%%EOF'))) return res.status(400).json({error:'Upload a valid PDF guide.'});
      } else {
        const text=data[0]===255&&data[1]===254?data.subarray(2).toString('utf16le'):data.toString('utf8').replace(/^\uFEFF/,'');
        if (text.includes('\0') || !/^\s*[A-Za-z_][\w.]*\s*=/m.test(text) || /[\x01-\x08\x0e-\x1f]/.test(text)) return res.status(400).json({error:'Upload a valid MT5 .set preset.'});
      }
      const hash=crypto.createHash('sha256').update(data).digest('hex');
      await run(`INSERT INTO download_updates VALUES(?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET filename=excluded.filename,version=excluded.version,data=excluded.data,sha256=excluded.sha256,updated_at=excluded.updated_at`,[req.params.id,filename,version,data,hash,Date.now()]);
      res.json({success:true});
    } catch { res.status(500).json({error:'Unable to update resource. The previous file is preserved.'}); }
  });
  app.delete('/api/admin/downloads/:id',verifyAdmin,valid,async(req,res)=>{
    try { await run('DELETE FROM download_updates WHERE resource_id=?',[req.params.id]); res.json({success:true}); }
    catch { res.status(500).json({error:'Unable to restore original resource.'}); }
  });
  // Fall through to the existing original-file route when no admin update exists.
  app.get('/api/downloads/:id',verifyUser,async(req,res,next)=>{
    if (!Object.hasOwn(resources,req.params.id)) return next();
    try {
      const row=await get('SELECT * FROM download_updates WHERE resource_id=?',[req.params.id]);
      if (!row) return next();
      downloadGuard(req,res,()=>{
      res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':req.params.id==='setup-guide'?'application/pdf':'application/octet-stream',
        'Content-Disposition':`attachment; filename="${row.filename}"`});
      res.send(row.data);
      });
    } catch { res.status(500).json({error:'Unable to download resource.'}); }
  });
}
module.exports=registerDownloadsApi;
