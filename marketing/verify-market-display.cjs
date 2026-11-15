'use strict';
// Market diagnostics only. Keys and short-lived read tokens are never printed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const source=path.resolve(__dirname,'../Corngrid-web'),runtime='C:/Website/Website/Corngrid-web';
const dotenv=require(path.join(source,'node_modules/dotenv'));
async function main(){
 if(process.argv.includes('--enable-external')){
  const files=[path.join(source,'.env'),path.join(runtime,'.env')];
  for(const file of files)if(!dotenv.parse(fs.readFileSync(file)).TWELVE_DATA_API_KEY?.trim())throw Error('Twelve Data key is missing');
  const backup=path.join(os.tmpdir(),'CornGrid-market-config-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup,{recursive:true});
  for(const [index,file] of files.entries()){
   let content=fs.readFileSync(file,'utf8');fs.writeFileSync(path.join(backup,index===0?'source.env':'runtime.env'),content,{mode:0o600});
   const setting=/^[ \t]*(?:export[ \t]+)?MARKET_FALLBACK_PROVIDER[ \t]*=/;
   const newline=content.includes('\r\n')?'\r\n':'\n';let found=false;
   content=content.split(/\r?\n/).filter(line=>{if(!setting.test(line))return true;if(found)return false;found=true;return true;})
    .map(line=>setting.test(line)?'MARKET_FALLBACK_PROVIDER=external':line).join(newline);
   if(!found)content+=(content.endsWith('\n')?'':newline)+'MARKET_FALLBACK_PROVIDER=external'+newline;
   fs.writeFileSync(file,content);if(dotenv.parse(fs.readFileSync(file)).MARKET_FALLBACK_PROVIDER!=='external')throw Error('Configuration verification failed');
  }
  console.log(JSON.stringify({externalProviderEnabled:true,backup,restartRequired:true}));return;
 }
 const env=dotenv.parse(fs.readFileSync(path.join(runtime,'.env')));
 const {Client}=require(path.join(source,'node_modules/pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 let token;
 try{
  // This token can only be used below against shared market data on localhost.
  const result=await db.query(`SELECT u.id,COALESCE(v.version,0) AS version FROM users u
   LEFT JOIN user_auth_versions v ON v.user_id=u.id
   WHERE u.email_verified=TRUE AND NOT EXISTS (SELECT 1 FROM account_archives a WHERE a.user_id=u.id)
   AND NOT EXISTS (SELECT 1 FROM user_account_access a WHERE a.user_id=u.id AND a.suspended_until>$1)
   ORDER BY u.id LIMIT 1`,[Date.now()]);
  if(!result.rows[0])throw Error('No active verified account is available for read-only market verification');
  token=require(path.join(source,'node_modules/jsonwebtoken')).sign({id:result.rows[0].id,authVersion:Number(result.rows[0].version)},env.JWT_SECRET,{expiresIn:process.argv.includes('--preview')?'10m':'90s'});
 }finally{await db.end();}
 if(process.argv.includes('--preview')){
  const express=require(path.join(source,'node_modules/express')),app=express();
  app.get('/preview-market',(_req,res)=>{
   let html=fs.readFileSync(path.join(runtime,'public/dashboard.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
   html=html.replace('</body>','<script src="vendor/lightweight-charts.standalone.production.js"></script><script src="market.js"></script><script>document.querySelectorAll(".page").forEach(el=>{el.hidden=el.id!=="page-market";el.classList.toggle("is-visible",!el.hidden)});document.getElementById("page-title").textContent="Market Overview";window.CornGridMarket.onOpen();</script></body>');
   res.type('html').send(html);
  });
  for(const route of ['/api/market/summary','/api/market/candles','/api/market/quote','/api/market/feeds'])app.get(route,async(req,res)=>{
   try{const response=await fetch('http://127.0.0.1:3000'+req.originalUrl,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});res.status(response.status).type('json').send(await response.text());}catch{res.status(502).json({error:'Preview proxy failed'});}
  });
  app.get('/api/market/drawings',(_req,res)=>res.json({drawings:[]}));
  app.use('/api',(_req,res)=>res.sendStatus(503));
  if(process.argv.includes('--source'))app.get('/market.js',(_req,res)=>res.sendFile(path.join(source,'public/market.js')));
  app.use(express.static(path.join(runtime,'public')));
  const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({preview:'http://127.0.0.1:'+server.address().port+'/preview-market'})));return;
 }
 const checks=[];
 const symbols=process.argv.includes('--all')?['XAUUSD','EURUSD','GBPUSD','USDJPY']:['XAUUSD'];
 for(const route of symbols.flatMap(symbol=>['/api/market/summary?symbol='+symbol,'/api/market/candles?symbol='+symbol+'&interval=1h&outputsize=500'])){
  const response=await fetch('http://127.0.0.1:3000'+route,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)}),body=await response.json();
  checks.push({route,http:response.status,provider:body.provider||null,state:body.state||null,price:body.price??null,candles:Array.isArray(body.candles)?body.candles.length:null,error:body.error||null});
 }
 console.log(JSON.stringify({externalProviderEnabled:env.MARKET_FALLBACK_PROVIDER==='external',checks}));
}
main().catch(error=>{console.error('Market display verification failed:',error.code||error.name);process.exitCode=1;});
