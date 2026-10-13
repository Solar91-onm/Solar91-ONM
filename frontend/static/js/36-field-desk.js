"use strict";
/* Solar91 Field Desk — one small, optional dashboard layer over the existing modules.
   Uses real scoped FastAPI worklists, not demo fixtures or browser-persisted tasks. */
(function () {
  if (window.s91FieldDeskInstalled) return;
  window.s91FieldDeskInstalled = true;
  const allowed = new Set(['O&M Head', 'Assignee', 'Site Engineer', 'Administration']);
  const escapeText = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  const role = () => (window.AUTH_IDENTITY && AUTH_IDENTITY.role) || (typeof S !== 'undefined' && S.currentRole) || '';
  const canRecord = () => role() === 'Site Engineer' || role() === 'O&M Head';
  const state = {data:null, at:0, loading:false, error:null, pending:null};
  const root = () => document.getElementById('s91-field-desk');

  function markup(data) {
    const s = data.summary || {};
    const metric = (name, value) => '<div class="s91-field-metric"><b>'+escapeText(value || 0)+'</b><span>'+escapeText(name)+'</span></div>';
    const issue = r => '<article class="s91-field-item"><div><strong>'+escapeText(r.ticket)+' · '+escapeText(r.description)+'</strong><small>'+escapeText(r.plant)+' · '+escapeText(r.severity)+' · '+escapeText(r.status)+' · '+escapeText(r.assignee)+'</small></div><div class="s91-field-actions"><button type="button" data-field-ticket="'+escapeText(r.ticket)+'">Open</button>'+(canRecord()?'<button type="button" data-field-update="'+escapeText(r.id)+'" data-field-label="'+escapeText(r.ticket)+'">Site update</button>':'')+'</div></article>';
    const task = r => '<article class="s91-field-item"><div><strong>'+escapeText(r.id)+' · '+escapeText(r.name)+'</strong><small>'+escapeText(r.plant)+' · '+escapeText(r.equipment||'')+' · '+escapeText(r.status)+' · Due '+escapeText(r.due||'Unscheduled')+(r.overdue_days?' · '+r.overdue_days+'d overdue':'')+'</small></div><div class="s91-field-actions"><button type="button" data-field-pm="'+escapeText(r.id)+'">Open PM</button></div></article>';
    return '<div class="s91-field-head"><div><span class="s91-field-strap">FIELD OPERATIONS · LIVE WORKLIST</span><h2>'+(role()==='Site Engineer'?'My Site — Today’s Work':'Daily Field Work')+'</h2><p>'+escapeText(data.scope==='one-plant'?(data.plants[0]?.name||'Assigned plant'):data.scope==='assigned-types'?'Assigned equipment across plants':'Portfolio overview')+' · Site engineers report field activity; the O&M team manages assignment and closure.</p></div><button class="s91-field-refresh" type="button" data-field-refresh>Refresh live work</button></div>'+ 
      '<div class="s91-field-metrics">'+metric('Active issues',s.open_issues)+metric('Critical issues',s.critical_issues)+metric('PM due / today',s.due_tasks)+metric('PM overdue',s.overdue_tasks)+'</div>'+ 
      '<div class="s91-field-cols"><div class="s91-field-list"><h3>Open site issues</h3>'+(data.issues?.length?data.issues.map(issue).join(''):'<div class="s91-field-empty">No open site issues in your assigned scope.</div>')+'</div><div class="s91-field-list"><h3>Scheduled maintenance</h3>'+(data.tasks?.length?data.tasks.map(task).join(''):'<div class="s91-field-empty">No scheduled maintenance pending in your scope.</div>')+'</div></div>'+
      (data.limited?'<p style="font-size:11px;color:#936b20">Worklist is limited to the newest records. Use the full register to see everything.</p>':'')+
      (canRecord()?'<p style="font-size:11px;color:#687969;margin:12px 0 0">Field notes are saved against the real issue and audit trail. Assignment, resolution and closure remain with authorized O&amp;M personnel.</p>':'');
  }

  function paint() {
    const box = root(); if (!box) return;
    if (state.data) box.innerHTML = markup(state.data);
    else if(state.error) box.innerHTML = '<div class="s91-field-head"><div><h2>Field Desk is temporarily unavailable</h2><p class="s91-field-error">'+escapeText(state.error)+'</p></div><button type="button" class="s91-field-refresh" data-field-refresh>Retry</button></div>';
    else box.innerHTML = '<div class="s91-field-head"><div><h2>Loading today’s field work…</h2><p>Reading operational records assigned to your role.</p></div></div>';
  }
  async function fetchOverview(force) {
    if (!allowed.has(role()) || state.loading) return;
    if (!force && state.data && Date.now()-state.at < 60000) {paint();return;}
    state.loading=true;state.error=null;
    if (!state.data) paint();
    try {
      const result = await apiFetch('/api/field/overview?limit=15');
      if (!allowed.has(role()) || result.role!==role()) return;
      state.data=result;state.at=Date.now();state.error=null;
      window.s91FieldOverviewData=result;document.dispatchEvent(new CustomEvent("s91:field-overview",{detail:result}));
    } catch (error) {
      state.error=error.message || 'Network error';
      if (force) state.data=null;
    } finally {state.loading=false;paint();}
  }
  window.s91RefreshFieldDesk = () => fetchOverview(true);
  window.s91ShowFieldDesk = () => {if(typeof goView==='function') goView('dashboard');setTimeout(()=>{root()?.scrollIntoView({behavior:'smooth',block:'start'});fetchOverview(false);},120)};

  const previousRenderDashboard = window.renderDashboard;
  if (typeof previousRenderDashboard === 'function') {
    window.renderDashboard = function () {
      const legacy = previousRenderDashboard.apply(this, arguments);
      if (!allowed.has(role())) return legacy;
      // Preserve the existing layered dashboard and insert the action surface ABOVE it.
      setTimeout(() => fetchOverview(false), 0);
      return '<section id="s91-field-desk" class="s91-field-desk" aria-label="Daily field work">'+(state.data?markup(state.data):'<h2 style="font-size:16px">Loading today’s field work…</h2>')+'</section>'+legacy;
    };
  }
  function closeDialog() {document.getElementById('s91-field-dialog-overlay')?.remove();}
  function showDialog(id, label) {
    if (!canRecord()) return;
    closeDialog();
    const el=document.createElement('div');el.id='s91-field-dialog-overlay';el.className='s91-field-modal';
    el.innerHTML='<form id="s91-field-note-form" class="s91-field-dialog" role="dialog" aria-modal="true" aria-label="Report site work"><h2>Site work update · '+escapeText(label)+'</h2><p>Record the inspection, actual work or blocker at your plant. This does not close or reassign the ticket.</p><label for="s91-field-status">Work status</label><select id="s91-field-status" required><option>Worked</option><option>Waiting for parts</option><option>Waiting for vendor</option><option>Waiting for shutdown or access</option><option>Weather or site condition</option><option>No work today</option></select><label for="s91-field-note">Inspection / work notes *</label><textarea id="s91-field-note" rows="4" minlength="3" maxlength="4000" required placeholder="What was checked? Findings, measurements, actions, blockers…"></textarea><label for="s91-field-hours">Work hours (optional)</label><input id="s91-field-hours" type="number" min="0" max="24" step="0.25" value="0"><label for="s91-field-next">Next action (optional)</label><textarea id="s91-field-next" rows="2" maxlength="1000" placeholder="Who needs to do what next?"></textarea><div class="s91-field-footer"><button type="button" data-field-cancel>Cancel</button><button type="submit">Save to issue</button></div></form>';
    document.body.append(el);el.dataset.issueId=id;
    el.addEventListener('click',evt=>{if(evt.target===el||evt.target.closest('[data-field-cancel]'))closeDialog();});
    el.querySelector('#s91-field-note').focus();
  }
  document.addEventListener('click', evt=>{
    if (evt.target.closest('[data-field-refresh]')) {fetchOverview(true);return;}
    const update=evt.target.closest('[data-field-update]');
    if (update) {showDialog(update.dataset.fieldUpdate, update.dataset.fieldLabel);return;}
    const issue=evt.target.closest('[data-field-ticket]');
    if (issue) {if(typeof openIssue==='function')openIssue(issue.dataset.fieldTicket);else if(typeof goTab==='function')goTab('issues');return;}
    const pm=evt.target.closest('[data-field-pm]');
    if (pm) {
      if(typeof S!=='undefined'&&S.schedF) S.schedF.q=pm.dataset.fieldPm;
      if(typeof goScheduledOM==='function')goScheduledOM('maintenance');else if(typeof goTab==='function')goTab('scheduled');
    }
  });
  document.addEventListener('submit',async evt=>{
    if(evt.target.id!=='s91-field-note-form')return;
    evt.preventDefault();
    const overlay=document.getElementById('s91-field-dialog-overlay');if(!overlay)return;
    const button=evt.target.querySelector('button[type=submit]');
    if(button.disabled)return;
    button.disabled=true;button.textContent='Saving…';
    try {
      const note=evt.target.querySelector('#s91-field-note').value.trim();
      const day_status=evt.target.querySelector('#s91-field-status').value;
      const hours=Number(evt.target.querySelector('#s91-field-hours').value||0);
      const next_step=evt.target.querySelector('#s91-field-next').value.trim()||null;
      await apiFetch('/api/field/issues/'+encodeURIComponent(overlay.dataset.issueId)+'/updates',{
        method:'POST',body:JSON.stringify({note,day_status,hours,next_step})
      });
      closeDialog();
      if(typeof toast==='function')toast('Field update saved to issue activity.');
      await fetchOverview(true);
    } catch(error) {
      button.disabled=false;button.textContent='Save to issue';
      const p=evt.target.querySelector('.s91-field-form-error')||document.createElement('p');
      p.className='s91-field-form-error';p.style.color='#ac3636';p.textContent=error.message||'Unable to save field update';
      evt.target.insertBefore(p,evt.target.querySelector('.s91-field-footer'));
    }
  });
  document.addEventListener('keydown',evt=>{if(evt.key==='Escape'&&document.getElementById('s91-field-dialog-overlay'))closeDialog()});
  // Auth/initial data can finish before this enhancement script executes. Render once
  // after the shell settles so the Field Desk is present on the very first dashboard.
  setTimeout(() => {
    if (typeof S !== 'undefined' && S.view === 'dashboard' && allowed.has(role()) &&
        document.querySelector('#app .shell') && !root() && typeof render === 'function') {
      render();
    }
  }, 450);
})();
