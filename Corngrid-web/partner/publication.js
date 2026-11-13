'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {dbGet,dbAll,dbRun,withTransaction,isPostgres}=require('../db-async');
const {ensureMarketplaceSchema}=require('../marketplace/schema');
const {decodePresets}=require('./presets');
const {fail}=require('../marketplace/validation');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const parse=value=>JSON.parse(value);
const EX5_LIMIT=10*1024*1024;
const RISK='Automated trading involves financial risk. Historical performance does not guarantee future results. Capital can be lost.';
function validateEx5(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<64||bytes.length>EX5_LIMIT||bytes.subarray(0,3).toString('ascii')!=='EX5')fail('Upload a valid MetaTrader 5 EX5 executable, up to 10 MB.');
}
function within(root,relative){
  if(typeof relative!=='string')fail('Invalid artifact path.',409);
  const resolved=path.resolve(root,relative),rel=path.relative(path.resolve(root),resolved);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))fail('Invalid artifact path.',409);
  return resolved;
}
function decodeFiles(files,entryFile){
  if(!Array.isArray(files)||!files.length||files.length>20)fail('Upload the EA executable (.ex5), or its source project, with at most 20 files.');
  const seen=new Set();let total=0;
  const decoded=files.map(file=>{
    const name=file?.name;
    if(typeof name!=='string'||!/^[A-Za-z0-9._ -]{1,120}$/.test(name)||/[. ]$/.test(name)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)||name!==path.basename(name)||seen.has(name.toLowerCase()))fail('File names must be safe and unique, including letter case.');
    seen.add(name.toLowerCase());const ext=path.extname(name).toLowerCase();
    if(!['.ex5','.mq5','.mqh','.zip'].includes(ext))fail('Upload .ex5, .mq5, .mqh or .zip EA files.');
    const data=file.contentBase64;
    if(typeof data!=='string'||data.length>13981020||!data.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))fail('Invalid EA file encoding or size.');
    const bytes=Buffer.from(data,'base64');total+=bytes.length;
    if(!bytes.length||bytes.length>EX5_LIMIT||total>20*1024*1024)fail('Each EA file must be up to 10 MB; the whole submission must be up to 20 MB.');
    if(ext==='.ex5')validateEx5(bytes);
    if(ext==='.zip'&&(bytes[0]!==0x50||bytes[1]!==0x4b))fail('The project archive is not a ZIP file.');
    return {name,ext,bytes,sha256:sha(bytes)};
  });
  const binaries=decoded.filter(f=>f.ext==='.ex5'),sources=decoded.filter(f=>f.ext==='.mq5');
  if(binaries.length>1)fail('Upload one main EX5 executable per submission.');
  if(!binaries.length&&!sources.length&&!decoded.some(f=>f.ext==='.zip'))fail('Include an EX5 executable, an MQ5 main file, or a ZIP project.');
  let entry=binaries[0]?.name||entryFile||sources[0]?.name||null;
  if(!binaries.length&&sources.length>1&&!entryFile)fail('Specify the main MQ5 entry filename when uploading several MQ5 files.');
  if(entry&&!decoded.some(f=>f.name===entry&&['.mq5','.ex5'].includes(f.ext)))fail('The entry file must be an uploaded EX5 or MQ5 file.');
  return {decoded,entry};
}
function createPartnerPublication({db,events,storageDir,strategyStorageDir,scanSource=()=>[]}={}){
  const sourceRoot=path.resolve(storageDir||path.join(__dirname,'../storage/ea-submissions'));
  const strategyRoot=path.resolve(strategyStorageDir||path.join(__dirname,'../storage'));
  const get=(s,p)=>dbGet(db,s,p),all=(s,p)=>dbAll(db,s,p),run=(s,p)=>dbRun(db,s,p);
  const ready=(async()=>{
    await ensureMarketplaceSchema(db);
    if(isPostgres(db))await get('SELECT submission_id FROM ea_submission_links LIMIT 0');
    else{const sql=await fs.readFile(path.join(__dirname,'../migrations/sqlite/0016_partner_publication.sql'),'utf8');await new Promise((resolve,reject)=>db.exec(sql,e=>e?reject(e):resolve()));}
  })();ready.catch(()=>{});
  const lock=isPostgres(db)?' FOR UPDATE':'';
  async function audit(actor,action,id,metadata){
    await run('INSERT INTO marketplace_audit(id,actor_role,actor_id,action,ea_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',[crypto.randomUUID(),actor.role,String(actor.id||'admin'),action,id,JSON.stringify(metadata||{}),Date.now()]);
  }
  async function profile(userId){const p=await get("SELECT * FROM partner_profiles WHERE user_id=? AND status='active'",[userId]);if(!p)fail('Approved, active partner access is required.',403);return p;}
  async function snapshot(listing){
    const fields=['id','provider_id','name','short_description','full_description','version','strategy_type','supported_symbols','supported_timeframes','minimum_balance','balance_currency','recommended_leverage','account_mode','platform','revision'];
    return {listing:Object.fromEntries(fields.map(k=>[k,listing[k]])),media:await all('SELECT id,kind,content_hash,display_order FROM marketplace_media WHERE ea_id=? AND deleted_at IS NULL ORDER BY display_order,id',[listing.id])};
  }
  async function presetsFor(id){const rows=await all('SELECT symbol,file_name,content_text FROM ea_submission_presets WHERE submission_id=? ORDER BY symbol',[id]);return rows.map(r=>({symbol:r.symbol,name:r.file_name,sha256:sha(r.content_text)}));}
  async function createSubmission(userId,body,{listingId=body?.marketplaceId,revision=body?.marketplaceRevision}={}){
    await ready;await profile(userId);
    const {decoded,entry}=decodeFiles(body?.files,body?.entryFile);
    let presets;try{presets=decodePresets(body.presets);}catch(e){fail(e.message);}
    if(!presets.length)fail('Upload at least one .set preset for the EA.');
    const key=body.requestKey||crypto.randomUUID();if(typeof key!=='string'||!/^[a-f0-9-]{36}$/i.test(key))fail('Invalid submission request key.');
    const fileManifest=decoded.map(f=>({name:f.name,bytes:f.bytes.length,sha256:f.sha256})).sort((a,b)=>a.name.localeCompare(b.name));
    const presetManifest=presets.map(p=>({symbol:p.symbol,name:p.name,sha256:sha(p.text)})).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    const requestDigest=sha(JSON.stringify({listingId:listingId||null,revision:revision??null,name:body.name,version:body.version,description:body.description,symbols:body.symbols,strategyDescription:body.strategyDescription,riskDescription:body.riskDescription,documentation:body.documentation,entry,files:fileManifest,presets:presetManifest}));
    let created;
    const result=await withTransaction(db,async()=>{
      await get('SELECT user_id FROM partner_profiles WHERE user_id=?'+lock,[userId]);await profile(userId);
      const previous=await get('SELECT l.*,s.partner_id,s.submission_uid FROM ea_submission_links l JOIN ea_submissions s ON s.id=l.submission_id WHERE l.request_key=?',[key]);
      if(previous){if(previous.partner_id!==userId||previous.request_digest!==requestDigest)fail('The submission key was already used for different files or details.',409);return {submissionId:previous.submission_id,submissionUid:previous.submission_uid,listingId:previous.listing_id,alreadyCreated:true,scanFindings:[]};}
      let listing;
      if(listingId){
        listing=await get('SELECT * FROM marketplace_eas WHERE id=?'+lock,[listingId]);
        if(!listing||listing.provider_type!=='partner'||listing.provider_id!==userId)fail('EA listing not found.',404);
        if(listing.listing_status==='archived')fail('This listing is archived.',409);
        if(revision!==listing.revision)fail('The listing changed. Reload it before uploading the release.',409,'REVISION_CONFLICT');
      }
      const name=listing?.name||(typeof body.name==='string'?body.name.trim():null),version=listing?.version||(typeof body.version==='string'?body.version.trim():null);
      const d=listing?parse(listing.full_description):null;
      const description=listing?(d.overview||listing.short_description):(typeof body.description==='string'?body.description.trim():null);
      if(typeof name!=='string'||name.length<2||name.length>100)fail('Enter an EA name between 2 and 100 characters.');
      if(typeof version!=='string'||!/^[0-9A-Za-z._-]{1,40}$/.test(version))fail('Enter a valid EA version, up to 40 characters.');
      if(typeof description!=='string'||description.length<10||description.length>6000)fail('Add an overview of at least 10 characters.');
      const symbols=presets.map(p=>p.symbol).sort();
      const declared=listing?parse(listing.supported_symbols):String(body.symbols||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
      if(declared.some(s=>!symbols.includes(s))||listing&&symbols.some(s=>!declared.includes(s)))fail('Upload one .set preset for every listed trading pair; symbols and presets must match.');
      if(!listing){
        const id=crypto.randomUUID(),stamp=Date.now();
        if(Number((await get('SELECT COUNT(*) AS n FROM marketplace_eas WHERE provider_id=?',[userId])).n)>=100)fail('The partner listing limit has been reached.',409);
        const full={overview:description,features:'',strategy:String(body.strategyDescription||'').slice(0,2000),markets:symbols.join(', '),configuration:String(body.documentation||'').slice(0,4000),riskManagement:'',risks:String(body.riskDescription||RISK).slice(0,2000),changelog:`Version ${version}`};
        await run(`INSERT INTO marketplace_eas(id,provider_type,provider_id,name,slug,short_description,full_description,version,supported_symbols,created_at,updated_at) VALUES(?,'partner',?,?,?,?,?,?,?,?,?)`,[id,userId,name,'partner-'+id,description.slice(0,300),JSON.stringify(full),version,JSON.stringify(symbols),stamp,stamp]);
        listing=await get('SELECT * FROM marketplace_eas WHERE id=?',[id]);
      }
      if(!listing.short_description||!parse(listing.full_description).overview||!parse(listing.full_description).risks)fail('Add a short description, overview and important trading risks before submitting.');
      const submissionUid='sub_'+crypto.randomBytes(9).toString('hex'),stamp=Date.now();
      const inserted=await run(`INSERT INTO ea_submissions(submission_uid,partner_id,name,description,version,symbols,strategy_description,risk_description,documentation,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending_review',?,?)`,[submissionUid,userId,name,description.slice(0,2000),version,symbols.join(','),parse(listing.full_description).strategy||'',parse(listing.full_description).risks,parse(listing.full_description).configuration||'',stamp,stamp]);
      const id=inserted.lastID,dir=within(sourceRoot,submissionUid);await fs.mkdir(dir,{recursive:true});created=dir;
      const findings=[];
      for(const file of decoded){await fs.writeFile(within(dir,file.name),file.bytes,{flag:'wx'});if(['.mq5','.mqh'].includes(file.ext))findings.push(...scanSource(file.name,file.bytes.toString('utf8')));}
      const v=await run('INSERT INTO ea_versions(submission_id,version,file_path,file_count,source_hash,status,created_at) VALUES(?,?,?,?,?,?,?)',[id,version,submissionUid,decoded.length,sha(JSON.stringify(fileManifest)),'stored',stamp]);
      for(const p of presets)await run('INSERT INTO ea_submission_presets(submission_id,symbol,file_name,content_text) VALUES(?,?,?,?)',[id,p.symbol,p.name,p.text]);
      await run('UPDATE ea_submission_links SET superseded_at=? WHERE listing_id=? AND superseded_at IS NULL',[stamp,listing.id]);
      await run("UPDATE marketplace_reviews SET decision='superseded',reviewed_at=? WHERE ea_id=? AND decision='pending'",[stamp,listing.id]);
      // A file-only release is a new reviewed revision too; an older approval
      // must never authorize a newly uploaded executable with unchanged text.
      await run('UPDATE marketplace_eas SET revision=revision+1 WHERE id=?',[listing.id]);listing.revision++;
      const saved=await snapshot(listing),manifest={files:fileManifest,presets:presetManifest};
      await run('INSERT INTO ea_submission_links(submission_id,version_id,listing_id,listing_revision,request_key,request_digest,manifest_json,listing_snapshot_json,entry_file,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,v.lastID,listing.id,listing.revision,key,requestDigest,JSON.stringify(manifest),JSON.stringify(saved),entry,stamp]);
      const binary=decoded.find(f=>f.ext==='.ex5');
      if(binary)await run('INSERT INTO ea_submission_artifacts(id,submission_id,version_id,file_path,file_name,sha256,bytes,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[crypto.randomUUID(),id,v.lastID,path.join(submissionUid,binary.name),binary.name,binary.sha256,binary.bytes.length,'partner',stamp]);
      await run('INSERT INTO marketplace_reviews(id,ea_id,revision,snapshot_json,submitted_by,created_at) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),listing.id,listing.revision,JSON.stringify({submissionId:id,versionId:v.lastID,manifest,...saved}),userId,stamp]);
      await run("UPDATE marketplace_eas SET listing_status='pending_review',review_notes='',updated_at=? WHERE id=?",[stamp,listing.id]);
      if(findings.length)await run('UPDATE ea_submissions SET review_notes=? WHERE id=?',[('Automated scan flagged: '+findings.join('; ')).slice(0,1000),id]);
      await audit({role:'partner',id:userId},'ea_release_submitted',listing.id,{submissionId:id,versionId:v.lastID});
      return {submissionId:id,submissionUid,listingId:listing.id,scanFindings:findings,alreadyCreated:false};
    }).catch(async error=>{
      if(created){const relative=path.relative(sourceRoot,path.resolve(created));if(/^sub_[a-f0-9]{18}$/.test(relative))await fs.rm(path.resolve(created),{recursive:true,force:true}).catch(()=>{});}
      throw error;
    });
    if(!result.alreadyCreated)await events?.emit('EA_SUBMITTED',{actorType:'partner',actorId:userId,payload:{submissionUid:result.submissionUid,listingId:result.listingId}});
    return {...result,message:'EA files and presets received. Administrator approval will publish the EA to Marketplace and Sandbox automatically.'};
  }
  async function context(id,{verify=true}={}){
    const link=await get('SELECT * FROM ea_submission_links WHERE submission_id=?',[id]);
    if(!link)return null;
    const submission=await get('SELECT * FROM ea_submissions WHERE id=? AND deleted_at IS NULL',[id]);
    const listing=await get('SELECT * FROM marketplace_eas WHERE id=?',[link.listing_id]);
    const artifact=await get('SELECT * FROM ea_submission_artifacts WHERE version_id=?',[link.version_id]);
    const manifest=parse(link.manifest_json),saved=parse(link.listing_snapshot_json);
    let valid=Boolean(submission&&listing&&!link.superseded_at&&listing.revision===link.listing_revision&&JSON.stringify(await snapshot(listing))===JSON.stringify(saved));
    if(valid&&JSON.stringify(await presetsFor(id))!==JSON.stringify(manifest.presets))valid=false;
    if(verify&&valid){
      for(const file of manifest.files){try{const bytes=await fs.readFile(within(sourceRoot,path.join(submission.submission_uid,file.name)));if(bytes.length!==file.bytes||sha(bytes)!==file.sha256){valid=false;break;}}catch{valid=false;break;}}
    }
    let artifactReady=false;
    if(artifact){try{const bytes=await fs.readFile(within(sourceRoot,artifact.file_path));validateEx5(bytes);artifactReady=bytes.length===artifact.bytes&&sha(bytes)===artifact.sha256;}catch{artifactReady=false;}}
    const digest=valid&&artifactReady?sha(JSON.stringify({submissionId:id,versionId:link.version_id,manifest,saved,artifact:{id:artifact.id,sha256:artifact.sha256,bytes:artifact.bytes}})):null;
    return {link,submission,listing,artifact,valid,artifactReady,digest};
  }
  async function inspect(id){await ready;const c=await context(id);if(!c)return null;return {submissionId:id,listingId:c.link.listing_id,listingRevision:c.link.listing_revision,versionId:c.link.version_id,entryFile:c.link.entry_file,reviewDigest:c.digest,current:c.valid,artifactReady:c.artifactReady,artifact:c.artifact?{name:c.artifact.file_name,sha256:c.artifact.sha256,bytes:c.artifact.bytes,origin:c.artifact.origin}:null,files:parse(c.link.manifest_json).files,presets:parse(c.link.manifest_json).presets,reviewPresets:await all('SELECT symbol,file_name AS name,content_text AS text FROM ea_submission_presets WHERE submission_id=? ORDER BY symbol',[id]),canApprove:Boolean(c.digest&&['pending_review','under_review','testing_passed','approved'].includes(c.submission.status)),published:c.submission.status==='published'};}
  async function attachArtifact(id,bytes,{origin,reportId,actor}={}){
    await ready;validateEx5(bytes);
    const artifactId=crypto.randomUUID(),relative=path.join('_artifacts',artifactId+'.ex5'),file=within(sourceRoot,relative);let written=false;
    try{return await withTransaction(db,async()=>{
      const sub=await get('SELECT * FROM ea_submissions WHERE id=?'+lock,[id]);if(!sub||sub.deleted_at)fail('Submission not found.',404);
      const c=await context(id);if(!c||!c.valid||['published','rejected'].includes(sub.status))fail('This submission has changed or is no longer accepting artifacts.',409);
      if(origin==='test_node'){
        const report=await get('SELECT * FROM ea_test_reports WHERE id=? AND submission_id=? AND node_id=?',[reportId,id,actor.id]);
        const latest=await get('SELECT MAX(id) AS id FROM ea_test_reports WHERE submission_id=?',[id]);
        if(!report||report.status!=='running'||report.version_id!==c.link.version_id||latest.id!==report.id||sub.status!=='testing')fail('An active assigned test report is required.',403);
      }else if(origin!=='admin')fail('Invalid artifact origin.',403);
      if(c.artifact){if(c.artifact.sha256!==sha(bytes))fail('An immutable artifact already exists for this version. Submit a new release to replace it.',409);return {id:c.artifact.id,alreadyStored:true};}
      await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{flag:'wx'});written=true;
      await run('INSERT INTO ea_submission_artifacts(id,submission_id,version_id,file_path,file_name,sha256,bytes,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[artifactId,id,c.link.version_id,relative,'reviewed.ex5',sha(bytes),bytes.length,origin,Date.now()]);
      await run("UPDATE ea_versions SET status='compiled' WHERE id=?",[c.link.version_id]);
      await audit(actor,'ea_artifact_staged',c.listing.id,{submissionId:id,artifactId,sha256:sha(bytes)});return {id:artifactId,alreadyStored:false};
    });}catch(error){if(written)await fs.unlink(file).catch(()=>{});throw error;}
  }
  async function approve(id,{actor,reviewDigest}={}){
    await ready;
    const result=await withTransaction(db,async()=>{
      const sub=await get('SELECT * FROM ea_submissions WHERE id=?'+lock,[id]);if(!sub||sub.deleted_at)fail('Submission not found.',404);
      const old=await get('SELECT a.*,s.code FROM ea_release_approvals a JOIN trading_strategies s ON s.id=a.strategy_id WHERE a.submission_id=?',[id]);
      if(old){if(!reviewDigest||old.review_digest!==reviewDigest)fail('Reload the reviewed release before repeating approval.',409);return {submissionId:id,listingId:old.listing_id,strategyId:old.strategy_id,strategyCode:old.code,alreadyPublished:true};}
      const link=await get('SELECT * FROM ea_submission_links WHERE submission_id=?',[id]);if(!link)fail('Upload the EA and preset files using the unified submission flow first.',409,'EA_FILES_REQUIRED');
      await get('SELECT id FROM marketplace_eas WHERE id=?'+lock,[link.listing_id]);
      const c=await context(id);await profile(sub.partner_id);
      if(!c?.valid)fail('The listing, files or presets changed. A fresh submission and review are required.',409,'REVIEW_CHANGED');
      if(!c.artifactReady)fail('The reviewed EX5 artifact is not available yet. Compile the source on a test node or upload the reviewed executable first.',409,'ARTIFACT_REQUIRED');
      if(!reviewDigest||reviewDigest!==c.digest)fail('The review snapshot changed. Reload and review the exact EA artifact and preset files.',409,'REVIEW_CHANGED');
      if(!['pending_review','under_review','testing_passed','approved'].includes(sub.status)||c.listing.listing_status!=='pending_review')fail('This submission is not ready for approval.',409);
      const bytes=await fs.readFile(within(sourceRoot,c.artifact.file_path));validateEx5(bytes);if(sha(bytes)!==c.artifact.sha256)fail('The reviewed EA artifact changed.',409);
      const relative=path.join('ea-releases',sub.submission_uid,c.artifact.sha256+'.ex5'),released=within(strategyRoot,relative);
      await fs.mkdir(path.dirname(released),{recursive:true});
      try{await fs.writeFile(released,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||sha(await fs.readFile(released))!==c.artifact.sha256)throw error;}
      let strategy=c.listing.existing_strategy_id?await get('SELECT s.*,e.partner_id FROM trading_strategies s LEFT JOIN ea_submissions e ON e.id=s.submission_id WHERE s.id=?'+(isPostgres(db)?' FOR UPDATE OF s':''),[c.listing.existing_strategy_id]):null;
      if(strategy&&strategy.partner_id!==sub.partner_id)fail('The linked strategy belongs to a different provider.',409);
      const stamp=Date.now(),code=strategy?.code||'partner-'+sub.submission_uid.slice(4),fileName=code+'.ex5';
      if(strategy)await run('UPDATE trading_strategies SET name=?,description=?,version=?,ea_file_path=?,ea_file_name=?,submission_id=?,is_active=TRUE,is_published=TRUE,updated_at=? WHERE id=?',[sub.name,sub.description,sub.version,relative,fileName,id,stamp,strategy.id]);
      else{const inserted=await run('INSERT INTO trading_strategies(code,name,description,version,ea_file_path,ea_file_name,submission_id,is_active,is_published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,TRUE,TRUE,?,?)',[code,sub.name,sub.description,sub.version,relative,fileName,id,stamp,stamp]);strategy={id:inserted.lastID};}
      await run("UPDATE ea_submissions SET status='published',strategy_id=?,reviewed_by=NULL,reviewed_at=?,published_at=?,rejection_reason=NULL,updated_at=? WHERE id=?",[strategy.id,stamp,stamp,stamp,id]);
      await run("UPDATE marketplace_eas SET existing_strategy_id=?,listing_status='published',infrastructure_status='available',review_notes='',updated_at=? WHERE id=?",[strategy.id,stamp,c.listing.id]);
      await run("UPDATE marketplace_reviews SET decision='approved',reviewed_by=?,reviewed_at=? WHERE ea_id=? AND revision=? AND decision='pending'",[String(actor.id||'admin'),stamp,c.listing.id,c.link.listing_revision]);
      await run('INSERT INTO ea_release_approvals(submission_id,version_id,artifact_id,listing_id,listing_revision,strategy_id,review_digest,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?)',[id,c.link.version_id,c.artifact.id,c.listing.id,c.link.listing_revision,strategy.id,c.digest,String(actor.id||'admin'),stamp]);
      await audit(actor,'ea_release_published',c.listing.id,{submissionId:id,strategyId:strategy.id,artifactHash:c.artifact.sha256,reviewDigest:c.digest});
      await run('INSERT INTO subscription_audit_logs(actor_id,actor_role,action,affected_type,affected_id,metadata,created_at) VALUES(?,?,?,?,?,?,?)',[null,'admin','ea_published','ea_submission',id,JSON.stringify({listingId:c.listing.id,strategyId:strategy.id,artifactHash:c.artifact.sha256}),stamp]);
      return {submissionId:id,listingId:c.listing.id,strategyId:strategy.id,strategyCode:code,alreadyPublished:false};
    });
    if(!result.alreadyPublished)await events?.emit('EA_PUBLISHED',{actorType:'admin',payload:result});
    return {...result,message:'EA approved and published to Marketplace and Sandbox. Existing running EAs were not restarted.'};
  }
  async function reject(id,{actor,reason}={}){
    await ready;if(typeof reason!=='string'||reason.trim().length<5||reason.length>1000)fail('Enter a rejection reason between 5 and 1000 characters.');
    await withTransaction(db,async()=>{
      const sub=await get('SELECT * FROM ea_submissions WHERE id=?'+lock,[id]);if(!sub||sub.deleted_at)fail('Submission not found.',404);if(['published','rejected'].includes(sub.status))fail('This submission cannot be rejected.',409);
      const link=await get('SELECT * FROM ea_submission_links WHERE submission_id=?',[id]);
      if(link){const listing=await get('SELECT * FROM marketplace_eas WHERE id=?'+lock,[link.listing_id]);if(link.superseded_at||listing.revision!==link.listing_revision)fail('This submission was superseded. Review the current submission.',409);await run("UPDATE marketplace_eas SET listing_status='rejected',review_notes=?,updated_at=? WHERE id=?",[reason.trim(),Date.now(),link.listing_id]);await run("UPDATE marketplace_reviews SET decision='rejected',rejection_reason=?,reviewed_by=?,reviewed_at=? WHERE ea_id=? AND revision=? AND decision='pending'",[reason.trim(),String(actor.id||'admin'),Date.now(),link.listing_id,link.listing_revision]);}
      await run("UPDATE ea_submissions SET status='rejected',rejection_reason=?,reviewed_at=?,updated_at=? WHERE id=?",[reason.trim(),Date.now(),Date.now(),id]);await audit(actor,'ea_release_rejected',link?.listing_id||null,{submissionId:id,reason:reason.trim()});
    });
  }
  async function forListing(id){await ready;const row=await get('SELECT submission_id FROM ea_submission_links WHERE listing_id=? AND superseded_at IS NULL',[id]);return row?inspect(row.submission_id):null;}
  async function artifactFile(id){await ready;const a=await get('SELECT a.* FROM ea_submission_artifacts a JOIN ea_submissions s ON s.id=a.submission_id WHERE a.submission_id=? AND s.deleted_at IS NULL',[id]);if(!a)fail('No staged EA artifact is available.',404);return {path:within(sourceRoot,a.file_path),name:a.file_name,sha256:a.sha256};}
  async function isReleased(listingId,revision){
    await ready;const row=await get('SELECT a.sha256,s.ea_file_path FROM ea_release_approvals r JOIN ea_submission_artifacts a ON a.id=r.artifact_id JOIN trading_strategies s ON s.id=r.strategy_id WHERE r.listing_id=? AND r.listing_revision=? ORDER BY r.approved_at DESC LIMIT 1',[listingId,revision]);
    if(!row)return false;try{return sha(await fs.readFile(within(strategyRoot,row.ea_file_path)))===row.sha256;}catch{return false;}
  }
  return {ready,createSubmission,inspect,forListing,approve,reject,attachArtifact,artifactFile,isReleased,sourceRoot,strategyRoot};
}
module.exports={createPartnerPublication,validateEx5,decodeFiles};
