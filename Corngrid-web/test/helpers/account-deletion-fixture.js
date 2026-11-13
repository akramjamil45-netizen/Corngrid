'use strict';
const express=require('express'),sqlite=require('sqlite3'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const {dbRun,dbGet}=require('../../db-async');
async function fixture(t,{database,seed=true}={}){
 const db=database||new sqlite.Database(':memory:'),app=express(),secret='account-deletion-isolated-test';app.use(express.json({limit:'256kb'}));
 await dbRun(db,'PRAGMA foreign_keys=ON');
 await dbRun(db,'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT UNIQUE,password TEXT,bio TEXT,created_at TEXT,email_verified INTEGER)');
 await dbRun(db,'CREATE TABLE IF NOT EXISTS user_auth_versions(user_id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0)');
 const password=await bcrypt.hash('fixture-password',4);
 if(seed)for(const [id,name] of [[1,'Account Owner'],[2,'Other User']])await dbRun(db,"INSERT INTO users(id,username,email,password,email_verified,created_at) VALUES(?,?,?,?,TRUE,'2026-11-13')",[id,name,'account'+id+'@example.test',password]);
 const auth=require('../../user-auth')({db,jwtSecret:secret}),admin=require('../../admin-auth')({email:'admin@example.test',passwordHash:await bcrypt.hash('fixture-admin',4),jwtSecret:secret});
 const rateLimit=()=> (_req,_res,next)=>next();
 const service=require('../../account-deletion')(app,db,{verifyToken:auth,verifyAdminToken:admin.verifyToken,rateLimit});await service.ready;
 app.post('/login',require('../../login-handler')({db,jwtSecret:secret,adminAuth:{matchesEmail:()=>false},setAuthCookie(){},isSameOriginRequest:()=>false}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 const tokens={admin:await admin.authenticate('admin@example.test','fixture-admin')};
 const refreshTokens=async()=>{for(const id of [1,2])tokens[id]=jwt.sign({id,authVersion:(await dbGet(db,'SELECT version FROM user_auth_versions WHERE user_id=?',[id]))?.version||0},secret);};await refreshTokens();
 const request=async(route,{role=1,method='GET',body,headers={}}={})=>{const response=await fetch(base+route,{method,headers:{...(role?{Authorization:'Bearer '+tokens[role]}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),headers:response.headers};};
 const close=async()=>{await new Promise(resolve=>server.close(resolve));if(!database)await new Promise(resolve=>db.close(resolve));};if(t)t.after(close);
 return {app,db,base,server,tokens,request,close,refreshTokens,service};
}
module.exports={fixture};
