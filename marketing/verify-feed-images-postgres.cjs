'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web'),modules=path.join(root,'node_modules'),{Client}=require(path.join(modules,'pg')),sharp=require(path.join(modules,'sharp'));
const {fixture}=require(path.join(root,'test/helpers/feed-images-fixture'));
async function main(){
 const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env')),schema='feed_images_check_'+crypto.randomBytes(8).toString('hex'),url=new URL(env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const control=new Client({connectionString:env.DATABASE_URL});let f;await control.connect();
 try{
  await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
  for(const file of ['0001_initial.sql','0002_email_verification.sql','0010_account_archives.sql','0018_feed_images.sql','0018_feed_images.sql'])await control.query(fs.readFileSync(path.join(root,'migrations/postgres',file),'utf8'));
  f=await fixture(null,{database:require(path.join(root,'db-postgres'))(url.toString())});
  const bytes=await sharp({create:{width:800,height:600,channels:3,background:'#ffd400'}}).png().toBuffer(),images=[];
  for(let i=0;i<5;i++){const r=await f.request('/api/feed/uploads',{method:'POST',bytes});assert.equal(r.status,201);images.push(r.data.url);}
  const post=await f.request('/api/feed/posts',{method:'POST',body:{content:'Isolated PostgreSQL gallery',imagePaths:images}});assert.equal(post.status,201);const id=post.data.post.id;
  assert.deepEqual((await f.request('/api/feed/posts/'+id)).data.post.imagePaths,images);
  assert.equal((await f.request('/api/feed/posts',{user:2,method:'POST',body:{content:'Forbidden attachment reuse',imagePaths:images}})).status,400);
  const edit=imagePaths=>f.request('/api/feed/posts/'+id,{method:'PATCH',body:{content:'Updated gallery',imagePaths}});
  assert.deepEqual((await edit([images[4],images[2]])).data.post.imagePaths,[images[4],images[2]]);
  assert.equal((await edit([...images,images[0]])).status,400);
  await control.query("CREATE FUNCTION fail_fixture_image() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_order=1 THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$");
  await control.query('CREATE TRIGGER fail_fixture_image BEFORE INSERT ON feed_post_images FOR EACH ROW EXECUTE FUNCTION fail_fixture_image()');
  assert.equal((await edit(images)).status,500);assert.deepEqual((await f.request('/api/feed/posts/'+id)).data.post.imagePaths,[images[4],images[2]]);
  assert.deepEqual((await edit([])).data.post.imagePaths,[]);
  console.log(JSON.stringify({postgresVerified:true,migrationRepeatSafe:true,fiveImagesOrdered:true,ownershipEnforced:true,serverLimitEnforced:true,editAtomicRollback:true,removeAllImages:true,productionPostsCreated:0}));
 }finally{
  if(f)await f.close();if(!/^feed_images_check_[a-f0-9]{16}$/.test(schema))throw Error('Unsafe fixture schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
}
main().catch(error=>{console.error('Gallery PostgreSQL verification failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
