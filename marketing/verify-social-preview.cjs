'use strict';
// Inspect initial HTTP responses, as social crawlers do, without executing page JS.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {configuration,socialMetadata,WIDTH,HEIGHT,LOGO_HASH,approvedArtwork}=require('./social-preview.cjs');
const root=path.resolve(__dirname,'..'),sharp=require('../Corngrid-web/node_modules/sharp');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function head(html){const end=html.indexOf('</head>');assert.ok(end>0,'Missing initial HTML head');return html.slice(0,end);}
function metadata(html){
 const values=new Map();
 for(const tag of head(html).matchAll(/<meta\b[^>]*>/g)){
  const attributes=Object.fromEntries([...tag[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
  const name=attributes.property||attributes.name;
  if(name?.startsWith('og:')||name?.startsWith('twitter:')){assert.ok(!values.has(name),'Duplicate metadata: '+name);values.set(name,attributes.content);}
 }
 return values;
}
function verifyHead(html,lang){
 const expected=metadata('<head>'+socialMetadata(lang)+'</head>'),received=metadata(html);
 for(const [key,value] of expected)assert.equal(received.get(key),value,key+' in '+lang);
 const c=configuration(lang);assert.ok(head(html).includes('<link rel="canonical" href="'+c.canonical+'">'));
 assert.ok(html.includes('data-public-page="infrastructure"'));
 assert.ok(head(html).indexOf('og:image')<50000,'Metadata must be near the start of the response');
}
async function staticChecks(){
 assert.equal(hash(fs.readFileSync(path.join(root,'Corngrid-web/public/images/corngrid-report-logo.png'))),LOGO_HASH);
 for(const lang of ['ms','en']){
  assert.equal(hash(approvedArtwork(lang)),configuration(lang).imageHash);
  verifyHead(fs.readFileSync(path.join(root,lang==='ms'?'index.html':'en/index.html'),'utf8'),lang);
  const image=path.join(root,configuration(lang).imagePath),meta=await sharp(image).metadata();
  assert.equal(meta.width,WIDTH);assert.equal(meta.height,HEIGHT);assert.equal(meta.format,configuration(lang).imageFormat);assert.ok(fs.statSync(image).size<1024*1024);
  assert.equal(hash(fs.readFileSync(image)),configuration(lang).imageHash,'Exact supplied artwork for '+lang);
 }
 return {languages:2,images:new Set(['ms','en'].map(lang=>configuration(lang).imagePath)).size,dimensions:[WIDTH,HEIGHT],officialLogoVerified:true,approvedArtworkVerified:true};
}
async function verifyOrigin(origin){
 const agents=['CornGrid-LinkPreview-Check/1.0','facebookexternalhit/1.1','Twitterbot/1.0','WhatsApp/2.0'];
 let htmlChecks=0,imageChecks=0;
 for(const agent of agents){
  for(const lang of ['ms','en']){
   const headers={'User-Agent':agent,'Accept-Encoding':'gzip, deflate'};
   const response=await fetch(origin+(lang==='ms'?'/':'/en/'),{headers,signal:AbortSignal.timeout(20000)});
   assert.equal(response.status,200,origin+' '+lang+' '+agent);assert.ok(response.headers.get('content-type')?.startsWith('text/html'));verifyHead(await response.text(),lang);htmlChecks++;
   assert.ok(!response.headers.get('content-encoding') || ['gzip','deflate'].includes(response.headers.get('content-encoding')),'Crawler-compatible encoding');
   const file=configuration(lang).imagePath,image=await fetch(origin+'/'+file,{headers,signal:AbortSignal.timeout(20000)});
   assert.equal(image.status,200,file+' '+agent);assert.ok(image.headers.get('content-type')?.startsWith(configuration(lang).imageType));
   assert.equal(hash(Buffer.from(await image.arrayBuffer())),hash(fs.readFileSync(path.join(root,file))),file);imageChecks++;
  }
 }
 return {origin,htmlChecks,imageChecks,simulatedCrawlerUserAgents:agents.length};
}
module.exports={staticChecks,verifyOrigin,verifyHead,metadata,hash};
if(require.main===module)(async()=>{
 const checks=await staticChecks();
 const origin=process.argv.includes('--live')?'https://corngrid.com':process.argv.includes('--local')?'http://127.0.0.1:3108':null;
 const requests=origin?await verifyOrigin(origin):null;
 console.log(JSON.stringify({verified:true,...checks,requests}));
})().catch(error=>{console.error('Social preview verification failed:',error.message);process.exitCode=1;});
