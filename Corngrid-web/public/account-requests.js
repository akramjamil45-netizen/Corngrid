(() => {
  'use strict';
  const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={userBusy:false,userRequest:null,userSeq:0,adminBusy:false,page:1,pages:0,status:'pending',adminSeq:0};
  const date=value=>new Date(Number(value)).toLocaleString();
  async function api(url,options={}){
    const response=await fetch(url,{...options,credentials:'same-origin',signal:AbortSignal.timeout(20000),headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}}),data=await response.json().catch(()=>({}));
    if(!response.ok){if(data.code==='ACCOUNT_ARCHIVED'&&$('account-deletion-form'))location.replace('/login');throw Error(data.error||'Unable to load account requests. Please retry.');}return data;
  }
  function userStatus(message){$('account-deletion-status').textContent=message;}
  function userControls(disabled){$('account-deletion-form').querySelectorAll('input,textarea,button').forEach(e=>e.disabled=disabled);$('account-deletion-cancel').disabled=disabled;}
  async function openUser(){
    if(!$('account-deletion-form')||state.userBusy)return;
    const seq=++state.userSeq;userControls(true);
    try{
      const data=await api('/api/user/account-deletion-request');if(seq!==state.userSeq)return;
      state.userRequest=data.request;
      $('account-deletion-username').textContent=data.username;$('account-deletion-confirm-name').placeholder=data.username;
      const pending=data.request?.status==='pending';$('account-deletion-pending').hidden=!pending;$('account-deletion-form').hidden=pending;
      $('account-deletion-summary').textContent=pending?'Pending administrator review':'Request account deletion';
      if(pending){$('account-deletion-pending-text').textContent='Requested '+date(data.request.requestedAt)+'. You can cancel while the request is pending.';userStatus('Your account remains active until administrator approval.');}
      else if(data.request?.status==='rejected')userStatus('Previous request rejected: '+data.request.reviewNote);
      else if(data.request?.status==='cancelled')userStatus('Your previous request was cancelled.');
      else if(data.request?.status==='approved')userStatus('Your previous request was approved. This account has since been restored.');
      else userStatus('');
    }catch(error){userStatus(error.message);}finally{if(seq===state.userSeq)userControls(false);}
  }
  async function submitUser(event){
    event.preventDefault();if(state.userBusy)return;
    state.userBusy=true;state.userSeq++;userControls(true);userStatus('Sending your request…');
    try{
      await api('/api/user/account-deletion-request',{method:'POST',body:JSON.stringify({confirmUsername:$('account-deletion-confirm-name').value,confirm:$('account-deletion-confirm').checked,reason:$('account-deletion-reason').value.trim()})});
      $('account-deletion-form').reset();state.userBusy=false;await openUser();
    }catch(error){userStatus(error.message);}finally{state.userBusy=false;userControls(false);}
  }
  async function cancelUser(){
    if(state.userBusy||state.userRequest?.status!=='pending')return;
    state.userBusy=true;state.userSeq++;userControls(true);
    try{await api('/api/user/account-deletion-request/'+encodeURIComponent(state.userRequest.id),{method:'DELETE'});state.userBusy=false;await openUser();}
    catch(error){userStatus(error.message);}finally{state.userBusy=false;userControls(false);}
  }
  function badge(count){const b=$('account-requests-badge');if(!b)return;b.hidden=!count;b.textContent=count;b.setAttribute('aria-label',count+' pending account requests');}
  async function refreshBadge(){if(!$('account-requests-badge'))return;try{const data=await api('/api/admin/account-deletion-requests?status=pending&page=1');badge(data.pendingCount);}catch{/* The full page exposes an actionable error on open. */}}
  async function openAdmin(){
    if(!$('account-requests-list')||state.adminBusy)return;
    const seq=++state.adminSeq,list=$('account-requests-list');list.setAttribute('aria-busy','true');
    try{
      const data=await api('/api/admin/account-deletion-requests?status='+state.status+'&page='+state.page);if(seq!==state.adminSeq)return;
      badge(data.pendingCount);state.pages=data.pages;$('account-requests-summary').textContent=data.pendingCount+' pending · '+data.total+' matching requests';
      list.innerHTML=data.requests.map(r=>`<article class="account-request-card"><header><div><h3>${esc(r.username)}</h3><small>${esc(r.email)}</small></div><span class="pill ${r.status==='pending'?'pill-delayed':r.status==='approved'?'pill-live':'pill-muted'}">${esc(r.status[0].toUpperCase()+r.status.slice(1))}</span></header><small>Requested ${esc(date(r.requestedAt))}${r.requestedUsername!==r.username?' · Submitted as '+esc(r.requestedUsername):''}</small>${r.reason?`<p><strong>User reason</strong><br>${esc(r.reason)}</p>`:'<p>No reason provided.</p>'}${r.reviewNote?`<p><strong>Review note</strong><br>${esc(r.reviewNote)}</p>`:''}${r.isArchived?'<p>Account is archived.</p>':r.status==='approved'?'<p>Account was restored after approval.</p>':''}${r.status==='pending'?`<footer><button type="button" class="button button-danger button-small" data-account-approve="${esc(r.id)}" data-account-name="${esc(r.username)}">Approve &amp; archive</button><button type="button" class="button button-secondary button-small" data-account-reject="${esc(r.id)}">Reject</button></footer>`:`<small>Reviewed ${esc(date(r.reviewedAt))}</small>`}</article>`).join('')||'<p class="table-empty">No account requests with this status.</p>';
      $('account-requests-page').textContent='Page '+state.page+' of '+Math.max(1,data.pages);$('account-requests-prev').disabled=state.page<=1;$('account-requests-next').disabled=state.page>=data.pages;$('account-requests-feedback').textContent='';
    }catch(error){if(seq===state.adminSeq){list.innerHTML='';$('account-requests-feedback').textContent=error.message;}}finally{if(seq===state.adminSeq)list.removeAttribute('aria-busy');}
  }
  async function review(event){
    const approve=event.target.closest('[data-account-approve]'),reject=event.target.closest('[data-account-reject]');if((!approve&&!reject)||state.adminBusy)return;
    const id=approve?.dataset.accountApprove||reject.dataset.accountReject;let body;
    if(approve){const username=approve.dataset.accountName,typed=prompt('Approve deletion and archive '+username+'? This blocks account access and preserves records. Type the current display name exactly to confirm.');if(typed===null)return;if(typed!==username){$('account-requests-feedback').textContent='The display name did not match. No change was made.';return;}body={confirmUsername:typed};}
    else{const note=prompt('Reason for rejecting this request (shown to the user):');if(note===null)return;if(note.trim().length<5){$('account-requests-feedback').textContent='Add a reason of at least 5 characters.';return;}body={note:note.trim()};}
    state.adminBusy=true;state.adminSeq++;const controls=[...$('account-requests').querySelectorAll('button,select')];controls.forEach(c=>c.disabled=true);
    try{const options={method:'POST',body:JSON.stringify(body)};const result=approve?await api(`/api/admin/account-deletion-requests/${encodeURIComponent(id)}/approve`,options):await api(`/api/admin/account-deletion-requests/${encodeURIComponent(id)}/reject`,options);state.adminBusy=false;await openAdmin();$('account-requests-feedback').textContent=result.message;}
    catch(error){$('account-requests-feedback').textContent=error.message;}finally{state.adminBusy=false;controls.filter(c=>c.isConnected).forEach(c=>c.disabled=false);$('account-requests-prev').disabled=state.page<=1;$('account-requests-next').disabled=state.page>=state.pages;}
  }
  function init(){
    if($('account-deletion-form')){
      $('account-deletion-form').addEventListener('submit',submitUser);$('account-deletion-cancel').addEventListener('click',cancelUser);
      $('account-deletion-details').addEventListener('toggle',()=>{if($('account-deletion-details').open)openUser();});
    }
    if($('account-requests-list')){
      $('account-requests-list').addEventListener('click',review);$('account-requests-refresh').addEventListener('click',openAdmin);
      $('account-requests-filter').addEventListener('change',event=>{state.status=event.target.value;state.page=1;openAdmin();});
      $('account-requests-prev').addEventListener('click',()=>{if(state.page>1){state.page--;openAdmin();}});$('account-requests-next').addEventListener('click',()=>{if(state.page<state.pages){state.page++;openAdmin();}});refreshBadge();
    }
    setInterval(()=>{if(document.hidden)return;if($('account-requests')&&!$('account-requests').hidden)openAdmin();else refreshBadge();if($('page-settings')?.classList.contains('is-visible')&&$('account-deletion-details')?.open)openUser();},30000);
  }
  window.CornGridAccountRequests={openUser,openAdmin};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
