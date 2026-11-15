(() => {
 'use strict';
 const nativeFetch=window.fetch.bind(window),admin=!!document.getElementById('admin-sidebar'),prefix=admin?'/api/admin/security/mfa':'/api/security/mfa';
 const make=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
 function promptForm(title,fields,note='',secret=''){
  return new Promise(resolve=>{
   const dialog=make('dialog',null,'cg-security-dialog'),form=make('form'),heading=make('h2',title),description=make('p',note,'muted');heading.id='security-dialog-title';dialog.setAttribute('aria-labelledby',heading.id);form.append(heading,description);
   if(secret){const label=make('label','Manual setup key');const input=make('input');input.readOnly=true;input.value=secret;input.setAttribute('aria-label','Authenticator manual setup key');label.append(input);form.append(label);}
   for(const field of fields){const label=make('label',field.label),input=make('input');input.name=field.name;input.type=field.type||'text';input.required=true;input.autocomplete=field.name==='password'?'current-password':'one-time-code';if(field.name==='code')input.maxLength=19;label.append(input);form.append(label);}
   const actions=make('div',null,'cg-security-actions'),cancel=make('button','Cancel','button button-secondary'),submit=make('button','Continue','button button-primary');cancel.type='button';submit.type='submit';actions.append(cancel,submit);form.append(actions);dialog.append(form);document.body.append(dialog);
   let result=null;cancel.onclick=()=>dialog.close();form.onsubmit=event=>{event.preventDefault();result=Object.fromEntries(new FormData(form));dialog.close();};dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});dialog.showModal();form.querySelector('input:not([readonly])')?.focus();
  });
 }
 async function api(route,body){const response=await nativeFetch(prefix+route,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw Error(result.error||'Security settings are unavailable.');return result;}
 let prompting=false;
 window.fetch=async function(input,options){
  const url=new URL(input instanceof Request?input.url:String(input),location.href),method=String(options?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  const sensitive=url.origin===location.origin&&!['GET','HEAD','OPTIONS'].includes(method)&&/^\/api\/(?:admin\/payouts|partner\/(?:bank-details|payouts))(?:\/|$)/.test(url.pathname);
  if(!sensitive)return nativeFetch(input,options);
  const request=new Request(input,options),replay=request.clone(),response=await nativeFetch(request);let result;
  if(response.status===403){try{result=await response.clone().json();}catch{}}
  if(result?.code!=='MFA_STEP_UP_REQUIRED'||prompting)return response;
  prompting=true;let proof;
  try{proof=await promptForm('Verify this action',[{name:'code',label:'Authenticator or recovery code'}],'Use a fresh authenticator code or an unused recovery code.');}finally{prompting=false;}
  if(!proof||replay.signal.aborted)return response;
  const headers=new Headers(replay.headers);headers.set('X-MFA-Code',proof.code.trim());return nativeFetch(new Request(replay,{headers}));
 };
 function recoveryDialog(codes){
  const dialog=make('dialog',null,'cg-security-dialog'),heading=make('h2','Save your recovery codes');heading.id='mfa-recovery-title';dialog.setAttribute('aria-labelledby',heading.id);
  const text=make('textarea');text.readOnly=true;text.value=codes.join('\n');text.rows=8;text.setAttribute('aria-label','Single-use recovery codes');
  dialog.append(heading,make('p','Each code works once. Save them offline before closing; they will not be shown again.','muted'),text);
  const actions=make('div',null,'cg-security-actions'),download=make('button','Download codes','button button-secondary'),done=make('button','I have saved the codes','button button-primary');download.type=done.type='button';
  download.onclick=()=>{const url=URL.createObjectURL(new Blob(['CornGrid recovery codes\nKeep private. Each code can be used once.\n\n'+codes.join('\n')],{type:'text/plain'})),link=make('a');link.href=url;link.download='corngrid-recovery-codes.txt';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);};
  done.onclick=()=>dialog.close();dialog.onclose=()=>{text.value='';codes.length=0;dialog.remove();};actions.append(download,done);dialog.append(actions);document.body.append(dialog);dialog.showModal();done.focus();
 }
 async function init(){
  const target=admin?document.querySelector('.topbar-actions'):document.getElementById('setting-security');if(!target)return;
  const section=make('section',null,'cg-security-settings'),message=make('p',null,'muted'),button=make('button','Security','button button-secondary');button.type='button';
  if(admin){target.prepend(button);}else{section.append(make('h3','Two-factor authentication'),message,button);target.append(section);}
  let state;
  async function load(){state=await api('');button.textContent=admin?'Security':state.enabled?'Disable two-factor authentication':'Set up two-factor authentication';message.textContent=state.enabled?'Enabled. '+state.recoveryRemaining+' recovery codes remain.':'Protect your partner account with an authenticator app.';if(!admin)section.hidden=!state.eligible&&!state.enabled;}
  try{await load();}catch{return;}
  button.onclick=async()=>{
   button.disabled=true;
   try{
    if(state.enabled){
     const values=await promptForm('Two-factor authentication is enabled',[{name:'password',label:'Current password',type:'password'},{name:'code',label:'Authenticator or recovery code'}],'Disabling 2FA signs out other sessions. '+state.recoveryRemaining+' recovery codes remain. Select Continue to disable.');
     if(values)await api('/disable',values);
    }else{
     const values=await promptForm('Set up two-factor authentication',[{name:'password',label:'Current password',type:'password'}],'Confirm your password before adding an authenticator app.');if(!values)return;
     const setup=await api('/setup',values),confirmation=await promptForm('Add CornGrid to your authenticator',[{name:'code',label:'6-digit authenticator code'}],'Enter the manual key in your authenticator app, then enter its code. Setup expires in 10 minutes.',setup.secret);setup.secret='';setup.uri='';
     if(!confirmation)return;const confirmed=await api('/confirm',confirmation);recoveryDialog(confirmed.recoveryCodes);
    }
    await load();
   }catch(error){
    const dialog=make('dialog',null,'cg-security-dialog'),close=make('button','Close','button button-secondary');close.type='button';dialog.append(make('h2','Security settings'),make('p',error.message),close);close.onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();close.focus();
   }finally{button.disabled=false;}
  };
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
