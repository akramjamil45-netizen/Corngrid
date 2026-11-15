'use strict';
const path=require('node:path'),express=require('../Corngrid-web/node_modules/express'),sharp=require('../Corngrid-web/node_modules/sharp');
const {fixture}=require('../Corngrid-web/test/helpers/feed-images-fixture');
async function main(){
 const f=await fixture(),images=[];
 for(let i=0;i<5;i++){
  const bytes=await sharp({create:{width:i%2?700:1100,height:i%2?950:700,channels:3,background:['#111923','#283721','#3b283e','#303d4e','#493b1b'][i]}}).composite([{input:Buffer.from(`<svg width="700" height="700"><text x="50" y="300" fill="#ffd400" font-family="sans-serif" font-size="60">CORNGRID</text><text x="50" y="390" fill="white" font-family="sans-serif" font-size="40">Image ${i+1} of 5</text></svg>`)}]).png().toBuffer();
  const r=await f.request('/api/feed/uploads',{method:'POST',bytes});if(r.status!==201)throw Error('Preview upload failed');images.push(r.data.url);
 }
 const post=await f.request('/api/feed/posts',{method:'POST',body:{content:'CornGrid community gallery. Swipe left or right to explore all five images.',imagePaths:images}});if(post.status!==201)throw Error('Preview publish failed');
 await f.request('/api/feed/posts',{method:'POST',body:{content:'A single image remains simple.',imagePath:images[1]}});
 f.app.get('/preview',(_req,res)=>{res.cookie('corngrid_session',f.tokens[1],{httpOnly:true,sameSite:'lax',path:'/'});res.redirect('/dashboard.html#feed');});
 f.app.get('/api/me',(_req,res)=>res.json({id:1,username:'Gallery User 1',email:'gallery1@example.test',created_at:'2026-11-01'}));
 f.app.get('/api/chat/unread-count',(_req,res)=>res.json({count:0}));
 f.app.use(express.static(path.resolve(__dirname,'../Corngrid-web/public')));
 console.log(JSON.stringify({url:f.base+'/preview',isolated:true}));process.on('SIGINT',()=>f.close().then(()=>process.exit(0)));
}
main().catch(error=>{console.error('Gallery preview failed:',error.code||error.name);process.exitCode=1;});
