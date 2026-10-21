"use strict";
/* ================================================================
   OPS WORKFLOW — v3 · RING BELL
   · Remove "Regional O&M Head"
   · Full-screen ringing overlay on any screen, any role
   · Sound (Web Audio) + Vibration + Pulsing bell
   · Rural-first: big text, big buttons, high contrast
   Load AFTER OPS WORKFLOW v2.
   ================================================================ */
(function(){
  if(window._ccOpsRing) return;
  window._ccOpsRing = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
  function getUser(){return S.currentUser || (typeof OM_HEAD!=="undefined"?OM_HEAD:"Arun Agarwal")}
  function getRole(){return S.currentRole || "O&M Head"}
  function isClient(){return /^Client/.test(getRole())}
  function isVendor(){return /^Vendor/.test(getRole())}
  function canRing(){return !isClient() && !isVendor()}

  /* ---- 1 · strip Regional O&M Head from the role list ---- */
  var ROLES_OLD = ["O&M Head","Regional O&M Head","Site Engineer","Technician","Client / Asset Owner","Vendor (limited)"];
  var ROLES_NEW = ["O&M Head","Site Engineer","Technician","Client / Asset Owner","Vendor (limited)"];
  /* patch the topbar dropdown in place next render */
  function cleanRoleOptions(){
    var sel = document.getElementById("cc-role-switch");
    if(!sel) return;
    var cur = sel.value;
    if(sel.getAttribute("data-cc-clean") === "1") return;
    sel.setAttribute("data-cc-clean","1");
    sel.innerHTML = ROLES_NEW.map(function(r){
      return '<option value="'+xesc(r)+'"'+(r===cur?' selected':'')+'>'+xesc(r)+'</option>';
    }).join("");
    /* if the current role was Regional, snap to O&M Head */
    if(cur === "Regional O&M Head"){
      S.currentRole = "O&M Head";
      try{ saveK("currentRole", S.currentRole); }catch(e){}
    }
  }

  /* ---- 2 · sound engine (Web Audio, no external file) ---- */
  var _audioUnlocked = false;
  function unlockAudio(){
    if(_audioUnlocked) return;
    try{
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if(!Ctx) return;
      var ctx = new Ctx();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      g.gain.value = 0.0001;
      o.start();
      o.stop(ctx.currentTime + 0.02);
      _audioUnlocked = true;
      if(ctx.state === "suspended") ctx.resume();
    }catch(e){}
  }
  document.addEventListener("click", unlockAudio, {once:true, capture:true});
  document.addEventListener("touchstart", unlockAudio, {once:true, capture:true});
  document.addEventListener("keydown", unlockAudio, {once:true, capture:true});

  function beep(times){
    var n = times || 2;
    try{
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if(!Ctx) return;
      var ctx = new Ctx();
      if(ctx.state === "suspended") ctx.resume();
      for(var i=0;i<n;i++){
        var start = ctx.currentTime + i*0.35;
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(880, start);
        o.frequency.linearRampToValueAtTime(1320, start+0.10);
        o.frequency.linearRampToValueAtTime(880, start+0.20);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.35, start+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start+0.28);
        o.connect(g); g.connect(ctx.destination);
        o.start(start); o.stop(start+0.30);
      }
    }catch(e){}
  }

  function vibrate(){
    try{ if(navigator.vibrate) navigator.vibrate([220,110,220,110,220]); }catch(e){}
  }

  /* ---- 3 · pending rings for the current user ---- */
  var _lastBeepAt = 0;
  var _ringOpenFor = null;

  function pendingRings(){
    if(!canRing()) return [];
    var me = getUser();
    return (S.issues||[]).filter(function(t){
      if(!t) return false;
      if(t.status === "Closed" || t.status === "Resolved") return false;
      if(!t.updateRequestedAt) return false;
      var targets = (t.updateRequestedFrom || []).concat(t.assignee ? [t.assignee] : []);
      if(targets.indexOf(me) < 0) return false;
      var seen = Array.isArray(t.seenBy) ? t.seenBy.indexOf(me) >= 0 : false;
      if(seen) return false;
      return true;
    }).sort(function(a,b){
      return String(a.updateRequestedAt).localeCompare(String(b.updateRequestedAt));
    });
  }
  window.ccPendingRings = pendingRings;

  /* ---- 4 · ring overlay (full-screen, rural-first) ---- */
  function ensureOverlay(){
    var el = document.getElementById("cc-ring-ovl");
    if(el) return el;
    el = document.createElement("div");
    el.id = "cc-ring-ovl";
    el.className = "cc-ring-ovl";
    document.body.appendChild(el);
    return el;
  }

  function closeOverlay(){
    var el = document.getElementById("cc-ring-ovl");
    if(el) el.remove();
    _ringOpenFor = null;
  }
  window.ccCloseRing = closeOverlay;

  window.ccRingSeen = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id === ticketId});
    if(t && typeof ccMarkSeen === "function"){
      ccMarkSeen(ticketId);
    }
    closeOverlay();
  };

  window.ccRingOpen = function(ticketId){
    closeOverlay();
    try{
      if(typeof openIssue === "function") openIssue(ticketId);
    }catch(e){}
  };

  window.ccRingDismiss = function(){
    /* snooze for 15 min — ring auto-returns */
    S._ccRingSnoozeUntil = Date.now() + 15*60*1000;
    closeOverlay();
    if(typeof toast === "function") toast("Snoozed for 15 min — the bell will return.");
  };

  function showOverlay(t){
    if(_ringOpenFor === t.id && document.getElementById("cc-ring-ovl")) return;
    _ringOpenFor = t.id;
    var ov = ensureOverlay();
    var me = getUser();
    var targetLabel = t.assignee === me ? "You own this ticket" : "You were asked directly";
    var msg = "";
    var lastNote = (t.progress||[]).find(function(p){return p.kind === "update_request"});
    if(lastNote && lastNote.note){
      var m = lastNote.note.split(" — ");
      msg = m.length > 1 ? m.slice(1).join(" — ") : "";
    }
    var plant = (typeof plantRec === "function" ? plantRec(t.plant) : null);
    var proj = (plant && typeof plantProject === "function") ? plantProject(plant) : "";
    var since = t.updateRequestedAt;
    var sevColor = { Critical:"#b91c1c", Medium:"#0369a1", Solved:"#15803d" }[issueLevel(t)] || "#374151";

    ov.innerHTML =
      '<div class="cc-ring-card">'+
        '<div class="cc-ring-bell">🔔</div>'+
        '<div class="cc-ring-title">UPDATE REQUESTED</div>'+
        '<div class="cc-ring-sub">'+xesc(targetLabel)+'</div>'+
        '<div class="cc-ring-ticket">'+xesc(t.id)+'</div>'+
        '<div class="cc-ring-meta">'+
          '<div class="cc-ring-row"><span>Plant</span><b>'+xesc(t.plant||"—")+'</b></div>'+
          (proj?'<div class="cc-ring-row"><span>Project</span><b>'+xesc(proj)+'</b></div>':'')+
          '<div class="cc-ring-row"><span>Equipment</span><b>'+xesc(t.equip||"—")+'</b></div>'+
          '<div class="cc-ring-row"><span>Priority</span><b style="color:'+sevColor+'">'+xesc(issueLevel(t))+'</b></div>'+
          '<div class="cc-ring-row"><span>Asked by</span><b>'+xesc(t.updateRequestedBy||"—")+'</b></div>'+
        '</div>'+
        (msg ? '<div class="cc-ring-msg">"'+xesc(msg)+'"</div>' : '')+
        '<div class="cc-ring-actions">'+
          '<button class="cc-ring-btn primary" onclick="ccRingSeen(\''+xesc(t.id)+'\')">'+
            '<span class="cc-ring-ico">👀</span>'+
            '<span><b>SEEN — I\'M ON IT</b><small>Acknowledge the request</small></span>'+
          '</button>'+
          '<button class="cc-ring-btn" onclick="ccRingOpen(\''+xesc(t.id)+'\')">'+
            '<span class="cc-ring-ico">📋</span>'+
            '<span><b>OPEN TICKET</b><small>See details &amp; history</small></span>'+
          '</button>'+
        '</div>'+
        '<button class="cc-ring-snooze" onclick="ccRingDismiss()">Snooze 15 min</button>'+
      '</div>';
  }

  /* ---- 5 · ring loop — checks every 4s ---- */
  function tickRing(){
    if(document.hidden) return;
    try{
      if(!canRing()){ closeOverlay(); return; }
      if(Date.now() < (S._ccRingSnoozeUntil||0)) return;

      var list = pendingRings();
      if(!list.length){ closeOverlay(); return; }

      /* suppress if user is already viewing that exact ticket */
      var opening = list[0];
      if(S.modal === "ticket" && S.modalCtx && S.modalCtx.id === opening.id){
        /* mark as seen silently so it doesn't nag while they read */
        if(typeof ccMarkSeen === "function") ccMarkSeen(opening.id);
        closeOverlay();
        return;
      }

      showOverlay(opening);

      /* beep + vibrate every ~20s while it's up */
      var now = Date.now();
      if(now - _lastBeepAt > 20000){
        _lastBeepAt = now;
        beep(2);
        vibrate();
      }
    }catch(e){ console.warn("[RING]", e); }
  }

  setInterval(tickRing, 4000);
  /* first check a moment after boot */
  setTimeout(tickRing, 1500);

  /* clear snooze when a new request arrives */
  var _seenIds = {};
  setInterval(function(){
    if(document.hidden) return;
    var list = pendingRings();
    list.forEach(function(t){
      var k = t.id + ":" + t.updateRequestedAt;
      if(!_seenIds[k]){ _seenIds[k] = 1; S._ccRingSnoozeUntil = 0; }
    });
  }, 5000);

  /* ---- 6 · topbar bell indicator for pending rings ---- */
  function injectRingBell(){
    var topbar = document.querySelector(".topbar");
    if(!topbar) return;
    if(topbar.querySelector("#cc-ring-bell")) return;
    var existing = topbar.querySelector(".icon-btn"); /* the app's own bell */
    if(!existing) return;

    var holder = document.createElement("button");
    holder.id = "cc-ring-bell";
    holder.className = "icon-btn cc-ring-bell";
    holder.type = "button";
    holder.title = "Pending update requests";
    holder.onclick = function(){ S._ccRingSnoozeUntil = 0; tickRing(); };
    holder.innerHTML = '🔔<span class="cc-ring-count" id="cc-ring-count" style="display:none">0</span>';
    /* insert before the app's own bell */
    existing.parentNode.insertBefore(holder, existing);
  }
  function updateRingBell(){
    var btn = document.getElementById("cc-ring-bell");
    if(!btn) return;
    var n = pendingRings().length;
    var count = document.getElementById("cc-ring-count");
    if(!count) return;
    if(n > 0){
      count.style.display = "grid";
      count.textContent = Math.min(n, 9);
      btn.classList.add("ringing");
    } else {
      count.style.display = "none";
      btn.classList.remove("ringing");
    }
  }

  /* ---- 7 · styles ---- */
  var style = document.createElement("style");
  style.textContent = [
    /* topbar bell */
    '.cc-ring-bell{position:relative;font-size:18px;line-height:1}',
    '.cc-ring-bell.ringing{background:var(--danger-soft)!important;color:var(--danger)!important}',
    '.cc-ring-bell.ringing::after{content:"";position:absolute;inset:-2px;border-radius:inherit;border:2px solid var(--danger);animation:ccRingPulse 1.4s ease-out infinite;pointer-events:none}',
    '.cc-ring-count{position:absolute;top:0;right:0;min-width:15px;height:15px;border-radius:999px;background:var(--danger);color:#fff;font-size:11px;font-weight:800;place-items:center;padding:0 3px}',
    '@keyframes ccRingPulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.6);opacity:0}}',

    /* full-screen ring overlay */
    '.cc-ring-ovl{position:fixed;inset:0;z-index:9000;background:rgba(8,12,10,.92);display:flex;align-items:center;justify-content:center;padding:18px;animation:ccRingFade .25s ease}',
    '@keyframes ccRingFade{from{opacity:0}to{opacity:1}}',
    '.cc-ring-card{background:#fff;border-radius:24px;max-width:520px;width:100%;max-height:96vh;overflow-y:auto;padding:28px 22px 22px;box-shadow:0 30px 80px rgba(0,0,0,.55);text-align:center;position:relative}',
    '.cc-ring-bell{font-size:76px;line-height:1;display:inline-block;animation:ccBellShake 1.2s ease-in-out infinite;transform-origin:50% 10%}',
    '@keyframes ccBellShake{0%,60%,100%{transform:rotate(0)}10%,30%,50%{transform:rotate(14deg)}20%,40%{transform:rotate(-14deg)}}',
    '.cc-ring-title{font-size:15px;font-weight:800;letter-spacing:.14em;color:var(--danger);margin-top:6px}',
    '.cc-ring-sub{font-size:12.5px;color:var(--muted-foreground);margin-top:4px}',
    '.cc-ring-ticket{font-size:30px;font-weight:900;letter-spacing:-.02em;margin-top:14px;color:var(--foreground);word-break:break-all}',
    '.cc-ring-meta{margin:14px auto 0;max-width:400px;text-align:left;background:var(--surface-subtle);border:1px solid var(--border);border-radius:14px;padding:12px 14px}',
    '.cc-ring-row{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:6px 0;border-bottom:1px dashed var(--border)}',
    '.cc-ring-row:last-child{border-bottom:0}',
    '.cc-ring-row span{color:var(--muted-foreground);font-weight:600}',
    '.cc-ring-row b{font-weight:700;text-align:right}',
    '.cc-ring-msg{margin:14px auto 0;max-width:400px;font-size:15px;font-style:italic;color:var(--foreground);background:#fef3c7;border:1px solid #fcd34d;border-radius:12px;padding:12px 14px;line-height:1.5}',
    '.cc-ring-actions{display:flex;flex-direction:column;gap:10px;margin-top:18px}',

    '.cc-ring-btn{display:flex;align-items:center;gap:14px;width:100%;padding:16px 18px;border-radius:16px;border:2px solid var(--border);background:#fff;font-family:inherit;font-size:15px;font-weight:700;text-align:left;cursor:pointer;transition:transform .1s,box-shadow .15s}',
    '.cc-ring-btn:active{transform:scale(.98)}',
    '.cc-ring-btn .cc-ring-ico{font-size:28px;flex-shrink:0}',
    '.cc-ring-btn b{display:block;font-size:15px;font-weight:800;letter-spacing:.02em}',
    '.cc-ring-btn small{display:block;font-size:12.5px;font-weight:500;color:var(--muted-foreground);margin-top:2px}',
    '.cc-ring-btn.primary{background:linear-gradient(135deg,#16A34A,#15803d);border-color:#15803d;color:#fff}',
    '.cc-ring-btn.primary small{color:rgba(255,255,255,.82)}',
    '.cc-ring-btn.primary:hover{box-shadow:0 10px 24px rgba(22,163,74,.35)}',
    '.cc-ring-btn:hover{border-color:var(--primary)}',
    '.cc-ring-snooze{background:none;border:0;color:var(--muted-foreground);font-size:12.5px;font-weight:600;cursor:pointer;margin-top:14px;font-family:inherit;text-decoration:underline}',

    /* small screens — bigger still */
    '@media(max-width:560px){'+
      '.cc-ring-card{padding:22px 16px 18px;border-radius:20px}'+
      '.cc-ring-bell{font-size:64px}'+
      '.cc-ring-ticket{font-size:26px}'+
      '.cc-ring-btn{padding:18px 16px}'+
      '.cc-ring-btn b{font-size:16px}'+
      '.cc-ring-row{font-size:13.5px}'+
    '}'
  ].join("");
  document.head.appendChild(style);

  /* ---- 8 · render hook (after v1 + v2) ---- */
  var origRender = render;
  render = function(){
    origRender.apply(this, arguments);
    try{
      cleanRoleOptions();
      injectRingBell();
      updateRingBell();
    }catch(e){ console.warn("[OPS WORKFLOW v3]", e); }
  };

  console.log("[OPS WORKFLOW v3] loaded · ring bell · sound · vibration · Regional removed");
})();
