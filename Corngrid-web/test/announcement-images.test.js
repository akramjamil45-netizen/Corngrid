'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp'),fs=require('node:fs/promises');
const {fixture}=require('./helpers/announcement-fixture');
const png=()=>sharp({create:{width:2200,height:700,channels:3,background:'#ffd400'}}).png().withMetadata({exif:{IFD0:{Artist:'Private test metadata'}}}).toBuffer();
const upload=(f,bytes,extra={})=>f.request('/api/feed/announcements/uploads',{method:'POST',bytes,...extra});
const publish=(f,imagePath,extra={})=>f.request('/api/feed/announcements',{method:'POST',body:{title:'Image announcement',content:'A real image attachment fixture.',isPinned:true,imagePath,...extra}});

test('admin uploads are normalized, published to Live Feed, retained during text/pin edits and replaceable/removable',async t=>{
  const f=await fixture(t),bytes=await png(),image=await upload(f,bytes);assert.equal(image.status,201);assert.match(image.data.url,/^\/uploads\/feed\/[a-f0-9]{32}\.webp$/);
  const downloaded=await f.request(image.data.url,{role:null});assert.equal(downloaded.status,200);const meta=await sharp(downloaded.data).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,1920);assert.equal(meta.exif,undefined);
  for(const [format,type] of [['jpeg','image/jpeg'],['webp','image/webp']])assert.equal((await upload(f,await sharp(bytes).toFormat(format).toBuffer(),{type})).status,201,format+' is accepted');
  const created=await publish(f,image.data.url);assert.equal(created.status,201);const id=created.data.announcementId;
  let list=(await f.request('/api/feed/announcements')).data.announcements;assert.equal(list.find(a=>a.id===id).imagePath,image.data.url);
  let feed=(await f.request('/api/feed?filter=announcements',{role:'user'})).data.posts;assert.equal(feed[0].id,id);assert.equal(feed[0].imagePath,image.data.url);
  for(const body of [{title:'Changed title'},{isPinned:false}])assert.equal((await f.request('/api/feed/announcements/'+id,{method:'PATCH',body})).status,200);
  list=(await f.request('/api/feed/announcements')).data.announcements;assert.equal(list[0].imagePath,image.data.url);
  const second=await upload(f,bytes);assert.equal((await f.request('/api/feed/announcements/'+id,{method:'PATCH',body:{imagePath:second.data.url}})).status,200);
  assert.equal((await f.request('/api/feed?filter=announcements',{role:'user'})).data.posts[0].imagePath,second.data.url);
  assert.equal((await f.request('/api/feed/announcements/'+id,{method:'PATCH',body:{imagePath:null}})).status,200);
  assert.equal((await f.request('/api/feed?filter=announcements',{role:'user'})).data.posts[0].imagePath,null);
  assert.equal((await publish(f,null)).status,201,'text-only announcements still work');
});

test('only admin may upload/publish/edit announcement images and cookie mutations retain CSRF enforcement',async t=>{
  const f=await fixture(t),bytes=await png();assert.equal((await upload(f,bytes,{role:null})).status,401);assert.equal((await upload(f,bytes,{role:'user'})).status,403);assert.deepEqual(await fs.readdir(f.directory),[]);
  const cookie={Cookie:'corngrid_session='+f.tokens.admin};
  assert.equal((await upload(f,bytes,{role:null,headers:{...cookie,Origin:'https://untrusted.example'}})).status,403);
  const image=await upload(f,bytes,{role:null,headers:{...cookie,Origin:f.base}});assert.equal(image.status,201);
  assert.equal((await f.request('/api/feed/announcements',{role:'user',method:'POST',body:{title:'Stolen',content:'Not allowed.',imagePath:image.data.url}})).status,403);
  const created=await publish(f,image.data.url);
  assert.equal((await f.request('/api/feed/announcements/'+created.data.announcementId,{role:'user',method:'PATCH',body:{imagePath:null}})).status,403);
});

test('invalid files, animated images, oversized bodies and external/missing image references cannot be attached',async t=>{
  const f=await fixture(t),valid=await png();
  for(const [bytes,type] of [[Buffer.from('<svg onload="alert(1)"></svg>'),'image/svg+xml'],[Buffer.from('MZ not an image'),'image/png'],[valid,'image/jpeg'],[Buffer.concat([valid.subarray(0,32),Buffer.from('broken')]),'image/png']])assert.equal((await upload(f,bytes,{type})).status,400);
  const pixels=Buffer.concat([Buffer.alloc(64*64*3,20),Buffer.alloc(64*64*3,220)]);
  const animated=await sharp(pixels,{raw:{width:64,height:128,pageHeight:64,channels:3}}).webp({loop:0,delay:[100,100]}).toBuffer();assert.ok((await sharp(animated).metadata()).pages>1);assert.equal((await upload(f,animated,{type:'image/webp'})).status,400);
  assert.equal((await upload(f,Buffer.alloc(5*1024*1024+1))).status,413);assert.deepEqual(await fs.readdir(f.directory),[]);
  const announcement=await publish(f,null),id=announcement.data.announcementId;
  for(const ref of ['https://outside.example/image.png','/uploads/feed/../../secret.png','/uploads/feed/'+'a'.repeat(32)+'.webp',17]){
    assert.equal((await publish(f,ref)).status,400);assert.equal((await f.request('/api/feed/announcements/'+id,{method:'PATCH',body:{imagePath:ref}})).status,400);
  }
  assert.equal((await f.request('/api/feed/announcements/'+id,{method:'PATCH',body:{imagePath:null}})).status,200);
});
