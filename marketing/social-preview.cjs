'use strict';
// Use the exact user-supplied, approved comic artwork. Never regenerate its logo or copy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const WIDTH=1280,HEIGHT=673;
const LOGO_HASH='7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0';
const APPROVED_ART_HASH='2c0073db3109d49b7f01aa407b4894386bbd89622ccb1d4f9a05c22ccf235d72';
const ARTWORKS={
 ms:{artSource:'marketing/assets/social/corngrid-comic-approved-v2.jpg',imagePath:'images/social/corngrid-infrastructure-comic-v2.jpg',imageHash:APPROVED_ART_HASH},
 en:{artSource:'marketing/assets/social/corngrid-comic-approved-en-v3.jpg',imagePath:'images/social/corngrid-infrastructure-comic-en-v3.jpg',imageHash:'ccbc65fc7b6e59b7a4ef489d887a052c845ea4501410e76e6a8905cedecfb7a3'}
};
const copy={
 ms:{
  title:'CornGrid Infrastructure | Sandbox Trading MT5',
  description:'Sambungkan akaun MT5, pilih strategi dan urus sandbox trading anda dalam satu platform.',
  alt:'Komik CornGrid hitam dan kuning dengan rak server MT5 Sandbox. Strategi anda. Kami urus MT5. corngrid.com.'
 },
 en:{
  title:'CornGrid Infrastructure | MT5 Trading Sandbox',
  description:'Connect your MT5 account, choose a strategy and manage your trading sandbox in one platform.',
  alt:'Black-and-yellow CornGrid comic with MT5 Sandbox server racks. Your trading strategy. We run it on MT5. Connect your account. Choose a strategy. corngrid.com.'
 }
};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function configuration(lang){
 assert.ok(Object.hasOwn(copy,lang),'Unsupported public card language.');
 // The user chose English sharing for the main URL as well as /en/.
 return {...copy.en,...ARTWORKS.en,lang,socialLanguage:'en',canonical:'https://corngrid.com/'+(lang==='en'?'en/':''),imageType:'image/jpeg',imageFormat:'jpeg'};
}
function approvedArtwork(lang='ms'){
 const c=configuration(lang),bytes=fs.readFileSync(path.join(root,c.artSource));
 assert.equal(hash(bytes),c.imageHash,'Restore the exact supplied '+lang+' artwork. Use a new version for any replacement.');
 return bytes;
}
function socialMetadata(lang){
 const c=configuration(lang),image='https://corngrid.com/'+c.imagePath;
 const og=[
  ['og:type','website'],['og:site_name','CornGrid Infrastructure'],['og:title',c.title],['og:description',c.description],['og:url',c.canonical],
  ['og:locale','en_US'],['og:locale:alternate','ms_MY'],
  ['og:image',image],['og:image:secure_url',image],['og:image:type',c.imageType],['og:image:width',WIDTH],['og:image:height',HEIGHT],['og:image:alt',c.alt]
 ];
 const twitter=[['twitter:card','summary_large_image'],['twitter:title',c.title],['twitter:description',c.description],['twitter:image',image],['twitter:image:alt',c.alt]];
 return og.map(([key,value])=>'<meta property="'+key+'"'+(['og:description','og:locale'].includes(key)?' data-social-language="en"':'')+' content="'+escape(value)+'">').join('')+twitter.map(([key,value])=>'<meta name="'+key+'" content="'+escape(value)+'">').join('');
}
function updatePage(file,lang){
 const location=path.join(root,file),previous=fs.readFileSync(location,'utf8'),end=previous.indexOf('</head>');
 assert.ok(end>0,'Missing static page head: '+file);
 const head=previous.slice(0,end).replace(/<meta\b[^>]*(?:property|name)="(?:og:|twitter:)[^"]*"[^>]*>/g,'');
 fs.writeFileSync(location,head+socialMetadata(lang)+previous.slice(end));
}
async function generate(){
 const sharp=require('../Corngrid-web/node_modules/sharp'),images=[];
 assert.equal(hash(fs.readFileSync(path.join(root,'Corngrid-web/public/images/corngrid-report-logo.png'))),LOGO_HASH);
 for(const lang of ['ms','en']){
  const c=configuration(lang),bytes=approvedArtwork(lang),meta=await sharp(bytes).metadata();
  assert.equal(meta.format,c.imageFormat);assert.equal(meta.width,WIDTH);assert.equal(meta.height,HEIGHT);assert.ok(bytes.length<1024*1024);
  const destination=path.join(root,c.imagePath);fs.mkdirSync(path.dirname(destination),{recursive:true});
  if(fs.existsSync(destination))assert.ok(fs.readFileSync(destination).equals(bytes),'A published image version cannot be overwritten.');
  else fs.writeFileSync(destination,bytes);
  images.push({lang,image:c.imagePath,width:meta.width,height:meta.height,bytes:bytes.length});
 }
 if(process.argv.includes('--update-pages'))for(const lang of ['ms','en'])updatePage(lang==='ms'?'index.html':'en/index.html',lang);
 console.log(JSON.stringify({images,pagesUpdated:process.argv.includes('--update-pages'),approvedArtworkVerified:true,preservedOriginalBytes:true}));
}
module.exports={configuration,socialMetadata,WIDTH,HEIGHT,LOGO_HASH,APPROVED_ART_HASH,approvedArtwork};
if(require.main===module)generate().catch(error=>{console.error(error.message);process.exitCode=1;});
