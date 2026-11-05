// Local visual preview only; exposes public marketing assets, no private project files.
const express=require('../Corngrid-web/node_modules/express');
const path=require('node:path');
const app=express(),root=path.join(__dirname,'..');
require('../Corngrid-web/marketing-routes')(app,root);
for(const file of ['mystyle.css','script.js','sw.js'])app.get('/'+file,(_req,res)=>res.sendFile(path.join(root,file)));
for(const dir of ['images','files','download','video'])app.use('/'+dir,express.static(path.join(root,dir),{index:false}));
app.get(['/login','/login.html'],(_req,res)=>res.sendFile(path.join(root,'Corngrid-web/public/index.html')));
app.get('/portfolios',(_req,res)=>res.sendFile(path.join(root,'Corngrid-web/public/public-portfolios.html')));
app.get('/portfolio/:shareId',(_req,res)=>res.sendFile(path.join(root,'Corngrid-web/public/public-portfolio.html')));
app.use(express.static(path.join(root,'Corngrid-web/public')));
app.listen(3108,'127.0.0.1',()=>console.log('Public marketing preview: http://127.0.0.1:3108'));
