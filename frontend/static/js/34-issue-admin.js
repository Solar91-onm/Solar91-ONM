"use strict";
/* O&M Head-only ticket correction and reversible deletion. The server enforces role and audit controls. */
(function(){
 const head=()=>typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role==="O&M Head";
 const escHtml=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
 const ownIssue=id=>(S.issues||[]).find(x=>x.id===id);
 const cleanRoot=()=>document.getElementById("s91-issue-admin-root")?.remove();
 const root=(html)=>{cleanRoot();const r=document.createElement("div");r.id="s91-issue-admin-root";r.innerHTML=html;document.body.append(r);r.querySelector('button[data-cancel]')?.focus({preventScroll:true});return r};
 const safeError=e=>typeof toast==="function"&&toast(e?.message||"Could not save the change. Please retry.");
 const overlay=(title,subtitle,body,actions)=>'<div class="s91-admin-shade" role="presentation"><section class="s91-admin-panel" role="dialog" aria-modal="true" aria-label="'+escHtml(title)+'"><header><div class="s91-admin-eyebrow">SOLAR91 · SITE ISSUE MANAGEMENT</div><h2>'+escHtml(title)+'</h2><p>'+escHtml(subtitle)+'</p></header><div class="s91-admin-body">'+body+'</div><footer>'+actions+'</footer></section></div>';
 const btnClose='<button type="button" class="btn o" data-cancel>Cancel</button>';
 document.addEventListener('click',e=>{if(e.target.matches('.s91-admin-shade')||e.target.closest('#s91-issue-admin-root [data-cancel]'))cleanRoot()});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('s91-issue-admin-root'))cleanRoot()});
 document.addEventListener('click',e=>{const edit=e.target.closest('[data-s91-edit]');if(edit){e.stopPropagation();if(head()&&typeof openModal==='function')openModal('editTicket',{id:edit.dataset.s91Edit});}});
 window.s91ConfirmDeleteIssue=function(id){
  if(!head())return;
  const ticket=ownIssue(id);if(!ticket||!ticket.dbId){toast('Ticket not found on the server; reload and try again.');return}
  const html='<div class="s91-admin-warning"><b>This does not permanently erase the ticket.</b><p>It will disappear from active registers, Command Centre counts, reports, and search. Its work history and private photos stay stored and can be restored.</p></div>'+
   '<label class="s91-admin-field">Reason for deletion<input id="s91-delete-reason" maxlength="500" placeholder="Example: Duplicate ticket created in error" autocomplete="off"/></label>'+
   '<label class="s91-admin-field">Confirm ticket number: <b>'+escHtml(ticket.id)+'</b><input id="s91-delete-code" placeholder="Type '+escHtml(ticket.id)+'" autocomplete="off"/></label>';
  const r=root(overlay('Move ticket to Deleted',id+' · O&M Head confirmation required',html,btnClose+'<button type="button" class="btn d" id="s91-submit-delete">Move to Deleted</button>'));
  r.querySelector('#s91-submit-delete').onclick=async function(){
   const reason=r.querySelector('#s91-delete-reason').value.trim(),confirmation=r.querySelector('#s91-delete-code').value.trim();
   if(reason.length<8){toast('Explain why this ticket should be removed (at least 8 characters).');return}
   if(confirmation!==ticket.id){toast('Type the exact ticket number to confirm.');return}
   this.disabled=true;this.textContent='Saving…';
   try{
    await apiFetch('/api/issues/'+encodeURIComponent(ticket.dbId),{method:'DELETE',body:{reason,confirm_ticket:confirmation}});
    S.issues=(S.issues||[]).filter(t=>t.id!==ticket.id);S.modal=null;S.modalCtx={};
    cleanRoot();if(typeof render==='function')render();
    if(typeof toast==='function')toast(ticket.id+' moved to Deleted. It can be restored by the O&M Head.');
   }catch(error){safeError(error);this.disabled=false;this.textContent='Move to Deleted'}
  };
 };
 window.s91OpenDeletedTickets=async function(){
  if(!head())return;
  const r=root(overlay('Deleted tickets','Recover tickets that were created or removed by mistake','<p class="s91-admin-muted">Loading deleted tickets…</p>',btnClose));
  try{
   const rows=await apiFetch('/api/issues/deleted?limit=200');if(!r.isConnected)return;
   const list=Array.isArray(rows)?rows:[];
   r.querySelector('.s91-admin-body').innerHTML=list.length?'<div class="s91-admin-list">'+list.map(t=>'<article class="s91-admin-item"><div><strong>'+escHtml(t.ticket_no)+'</strong><p>'+escHtml(t.description||'')+'</p><small>'+escHtml(t.deletion_reason||'')+' · deleted '+escHtml((t.deleted_at||'').replace('T',' ').slice(0,16))+'</small></div><button type="button" class="btn p sm" data-restore="'+escHtml(t.id)+'">Restore</button></article>').join('')+'</div>':'<div class="s91-admin-empty">No deleted tickets to restore.</div>';
   r.querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>{
    const ticket=list.find(t=>t.id===b.dataset.restore);if(ticket)s91RestoreIssue(ticket);
   });
  }catch(error){if(r.isConnected){r.querySelector('.s91-admin-body').textContent=error?.message||'Failed to load deleted tickets.'}}
 };
 window.s91RestoreIssue=function(ticket){
  if(!head())return;
  const r=root(overlay('Restore '+ticket.ticket_no,'This will return the ticket to the live registers.',
    '<label class="s91-admin-field">Reason for restoration<input id="s91-restore-reason" maxlength="500" placeholder="Example: Ticket was removed by mistake"/></label>',btnClose+'<button class="btn p" id="s91-submit-restore">Restore ticket</button>'));
  r.querySelector('#s91-submit-restore').onclick=async function(){
   const reason=r.querySelector('#s91-restore-reason').value.trim();if(reason.length<8){toast('Enter a restoration reason (at least 8 characters).');return}
   this.disabled=true;this.textContent='Restoring…';
   try{
    const row=await apiFetch('/api/issues/'+encodeURIComponent(ticket.id)+'/restore',{method:'POST',body:{reason}});
    if(typeof applyIssueRow==='function')applyIssueRow(row);
    cleanRoot();if(typeof render==='function')render();if(typeof toast==='function')toast(ticket.ticket_no+' restored with audit history.');
   }catch(error){safeError(error);this.disabled=false;this.textContent='Restore ticket'}
  }
 };
 // Reinforce clear edit access from the register, keeping all real save handlers in place.
 if(typeof issueQuickActs==='function'){
  const original=issueQuickActs;
  issueQuickActs=function(t){const html=original(t);if(!head()||!t.dbId)return html;
   const edit='<button class="btn o sm" type="button" data-s91-edit="'+escHtml(t.id)+'">Edit</button>';
   return html.replace('</div>',edit+'</div>');
  };
 }
})();
