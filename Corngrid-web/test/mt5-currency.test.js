'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),sqlite=require('sqlite3'),jwt=require('jsonwebtoken');
const {dbRun,dbGet,dbAll}=require('../db-async');
const {normalizeMt5Currency,mt5CurrencySql}=require('../mt5-currency');

test('MT5 denomination normalization preserves cent units and never assumes micro accounts use cents',()=>{
 for(const code of ['USDc','USDC','USC','usc','USCENT','USCENTS','USD CENT','USD CENTS',' USDc '])assert.equal(normalizeMt5Currency(code),'USDc');
 for(const code of ['USD','EUR','GBP','MYR','JPY','USDT'])assert.equal(normalizeMt5Currency(code.toLowerCase()),code);
 for(const value of ['',null,123,{},'USD<script>','USD/EUR'])assert.equal(normalizeMt5Currency(value),null);
 assert.throws(()=>mt5CurrencySql('currency); DROP TABLE users;'));
});

async function fixture(t){
 const db=new sqlite.Database(':memory:'),app=express(),key='mt5-currency-isolated-test';app.use(express.json());
 await new Promise((resolve,reject)=>db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,bio TEXT,created_at TEXT); INSERT INTO users VALUES(1,'Owner','owner@example.test','','',CURRENT_TIMESTAMP),(2,'Other','other@example.test','','',CURRENT_TIMESTAMP);",e=>e?reject(e):resolve()));
 const auth=require('../user-auth')({db,jwtSecret:key});require('../mt5-api')(app,db,auth);
 await dbGet(db,'SELECT COUNT(*) AS count FROM mt5_accounts');
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));});
 const origin='http://127.0.0.1:'+server.address().port;
 async function request(route,{owner=1,secret,method='GET',body}={}){
  const token=secret||jwt.sign({id:owner,authVersion:0},key);
  const response=await fetch(origin+route,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.match(response.headers.get('content-type')||'',/json/,route+' must resolve to an API route');
  return {status:response.status,body:await response.json()};
 }
 return {db,request};
}

