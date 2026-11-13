'use strict';
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { dbGet, dbAll, dbRun, withTransaction, isPostgres } = require('../db-async');
const { loadStrategyPreset, PAIRS } = require('../partner/presets');
const V = require('./validation');
const { normalizeImage, MAX_BYTES } = require('./media');
const uid = () => crypto.randomUUID();
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const BASE_SELECT = `SELECT e.*, p.display_name AS partner_name, p.status AS partner_status,
  s.code AS strategy_code, s.name AS strategy_name, s.is_active AS strategy_active, s.is_published AS strategy_published
  FROM marketplace_eas e LEFT JOIN partner_profiles p ON p.user_id=e.provider_id
  LEFT JOIN trading_strategies s ON s.id=e.existing_strategy_id`;

function createMarketplace(app, db, { verifyToken, adminAuth, subscriptions, sandbox, rateLimit, storageDir, strategyStorageDir, prerequisite = Promise.resolve() }) {
  const get = (sql, params) => dbGet(db, sql, params), all = (sql, params) => dbAll(db, sql, params), run = (sql, params) => dbRun(db, sql, params);
  let publication;
  const directory = storageDir || path.join(__dirname, '../storage/marketplace-media');
  const strategyDirectory = path.resolve(strategyStorageDir || path.join(__dirname, '../storage'));
  const adminActor = req => String(req.admin?.id || 'admin');
  const ready = (async () => {
    await prerequisite;
    await require('./schema').ensureMarketplaceSchema(db);
    // An editable draft only: installation never publishes an advertisement or
    // approves deployment on the administrator's behalf.
    const strategy = await get("SELECT id,name,version FROM trading_strategies WHERE code='corngrid-ea'");
    if (strategy) await run(`INSERT INTO marketplace_eas(id,provider_type,existing_strategy_id,name,slug,short_description,version,strategy_type,created_at,updated_at)
      VALUES('corngrid-official','official',?,?, 'corngrid-ea',?,?, 'grid',?,?) ON CONFLICT(id) DO NOTHING`,
      [strategy.id, strategy.name, 'The official CornGrid strategy for managed MetaTrader 5 infrastructure.', strategy.version || '', Date.now(), Date.now()]);
  })();
  // Startup consumes this rejection; avoid an unhandled rejection before listen.
  ready.catch(() => {});
  const wrap = fn => async (req, res) => {
    try { await ready; await fn(req, res); }
    catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
      if (error.code === '23505' || /UNIQUE constraint/.test(error.message || '')) return res.status(409).json({ error: 'That strategy is already linked to a Marketplace listing.' });
      console.error('Marketplace request failed:', error.code || error.name);
      res.status(500).json({ error: 'Unable to complete the Marketplace request. Please retry.' });
    }
  };
  const mutateLimit = rateLimit({ limit: 100, windowMs: 15 * 60000 });
  const uploadLimit = rateLimit({ limit: 40, windowMs: 60 * 60000 });
  const browseLimit = rateLimit({ limit: 180, windowMs: 60000 });
  async function audit(req, role, action, eaId, metadata = {}) {
    await run('INSERT INTO marketplace_audit(id,actor_role,actor_id,action,ea_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
      [uid(), role, role === 'admin' ? adminActor(req) : String(req.user.id), action, eaId, JSON.stringify(metadata), Date.now()]);
  }
  async function partner(req) {
    await access(req);
    const profile = await get("SELECT * FROM partner_profiles WHERE user_id=? AND status='active'", [req.user.id]);
    if (!profile) V.fail('Approved, active partner access is required.', 403, 'PARTNER_REQUIRED');
    return profile;
  }
  async function settings() { return get('SELECT * FROM marketplace_settings WHERE id=1'); }
  async function allowed(userId) {
    const config = await settings();
    if (!config.marketplace_enabled) return false;
    const override = await get('SELECT enabled FROM marketplace_user_access WHERE user_id=?', [userId]);
    return !override || Boolean(override.enabled);
  }
  async function access(req) { if (!await allowed(req.user.id)) V.fail('Marketplace access is currently disabled.', 403, 'MARKETPLACE_DISABLED'); }
  async function owned(id, req, role, lock = false) {
    if (role === 'partner') await partner(req);
    const row = await get('SELECT * FROM marketplace_eas WHERE id=?' + (lock && isPostgres(db) ? ' FOR UPDATE' : ''), [id]);
    if (!row || role === 'partner' && (row.provider_type !== 'partner' || row.provider_id !== req.user.id)) V.fail('EA listing not found.', 404);
    return row;
  }
  async function published(id) {
    const row = await get(BASE_SELECT + " WHERE e.id=? AND e.listing_status='published' AND (e.provider_type='official' OR p.status='active')", [id]);
    if (!row) V.fail('EA listing not found.', 404);
    return row;
  }
  function mediaUrl(id, role) { return `/api/${role === 'user' ? '' : role + '/'}marketplace/media/${encodeURIComponent(id)}`; }
  async function view(row, role = 'user', detail = false) {
    const images = await all('SELECT id,kind,width,height,display_order FROM marketplace_media WHERE ea_id=? AND deleted_at IS NULL ORDER BY display_order,created_at,id', [row.id]);
    const data = {
      id: row.id, name: row.name, slug: row.slug, provider_type: row.provider_type,
      provider_name: row.provider_type === 'official' ? 'CornGrid Official' : row.partner_name || 'CornGrid Partner',
      short_description: row.short_description, version: row.version, strategy_type: row.strategy_type,
      supported_symbols: parse(row.supported_symbols) || [], supported_timeframes: parse(row.supported_timeframes) || [],
      infrastructure_status: row.infrastructure_status, platform: row.platform,
      featured: Boolean(row.featured), logo: images.find(i => i.kind === 'logo') ? mediaUrl(images.find(i => i.kind === 'logo').id, role) : row.provider_type === 'official' ? '/images/pwa-192.png' : null,
      updated_at: Number(row.updated_at)
    };
    if (role === 'user' && data.infrastructure_status === 'available' && (!row.strategy_active || !row.strategy_published)) data.infrastructure_status = 'unavailable';
    if (detail) Object.assign(data, {
      full_description: parse(row.full_description) || {}, minimum_balance: row.minimum_balance === null ? null : Number(row.minimum_balance), balance_currency: row.balance_currency,
      recommended_leverage: row.recommended_leverage, account_mode: row.account_mode,
      screenshots: images.filter(i => i.kind === 'screenshot').map(i => ({ ...i, url: mediaUrl(i.id, role) })),
      logo_id: images.find(i => i.kind === 'logo')?.id || null,
      deployment: await deployment(row)
    });
    if (role !== 'user') Object.assign(data, { provider_id: row.provider_id, existing_strategy_id: row.existing_strategy_id, listing_status: row.listing_status, revision: row.revision, review_notes: row.review_notes });
    if (detail && role !== 'user') data.release = publication ? await publication.forListing(row.id) : null;
    if (detail && role === 'admin') data.approved_revision = row.provider_type === 'official' || Boolean(publication && await publication.isReleased(row.id,row.revision));
    return data;
  }
  async function deployment(row) {
    if (row.infrastructure_status !== 'available' || !row.existing_strategy_id) return { supported: false, symbols: [] };
    const strategy = await get('SELECT s.*,e.partner_id FROM trading_strategies s LEFT JOIN ea_submissions e ON e.id=s.submission_id WHERE s.id=? AND s.is_active=TRUE AND s.is_published=TRUE', [row.existing_strategy_id]);
    if (!strategy || (row.provider_type === 'official' ? strategy.submission_id !== null : strategy.partner_id !== row.provider_id)) return { supported: false, symbols: [] };
    if (!strategy.ea_file_path) return { supported: false, symbols: [] };
    const binaryPath = path.resolve(strategyDirectory, strategy.ea_file_path), relative = path.relative(strategyDirectory, binaryPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(binaryPath).toLowerCase() !== '.ex5') return { supported: false, symbols: [] };
    try { const binary = await fs.stat(binaryPath); if (!binary.isFile() || !binary.size) return { supported: false, symbols: [] }; }
    catch { return { supported: false, symbols: [] }; }
    const declared = parse(row.supported_symbols) || [], symbols = [];
    for (const symbol of PAIRS) if (declared.includes(symbol) && await loadStrategyPreset(db, strategy, symbol)) symbols.push(symbol);
    return { supported: symbols.length > 0, strategyCode: strategy.code, symbols };
  }
  async function validateStrategy(id, row) {
    if (id === null || id === undefined) return;
    const strategy = await get('SELECT s.*,e.partner_id FROM trading_strategies s LEFT JOIN ea_submissions e ON e.id=s.submission_id WHERE s.id=?', [id]);
    if (!strategy || (row.provider_type === 'official' ? strategy.submission_id !== null : strategy.partner_id !== row.provider_id)) V.fail('The strategy must belong to this EA provider and use the existing approval workflow.');
  }
  async function invalidate(row, role) {
    if (row.provider_type !== 'partner') return;
    if (row.listing_status === 'archived') V.fail('This listing is archived. Ask an administrator to reopen it.', 409);
    await run("UPDATE marketplace_reviews SET decision='superseded',reviewed_at=? WHERE ea_id=? AND decision='pending'", [Date.now(), row.id]);
    await run("UPDATE marketplace_eas SET listing_status='draft',review_notes='' WHERE id=?", [row.id]);
  }
  async function listingList(req, role) {
    if (role === 'user') await access(req);
    if (role === 'partner') await partner(req);
    const where = [], params = [];
    if (role === 'user') where.push("e.listing_status='published' AND (e.provider_type='official' OR p.status='active')");
    if (role === 'partner') { where.push("e.provider_type='partner' AND e.provider_id=?"); params.push(req.user.id); }
    const q = String(req.query.search || '').trim().slice(0,100);
    if (q) { where.push("(LOWER(e.name) LIKE ? ESCAPE '!' OR LOWER(e.short_description) LIKE ? ESCAPE '!' OR LOWER(COALESCE(p.display_name,'CornGrid Official')) LIKE ? ESCAPE '!')"); const term = '%' + q.toLowerCase().replace(/[!%_]/g, '!$&') + '%'; params.push(term,term,term); }
    for (const [key,column,values] of [['provider','provider_type',['official','partner']],['strategy','strategy_type',V.CATEGORIES],['status','listing_status',['draft','pending_review','approved','published','rejected','archived']]]) {
      if (!req.query[key] || req.query[key] === 'all') continue;
      if (key === 'status' && role === 'user' || !values.includes(req.query[key])) V.fail('Invalid filter.');
      where.push(`e.${column}=?`); params.push(req.query[key]);
    }
    const page = req.query.page === undefined ? 1 : Number(req.query.page), size = 24;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) V.fail('Invalid page.');
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const count = await get('SELECT COUNT(*) AS count FROM marketplace_eas e LEFT JOIN partner_profiles p ON p.user_id=e.provider_id' + clause, params);
    const rows = await all(BASE_SELECT + clause + ' ORDER BY e.featured DESC,e.updated_at DESC,e.id LIMIT ? OFFSET ?', [...params,size,(page-1)*size]);
    return { listings: await Promise.all(rows.map(row => view(row,role))), page, total: Number(count.count), pages: Math.ceil(Number(count.count)/size), categories: V.CATEGORIES };
  }
  async function edit(req, role) {
    const changes = V.metadata(req.body, { admin: role === 'admin' });
    return withTransaction(db, async () => {
      const row = await owned(req.params.id, req, role, true); V.revision(req.body,row);
      if (!Object.keys(changes).length) V.fail('No listing changes were supplied.');
      await validateStrategy(changes.existing_strategy_id, row);
      await invalidate(row,role);
      const entries = Object.entries(changes);
      await run(`UPDATE marketplace_eas SET ${entries.map(([k])=>k+'=?').join(',')},revision=revision+1,updated_at=? WHERE id=?`, [...entries.map(([,v])=>v),Date.now(),row.id]);
      await audit(req,role,'listing_edited',row.id,{ fields: Object.keys(changes), previousRevision:row.revision });
      return row.id;
    });
  }
  async function create(req, role) {
    const data = V.metadata(req.body,{admin:role==='admin',create:true});
    if (role === 'partner') await partner(req);
    const id = uid(), stamp = Date.now(), owner = role === 'admin' ? null : req.user.id;
    const row = { provider_type: role === 'admin' ? 'official' : 'partner', provider_id:owner };
    await withTransaction(db, async () => {
      if (owner) {
        if (isPostgres(db)) await get('SELECT user_id FROM partner_profiles WHERE user_id=? FOR UPDATE',[owner]);
        await partner(req);
        if (Number((await get('SELECT COUNT(*) AS n FROM marketplace_eas WHERE provider_id=?',[owner])).n) >= 100) V.fail('The partner listing limit has been reached.',409);
      }
      await validateStrategy(data.existing_strategy_id,row);
      const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) + '-' + id.slice(0,8);
      const entries = Object.entries(data);
      await run(`INSERT INTO marketplace_eas(id,provider_type,provider_id,slug,${entries.map(([k])=>k).join(',')},created_at,updated_at) VALUES(?,?,?,?,${entries.map(()=>'?').join(',')},?,?)`,[id,row.provider_type,owner,slug,...entries.map(([,v])=>v),stamp,stamp]);
      await audit(req,role,'listing_created',id);
    });
    return id;
  }
  app.get('/api/marketplace/settings',verifyToken,wrap(async(req,res)=>{
    const config = await settings(), enabled = await allowed(req.user.id), profile = await get("SELECT user_id FROM partner_profiles WHERE user_id=? AND status='active'",[req.user.id]);
    let promotion = null;
    if (enabled && config.promo_visible && config.promo_ea_id) {
      const destination = await get(BASE_SELECT + " WHERE e.id=? AND e.listing_status='published' AND (e.provider_type='official' OR p.status='active')",[config.promo_ea_id]);
      if (destination) promotion = { title:config.promo_title, description:config.promo_description, eaId:destination.id, image:config.promo_image_id ? mediaUrl(config.promo_image_id,'user') : null };
    }
    res.json({ enabled, partner: enabled && Boolean(profile), promotion, categories:V.CATEGORIES });
  }));
  app.get('/api/marketplace/eas',verifyToken,browseLimit,wrap(async(req,res)=>res.json(await listingList(req,'user'))));
  app.get('/api/marketplace/eas/:id',verifyToken,browseLimit,wrap(async(req,res)=>{ await access(req); res.json({listing:await view(await published(req.params.id),'user',true)}); }));
  app.post('/api/marketplace/eas/:id/deployment',verifyToken,mutateLimit,wrap(async(req,res)=>{
    await access(req); const row = await published(req.params.id), integration = await deployment(row);
    if (!integration.supported) V.fail('This EA is not currently available for infrastructure deployment.',409,'NOT_DEPLOYABLE');
    if (!await subscriptions.eligibleSubscription(req.user.id)) V.fail('An active subscription is required. Open Subscription to choose a plan.',403,'SUBSCRIPTION_REQUIRED');
    const status = await sandbox.manager.sandboxStatus(req.user.id);
    if (!status.capacity.canAdd) V.fail('Your sandbox allowance is full. Manage an existing sandbox first.',403,'SANDBOX_LIMIT_REACHED');
    res.json({strategyCode:integration.strategyCode,symbols:integration.symbols,destination:'/dashboard.html#sandbox'});
  }));

  // Literal routes keep the repository's client/API compatibility check useful.
  app.get('/api/partner/marketplace/eas',verifyToken,wrap(async(req,res)=>res.json(await listingList(req,'partner'))));
  app.post('/api/partner/marketplace/eas',verifyToken,mutateLimit,wrap(async(req,res)=>res.status(201).json({id:await create(req,'partner')})));
  app.get('/api/partner/marketplace/eas/:id',verifyToken,wrap(async(req,res)=>{await owned(req.params.id,req,'partner');res.json({listing:await view(await get(BASE_SELECT+' WHERE e.id=?',[req.params.id]),'partner',true)});}));
  app.patch('/api/partner/marketplace/eas/:id',verifyToken,mutateLimit,wrap(async(req,res)=>res.json({id:await edit(req,'partner')})));
  app.post('/api/partner/marketplace/eas/:id/submit',verifyToken,mutateLimit,wrap(async(req,res)=>{
    const row=await owned(req.params.id,req,'partner');
    if(!publication)V.fail('EA publication services are not available.',503);
    const result=await publication.createSubmission(req.user.id,req.body||{},{listingId:row.id,revision:req.body?.revision});
    res.status(result.alreadyCreated?200:201).json(result);
  }));
  app.get('/api/admin/marketplace/settings',adminAuth.verifyToken,wrap(async(_req,res)=>res.json({settings:await settings(),categories:V.CATEGORIES})));
  app.patch('/api/admin/marketplace/settings',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{
    const body=req.body||{}, changes={};
    if(Object.keys(body).some(k=>!['marketplace_enabled','promo_visible','promo_title','promo_description','promo_ea_id'].includes(k)))V.fail('Unsupported Marketplace setting.');
    for(const k of ['marketplace_enabled','promo_visible'])if(k in body)changes[k]=V.bool(body[k],k);
    for(const [k,max]of [['promo_title',120],['promo_description',400]])if(k in body)changes[k]=V.text(body[k],max,k);
    if('promo_ea_id'in body){if(body.promo_ea_id!==null&&!await get('SELECT id FROM marketplace_eas WHERE id=?',[body.promo_ea_id]))V.fail('Choose an existing promotional destination.');changes.promo_ea_id=body.promo_ea_id;}
    if(!Object.keys(changes).length)V.fail('No settings supplied.');
    await withTransaction(db,async()=>{const entries=Object.entries(changes);await run(`UPDATE marketplace_settings SET ${entries.map(([k])=>k+'=?').join(',')},updated_by=?,updated_at=? WHERE id=1`,[...entries.map(([,v])=>v),adminActor(req),Date.now()]);await audit(req,'admin','settings_updated',null,changes);});
    res.json({settings:await settings()});
  }));
  app.get('/api/admin/marketplace/eas',adminAuth.verifyToken,wrap(async(req,res)=>res.json(await listingList(req,'admin'))));
  app.post('/api/admin/marketplace/eas',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>res.status(201).json({id:await create(req,'admin')})));
  app.get('/api/admin/marketplace/eas/:id',adminAuth.verifyToken,wrap(async(req,res)=>{await owned(req.params.id,req,'admin');res.json({listing:await view(await get(BASE_SELECT+' WHERE e.id=?',[req.params.id]),'admin',true),reviews:await all('SELECT * FROM marketplace_reviews WHERE ea_id=? ORDER BY created_at DESC LIMIT 30',[req.params.id])});}));
  app.patch('/api/admin/marketplace/eas/:id',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>res.json({id:await edit(req,'admin')})));
  async function decision(req, choice) {
    const row=await owned(req.params.id,req,'admin');V.revision(req.body,row);
    if(row.provider_type!=='partner')V.fail('Only partner releases use this review action.',409);
    if(!publication)V.fail('EA publication services are not available.',503);
    const release=await publication.forListing(row.id);
    if(!release)V.fail('The partner must upload the EA and .set files for review first.',409,'EA_FILES_REQUIRED');
    const actor={role:'admin',id:adminActor(req)};
    if(choice==='approved')return publication.approve(release.submissionId,{actor,reviewDigest:req.body.reviewDigest});
    await publication.reject(release.submissionId,{actor,reason:req.body.reason});return {message:'EA release rejected.'};
  }
  app.post('/api/admin/marketplace/eas/:id/approve',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>res.json(await decision(req,'approved'))));
  app.post('/api/admin/marketplace/eas/:id/reject',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>res.json(await decision(req,'rejected'))));
  app.patch('/api/admin/marketplace/eas/:id/publication',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{
    const status=req.body?.status;if(!['draft','published','archived'].includes(status))V.fail('Choose publish, unpublish or archive.');
    await withTransaction(db,async()=>{
      const row=await owned(req.params.id,req,'admin',true);V.revision(req.body,row);
      if(status==='published'){
        if(!row.short_description||!row.version||!(parse(row.supported_symbols)||[]).length||!(parse(row.full_description)||{}).risks)V.fail('Add description, version, supported symbols and risks before publishing.');
        if(row.provider_type==='partner'&&(!publication||!await publication.isReleased(row.id,row.revision)))V.fail('This partner release needs reviewed EA and preset files before publication.',409,'EA_FILES_REQUIRED');
      }
      if(status!=='published')await run("UPDATE marketplace_reviews SET decision='superseded',reviewed_at=? WHERE ea_id=? AND decision='pending'",[Date.now(),row.id]);
      await run('UPDATE marketplace_eas SET listing_status=?,updated_at=? WHERE id=?',[status,Date.now(),row.id]);
      await audit(req,'admin','publication_updated',row.id,{status});
    });res.json({message:'Publication updated.'});
  }));
  app.patch('/api/admin/marketplace/eas/:id/infrastructure',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{
    const status=req.body?.status;if(!['available','coming_soon','unavailable','maintenance'].includes(status))V.fail('Choose a valid infrastructure status.');
    await withTransaction(db,async()=>{
      const row=await owned(req.params.id,req,'admin',true);V.revision(req.body,row);
      if(status==='available'){
        if(row.provider_type==='partner'&&(!publication||!await publication.isReleased(row.id,row.revision)))V.fail('Approve the EA and preset release first.',409,'EA_FILES_REQUIRED');
        await validateStrategy(row.existing_strategy_id,row);
        if(!(await deployment({...row,infrastructure_status:'available'})).supported)V.fail('Link an active, published strategy with an approved preset for at least one listed symbol first.',409);
      }
      await run('UPDATE marketplace_eas SET infrastructure_status=?,updated_at=? WHERE id=?',[status,Date.now(),row.id]);
      await audit(req,'admin','infrastructure_updated',row.id,{status});
    });res.json({message:'Marketplace availability updated. Running EAs were not changed.'});
  }));
  app.patch('/api/admin/marketplace/eas/:id/featured',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{
    const featured=V.bool(req.body?.featured,'featured');await withTransaction(db,async()=>{const row=await owned(req.params.id,req,'admin',true);V.revision(req.body,row);await run('UPDATE marketplace_eas SET featured=?,updated_at=? WHERE id=?',[featured,Date.now(),row.id]);await audit(req,'admin','featured_updated',row.id,{featured});});res.json({message:'Featured placement updated.'});
  }));
  app.get('/api/admin/marketplace/strategies',adminAuth.verifyToken,wrap(async(_req,res)=>res.json({strategies:await all('SELECT s.id,s.code,s.name,s.is_active,s.is_published,e.partner_id FROM trading_strategies s LEFT JOIN ea_submissions e ON e.id=s.submission_id ORDER BY s.name')})));
  app.get('/api/admin/marketplace/access',adminAuth.verifyToken,wrap(async(req,res)=>{
    const term='%'+String(req.query.search||'').slice(0,100).toLowerCase()+'%';res.json({users:await all('SELECT u.id,u.username,u.email,a.enabled FROM users u LEFT JOIN marketplace_user_access a ON a.user_id=u.id WHERE LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ? ORDER BY u.id DESC LIMIT 40',[term,term])});
  }));
  app.patch('/api/admin/marketplace/access/:userId',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{
    const id=Number(req.params.userId),value=req.body?.enabled;if(!Number.isSafeInteger(id)||id<1||!await get('SELECT id FROM users WHERE id=?',[id]))V.fail('User not found.',404);
    if(value!==null)V.bool(value,'enabled');
    await withTransaction(db,async()=>{if(value===null)await run('DELETE FROM marketplace_user_access WHERE user_id=?',[id]);else await run('INSERT INTO marketplace_user_access(user_id,enabled,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at',[id,value,adminActor(req),Date.now()]);await audit(req,'admin','user_access_updated',null,{userId:id,enabled:value});});res.json({message:'User access updated. Global OFF always overrides individual access.'});
  }));
  app.get('/api/admin/marketplace/audit',adminAuth.verifyToken,wrap(async(_req,res)=>res.json({audit:await all('SELECT * FROM marketplace_audit ORDER BY created_at DESC LIMIT 100')})));

  // Images are stored privately, decoded/re-encoded to WebP, and served through
  // the same publication/ownership checks as the containing listing.
  async function upload(req,res,role,kind) {
    if(kind!=='banner')await owned(req.params.id,req,role);
    const image=await normalizeImage(req.body,kind),id=uid(),file=id+'.webp';
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,file),image.bytes,{flag:'wx'});
    try {
      await withTransaction(db,async()=>{
        let row, displayOrder=0;
        if(kind!=='banner'){
          row=await owned(req.params.id,req,role,true);await invalidate(row,role);
          const count=await get("SELECT COUNT(*) AS n,COALESCE(MAX(display_order),-1) AS last_order FROM marketplace_media WHERE ea_id=? AND kind='screenshot' AND deleted_at IS NULL",[row.id]);
          if(kind==='screenshot'&&Number(count.n)>=10)V.fail('A listing can contain up to 10 screenshots.',409);
          if(kind==='screenshot')displayOrder=Number(count.last_order)+1;
          if(kind==='logo')await run("UPDATE marketplace_media SET deleted_at=? WHERE ea_id=? AND kind='logo' AND deleted_at IS NULL",[Date.now(),row.id]);
          await run('UPDATE marketplace_eas SET revision=revision+1,updated_at=? WHERE id=?',[Date.now(),row.id]);
        }else if(isPostgres(db))await get('SELECT id FROM marketplace_settings WHERE id=1 FOR UPDATE');
        await run('INSERT INTO marketplace_media(id,ea_id,kind,file_name,content_hash,bytes,width,height,display_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [id,row?.id||null,kind,file,crypto.createHash('sha256').update(image.bytes).digest('hex'),image.bytes.length,image.width,image.height,displayOrder,Date.now()]);
        if(kind==='banner')await run('UPDATE marketplace_settings SET promo_image_id=?,updated_by=?,updated_at=? WHERE id=1',[id,adminActor(req),Date.now()]);
        await audit(req,role,'media_uploaded',row?.id||null,{mediaId:id,kind});
      });
    }catch(error){await fs.unlink(path.join(directory,file)).catch(()=>{});throw error;}
    res.status(201).json({id,url:mediaUrl(id,role)});
  }
  async function removeMedia(req,role) {
    await withTransaction(db,async()=>{const row=await owned(req.params.id,req,role,true);V.revision(req.body,row);const image=await get('SELECT id FROM marketplace_media WHERE id=? AND ea_id=? AND deleted_at IS NULL',[req.params.imageId,row.id]);if(!image)V.fail('Image not found.',404);await invalidate(row,role);await run('UPDATE marketplace_media SET deleted_at=? WHERE id=?',[Date.now(),image.id]);await run('UPDATE marketplace_eas SET revision=revision+1,updated_at=? WHERE id=?',[Date.now(),row.id]);await audit(req,role,'media_removed',row.id,{mediaId:image.id});});
  }
  async function reorder(req,role) {
    await withTransaction(db,async()=>{const row=await owned(req.params.id,req,role,true);V.revision(req.body,row);const images=await all("SELECT id FROM marketplace_media WHERE ea_id=? AND kind='screenshot' AND deleted_at IS NULL",[row.id]);const ids=req.body.ids;if(!Array.isArray(ids)||ids.length!==images.length||new Set(ids).size!==ids.length||ids.some(id=>!images.some(i=>i.id===id)))V.fail('Supply each screenshot ID exactly once.');await invalidate(row,role);for(let i=0;i<ids.length;i++)await run('UPDATE marketplace_media SET display_order=? WHERE id=?',[i,ids[i]]);await run('UPDATE marketplace_eas SET revision=revision+1,updated_at=? WHERE id=?',[Date.now(),row.id]);await audit(req,role,'screenshots_reordered',row.id,{ids});});
  }
  const binary=express.raw({type:'application/octet-stream',limit:MAX_BYTES});
  app.post('/api/partner/marketplace/eas/:id/screenshots',verifyToken,uploadLimit,binary,wrap((req,res)=>upload(req,res,'partner','screenshot')));
  app.post('/api/partner/marketplace/eas/:id/logo',verifyToken,uploadLimit,binary,wrap((req,res)=>upload(req,res,'partner','logo')));
  app.delete('/api/partner/marketplace/eas/:id/screenshots/:imageId',verifyToken,mutateLimit,wrap(async(req,res)=>{await removeMedia(req,'partner');res.json({message:'Image removed.'});}));
  app.post('/api/partner/marketplace/eas/:id/screenshots/order',verifyToken,mutateLimit,wrap(async(req,res)=>{await reorder(req,'partner');res.json({message:'Screenshot order saved.'});}));
  app.post('/api/admin/marketplace/eas/:id/screenshots',adminAuth.verifyToken,uploadLimit,binary,wrap((req,res)=>upload(req,res,'admin','screenshot')));
  app.post('/api/admin/marketplace/eas/:id/logo',adminAuth.verifyToken,uploadLimit,binary,wrap((req,res)=>upload(req,res,'admin','logo')));
  app.delete('/api/admin/marketplace/eas/:id/screenshots/:imageId',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{await removeMedia(req,'admin');res.json({message:'Image removed.'});}));
  app.post('/api/admin/marketplace/eas/:id/screenshots/order',adminAuth.verifyToken,mutateLimit,wrap(async(req,res)=>{await reorder(req,'admin');res.json({message:'Screenshot order saved.'});}));
  app.post('/api/admin/marketplace/promotion/image',adminAuth.verifyToken,uploadLimit,binary,wrap((req,res)=>upload(req,res,'admin','banner')));
  async function sendMedia(req,res,role) {
    const image=await get('SELECT * FROM marketplace_media WHERE id=? AND deleted_at IS NULL',[req.params.imageId]);if(!image)V.fail('Image not found.',404);
    if(role==='user'){
      await access(req);
      if(image.ea_id)await published(image.ea_id);
      else{const config=await settings();if(!config.promo_visible||config.promo_image_id!==image.id||!config.promo_ea_id)V.fail('Image not found.',404);await published(config.promo_ea_id);}
    }else if(role==='partner')await owned(image.ea_id,req,role);
    if(!/^[a-f0-9-]{36}\.webp$/.test(image.file_name))V.fail('Image not found.',404);
    try{const bytes=await fs.readFile(path.join(directory,image.file_name));res.set({'Content-Type':'image/webp','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox"}).send(bytes);}catch(error){if(error.code==='ENOENT')V.fail('Image not found.',404);throw error;}
  }
  app.get('/api/marketplace/media/:imageId',verifyToken,wrap((req,res)=>sendMedia(req,res,'user')));
  app.get('/api/partner/marketplace/media/:imageId',verifyToken,wrap((req,res)=>sendMedia(req,res,'partner')));
  app.get('/api/admin/marketplace/media/:imageId',adminAuth.verifyToken,wrap((req,res)=>sendMedia(req,res,'admin')));
  return { ready, setPublicationSystem(service){ publication=service; } };
}
module.exports = { createMarketplace };
