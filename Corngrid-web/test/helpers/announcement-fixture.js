'use strict';
const express=require('express'),sqlite=require('sqlite3'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {dbRun,dbGet}=require('../../db-async');
async function fixture(t){
  const db=new sqlite.Database(':memory:'),app=express(),secret='announcement-images-isolated-fixture';
  app.use(express.json({limit:'256kb'}));
  await dbRun(db,'CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,bio TEXT,created_at TEXT)');
  await dbRun(db,'CREATE TABLE user_auth_versions(user_id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0)');
  await dbRun(db,"INSERT INTO users(id,username,email,password) VALUES(1,'Test Reader','reader@example.test','test')");
  const auth=require('../../user-auth')({db,jwtSecret:secret});
  const admin=require('../../admin-auth')({email:'admin@example.test',passwordHash:bcrypt.hashSync('fixture',4),jwtSecret:secret});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-announcement-images-'));
  require('../../feed-api')(app,db,auth,admin.verifyToken,{uploadDir:directory});await dbGet(db,'SELECT 1');
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:'Invalid request.'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  const tokens={admin:await admin.authenticate('admin@example.test','fixture'),user:jwt.sign({id:1,authVersion:0},secret)};
  const request=async(route,{role='admin',method='GET',body,bytes,type='image/png',headers={}}={})=>{const response=await fetch(base+route,{method,headers:{...(role?{Authorization:'Bearer '+tokens[role]}:{}),...(bytes?{'Content-Type':type}:body?{'Content-Type':'application/json'}:{}),...headers},body:bytes|| (body?JSON.stringify(body):undefined)});return {status:response.status,headers:response.headers,data:response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};};
  const close=async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(directory));if(!/^corngrid-announcement-images-[a-z0-9]+$/i.test(relative))throw Error('Unexpected image fixture directory');await fs.rm(path.resolve(directory),{recursive:true,force:true});};
  if(t)t.after(close);
  return {app,db,server,base,directory,tokens,request,close};
}
module.exports={fixture};
