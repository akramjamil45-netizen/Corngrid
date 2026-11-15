'use strict';
// New approval draft only. Keeps earlier drafts and all published assets intact.
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
 ${text('INFRASTRUCTURE',165,103,14,'#111111','letter-spacing="2.2"')}
 ${comic('STRATEGI',100,265,94,490)}
 ${comic('ANDA.',98,364,111,372)}
 <g transform="rotate(-2 316 437)">
  <path d="M60 409H613L595 479H43z" fill="#111111"/>
  <path d="M54 401H607L589 471H37z" fill="#FFEB00" stroke="#111111" stroke-width="4"/>
  ${comic('KAMI URUS MT5.',61,451,47,506)}
 </g>
 <path d="M44 486H567L551 551H44z" fill="#FFEB00"/>
 ${text('Sambung akaun. Pilih strategi.',56,512,23,'#111111')}
 ${text('Urus sandbox MT5 anda.',56,541,23,'#111111')}
 ${text('MT5 SANDBOX',853,165,18,'#111111','font-weight="900" text-anchor="middle"')}
 <rect y="563" width="1200" height="67" fill="#111111"/>
 <path d="M0 563H1200" stroke="#FFEB00" stroke-width="4"/>
 ${text('corngrid.com',56,611,36,'#FFFFFF','font-weight="800"')}
 <circle cx="350" cy="598" r="17" fill="#FFEB00"/>
 <path d="M342 598h16m-6-6 6 6-6 6" stroke="#111111" stroke-width="3" fill="none"/>
 ${text('MT5  /  SANDBOX  /  STRATEGI',1145,605,17,'#FFEB00','font-weight="700" text-anchor="end" letter-spacing="1.2"')}
 </svg>`;
 const result=await sharp(background).composite([{input:Buffer.from(svg)}]).png({compressionLevel:9}).toBuffer();
 const output=path.join(__dirname,'corngrid-comic-server-preview-ms.png');fs.writeFileSync(output,result);
 const meta=await sharp(result).metadata();assert.equal(meta.width,1200);assert.equal(meta.height,630);
 console.log(JSON.stringify({preview:output,width:meta.width,height:meta.height,bytes:result.length,officialLogoVerified:true,liveChanged:false}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
