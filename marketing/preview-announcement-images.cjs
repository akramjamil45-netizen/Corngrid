'use strict';
const path=require('node:path'),express=require('../Corngrid-web/node_modules/express'),sharp=require('../Corngrid-web/node_modules/sharp');
const {fixture}=require('../Corngrid-web/test/helpers/announcement-fixture');
async function main(){
 const f=await fixture();
 const bytes=await sharp({create:{width:1200,height:550,channels:3,background:'#12161e'}}).composite([{input:Buffer.from('<svg width="1200" height="550"><rect x="30" y="30" width="1140" height="490" rx="20" stroke="#ffd400" fill="none"/><text x="75" y="250" fill="#ffd400" font-family="sans-serif" font-size="60">CORNGRID ANNOUNCEMENT</text><text x="75" y="325" fill="#ffffff" font-family="sans-serif" font-size="35">Image upload preview</text></svg>')}]).png().toBuffer();
 const image=await f.request('/api/feed/announcements/uploads',{method:'POST',bytes,type:'image/png'});if(image.status!==201)throw Error('Preview image upload failed');
 const announcement=await f.request('/api/feed/announcements',{method:'POST',body:{title:'CornGrid update with image',content:'This is an isolated development preview. No production announcement is created.',isPinned:true,imagePath:image.data.url}});if(announcement.status!==201)throw Error('Preview announcement failed');
 f.app.get('/preview/:role',(req,res)=>{const admin=req.params.role==='admin';res.cookie('corngrid_session',f.tokens[admin?'admin':'user'],{httpOnly:true,sameSite:'lax',path:'/'});res.redirect(admin?'/admin.html#announcements':'/dashboard.html#feed');});
 f.app.get('/api/me',(_req,res)=>res.json({id:1,username:'Image Preview',email:'preview@example.test'}));
 f.app.get('/api/admin/overview',(_req,res)=>res.json({summary:{totalUsers:1,publicPortfolios:0,privatePortfolios:1,linkedAccounts:0},profiles:[],page:1,totalPages:0}));
 f.app.get('/api/admin/support/conversations',(_req,res)=>res.json({conversations:[],unreadCount:0}));
 f.app.get('/api/chat/unread-count',(_req,res)=>res.json({count:0}));
 f.app.use(express.static(path.resolve(__dirname,'../Corngrid-web/public')));
 console.log(JSON.stringify({admin:f.base+'/preview/admin',user:f.base+'/preview/user',isolated:true}));
 process.on('SIGINT',()=>f.close().then(()=>process.exit(0)));
}
main().catch(error=>{console.error('Announcement preview failed:',error.code||error.name);process.exitCode=1;});
