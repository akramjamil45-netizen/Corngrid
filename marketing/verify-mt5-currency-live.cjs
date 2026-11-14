'use strict';
// Read-only live checks. Never create test users, change account denominations,
// print balances, or expose database/JWT credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../Corngrid-web'),live='C:/Website/Website/Corngrid-web';
const files=['mt5-currency.js','mt5-api.js','reports/report-service.js','docs/MT5_CURRENCY.md'];
async function main(){
 const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 for(const f of files)assert.equal(hash(path.join(live,f)),hash(path.join(source,f)),f);
 const currency=require(path.join(live,'mt5-currency'));
 for(const alias of ['USC','USDC','USDc'])assert.equal(currency.normalizeMt5Currency(alias),'USDc');
 assert.equal(currency.normalizeMt5Currency('USD'),'USD');
 const env=require(path.join(source,'node_modules/dotenv')).parse(fs.readFileSync(path.join(live,'.env')));
 const {Client}=require(path.join(source,'node_modules/pg'));
 const db=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:5000});
 let actualCurrencies;
 try{
  await db.connect();await db.query('BEGIN READ ONLY');
  actualCurrencies=(await db.query('SELECT DISTINCT currency FROM mt5_accounts')).rows.map(r=>currency.normalizeMt5Currency(r.currency));
  const expression=currency.mt5CurrencySql('a.currency');
  const {rows}=await db.query(`SELECT ${expression} AS currency, SUM(amount)::int AS amount FROM (VALUES ('USC',10000),('USDC',5000),('USD',100),('usd',200),('USDT',7)) AS a(currency,amount) GROUP BY ${expression}`);
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.currency,r.amount])),{USDc:15000,USD:300,USDT:7});
  await db.query('ROLLBACK');
 }finally{await db.end();}
 const version=crypto.createHash('sha256').update(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
 const token=require(path.join(source,'node_modules/jsonwebtoken')).sign({sub:'admin',role:'admin',adminVersion:version},env.JWT_SECRET,{expiresIn:'2m'});
 async function get(origin,route,authenticated=false){
  const r=await fetch(origin+route,{headers:authenticated?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(20000)});
  assert.equal(r.status,200,route);return r.json();
 }
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  assert.equal((await get(origin,'/api/health/ready')).status,'ok');
  const options=await get(origin,'/api/admin/reports/options',true);
  assert.deepEqual([...options.currencies].sort(),[...new Set(actualCurrencies)].sort());
  assert.ok(options.accounts.every(a=>a.currency===currency.normalizeMt5Currency(a.currency)));
  const directory=await get(origin,'/api/public/portfolios');
  assert.ok(directory.portfolios.every(p=>!p.currency||p.currency===currency.normalizeMt5Currency(p.currency)));
  const anon=await fetch(origin+'/api/portfolio',{signal:AbortSignal.timeout(15000)});assert.equal(anon.status,401);
 }
 console.log(JSON.stringify({verified:true,filesMatch:true,postgresGroupingVerified:true,authenticatedReportOptions:true,publicPortfolios:true,anonymousAccessDenied:true,databaseModified:false,productionTestAccountsCreated:0}));
}
main().catch(error=>{console.error('Currency verification failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
