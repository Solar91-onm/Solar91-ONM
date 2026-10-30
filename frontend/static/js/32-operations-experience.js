"use strict";
/* A presentation and navigation enhancement. Operational data and mutations continue
 * through the original authenticated FastAPI/Supabase handlers. */
(function(){
  const htmlEscape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const circle = (name) => ({issue:'◎',pm:'▤',washing:'◉',plants:'☀',reports:'↗',handover:'◇'}[name] || '•');
  const previousDashboard = window.renderDashboard;
  if (typeof previousDashboard === "function") {
    window.renderDashboard = function(){
      const original = previousDashboard.apply(this,arguments);
      if (!window.S) return original;
      const role = S._roleLabel || S.currentRole || '';
      const head = role !== 'Site Engineer';
      const currentPlant = role === 'Site Engineer' && S._sePlant ? S._sePlant : (S.issF?.plant && S.issF.plant !== 'all' ? S.issF.plant : (S.dashPlant && S.dashPlant !== 'all' ? S.dashPlant : null));
      const issues = (S.issues||[]).filter(t=>!currentPlant || t.plant===currentPlant);
      const tasks = (S.tasks||[]).filter(t=>!currentPlant || t.plant===currentPlant);
      const count = issues.filter(t=>t.status!=='Closed' && t.status!=='Resolved').length;
      const pending = tasks.filter(t=>t.status!=='Completed' && t.status!=='Cancelled').length;
      const critical = issues.filter(t=>t.severity==='Critical' && t.status!=='Closed' && t.status!=='Resolved').length;
      const plants = (S.plants||[]).filter(p=>!currentPlant||p.name===currentPlant).length;
      const cards = [
        ['issue','Site issues','Review open tickets',count,"goTab('issues')"],
        ['pm','Preventive maintenance','Check upcoming and overdue work',pending,"goScheduledOM('maintenance')"],
        ['washing','Washing','View progress and approvals',null,"goScheduledOM('washing')"],
        ...(head?[['plants','Plant portfolio','Inspect every solar site',plants,"goView('plants')"]]:[])
      ];
      const washRows = (S._washCycles?.plants||[]).filter(p=>!currentPlant || (S.plants||[]).some(x=>(x.dbId===p.plant_id||x.id===p.plant_id)&&x.name===currentPlant));
      const washDue = washRows.filter(p=>['1d','3d','7d'].includes(p.overdue_bucket)||Number(p.late_days||0)>0).length;
      const washPending = (S._washCycles?.reports||[]).filter(r=>r.review_status==='Pending'&&(!currentPlant||washRows.some(p=>String(p.plant_id)===String(r.plant_id)))).length;
      const pmOverdue = tasks.filter(t=>t.status!=='Completed'&&t.status!=='Cancelled'&&typeof taskOD==='function'&&taskOD(t)>0).length;
      const openIssues = issues.filter(t=>t.status!=='Closed'&&t.status!=='Resolved');
      const issueOverdue = openIssues.filter(t=>typeof isOverdueIssue==='function'&&isOverdueIssue(t)).length;
      const percent = (part,whole)=>whole?Math.round(100*part/whole):0;
      const quick = [
       {kind:'issues',name:'Open tickets',val:openIssues.length,desc:'Open issue register',tone:'amber',fn:"s91OpenQueue('issues','open')"},
       {kind:'critical',name:'Critical faults',val:critical,desc:'Critical issues first',tone:'red',fn:"s91OpenQueue('issues','critical')"},
       {kind:'issueslate',name:'Overdue tickets',val:issueOverdue,desc:'Past fix commitment',tone:'rose',fn:"s91OpenQueue('issues','overdue')"},
       {kind:'pmlate',name:'PM overdue',val:pmOverdue,desc:'Late preventive work',tone:'blue',fn:"s91OpenQueue('pm','overdue')"},
       {kind:'washing',name:'Washing due',val:washDue,desc:'Plants past cycle due date',tone:'teal',fn:"s91OpenQueue('washing','late')"},
       {kind:'reviews',name:'Reports to review',val:washPending,desc:'Washing confirmations',tone:'gold',fn:"s91OpenQueue('washing','review')"}
      ];
      const tiles = quick.filter(c=>c.kind!=='reviews'||role!=='Site Engineer').map(c=>'<button type="button" class="s91-queue-tile tone-'+c.tone+'" onclick="'+c.fn+'" aria-label="'+c.name+': '+c.val+'. Open register"><span class="s91-queue-tile-top"><b>'+c.name+'</b><span aria-hidden="true">↗</span></span><strong>'+c.val+'</strong><small>'+c.desc+'</small><span class="s91-queue-mini"><i style="width:'+Math.min(100,percent(c.val,Math.max(1,c.kind==='washing'||c.kind==='reviews'?washRows.length:c.kind==='pmlate'?tasks.length:issues.length)))+'%"></i></span></button>').join('');
      const reportTools=head?'<button type="button" class="s91-command-report" onclick="s91OpenReportPreview(&quot;daily&quot;)"><span class="s91-command-report-icon">▤</span><span><b>Operational report</b><small>Compact daily, weekly or monthly brief · review before export</small></span><span aria-hidden="true">↗</span></button>':'';
      const shortcuts = '<section class="s91-ops-pulse" aria-label="Command Centre operational queues"><div class="s91-pulse-heading"><div><span class="s91-eyebrow">LIVE OPERATIONS · COMMAND CENTRE</span><h2>What needs attention</h2><p>Choose a number to open its filtered register. Counts reflect loaded, authorised operations data.</p></div><span class="s91-pulse-tag">'+(critical+pmOverdue+issueOverdue)+' priority signals</span></div><div class="s91-queue-grid">'+tiles+'</div><div class="s91-pulse-footer">'+reportTools+'<button type="button" class="s91-command-ask" onclick="s91AssistantOpen()"><span class="s91-command-report-icon">⌕</span><span><b>Ask about your operations</b><small>Search tickets, plants, PM and washing · no paid AI required</small></span><span aria-hidden="true">↗</span></button></div></section>';
      return shortcuts+original;
    };
  }

  const prevModal = window.renderModal;
  if (typeof prevModal !== "function") return;
  const nextStep = {
    Open:'Awaiting assignment',Assigned:'Assignee to acknowledge',Acknowledged:'Ready to begin work',
    'In Progress':'Record progress or submit resolution','Pending Vendor':'Awaiting parts or vendor response',
    Resolved:'Awaiting O&M Head verification',Closed:'Ticket closed — reopen if issue recurs'
  };
  function infoFor(kind){
    const ctx=S.modalCtx||{};
    if(kind==='ticket'){
      const ticket=(S.issues||[]).find(t=>String(t.id)===String(ctx.id));
      if(!ticket)return null;
      const updates=(ticket.activity||[]).length,photos=(ticket.evidence||[]).length;
      return {title:'ISSUE WORKFLOW',status:ticket.status,signal:ticket.severity,action:(ticket.status==='Open'&&ticket.assignee?'Ready for acknowledgement':nextStep[ticket.status]||'Review current ticket'),subtitle:ticket.plant+' · '+(ticket.equip||ticket.vertical||'Equipment'),facts:[['Assigned to',ticket.assignee||'Unassigned'],['Work entries',(ticket.progress||[]).length],['Evidence photos',photos],['Team updates',updates]],phase:['Open','Assigned','Acknowledged','In Progress','Pending Vendor','Resolved','Closed'].indexOf(ticket.status),phases:['Opened','Assigned','Acknowledged','Working','Resolved','Closed']};
    }
    if(kind==='pm'){
      const task=(S.tasks||[]).find(t=>String(t.id)===String(ctx.id));
      if(!task)return null;
      const total=Math.max(1,Number(task.totalUnits||task.quantity||1));
      return {title:'PREVENTIVE MAINTENANCE',status:task.status,signal:task.type||'Equipment',action:task.status==='Completed'?'Maintenance evidence recorded':task.status==='In Progress'?'Complete checklist and upload proof':'Review task schedule and assignment',subtitle:task.plant+' · '+(task.type||'Equipment'),facts:[['Units in this work scope',total],['Assignee',task.assignee||'Not assigned'],['Frequency',task.freq||'—'],['Due date',task.due||'—']],phase:task.status==='Completed'?2:task.status==='In Progress'?1:0,phases:['Scheduled','In progress','Completed']};
    }
    if(kind==='washing'){
      const plant=(S._washCycles?.plants||[]).find(p=>String(p.plant_id)===String(S.washDetailsPlant));
      if(!plant)return {title:'WASHING OPERATIONS',status:'Plant overview',signal:'Cleaning cycles',action:'Review plant progress and pending reports',facts:[],phases:['Scheduled','Cleaning','Review','Confirmed'],phase:1};
      const pending=(plant.daily_status||[]).reduce((sum,day)=>sum+(Number(day.pending)||0),0);
      const confirmed=(plant.daily_status||[]).reduce((sum,day)=>sum+(Number(day.confirmed)||0),0);
      return {title:'WASHING OPERATIONS',status:pending?'Awaiting confirmation':'Plant progress',signal:'Cleaning cycles',action:pending?'Review and verify submitted washing reports':'Review cycles and daily cleaning',facts:[['Confirmed tables',confirmed],['Waiting confirmation',pending],['Daily entries',(plant.daily_status||[]).length]],phases:['Scheduled','Cleaning','Review','Confirmed'],phase:pending?2:1};
    }
    return null;
  }
  function journey(info){
    if(!info||!info.phases||info.title==='ISSUE WORKFLOW')return '';
    // 'Pending Vendor' and 'Assigned' are alternate status branches; phase display is advisory only.
    let index=info.phase||0;
    if(info.title==='ISSUE WORKFLOW')index=({Open:0,Assigned:1,Acknowledged:2,'In Progress':3,'Pending Vendor':3,Resolved:4,Closed:5})[info.status]||0;
    return '<div class="s91-journey" aria-label="Workflow stages">'+info.phases.map((step,i)=>'<div class="s91-journey-step '+(i<index?'is-done':i===index?'is-current':'')+'"><span class="s91-journey-dot">'+(i<index?'✓':i+1)+'</span><small>'+htmlEscape(step)+'</small></div>').join('')+'</div>';
  }
  function quickPanel(kind){
    const info=infoFor(kind);
    if(!info)return '';
    const facts=info.facts.map(([label,value])=>'<div><small>'+htmlEscape(label)+'</small><strong>'+htmlEscape(value)+'</strong></div>').join('');
    return '<section class="s91-overlay-summary" aria-label="'+htmlEscape(info.title)+' summary"><div class="s91-overlay-summary-top"><span class="s91-eyebrow">'+htmlEscape(info.title)+'</span><span class="s91-overlay-status">'+htmlEscape(info.status)+'</span></div><div class="s91-overlay-lead"><span class="s91-lead-symbol">'+(kind==='ticket'?'⚑':kind==='washing'?'◉':'▦')+'</span><div><b>'+htmlEscape(info.action)+'</b><p>'+htmlEscape(info.subtitle||info.signal||'')+'</p></div></div>'+journey(info)+(facts?'<div class="s91-overlay-facts">'+facts+'</div>':'')+'<div class="s91-overlay-jump"><button type="button" class="s91-overlay-link" data-s91-jump-actions="1">Find workflow actions <span aria-hidden="true">↓</span></button></div></section>';
  }
  window.renderModal=function(){
    const current=prevModal.apply(this,arguments);
    if(!current||!window.S)return current;
    const kind=S.modal==='ticket'?'ticket':S.modal==='taskDetail'?'pm':S.modal==='washingPlantDetails'?'washing':null;
    if(!kind)return current;
    const summary=quickPanel(kind);
    if(!summary)return current;
    // Inject without replacing any form controls, event handlers, or original evidence blocks.
    return current.replace('<div class="modal-b">','<div class="modal-b">'+summary);
  };
  // Keyboard accessibility for complex overlays and non-native card navigation.
  document.addEventListener('click',event=>{
    const jump=event.target.closest('[data-s91-jump-actions]');
    if(!jump)return;
    const modal=jump.closest('.s91-reference-modal');
    const body=modal?.querySelector('.modal-b');
    if(!body)return;
    const choices=[...modal.querySelectorAll('.modal-f .btn.p:not([disabled]),.modal-b .btn.p:not([disabled]),.modal-f .btn:not([disabled]),.modal-b button[onclick]:not([disabled])')].filter(b=>b.offsetParent!==null);
    const target=choices[0];
    if(!target)return;
    target.scrollIntoView({behavior:'smooth',block:'nearest'});
    target.focus({preventScroll:true});
  });
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!window.S||!S.modal)return;
    const tag=event.target?.tagName;
    if(tag==='SELECT'||tag==='INPUT'&&event.target.type==='file')return;
    if(typeof closeModal==='function')closeModal();
  });
})();
