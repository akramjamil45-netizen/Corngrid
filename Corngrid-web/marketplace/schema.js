'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {dbGet,isPostgres}=require('../db-async');
const schemas=new WeakMap();
function ensureMarketplaceSchema(db){
  if(!schemas.has(db))schemas.set(db,(async()=>{
    if(isPostgres(db))await dbGet(db,'SELECT marketplace_enabled FROM marketplace_settings WHERE id=1');
    else{const sql=await fs.readFile(path.join(__dirname,'../migrations/sqlite/0015_marketplace.sql'),'utf8');await new Promise((resolve,reject)=>db.exec(sql,e=>e?reject(e):resolve()));}
  })());
  return schemas.get(db);
}
module.exports={ensureMarketplaceSchema};
