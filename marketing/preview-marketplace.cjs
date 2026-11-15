'use strict';
// A real in-memory API and actual dashboard scripts, with isolated fixture users.
// No production environment, broker credentials, binary execution or payments.
const path=require('node:path'),express=require('../Corngrid-web/node_modules/express');
const {fixture}=require('../Corngrid-web/test/helpers/marketplace-fixture');
const sharp=require('../Corngrid-web/node_modules/sharp');
async function main(){
  const f=await fixture(),root=path.resolve(__dirname,'../Corngrid-web/public');
  await f.enable();
  const image=await sharp({create:{width:1000,height:600,channels:3,background:'#171b24'}}).composite([{input:Buffer.from('<svg width="1000" height="600"><rect x="40" y="40" width="920" height="520" rx="20" fill="#11151d" stroke="#ffd400"/><text x="90" y="300" fill="#ffd400" font-size="54" font-family="sans-serif">EA interface preview</text></svg>')}]).png().toBuffer();
  const official=await f.details('corngrid-official');
  await f.request('/api/admin/marketplace/eas/corngrid-official',{user:'admin',method:'PATCH',body:{...f.data,name:'CornGrid EA',strategy_type:'grid',revision:official.revision}});
  for(let i=0;i<2;i++)await f.request('/api/admin/marketplace/eas/corngrid-official/screenshots',{user:'admin',method:'POST',bytes:image});
  await f.action('corngrid-official','publication',{status:'published'});await f.action('corngrid-official','infrastructure',{status:'available'});await f.action('corngrid-official','featured',{featured:true});
  const partner=await f.create(2,{name:'Aurora Trend EA',strategy_type:'trend',short_description:'An example partner listing for the isolated development preview.'});
  await f.request(`/api/partner/marketplace/eas/${partner}/screenshots`,{user:2,method:'POST',bytes:image});
  await f.action(partner,'submit',{},2);await f.action(partner,'approve');await f.action(partner,'publication',{status:'published'});
  const pending=await f.create(2,{name:'Partner Review Draft'});await f.action(pending,'submit',{},2);
  await f.enable();await f.grant();
  f.app.get('/preview/:role',(req,res)=>{
    const role=req.params.role,token=f.tokens[role==='admin'?'admin':role==='partner'?2:1];
    res.cookie('corngrid_session',token,{httpOnly:true,sameSite:'lax',path:'/'});
    res.redirect(role==='admin'?'/admin.html#marketplace':'/dashboard.html#'+(role==='partner'?'partner-marketplace':'marketplace'));
  });
  f.app.get('/api/me',(_req,res)=>res.json({id:1,username:'Marketplace Preview',email:'preview@example.test',created_at:new Date().toISOString()}));
  f.app.get('/api/user/portfolio-sharing',(_req,res)=>res.json({isPublic:false,accounts:[]}));
  f.app.get('/api/chat/unread-count',(_req,res)=>res.json({count:0}));
  f.app.use(express.static(root));
  console.log(JSON.stringify({user:f.base+'/preview/user',partner:f.base+'/preview/partner',admin:f.base+'/preview/admin',partnerListing:partner}));
  process.on('SIGINT',()=>f.close().then(()=>process.exit(0)));
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
