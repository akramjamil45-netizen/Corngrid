'use strict';
// Read-only aggregate inspection; never prints connection details or account IDs.
const fs=require('node:fs'),path=require('node:path');
const modules=path.join(__dirname,'../Corngrid-web/node_modules');
const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
const {Client}=require(path.join(modules,'pg'));
const assert=require('node:assert/strict');
const {mt5CurrencySql}=require('../Corngrid-web/mt5-currency');
async function main(){
 if(!env.DATABASE_URL)throw Error('Database URL unavailable');
 const client=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:5000});
 try{await client.connect();await client.query('BEGIN READ ONLY');
  const {rows}=await client.query('SELECT currency, COUNT(*)::int AS accounts FROM mt5_accounts GROUP BY currency ORDER BY currency');
  const expression=mt5CurrencySql('a.currency');
  const sample=await client.query(`SELECT ${expression} AS currency, SUM(amount)::int AS amount FROM (VALUES ('USC',10000),('USDC',5000),('USD',100),('usd',200),('USDT',7)) AS a(currency,amount) GROUP BY ${expression}`);
  assert.deepEqual(Object.fromEntries(sample.rows.map(r=>[r.currency,r.amount])),{USDc:15000,USD:300,USDT:7});
  await client.query('ROLLBACK');console.log(JSON.stringify({readOnly:true,currencies:rows,postgresGroupingVerified:true}));
 }finally{await client.end();}
}
main().catch(()=>{console.error('Read-only currency inspection failed; no connection details printed.');process.exitCode=1;});