test('pairing, authenticated heartbeats and legacy reads use USDc without scaling amounts or mixing USD totals',async t=>{
 const {db,request}=await fixture(t);
 const code=(await request('/api/mt5/pairing-code',{method:'POST',body:{}})).body.code;
 assert.equal((await request('/api/mt5/pair',{method:'POST',body:{code,accountNumber:'10101',brokerServer:'Example-Micro'}})).status,400);
 const paired=await request('/api/mt5/pair',{method:'POST',body:{code,accountNumber:'10101',brokerServer:'Example-Micro',currency:'USDc'}});
 assert.equal(paired.status,201);const secret=paired.body.installationSecret;
 const now=Date.now(),heartbeat={timestamp:now,balance:10000,equity:10020,floatingProfit:20,positions:[{ticket:'C1',symbol:'XAUUSD',direction:'BUY',volume:0.01,entryPrice:2000,profit:20,openedAt:now-1000}]};
 assert.equal((await request('/api/mt5/heartbeat',{secret,method:'POST',body:heartbeat})).status,200);
 const cent=await dbGet(db,'SELECT id,currency,balance FROM mt5_accounts');assert.equal(cent.currency,'USDc');assert.equal(cent.balance,10000);
 assert.equal((await request('/api/mt5/trades',{secret,method:'POST',body:{deals:[{dealId:'C1',symbol:'XAUUSD',direction:'BUY',volume:0.01,profit:12,commission:-1,swap:0,closedAt:now-1000}]}})).status,200);
 const positions=(await request('/api/portfolio/positions?accountId='+cent.id)).body;
 const trades=(await request('/api/portfolio/trades?accountId='+cent.id)).body;
 assert.equal(positions.items[0].currency,'USDc');assert.equal(trades.items[0].currency,'USDc');
 const performance=(await request('/api/portfolio/performance?accountId='+cent.id)).body;
 assert.equal(performance.currency,'USDc');assert.equal(performance.netProfit,11);
 // Legacy database aliases remain untouched, but compare as the same unit.
 for(const [number,currency,balance] of [['20202','USC',2000],['30303','USDC',3000]]){
  await dbRun(db,"INSERT INTO mt5_accounts(user_id,account_number,broker_server,currency,balance,equity,floating_profit,linked_at) VALUES(1,?,'Example',?,?,?,0,?)",[number,currency,balance,balance,now]);
 }
 let portfolio=await request('/api/portfolio');assert.equal(portfolio.body.currency,'USDc');assert.equal(portfolio.body.balance,15000);
 assert.equal((await request('/api/portfolio/positions?sort=profit-desc')).status,200);
 const accounts=(await request('/api/mt5/accounts')).body.accounts;
 assert.ok(accounts.every(a=>a.currency==='USDc'));
 const ids=accounts.map(a=>a.id);
 const shared=await request('/api/user/portfolio-sharing',{method:'PATCH',body:{isPublic:true,accountIds:ids}});
 assert.equal(shared.status,200);const shareId=shared.body.shareUrl.split('/').pop();
 const directory=(await request('/api/public/portfolios')).body.portfolios[0];assert.equal(directory.currency,'USDc');assert.equal(directory.balance,15000);
 const publicDetail=(await request('/api/public/portfolios/'+shareId)).body;assert.equal(publicDetail.currency,'USDc');assert.equal(publicDetail.balance,15000);
 // Neither a broker name nor a claimed account type overrides reported USD.
 const nextCode=(await request('/api/mt5/pairing-code',{method:'POST',body:{}})).body.code;
 const standard=await request('/api/mt5/pair',{method:'POST',body:{code:nextCode,accountNumber:'40404',brokerServer:'Example-Cent-Micro',currency:'usd',accountType:'cent'}});
 assert.equal(standard.status,201);
 assert.equal((await dbGet(db,"SELECT currency FROM mt5_accounts WHERE account_number='40404'")).currency,'USD');
 const standardId=(await dbGet(db,"SELECT id FROM mt5_accounts WHERE account_number='40404'")).id;
 await request('/api/user/portfolio-sharing',{method:'PATCH',body:{isPublic:true,accountIds:[...ids,standardId]}});
 const mixedPublic=(await request('/api/public/portfolios')).body.portfolios[0];assert.equal(mixedPublic.currency,null);assert.equal(mixedPublic.balanceAvailable,false);
 portfolio=await request('/api/portfolio');assert.equal(portfolio.body.balanceAvailable,false);assert.equal(portfolio.body.currency,null);
 assert.equal((await request('/api/portfolio/positions?sort=profit-desc')).status,400);
 const scoped=await request('/api/portfolio?accountId='+cent.id);assert.equal(scoped.body.currency,'USDc');assert.equal(scoped.body.balance,10000);
 assert.equal((await request('/api/portfolio?accountId='+cent.id,{owner:2})).status,404);
 assert.equal((await request('/api/mt5/heartbeat',{secret,method:'POST',body:{...heartbeat,timestamp:now+1000,currency:'USC',balance:12000}})).status,200);
 assert.equal((await request('/api/mt5/heartbeat',{secret,method:'POST',body:{...heartbeat,timestamp:now+2000,currency:'USD<script>',balance:1}})).status,400);
 assert.equal((await request('/api/mt5/heartbeat',{secret,method:'POST',body:{...heartbeat,timestamp:now-1000,currency:'USD',balance:1}})).status,202);
 const after=await dbGet(db,'SELECT currency,balance FROM mt5_accounts WHERE id=?',[cent.id]);assert.deepEqual(after,{currency:'USDc',balance:12000});
 assert.deepEqual((await dbAll(db,"SELECT currency FROM mt5_accounts WHERE account_number IN ('20202','30303') ORDER BY account_number")).map(a=>a.currency),['USC','USDC']);
});
