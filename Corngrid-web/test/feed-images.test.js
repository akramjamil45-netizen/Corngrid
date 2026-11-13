'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp'),fs=require('node:fs/promises'),path=require('node:path');
const {fixture}=require('./helpers/feed-images-fixture'),{dbRun,dbGet}=require('../db-async');
const png=()=>sharp({create:{width:2200,height:700,channels:3,background:'#ffd400'}}).withMetadata({exif:{IFD0:{Artist:'Private fixture metadata'}}}).png().toBuffer();
const upload=(f,bytes,extra={})=>f.request('/api/feed/uploads',{method:'POST',bytes,...extra});
const publish=(f,imagePaths,extra={})=>f.request('/api/feed/posts',{method:'POST',body:{content:'Gallery fixture',imagePaths,...extra}});
async function images(f,count=5){const bytes=await png(),urls=[];for(let n=0;n<count;n++){const r=await upload(f,bytes);assert.equal(r.status,201);urls.push(r.data.url);}return urls;}

test('up to five normalized images retain order on feed, single-post, profile and edits',async t=>{
 const f=await fixture(t),urls=await images(f),result=await publish(f,urls);assert.equal(result.status,201);const id=result.data.post.id;
 assert.deepEqual(result.data.post.imagePaths,urls);assert.equal(result.data.post.imagePath,urls[0]);
 for(const route of ['/api/feed','/api/feed?filter=mine','/api/feed?filter=popular','/api/feed/profile/Gallery%20User%201'])assert.deepEqual((await f.request(route)).data.posts[0].imagePaths,urls,route);
 assert.deepEqual((await f.request('/api/feed/posts/'+id)).data.post.imagePaths,urls);
 const edit=body=>f.request('/api/feed/posts/'+id,{method:'PATCH',body:{content:'Edited gallery',...body}});
 assert.deepEqual((await edit({})).data.post.imagePaths,urls,'omitted array retains all images');
 assert.deepEqual((await edit({imagePaths:[urls[4],urls[0]]})).data.post.imagePaths,[urls[4],urls[0]]);
 const extra=await images(f,1);assert.equal((await edit({imagePaths:[...extra,urls[0]]})).data.post.imagePath,extra[0]);
 assert.deepEqual((await edit({imagePaths:[]})).data.post.imagePaths,[]);assert.equal((await f.request('/api/feed/posts/'+id)).data.post.imagePath,null);
});

test('server rejects more than five images, duplicates, malformed arrays and external/missing references',async t=>{
 const f=await fixture(t),urls=await images(f);
 for(const value of [[...urls,urls[0]],[urls[0],urls[0]],null,'x',['https://outside.example/a.png'],['/uploads/feed/'+'a'.repeat(32)+'.webp'],[17]])assert.equal((await publish(f,value)).status,400);
 assert.equal((await publish(f,urls,{imagePath:urls[1]})).status,400);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM feed_posts')).n,0);
 const created=await publish(f,urls);assert.equal(created.status,201);
 assert.equal((await f.request('/api/feed/posts/'+created.data.post.id,{method:'PATCH',body:{content:'Invalid edit',imagePaths:[...urls,urls[0]]}})).status,400);
 assert.deepEqual((await f.request('/api/feed/posts/'+created.data.post.id)).data.post.imagePaths,urls);
});

test('image upload and post edit require authentication, ownership and cookie CSRF checks',async t=>{
 const f=await fixture(t),bytes=await png();assert.equal((await upload(f,bytes,{user:null})).status,401);
 assert.equal((await upload(f,bytes,{user:null,headers:{Cookie:'corngrid_session='+f.tokens[1],Origin:'https://untrusted.example'}})).status,403);
 const urls=await images(f,1);
 const stolen=await f.request('/api/feed/posts',{user:2,method:'POST',body:{content:'Stolen image',imagePaths:urls}});assert.equal(stolen.status,400);
 const created=await publish(f,urls),id=created.data.post.id;
 assert.equal((await f.request('/api/feed/posts/'+id,{user:2,method:'PATCH',body:{content:'Hijack',imagePaths:[]}})).status,403);
 assert.deepEqual((await f.request('/api/feed/posts/'+id)).data.post.imagePaths,urls);
 const otherImage=await upload(f,bytes,{user:2});assert.equal((await f.request('/api/feed/posts/'+id,{method:'PATCH',body:{content:'Hijack image',imagePaths:[otherImage.data.url]}})).status,400);
});

