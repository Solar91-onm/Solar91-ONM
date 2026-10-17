"use strict";
/* ================================================================
   SMART PORTAL UPGRADE v1
   Proof · Live SLA · Saved views · Chronic detect · Batch · Today
   Drop-in: wraps render(), layers in on top of your existing UI.
   ================================================================ */
(function(){
  if(window._ccSmart) return;
  window._ccSmart = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}

  /* ---------- demo photo generator (self-contained, no network) ---------- */
  function ccFakePhoto(kind, at, by, note){
    var w=320,h=240;
    var colors={before:["#7f1d1d","#450a0a"],after:["#14532d","#052e16"],
      reading:["#1e3a8a","#0c1e4a"],spare_old:["#78350f","#3c1a07"],
      spare_new:["#166534","#052e16"],checklist:["#3730a3","#1e1b4b"],
      table:["#0e7490","#083344"],site:["#4c1d95","#2e1065"]};
    var c = colors[kind]||["#374151","#111827"];
    var hash=0, s=(kind+at+by+note).slice(0,80);
    for(var i=0;i<s.length;i++) hash=((hash<<5)-hash)+s.charCodeAt(i)|0;
    var sh="";
    for(var i=0;i<5;i++){
      var x=Math.abs((hash*(i+3))%(w-40))+20;
      var y=Math.abs((hash*(i+7))%(h-60))+20;
      var r=15+Math.abs((hash*(i+11))%40);
      sh+='<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="rgba(255,255,255,0.08)"/>';
    }
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'+
      '<stop offset="0" stop-color="'+c[0]+'"/><stop offset="1" stop-color="'+c[1]+'"/></linearGradient></defs>'+
      '<rect width="'+w+'" height="'+h+'" fill="url(#g)"/>'+sh+
      '<rect x="0" y="'+(h-40)+'" width="'+w+'" height="40" fill="rgba(0,0,0,0.55)"/>'+
      '<text x="8" y="'+(h-24)+'" fill="#fff" font-family="sans-serif" font-size="10" font-weight="600">'+xesc((kind||"").toUpperCase())+' · '+xesc(at||"")+'</text>'+
      '<text x="8" y="'+(h-10)+'" fill="#e5e7eb" font-family="sans-serif" font-size="9">'+xesc((note||"").slice(0,44))+'</text>'+
      '<text x="'+(w-8)+'" y="16" text-anchor="end" fill="rgba(255,255,255,.7)" font-family="sans-serif" font-size="9">DEMO · '+xesc(by||"")+'</text>'+
      '</svg>';
    return "data:image/svg+xml;utf8,"+encodeURIComponent(svg);
  }
  window.ccFakePhoto = ccFakePhoto;

  /* ---------- evidence data model ---------- */
  function ccAddEvidence(t, kind, note, by){
    if(!t.evidence) t.evidence = [];
    var at = (typeof stampLong==="function") ? stampLong() : new Date().toLocaleString();
    var ev = {
      id: (typeof uid==="function") ? uid("EV") : "EV-"+Date.now(),
      kind: kind||"site", at: at, iso: new Date().toISOString(),
      by: by || (typeof OM_HEAD!=="undefined" ? OM_HEAD : "System"),
      note: note||"", gps: null,
      url: ccFakePhoto(kind, at, by||OM_HEAD, note)
    };
    t.evidence.push(ev);
    return ev;
  }
  window.ccAddEvidence = ccAddEvidence;

  function ccProofState(t){
    var ev = t.evidence||[];
    var hasBefore = ev.some(function(e){return e.kind==="before"});
    var hasAfter  = ev.some(function(e){return e.kind==="after"||e.kind==="reading"});
    if(!ev.length) return {state:"missing",label:"Proof missing",tone:"d"};
    if(t.status==="Resolved"||t.status==="Closed"){
      if(hasBefore&&hasAfter) return {state:"complete",label:"Proof complete",tone:"s"};
      return {state:"partial",label:"Proof partial — missing closure photo",tone:"w"};
    }
    if(hasBefore) return {state:"complete",label:"Proof complete",tone:"s"};
    return {state:"partial",label:"Proof partial — missing before photo",tone:"w"};
  }
  window.ccProofState = ccProofState;

  /* ---------- live SLA countdown ---------- */
  function ccCountdown(t){
    if(t.status==="Closed") return {label:"Closed",tone:"m"};
    if(t.status==="Resolved") return {label:"Awaiting verify",tone:"s"};
    if(!t.etc) return {label:"No ETC",tone:"m"};
    var now = new Date(typeof NOW_ISO!=="undefined" ? NOW_ISO : Date.now());
    var due = new Date(t.etc);
    var ms = due - now;
    if(ms<0){
      var hrs = Math.abs(ms)/3600000;
      var label = hrs>=24 ? Math.floor(hrs/24)+"d "+Math.floor(hrs%24)+"h OVERDUE"
                          : Math.floor(hrs)+"h "+Math.floor((hrs%1)*60)+"m OVERDUE";
      return {label:label,tone:"d"};
    }
    var hrs2 = ms/3600000;
    if(hrs2<=12){
      var l2 = hrs2>=1 ? Math.floor(hrs2)+"h "+Math.floor((hrs2%1)*60)+"m left" : Math.floor(hrs2*60)+"m left";
      return {label:l2,tone:"w"};
    }
    var l3 = hrs2>=24 ? Math.floor(hrs2/24)+"d "+Math.floor(hrs2%24)+"h left" : Math.floor(hrs2)+"h left";
    return {label:l3,tone:"s"};
  }
  window.ccCountdown = ccCountdown;
  function ccSlaBadge(t){
    var c = ccCountdown(t);
    var ico = c.tone==="d"?"🔴":c.tone==="w"?"⏱":c.tone==="s"?"✅":"";
    return '<span class="cc-sla '+c.tone+'">'+ico+' '+xesc(c.label)+'</span>';
  }
  window.ccSlaBadge = ccSlaBadge;

  /* ---------- chronic issue detection ---------- */
  function ccChronicCounts(){
    var map={};
    (S.issues||[]).forEach(function(t){
      var k=[t.plant,t.vertical,t.sub||""].join("|");
      map[k]=(map[k]||0)+1;
    });
    return map;
  }
  function ccIsChronic(t){
    var k=[t.plant,t.vertical,t.sub||""].join("|");
    return (ccChronicCounts()[k]||0)>=3;
  }
  function ccChronicBadge(t){
    return ccIsChronic(t) ? '<span class="cc-chronic" title="Same plant + type + sub-category logged 3+ times">⚠ Chronic</span>' : '';
  }

  /* ---------- persistent breach banner ---------- */
  function ccBreachBanner(){
    var breaches = (S.issues||[]).filter(function(t){return typeof slaState==="function" && slaState(t)==="breach"});
    if(!breaches.length) return "";
    var sorted = breaches.slice().sort(function(a,b){return new Date(a.etc)-new Date(b.etc)});
    var shown = sorted.slice(0,3).map(function(t){
      var c = ccCountdown(t);
      return '<b>'+xesc(t.id)+'</b> ('+xesc(c.label.replace(" OVERDUE",""))+')';
    }).join(" · ");
    var more = sorted.length>3 ? ' · +'+(sorted.length-3)+' more' : '';
    return '<div class="cc-breach-bar">'+
      '<span class="cc-breach-ico">🔴</span>'+
      '<span><b>'+sorted.length+' ticket'+(sorted.length===1?"":"s")+' breached</b> — '+shown+more+'</span>'+
      '<button class="btn o sm" style="margin-left:auto" onclick="ccGotoBreaches()">Open list</button>'+
    '</div>';
  }
  window.ccBreachBanner = ccBreachBanner;
  window.ccGotoBreaches = function(){
    S.issF = (typeof blankIssF==="function") ? blankIssF({chip:"Overdue"}) : {chip:"Overdue"};
    S.tablePages.issues = 1;
    if(S.view==="om-module" && S.omTab==="issues") render();
    else goTab("issues");
  };

  /* ---------- saved filter views ---------- */
  function ccViews(){
    if(!S.savedViews) S.savedViews = (typeof loadK==="function") ? loadK("savedViews", []) : [];
    return S.savedViews;
  }
  function ccSaveViewsList(){ try{ if(typeof saveK==="function") saveK("savedViews", S.savedViews||[]); }catch(e){} }
  window.ccSaveView = function(name){
    ccViews().push({id:"V"+Date.now(),name:name||"Saved view",
      filter:JSON.parse(JSON.stringify(S.issF||{})), at:new Date().toISOString()});
    ccSaveViewsList();
    if(typeof ccPopup==="function") ccPopup('View saved','“'+name+'” pinned above the register','s',null);
    render();
  };
  window.ccApplyView = function(id){
    var v = ccViews().find(function(x){return x.id===id});
    if(!v) return;
    S.issF = Object.assign((typeof blankIssF==="function"?blankIssF():{}), v.filter);
    S.tablePages.issues = 1;
    persist(); render();
    if(typeof ccPopup==="function") ccPopup('View applied',v.name,"i",null);
  };
  window.ccDelView = function(id){
    S.savedViews = ccViews().filter(function(x){return x.id!==id});
    ccSaveViewsList(); render();
  };
  window.ccPromptSaveView = function(){
    var name = prompt("Name this view (e.g. My breaches, Rajasthan critical):");
    if(name) ccSaveView(name);
  };
  function ccViewsStrip(){
    var views = ccViews();
    if(!views.length) return "";
    return '<div class="cc-views-strip panel" style="padding:8px 12px">'+
      '<span class="kpi-label" style="flex:0 0 auto">SAVED VIEWS</span>'+
      views.map(function(v){
        return '<span class="pill pillsm gf-chip" style="cursor:pointer" onclick="ccApplyView(\''+xesc(v.id)+'\')">'+xesc(v.name)+
          ' <button type="button" onclick="event.stopPropagation();ccDelView(\''+xesc(v.id)+'\')" style="border:0;background:none;color:inherit;cursor:pointer;padding:0 0 0 4px">×</button></span>';
      }).join("")+
      '<button class="btn g sm" style="margin-left:auto" onclick="ccPromptSaveView()">+ Save current</button></div>';
  }

  /* ---------- evidence lightbox ---------- */
  window.ccOpenLightbox = function(ticketId, evId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId}); if(!t) return;
    var ev = (t.evidence||[]).find(function(e){return e.id===evId}); if(!ev) return;
    var idx = t.evidence.indexOf(ev);
    var prev = idx>0 ? t.evidence[idx-1] : null;
    var next = idx<t.evidence.length-1 ? t.evidence[idx+1] : null;
    var box = document.getElementById("cc-lbox");
    if(!box){ box = document.createElement("div"); box.id="cc-lbox"; box.className="cc-lbox"; document.body.appendChild(box); }
    box.onclick = function(e){ if(e.target===box) box.remove(); };
    box.innerHTML = '<div class="cc-lbox-inner">'+
      '<button class="cc-lbox-close" onclick="document.getElementById(\'cc-lbox\').remove()">×</button>'+
      '<img src="'+ev.url+'"/>'+
      '<div class="cc-lbox-meta">'+
        '<div><b>'+xesc(t.id)+'</b> · '+xesc(t.plant||"")+' · '+xesc(t.vertical||"")+'</div>'+
        '<div style="margin-top:6px"><b>Kind:</b> '+xesc(ev.kind)+' · <b>At:</b> '+xesc(s91LogAt(ev.at))+' · <b>By:</b> '+xesc(ev.by)+'</div>'+
        (ev.note?'<div style="margin-top:4px"><b>Note:</b> '+xesc(ev.note)+'</div>':'')+
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
          (prev?'<button class="btn o sm" onclick="document.getElementById(\'cc-lbox\').remove();ccOpenLightbox(\''+xesc(t.id)+'\',\''+xesc(prev.id)+'\')">← '+xesc(prev.kind)+'</button>':'')+
          (next?'<button class="btn o sm" onclick="document.getElementById(\'cc-lbox\').remove();ccOpenLightbox(\''+xesc(t.id)+'\',\''+xesc(next.id)+'\')">'+xesc(next.kind)+' →</button>':'')+
          '<span style="font-size:12.5px;color:#9ca3af;margin-left:auto">Photo '+(idx+1)+' of '+t.evidence.length+'</span>'+
        '</div>'+
      '</div></div>';
  };
  window.ccAddPhotoQuick = function(id, kind){
    var t = (S.issues||[]).find(function(x){return x.id===id}); if(!t) return;
    var note = prompt("Caption for this "+kind+" photo (optional):")||"";
    ccAddEvidence(t, kind, note, (typeof OM_HEAD!=="undefined"?OM_HEAD:"System"));
    persist(); render();
    if(typeof ccPopup==="function") ccPopup('Photo attached',kind+(note?" · "+note:""),"s",null);
  };

  /* ---------- styles ---------- */
  var style = document.createElement("style");
  style.textContent = [
    '.cc-breach-bar{position:sticky;top:66px;z-index:25;display:flex;align-items:center;gap:10px;'+
      'background:linear-gradient(90deg,#7f1d1d,#dc4c3e);color:#fff;padding:9px 14px;border-radius:12px;'+
      'font-size:12.5px;box-shadow:0 8px 22px rgba(220,76,62,.35);border:1px solid #b91c1c;margin-bottom:2px}',
    '.cc-breach-bar .cc-breach-ico{font-size:16px;animation:pulse 1.4s infinite}',
    '.cc-breach-bar b{font-weight:800;color:#fff}',
    '.cc-breach-bar .btn.o{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3);color:#fff}',
    '.cc-breach-bar .btn.o:hover{background:rgba(255,255,255,.22);border-color:#fff;color:#fff}',
    '.cc-views-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.cc-sla{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:700;padding:3px 7px;border-radius:6px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.cc-sla.s{background:var(--success-soft);color:var(--success)}',
    '.cc-sla.w{background:var(--warning-soft);color:var(--warning-strong)}',
    '.cc-sla.d{background:var(--danger-soft);color:var(--danger)}',
    '.cc-sla.m{background:var(--muted);color:var(--muted-foreground)}',
    '.cc-proof{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;padding:2px 6px;border-radius:999px;white-space:nowrap}',
    '.cc-proof.s{background:var(--success-soft);color:var(--success)}',
    '.cc-proof.w{background:var(--warning-soft);color:var(--warning-strong)}',
    '.cc-proof.d{background:var(--danger-soft);color:var(--danger)}',
    '.cc-chronic{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:700;padding:1px 6px;border-radius:999px;background:#fef3c7;color:#92400e;border:1px solid #fcd34d}',
    '.cc-thumbs{display:inline-flex;gap:3px;align-items:center;vertical-align:middle}',
    '.cc-thumb{width:22px;height:22px;border-radius:5px;object-fit:cover;border:1px solid var(--border);cursor:pointer;flex-shrink:0;transition:transform .12s,border-color .12s}',
    '.cc-thumb:hover{transform:scale(1.15);border-color:var(--primary)}',
    '.cc-lbox{position:fixed;inset:0;background:rgba(5,10,8,.85);z-index:5000;display:flex;align-items:center;justify-content:center;padding:20px}',
    '.cc-lbox-inner{background:#0b0f0d;border-radius:14px;max-width:720px;width:100%;max-height:90vh;overflow:auto;position:relative;box-shadow:0 30px 80px rgba(0,0,0,.6)}',
    '.cc-lbox img{width:100%;display:block;border-radius:14px 14px 0 0}',
    '.cc-lbox-meta{padding:14px 18px;color:#e5e7eb;font-size:12.5px;line-height:1.6}',
    '.cc-lbox-meta b{color:#fff}',
    '.cc-lbox-close{position:absolute;top:10px;right:10px;width:32px;height:32px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.2);cursor:pointer;display:grid;place-items:center;font-size:16px}',
    '.cc-lbox-close:hover{background:var(--danger);border-color:var(--danger)}',
    '.cc-quicktmpl{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.cc-quicktmpl button{font-size:12.5px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);background:#fff;cursor:pointer;color:var(--muted-foreground);font-weight:600;font-family:inherit}',
    '.cc-quicktmpl button:hover{border-color:var(--primary);color:var(--primary);background:var(--secondary)}',
    '.cc-batch-bar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:1200;background:#0b0f0d;color:#fff;padding:10px 16px;border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.4);display:flex;align-items:center;gap:12px;font-size:12.5px}',
    '.cc-batch-bar .btn{background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.25)}',
    '.cc-batch-bar .btn:hover{background:rgba(255,255,255,.24);border-color:#fff;color:#fff}',
    '.cc-batch-bar .btn.p{background:var(--primary);border-color:var(--primary)}',
    '.cc-batch-bar .btn.p:hover{background:#128A3E}',
    '.cc-cbcell{width:22px;text-align:center}',
    '.cc-today{background:linear-gradient(135deg,#0B2B1D,#16A34A);color:#fff;border-radius:18px;padding:16px 20px;box-shadow:0 12px 30px rgba(11,43,29,.25)}',
    '.cc-today h3{font-size:15px;font-weight:800;margin:0;color:#fff}',
    '.cc-today .cc-tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:12px}',
    '.cc-today .cc-titem{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:10px 12px;font-size:12px;color:#fff;cursor:pointer;transition:.15s}',
    '.cc-today .cc-titem:hover{background:rgba(255,255,255,.20)}',
    '.cc-today .cc-titem b{font-size:12.5px;color:#fff}',
    '.cc-today .cc-titem .n{font-size:20px;font-weight:800;letter-spacing:-.02em;color:#FFD666;margin-top:4px}'
  ].join("");
  document.head.appendChild(style);

  /* ---------- row enrichment: SLA + proof + thumbs + chronic ---------- */
  function ccEnrichRow(tr){
    if(tr.getAttribute("data-cc-enriched")) return;
    var id = tr.getAttribute("data-id")||tr.getAttribute("data-rid");
    if(!id) return;
    var t = (S.issues||[]).find(function(x){return x.id===id});
    if(!t) return;
    tr.setAttribute("data-cc-enriched","1");
    var tds = tr.querySelectorAll("td");
    if(!tds.length) return;
    if(!tds[0].querySelector(".cc-sla")){
      tds[0].insertAdjacentHTML("beforeend",
        '<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">'+ccSlaBadge(t)+ccChronicBadge(t)+'</div>');
    }
    if((t.evidence||[]).length && !tds[0].querySelector(".cc-thumbs")){
      var ev = t.evidence.slice(0,4);
      var more = t.evidence.length>4 ? '<span style="font-size:12px;color:var(--muted-foreground);margin-left:3px">+'+(t.evidence.length-4)+'</span>' : '';
      tds[0].insertAdjacentHTML("beforeend",
        '<div style="margin-top:4px"><span class="cc-thumbs" onclick="event.stopPropagation()">'+
        ev.map(function(e){
          return '<img class="cc-thumb" src="'+e.url+'" title="'+xesc(e.kind)+' · '+xesc(e.at)+'" onclick="ccOpenLightbox(\''+xesc(t.id)+'\',\''+xesc(e.id)+'\')"/>';
        }).join("")+more+'</span></div>');
    }
    for(var i=0;i<tds.length;i++){
      if(tds[i].querySelector(".badge") && !tds[i].querySelector(".cc-proof")){
        var ps = ccProofState(t);
        var ico = ps.tone==="s"?"🟢":ps.tone==="w"?"🟡":"🔴";
        tds[i].insertAdjacentHTML("beforeend",
          ' <span class="cc-proof '+ps.tone+'" title="'+xesc(ps.label)+'">'+ico+' proof</span>');
        break;
      }
    }
  }
  function ccEnrichAll(){
    var rows = document.querySelectorAll('tr[data-act="issue"], tr[data-rid]');
    rows.forEach(ccEnrichRow);
  }

  /* ---------- batch selection ---------- */
  window.ccToggleSel = function(id, cb){
    if(!S.ccBatch) S.ccBatch = new Set();
    if(cb.checked) S.ccBatch.add(id); else S.ccBatch.delete(id);
    ccRenderBatchBar();
  };
  function ccRenderBatchBar(){
    var set = S.ccBatch||new Set();
    var bar = document.getElementById("cc-batch-bar");
    if(!set.size){ if(bar) bar.remove(); return; }
    if(!bar){ bar = document.createElement("div"); bar.id="cc-batch-bar"; bar.className="cc-batch-bar"; document.body.appendChild(bar); }
    bar.innerHTML = '<b>'+set.size+'</b> selected'+
      '<button class="btn p sm" onclick="ccBatchClose()">Close all…</button>'+
      '<button class="btn sm" onclick="ccBatchAssign()">Assign…</button>'+
      '<button class="btn sm" onclick="ccBatchClear()">Clear</button>';
  }
  window.ccBatchClear = function(){ S.ccBatch = new Set(); ccRenderBatchBar(); render(); };
  window.ccBatchClose = function(){
    var set = S.ccBatch||new Set();
    if(!set.size) return;
    var reason = prompt("Close "+set.size+" ticket(s) directly. Closure reason (optional):")||"Bulk closed";
    var n=0;
    (S.issues||[]).forEach(function(t){
      if(!set.has(t.id)) return;
      var prev = t.status;
      t.status = "Closed"; t.updated = stampISO();
      t.closure = t.closure||{};
      t.closure.closedAt = t.closure.closedAt||stampISO();
      t.closure.verifiedBy = t.closure.verifiedBy||OM_HEAD;
      t.closure.directClose = true;
      t.closure.remarks = reason;
      t.closure.rootCause = t.closure.rootCause||"Bulk close";
      t.closure.corrective = t.closure.corrective||reason;
      t.progress = [{at:stampISO(),note:"Bulk closed by "+OM_HEAD+" — "+reason,parts:"—",hrs:0}].concat(t.progress||[]);
      if(typeof audit==="function") audit("Issues","Bulk closed "+t.id+" — "+reason,OM_HEAD,prev,"Closed");
      n++;
    });
    S.ccBatch = new Set(); ccRenderBatchBar();
    persist(); render();
    if(typeof ccPopup==="function") ccPopup(n+" ticket(s) closed",reason,"s",null);
  };
  window.ccBatchAssign = function(){
    var set = S.ccBatch||new Set();
    if(!set.size) return;
    var who = prompt("Assign "+set.size+" ticket(s) to (name):", (typeof TEAM_POOL!=="undefined"?TEAM_POOL[0]:""));
    if(!who) return;
    var n=0;
    (S.issues||[]).forEach(function(t){
      if(!set.has(t.id)) return;
      t.assignee = who;
      if(t.status==="Open") t.status = "Assigned";
      t.updated = stampISO();
      t.progress = [{at:stampISO(),note:"Bulk assigned to "+who,parts:"—",hrs:0}].concat(t.progress||[]);
      n++;
    });
    S.ccBatch = new Set(); ccRenderBatchBar();
    persist(); render();
    if(typeof ccPopup==="function") ccPopup(n+" ticket(s) assigned to "+who,"","s",null);
  };

  function ccInjectCheckboxes(){
    var tbl = document.querySelector('#section-results table');
    if(!tbl) return;
    var head = tbl.querySelector("thead tr");
    if(head && !head.querySelector(".cc-cbcell")){
      var th = document.createElement("th");
      th.className = "cc-cbcell";
      th.innerHTML = '<input type="checkbox" title="Select all" onchange="var cbs=document.querySelectorAll(\'.cc-rowcb\');for(var i=0;i<cbs.length;i++){cbs[i].checked=this.checked;ccToggleSel(cbs[i].getAttribute(\'data-tid\'),cbs[i])}"/>';
      head.insertBefore(th, head.firstChild);
    }
    tbl.querySelectorAll("tbody tr").forEach(function(tr){
      if(tr.querySelector(".cc-rowcb")) return;
      var id = tr.getAttribute("data-id")||tr.getAttribute("data-rid");
      if(!id) return;
      var td = document.createElement("td");
      td.className = "cc-cbcell";
      td.innerHTML = '<input type="checkbox" class="cc-rowcb" data-tid="'+xesc(id)+'" onchange="event.stopPropagation();ccToggleSel(this.getAttribute(\'data-tid\'),this)"/>';
      tr.insertBefore(td, tr.firstChild);
    });
  }

  /* ---------- Today panel ---------- */
  function ccTodayPanel(){
    var todayStr = (typeof TODAY!=="undefined") ? TODAY : new Date().toISOString().slice(0,10);
    var tasksToday = (S.tasks||[]).filter(function(t){return t.status!=="Completed" && t.due<=todayStr});
    var mine = (S.issues||[]).filter(function(t){return t.status!=="Closed" && t.status!=="Resolved" && t.assignee===OM_HEAD});
    var breaches = (S.issues||[]).filter(function(t){return typeof slaState==="function" && slaState(t)==="breach"});
    var chronicSet = {};
    (S.issues||[]).forEach(function(t){ if(ccIsChronic(t)) chronicSet[[t.plant,t.vertical,t.sub||""].join("|")] = 1; });
    var items = [
      {label:"Tasks due today or overdue", n:tasksToday.length, act:"goTab('scheduled')"},
      {label:"PM units scheduled today", n:(S.tasks||[]).filter(function(t){return t.unitNo && t.status!=="Completed" && t.due===todayStr}).length, act:"goTab('scheduled')"},
      {label:"My open tickets", n:mine.length, act:"S.issF=blankIssF({assignee:'"+OM_HEAD+"'});S.tablePages.issues=1;goTab('issues')"},
      {label:"Breached tickets", n:breaches.length, act:"ccGotoBreaches()"},
      {label:"Chronic issues", n:Object.keys(chronicSet).length, act:"goTab('issues')"}
    ];
    if(!items.some(function(x){return x.n>0})) return "";
    return '<div class="cc-today">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">'+
        '<div><h3>☀️ Today · '+xesc(todayStr)+'</h3>'+
        '<div style="font-size:12.5px;color:rgba(255,255,255,.72);margin-top:2px">Your attention list — click to jump straight to it</div></div>'+
        '<span style="background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.22);color:#fff;font-size:12.5px;font-weight:700;padding:5px 11px;border-radius:999px">LIVE</span>'+
      '</div>'+
      '<div class="cc-tgrid">'+
        items.map(function(it){
          return '<div class="cc-titem" onclick="'+it.act+'"><b>'+xesc(it.label)+'</b><div class="n">'+it.n+'</div></div>';
        }).join("")+
      '</div></div>';
  }

  /* ---------- quick ticket templates ---------- */
  var CC_TEMPLATES = [
    {label:"Inverter fault", vert:"Inverter", sub:"Fault code", sev:"Critical", desc:"Inverter stopped with fault code."},
    {label:"Module hotspot", vert:"Module", sub:"Hotspot", sev:"Critical", desc:"Thermal hotspot detected during IR scan."},
    {label:"Transformer oil leak", vert:"Transformer", sub:"Oil leak",                   sev:"Critical", desc:"Oil seepage observed at transformer base."},
    {label:"String underperform",  vert:"String",      sub:"String underperformance",    sev:"Medium",   desc:"String generating below expected output."},
    {label:"Comms loss (RMS)",     vert:"RMS",         sub:"Communication loss",         sev:"Medium",   desc:"RMS stopped reporting / data gap."},
    {label:"Fence breach", vert:"Boundary wall", sub:"Fence breach", sev:"Critical", desc:"Boundary fence breached / cut."}
  ];
  window.ccApplyTemplate = function(vert, sub, sev, desc){
    var v = document.getElementById("tk-vert");
    if(v){ v.value = vert; if(typeof updSub==="function") updSub(); }
    setTimeout(function(){
      var s = document.getElementById("tk-sub"); if(s && sub) s.value = sub;
      var sv = document.getElementById("tk-sev"); if(sv && sev){ sv.value = sev; if(typeof updEtc==="function") updEtc(); }
      var d = document.getElementById("tk-desc"); if(d && desc) d.value = desc;
    },30);
  };
  function ccInjectTemplates(){
    if(S.modal!=="newTicket") return;
    var step2 = document.querySelector('.wiz-ticket[data-step="2"]');
    if(!step2 || step2.querySelector(".cc-quicktmpl")) return;
    var div = document.createElement("div");
    div.className = "cc-quicktmpl";
    div.innerHTML = '<span style="font-size:12.5px;color:var(--muted-foreground);width:100%;font-weight:600;margin-bottom:2px">Quick templates — 1 click fills category, severity &amp; description</span>'+
      CC_TEMPLATES.map(function(t){
        return '<button type="button" onclick="ccApplyTemplate(\''+xesc(t.vert)+'\',\''+xesc(t.sub)+'\',\''+xesc(t.sev)+'\',\''+xesc(t.desc)+'\')">'+xesc(t.label)+'</button>';
      }).join("");
    step2.appendChild(div);
  }

  /* ---------- evidence panel in ticket drawer ---------- */
  function ccInjectEvidencePanel(){
    if(S.modal!=="ticket") return;
    var body = document.querySelector(".modal .modal-b");
    if(!body || body.querySelector(".cc-evidence-panel")) return;
    var id = S.modalCtx&&S.modalCtx.id;
    var t = (S.issues||[]).find(function(x){return x.id===id});
    if(!t) return;
    var ev = t.evidence||[];
    var panel = document.createElement("div");
    panel.className = "cc-evidence-panel";
    panel.style.cssText = "border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:14px;background:var(--surface-subtle)";
    panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">'+
        '<div><div style="font-size:13px;font-weight:700">📎 Evidence ('+ev.length+')</div>'+
        '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:2px">Real photos with metadata — replaces WhatsApp</div></div>'+
        '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
          '<button class="btn p sm" onclick="event.stopPropagation();ccAddPhotoQuick(\''+xesc(t.id)+'\',\'before\')">📷 Before</button>'+
          '<button class="btn o sm" onclick="event.stopPropagation();ccAddPhotoQuick(\''+xesc(t.id)+'\',\'after\')">📷 After fix</button>'+
          '<button class="btn o sm" onclick="event.stopPropagation();ccAddPhotoQuick(\''+xesc(t.id)+'\',\'reading\')">📊 Reading</button>'+
        '</div></div>'+
      (ev.length ?
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px">'+
          ev.map(function(e){
            return '<img src="'+e.url+'" style="width:100%;border-radius:8px;border:1px solid var(--border);cursor:pointer;aspect-ratio:4/3;object-fit:cover" onclick="ccOpenLightbox(\''+xesc(t.id)+'\',\''+xesc(e.id)+'\')" title="'+xesc(e.kind)+' · '+xesc(e.at)+' · '+xesc(e.by)+'"/>';
          }).join("")+
        '</div>'
      : '<div style="font-size:12px;color:var(--muted-foreground);text-align:center;padding:14px 0">No photos attached yet. Photos are how disputes get settled.</div>');
    body.appendChild(panel);
  }

  /* ---------- wrap render() ---------- */
  var origRender = render;
  render = function(){
    origRender.apply(this, arguments);
    try{ ccAfterRender(); }catch(err){ console.warn("[SMART] post-render", err); }
  };

  function ccAfterRender(){
    if(S.view!=="settings" && S.view!=="data"){
      var content = document.querySelector(".content > div");
      if(content){
        var old = content.querySelector(".cc-breach-bar");
        if(old) old.remove();
        var banner = ccBreachBanner();
        if(banner){
          var first = content.firstElementChild;
          if(first) first.insertAdjacentHTML("afterend", banner);
          else content.insertAdjacentHTML("afterbegin", banner);
        }
      }
    }
    if(S.view==="om-module" && S.omTab==="issues"){
      var c2 = document.querySelector(".content > div");
      if(c2 && !c2.querySelector(".cc-views-strip")){
        var reg = document.getElementById("section-results");
        if(reg) reg.insertAdjacentHTML("beforebegin", ccViewsStrip());
      }
    }
    if(S.view==="dashboard"){
      var c3 = document.querySelector(".content > div");
      if(c3 && !c3.querySelector(".cc-today")){
        var hero = c3.querySelector(".cc-hero");
        if(hero) hero.insertAdjacentHTML("afterend", ccTodayPanel());
      }
    }
    if((S.view==="om-module" && S.omTab==="issues") || S.view==="dashboard"){
      ccEnrichAll();
      if(S.view==="om-module" && S.omTab==="issues") ccInjectCheckboxes();
    }
    if(S.modal==="newTicket") ccInjectTemplates();
    if(S.modal==="ticket") ccInjectEvidencePanel();
  }

  /* ---------- Ctrl/Cmd + K ---------- */
  document.addEventListener("keydown", function(e){
    if((e.ctrlKey||e.metaKey) && (e.key==="k"||e.key==="K")){
      var tag = (e.target.tagName||"").toLowerCase();
      if(tag==="input"||tag==="textarea") return;
      e.preventDefault();
      var tb = document.querySelector(".topbar input.inp");
      if(tb){ tb.focus(); tb.select(); }
    }
  });

  console.log("[SMART PORTAL] v1 loaded · Ctrl+K · breach banner · live SLA · proof · saved views · batch · Today");
})();

