'use strict';
const express=require('express'),sqlite=require('sqlite3'),jwt=require('jsonwebtoken'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {dbRun}=require('../../db-async');
async function fixture(t,{database}={}){
 const db=database||new sqlite.Database(':memory:'),app=express(),secret='isolated-feed-gallery-fixture';
 app.use(express.json());
 await dbRun(db,'CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,bio TEXT,created_at TEXT)');
 await dbRun(db,'CREATE TABLE user_auth_versions(user_id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0)');
 for(const id of [1,2])await dbRun(db,'INSERT INTO users(id,username,email,password) VALUES(?,?,?,?)',[id,'Gallery User '+id,'gallery'+id+'@example.test','test']);
 const auth=require('../../user-auth')({db,jwtSecret:secret}),directory=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-feed-gallery-'));
 const service=require('../../feed-api')(app,db,auth,(_req,res)=>res.sendStatus(403),{uploadDir:directory});await service.ready;
 app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:'Invalid request.'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 const tokens={1:jwt.sign({id:1,authVersion:0},secret),2:jwt.sign({id:2,authVersion:0},secret)};
 const request=async(route,{user=1,method='GET',body,bytes,type='image/png',headers={}}={})=>{const response=await fetch(base+route,{method,headers:{...(user?{Authorization:'Bearer '+tokens[user]}:{}),...(bytes?{'Content-Type':type}:body?{'Content-Type':'application/json'}:{}),...headers},body:bytes||(body?JSON.stringify(body):undefined)});return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};};
 const close=async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(directory));if(!/^corngrid-feed-gallery-[a-z0-9]+$/i.test(relative))throw Error('Unexpected fixture path');await fs.rm(path.resolve(directory),{recursive:true,force:true});};
 if(t)t.after(close);return {app,db,directory,base,server,request,tokens,close};
}
module.exports={fixture};
