'use strict';
// Real PostgreSQL adapter + isolated schema. No production feed rows are written.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web'),modules=path.join(root,'node_modules'),express=require(path.join(modules,'express')),sharp=require(path.join(modules,'sharp')),{Client}=require(path.join(modules,'pg'));
async function main(){
 const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
 const schema='announcement_check_'+crypto.randomBytes(8).toString('hex'),url=new URL(env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const control=new Client({connectionString:env.DATABASE_URL}),directory=await fsp.mkdtemp(path.join(os.tmpdir(),'corngrid-announcement-pg-'));let db,server;await control.connect();
 try{
  await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);await control.query(fs.readFileSync(path.join(root,'migrations/postgres/0001_initial.sql'),'utf8'));
  await control.query("INSERT INTO users(id,username,email,password) VALUES(1,'Isolated reader','reader@example.test','test')");
  db=require(path.join(root,'db-postgres'))(url.toString());const app=express();app.use(express.json());
  const user=(req,res,next)=>{req.user={id:1};next();},admin=(req,res,next)=>req.get('X-Test-Admin')==='1'?(req.admin=true,next()):res.sendStatus(403);
  require(path.join(root,'feed-api'))(app,db,user,admin,{uploadDir:directory});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=async(route,{method='GET',bytes,body}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+route,{method,headers:{'X-Test-Admin':'1',...(bytes?{'Content-Type':'image/png'}:body?{'Content-Type':'application/json'}:{})},body:bytes|| (body?JSON.stringify(body):undefined)});return {status:response.status,data:await response.json()};};
  const bytes=await sharp({create:{width:500,height:300,channels:3,background:'#ffd400'}}).png().toBuffer(),image=await request('/api/feed/announcements/uploads',{method:'POST',bytes});assert.equal(image.status,201);
  const created=await request('/api/feed/announcements',{method:'POST',body:{title:'Isolated PostgreSQL announcement',content:'Image fixture only.',imagePath:image.data.url,isPinned:true}});assert.equal(created.status,201);const id=created.data.announcementId;
  assert.equal((await request('/api/feed?filter=announcements')).data.posts[0].imagePath,image.data.url);
  assert.equal((await request('/api/feed/announcements/'+id,{method:'PATCH',body:{title:'Updated',isPinned:false}})).status,200);
  assert.equal((await request('/api/feed/announcements')).data.announcements[0].imagePath,image.data.url);
  assert.equal((await request('/api/feed/announcements/'+id,{method:'PATCH',body:{imagePath:null}})).status,200);
  assert.equal((await request('/api/feed?filter=announcements')).data.posts[0].imagePath,null);
  console.log(JSON.stringify({postgresVerified:true,imageUpload:true,feedImage:true,textAndPinPreserveImage:true,removeImage:true,noSchemaMigrationRequired:true,productionFeedUnchanged:true}));
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));if(db)await new Promise(resolve=>db.close(resolve));
  if(!/^announcement_check_[a-f0-9]{16}$/.test(schema))throw Error('Invalid test schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
  if(!/^corngrid-announcement-pg-[a-z0-9]+$/i.test(path.relative(path.resolve(os.tmpdir()),path.resolve(directory))))throw Error('Invalid test directory');await fsp.rm(path.resolve(directory),{recursive:true,force:true});
 }
}
main().catch(error=>{console.error('Announcement PostgreSQL check failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