test('community uploads decode and normalize static images; invalid, animated and oversized files fail',async t=>{
 const f=await fixture(t),bytes=await png(),r=await upload(f,bytes);assert.equal(r.status,201);
 const meta=await sharp((await f.request(r.data.url,{user:null})).data).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,1920);assert.equal(meta.exif,undefined);
 for(const [data,type] of [[Buffer.from('<svg onload="x()"/>'),'image/svg+xml'],[Buffer.from('MZ fake'),'image/png'],[bytes,'image/jpeg']])assert.equal((await upload(f,data,{type})).status,400);
 assert.equal((await upload(f,Buffer.alloc(5*1024*1024+1))).status,413);
 const pixels=Buffer.concat([Buffer.alloc(64*64*3,20),Buffer.alloc(64*64*3,220)]),animated=await sharp(pixels,{raw:{width:64,height:128,pageHeight:64,channels:3}}).webp({loop:0,delay:[100,100]}).toBuffer();assert.equal((await upload(f,animated,{type:'image/webp'})).status,400);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM feed_image_uploads')).n,1);
 await fs.unlink(path.join(f.directory,path.basename(r.data.url)));assert.equal((await publish(f,[r.data.url])).status,400);
});

test('legacy single-image posts, text-only clients and soft deletion remain compatible',async t=>{
 const f=await fixture(t),legacy='/uploads/feed/'+'b'.repeat(32)+'.jpg';
 const row=await dbRun(f.db,"INSERT INTO feed_posts(author_user_id,kind,content,image_path,created_at) VALUES(1,'community','Legacy',?,?)",[legacy,Date.now()]);
 assert.deepEqual((await f.request('/api/feed/posts/'+row.lastID)).data.post.imagePaths,[legacy]);
 assert.equal((await f.request('/api/feed/posts/'+row.lastID,{method:'PATCH',body:{content:'Kept legacy',imagePaths:[legacy]}})).status,200);
 const [url]=await images(f,1),created=await f.request('/api/feed/posts',{method:'POST',body:{content:'Older client',imagePath:url}});assert.equal(created.status,201);assert.deepEqual(created.data.post.imagePaths,[url]);
 assert.equal((await f.request('/api/feed/posts',{method:'POST',body:{content:'Text only'}})).status,201);
 assert.equal((await f.request('/api/feed/posts/'+row.lastID,{method:'DELETE'})).status,200);assert.equal((await f.request('/api/feed/posts/'+row.lastID)).status,404);
});

test('image insert failures roll back new posts, daily quota and attachment edits together',async t=>{
 const f=await fixture(t),urls=await images(f,3),created=await publish(f,[urls[0]]),id=created.data.post.id;
 await dbRun(f.db,"CREATE TRIGGER reject_image_fixture BEFORE INSERT ON feed_post_images WHEN NEW.display_order=1 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 assert.equal((await publish(f,urls)).status,500);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM feed_posts')).n,1);
 assert.equal((await dbGet(f.db,"SELECT used FROM user_daily_usage WHERE user_id=1 AND kind='post'")).used,1);
 assert.equal((await f.request('/api/feed/posts/'+id,{method:'PATCH',body:{content:'Must roll back',imagePaths:urls}})).status,500);
 const unchanged=(await f.request('/api/feed/posts/'+id)).data.post;assert.equal(unchanged.content,'Gallery fixture');assert.deepEqual(unchanged.imagePaths,[urls[0]]);
});
