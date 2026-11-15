'use strict';
const path=require('node:path'),express=require('../Corngrid-web/node_modules/express'),{fixture}=require('../Corngrid-web/test/helpers/account-deletion-fixture');
async function main(){
 const f=await fixture();
 f.app.get('/preview/:role',(req,res)=>{const admin=req.params.role==='admin';res.cookie('corngrid_session',f.tokens[admin?'admin':1],{httpOnly:true,sameSite:'lax',path:'/'});res.redirect(admin?'/admin.html#account-requests':'/dashboard.html#settings');});
 f.app.get('/api/me',(_req,res)=>res.json({id:1,username:'Account Owner',email:'account1@example.test',bio:'Isolated request preview',created_at:'2026-11-13'}));
 f.app.get('/api/admin/overview',(_req,res)=>res.json({summary:{totalUsers:2,publicPortfolios:0,privatePortfolios:2,onlineAccounts:0,totalAccounts:0},profiles:[],pagination:{total:2,totalPages:1}}));
 f.app.get('/api/admin/support/conversations',(_req,res)=>res.json({conversations:[],unreadCount:0}));
 f.app.get('/api/admin/feed/reports',(_req,res)=>res.json({reports:[],count:0}));
 f.app.get('/api/chat/unread-count',(_req,res)=>res.json({count:0}));
 f.app.get('/login',(_req,res)=>res.send('Isolated preview: account archived; sign-in is blocked.'));
 f.app.use(express.static(path.resolve(__dirname,'../Corngrid-web/public')));
 console.log(JSON.stringify({user:f.base+'/preview/user',admin:f.base+'/preview/admin',isolated:true}));
 process.on('SIGINT',()=>f.close().then(()=>process.exit(0)));
}
main().catch(error=>{console.error('Account request preview failed:',error.code||error.name);process.exitCode=1;});
