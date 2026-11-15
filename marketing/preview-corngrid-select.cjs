'use strict';
const path=require('node:path'),express=require('../Corngrid-web/node_modules/express');
const app=express();
app.get('/fixture',(_req,res)=>res.sendFile(path.resolve(__dirname,'../Corngrid-web/test/fixtures/corngrid-select.html')));
app.use(express.static(path.resolve(__dirname,'../Corngrid-web/public')));
const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/fixture',isolated:true,databaseAccessed:false})));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
