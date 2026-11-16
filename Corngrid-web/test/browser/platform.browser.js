async (page) => {
 const origin=new URL(page.url()).origin,browser=page.context().browser(),results=[];
 async function otp(secret){let acc=0,bits=0,bytes=[];for(const c of secret){acc=(acc<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);bits+=5;if(bits>=8){bytes.push((acc>>>(bits-8))&255);bits-=8;}}const key=await crypto.subtle.importKey('raw',new Uint8Array(bytes),{name:'HMAC',hash:'SHA-1'},false,['sign']),counter=new ArrayBuffer(8);new DataView(counter).setBigUint64(0,BigInt(Math.floor(Date.now()/30000)));const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,counter)),offset=mac[mac.length-1]&15;return String((new DataView(mac.buffer).getUint32(offset)&0x7fffffff)%1000000).padStart(6,'0');}
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:{width:mobile?375:1440,height:mobile?812:900},isMobile:mobile,hasTouch:mobile});
  try{
   const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
   await context.request.post(origin+'/fixture/reset');const response=await context.request.post(origin+'/api/login',{headers:{Origin:origin},data:{email:'admin@example.test',password:'fixture-password'}});if(!response.ok())throw Error('Fixture login failed');
   await p.goto(origin+'/fixture');await p.getByRole('heading',{name:'Database',exact:true}).waitFor();
   if(await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth))throw Error('Horizontal overflow');
   const cards=await p.locator('.health-card').count();if(cards!==10)throw Error('Health checks missing');
   await p.getByRole('button',{name:'Security',exact:true}).click();let dialog=p.locator('.cg-security-dialog[open]');await dialog.getByLabel('Current password').fill('fixture-password');await dialog.getByRole('button',{name:'Continue'}).click();
   dialog=p.locator('.cg-security-dialog[open]');await dialog.getByRole('heading',{name:'Add CornGrid to your authenticator'}).waitFor();const secret=await dialog.getByLabel('Authenticator manual setup key').inputValue();const code=await p.evaluate(otp,secret);await dialog.getByLabel('6-digit authenticator code').fill(code);await dialog.getByRole('button',{name:'Continue'}).click();
   const recovery=p.locator('.cg-security-dialog[open]');await recovery.getByRole('heading',{name:'Save your recovery codes'}).waitFor();if((await recovery.getByLabel('Single-use recovery codes').inputValue()).split('\n').length!==8)throw Error('Recovery codes missing');
   const box=await recovery.boundingBox();if(box.x<0||box.x+box.width>(mobile?375:1440))throw Error('Security dialog exceeds viewport');await recovery.getByRole('button',{name:'I have saved the codes'}).click();
   await p.locator('.cg-security-dialog').waitFor({state:'detached',timeout:2000});if(errors.length)throw Error(errors.join('; '));results.push({mobile,healthCards:cards,mfaEnrollment:true,recoveryCodes:8,horizontalOverflow:false});
  }finally{await context.close();}
 }
 return results;
}
