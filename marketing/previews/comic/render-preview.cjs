'use strict';
// Approval preview only. Does not update pages, metadata, live assets or deployment.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const sharp=require('../../../Corngrid-web/node_modules/sharp');
const root=path.resolve(__dirname,'../../..');
async function main(){
 const logo=fs.readFileSync(path.join(root,'Corngrid-web/public/images/corngrid-report-logo.png'));
 assert.equal(crypto.createHash('sha256').update(logo).digest('hex'),'7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0');
 const background=await sharp(path.join(__dirname,'background-original.png')).resize(1200,630,{fit:'cover'}).png().toBuffer();
 const text=(value,x,y,size,fill='#111111',extra='')=>`<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" fill="${fill}" ${extra}>${value}</text>`;
 const comic=(value,x,y,size,width,fill='#111111')=>`<text x="${x}" y="${y}" font-family="Arial Black, Impact, Arial, sans-serif" font-size="${size}" font-weight="900" font-style="italic" fill="${fill}" stroke="${fill}" stroke-width="1.2" paint-order="stroke fill" textLength="${width}" lengthAdjust="spacingAndGlyphs">${value}</text>`;
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
 <rect x="52" y="39" width="96" height="96" fill="#111111"/>
 <rect x="46" y="33" width="96" height="96" fill="#FFEB00" stroke="#111111" stroke-width="3"/>
 <image x="58" y="45" width="72" height="72" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${logo.toString('base64')}"/>
 ${text('CornGrid',163,76,35,'#111111','font-weight="800"')}
 ${text('INFRASTRUCTURE',165,103,14,'#333333','letter-spacing="2.2"')}
 <path d="M951 38h193l-7 36H944z" fill="#111111"/>
 ${text('MT5 SANDBOX',1045,63,15,'#FFFFFF','font-weight="700" text-anchor="middle" letter-spacing="1"')}
 ${comic('STRATEGI',48,236,100,513)}
 ${comic('ANDA.',45,348,119,388)}
 <g transform="rotate(-2 316 410)">
  <path d="M60 382H599L581 452H43z" fill="#111111"/>
  <path d="M54 374H593L575 444H37z" fill="#FFEB00" stroke="#111111" stroke-width="4"/>
  ${comic('KAMI URUS MT5.',61,424,47,490)}
 </g>
 ${text('Sambung akaun. Pilih strategi.',56,491,24,'#333333')}
 ${text('Urus sandbox MT5 anda.',56,524,24,'#333333')}
 ${comic('MT5',735,324,88,232,'#FFEB00')}
 ${text('SANDBOX',850,359,17,'#FFFFFF','font-weight="700" text-anchor="middle" letter-spacing="3"')}
 <rect y="554" width="1200" height="76" fill="#111111"/>
 <path d="M0 554H1200" stroke="#FFEB00" stroke-width="5"/>
 ${text('corngrid.com',56,607,38,'#FFFFFF','font-weight="800"')}
 <circle cx="365" cy="594" r="18" fill="#FFEB00"/>
 <path d="M356 594h17m-6-6 6 6-6 6" stroke="#111111" stroke-width="3" fill="none"/>
 ${text('MT5  /  SANDBOX  /  STRATEGI',1145,601,17,'#FFEB00','font-weight="700" text-anchor="end" letter-spacing="1.2"')}
 </svg>`;
 const result=await sharp(background).composite([{input:Buffer.from(svg)}]).png({compressionLevel:9}).toBuffer();
 const output=path.join(__dirname,'corngrid-comic-preview-ms.png');fs.writeFileSync(output,result);
 const meta=await sharp(result).metadata();assert.equal(meta.width,1200);assert.equal(meta.height,630);
 console.log(JSON.stringify({preview:output,width:meta.width,height:meta.height,bytes:result.length,officialLogoVerified:true,liveChanged:false}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
