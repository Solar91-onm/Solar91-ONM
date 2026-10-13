"use strict";
/* ================================================================
   UI POLISH v1 — topbar, search, bells, notifications, filters
   Load LAST, right before init();
   ================================================================ */
(function(){
  if(window._ccUiPolish) return;
  window._ccUiPolish = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

  /* ----------------------------------------------------------------
     0 · UN-BREAK THE FILTER PANELS
     A legacy dashboard observer may remove `.filter-panel` elements.
     Both the dashboard and Site Issues rely on those filters, so keep
     filter panels inside .content visible.
     ---------------------------------------------------------------- */
  (function(){
    if(window._ccProtectFilters) return;
    window._ccProtectFilters = true;
    var origRemove = Element.prototype.remove;
    Element.prototype.remove = function(){
      try{
        if(this && this.nodeType === 1 &&
           this.classList && this.classList.contains("filter-panel") &&
           this.parentNode && this.parentNode.closest &&
           this.parentNode.closest(".content")){
          return; /* keep it */
        }
      }catch(e){}
      return origRemove.apply(this, arguments);
    };
  })();

  /* ----------------------------------------------------------------
     1 · CSS overrides
     ---------------------------------------------------------------- */
  var style = document.createElement("style");
  style.textContent = [
    /* ---- TOPBAR: taller, roomier, cleaner rhythm ---- */
    ".topbar{height:auto!important;min-height:72px!important;gap:12px!important;padding:8px 18px!important}",
    ".topbar > div:first-child{min-width:140px}",

    /* ---- SEARCH BAR: wider, prominent, unmissable ---- */
    ".topbar > div:nth-child(2){max-width:560px!important;flex:1 1 420px!important}",
    ".topbar > div:nth-child(2) > span:first-child{top:50%!important;transform:translateY(-50%)!important;left:13px!important;color:#4b5b52!important}",
    ".topbar > div:nth-child(2) > span:first-child svg{width:17px;height:17px}",
    ".topbar > div:nth-child(2) .inp{"+
      "height:42px!important;"+
      "font-size:13.5px!important;"+
      "border-radius:11px!important;"+
      "background:#ffffff!important;"+
      "border:1px solid #d8e0db!important;"+
      "padding-left:38px!important;"+
      "box-shadow:0 1px 2px rgba(16,24,20,.03) inset"+
    "}",
    ".topbar > div:nth-child(2) .inp::placeholder{color:#86948d}",
    ".topbar > div:nth-child(2) .inp:focus{"+
      "border-color:var(--primary)!important;"+
      "box-shadow:0 0 0 3px rgba(22,163,74,.13)!important;"+
      "background:#fff!important"+
    "}",

    /* ---- RIGHT CLUSTER: even spacing, aligned heights ---- */
    ".topbar > div:last-child{gap:10px!important}",
    ".topbar select.inp, .topbar input[type=date]{height:40px!important;font-size:12.5px!important;border-radius:10px!important;background:#fff!important;border:1px solid #d8e0db!important}",
    ".topbar select.inp:focus, .topbar input[type=date]:focus{border-color:var(--primary)!important;box-shadow:0 0 0 3px rgba(22,163,74,.13)!important}",

    /* role switcher — same height as everything else, muted */
    "#cc-role-switch{"+
      "height:40px!important;"+
      "font-size:12.5px!important;"+
      "font-weight:600!important;"+
      "padding:0 12px!important;"+
      "border-radius:10px!important;"+
      "background:#f2f5f3!important;"+
      "border:1px solid #d8e0db!important;"+
      "color:var(--foreground)"+
    "}",
    "#cc-role-switch:focus{border-color:var(--primary)!important;box-shadow:0 0 0 3px rgba(22,163,74,.13)!important}",

    /* live pill — subtle but correct height */
    ".topbar .live-pill{height:32px;padding:0 12px!important;display:inline-flex!important;align-items:center!important;font-size:11px!important}",

    /* ---- ICON BUTTONS (both bells, gear) ---- */
    ".topbar .icon-btn,"+
    ".topbar #cc-ring-bell{"+
      "width:42px!important;height:42px!important;"+
      "border-radius:11px!important;"+
      "display:grid!important;place-items:center!important;"+
      "padding:0!important;"+
      "background:transparent;"+
      "border:1px solid transparent;"+
      "color:#5c6b63;"+
      "cursor:pointer;"+
      "transition:background .15s,color .15s,border-color .15s;"+
      "position:relative"+
    "}",
    ".topbar .icon-btn:hover,"+
    ".topbar #cc-ring-bell:hover{"+
      "background:#f2f5f3!important;"+
      "color:var(--foreground)!important;"+
      "border-color:#d8e0db!important"+
    "}",

    /* RING BELL — amber when ringing (overrides v3's red) */
    "#cc-ring-bell.ringing{"+
      "background:linear-gradient(135deg,#fef3c7,#fde68a)!important;"+
      "color:#92400e!important;"+
      "border-color:#fcd34d!important"+
    "}",
    "#cc-ring-bell.ringing:hover{"+
      "background:linear-gradient(135deg,#fde68a,#fcd34d)!important"+
    "}",
    "#cc-ring-bell.ringing::after{"+
      "content:'';"+
      "position:absolute;inset:-3px;border-radius:14px;"+
      "border:2px solid #f59e0b;"+
      "animation:ccUiRingPulse 1.6s ease-out infinite;"+
      "pointer-events:none"+
    "}",
    "@keyframes ccUiRingPulse{"+
      "0%{transform:scale(1);opacity:.85}"+
      "100%{transform:scale(1.35);opacity:0}"+
    "}",
    "#cc-ring-bell.ringing svg{animation:ccUiBellShake 1.6s ease-in-out infinite;transform-origin:50% 10%}",
    "@keyframes ccUiBellShake{"+
      "0%,60%,100%{transform:rotate(0)}"+
      "10%,30%,50%{transform:rotate(14deg)}"+
      "20%,40%{transform:rotate(-14deg)}"+
    "}",

    /* COUNTS — matched treatment for both bells */
    ".topbar .bell-count,"+
    ".topbar .cc-ring-count{"+
      "position:absolute!important;"+
      "top:0!important;right:0!important;"+
      "min-width:18px!important;height:18px!important;"+
      "border-radius:999px!important;"+
      "background:var(--danger)!important;"+
      "color:#fff!important;"+
      "font-size:10px!important;font-weight:800!important;"+
      "display:grid;place-items:center;"+
      "padding:0 5px!important;"+
      "border:2px solid #fff!important;"+
      "box-shadow:0 3px 8px rgba(220,76,62,.35)!important;"+
      "line-height:1"+
    "}",

    /* ---- NOTIFICATION POPUP ---- */
    ".notif-pop{"+
      "width:min(440px,calc(100vw - 32px))!important;"+
      "right:0!important;top:52px!important;"+
      "border-radius:14px!important;"+
      "border:1px solid #dfe5e1!important;"+
      "box-shadow:0 28px 70px rgba(11,20,15,.22),0 6px 16px rgba(11,20,15,.08)!important;"+
      "animation:ccUiDrop .18s ease;overflow:hidden"+
    "}",
    "@keyframes ccUiDrop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}",
    /* header */
    ".notif-pop > div:first-child{"+
      "padding:14px 18px!important;"+
      "font-size:13.5px!important;font-weight:700!important;"+
      "background:linear-gradient(180deg,#f8fbf9 0%,#fff 100%)!important;"+
      "border-bottom:1px solid #eef2ef!important;"+
      "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"+
    "}",
    ".notif-pop > div:first-child .btn{margin:0!important;float:none!important}",
    /* rows */
    ".notif-pop > div:nth-child(2) > div{"+
      "padding:12px 18px!important;"+
      "transition:background .12s"+
    "}",
    ".notif-pop > div:nth-child(2) > div:hover{background:#f8fbf9}",

    /* ---- BREACH BAR — sits just below topbar, cleaner ---- */
    ".cc-breach-bar{"+
      "top:8px!important;"+
      "border-radius:12px!important;"+
      "padding:11px 16px!important;"+
      "font-size:12.5px!important;"+
      "box-shadow:0 12px 28px rgba(185,28,28,.28)!important;"+
      "border:1px solid #b91c1c!important;"+
      "gap:12px!important"+
    "}",
    ".cc-breach-bar .btn.o.sm{background:rgba(255,255,255,.18)!important;border-color:rgba(255,255,255,.4)!important;color:#fff!important;font-weight:700!important}",

    /* ---- YELLOW WORKFLOW FLAG ---- */
    ".cc-wf-flag{"+
      "display:inline-flex!important;align-items:center;gap:5px!important;"+
      "font-size:10.5px!important;font-weight:700!important;"+
      "padding:3px 9px!important;border-radius:999px!important;"+
      "background:linear-gradient(135deg,#fef3c7,#fde68a)!important;"+
      "color:#7c2d12!important;"+
      "border:1px solid #fcd34d!important;"+
      "white-space:nowrap;line-height:1.25"+
    "}",
    ".cc-wf-flag.seen{"+
      "background:linear-gradient(135deg,#eaf2fe,#dbeafe)!important;"+
      "color:#1e40af!important;"+
      "border-color:#bfdbfe!important"+
    "}",
    ".modal .cc-wf-flag{margin-right:6px}",

    /* ---- FILTER PANELS: always visible, clean, prominent ---- */
    ".filter-panel{"+
      "border-top:3px solid var(--primary)!important;"+
      "background:linear-gradient(180deg,#f8fbf9 0%,#ffffff 68px)!important;"+
      "padding:16px 18px!important"+
    "}",
    ".filter-panel .field .lbl{"+
      "color:#4b5b52!important;"+
      "font-weight:700!important;"+
      "font-size:11px!important;"+
      "text-transform:uppercase;"+
      "letter-spacing:.04em"+
    "}",
    ".filter-panel select.inp,"+
    ".filter-panel input.inp{"+
      "background:#fff!important;"+
      "border-color:#d8e0db!important"+
    "}",
    ".filter-panel .row.wrap .btn.o.sm{margin-bottom:2px}",

    /* generic filter rows in pages (Scheduled, Washing, Performance…) */
    ".content .panel .row.wrap .field .lbl{"+
      "color:#4b5b52;"+
      "font-weight:700;"+
      "font-size:11px;"+
      "text-transform:uppercase;"+
      "letter-spacing:.04em"+
    "}",
    ".content .panel .row.wrap .field select.inp,"+
    ".content .panel .row.wrap .field input.inp{"+
      "height:38px;background:#fff;border-color:#d8e0db"+
    "}",

    /* search-results dropdown attached to topbar search */
    ".search-results{"+
      "top:50px!important;"+
      "border-radius:14px!important;"+
      "border-color:#dfe5e1!important;"+
      "box-shadow:0 28px 60px rgba(11,20,15,.20)!important"+
    "}",
    ".search-result{padding:11px 16px!important}",
    ".search-result b{font-size:12.5px!important}",
    ".search-result span{font-size:11px!important}",

    /* avatar block a touch cleaner */
    ".topbar .tb-av{width:38px!important;height:38px!important;font-size:12px!important}",

    /* ---- MOBILE ---- */
    "@media(max-width:900px){"+
      ".topbar{height:auto!important;min-height:64px!important;gap:8px!important;padding:8px 10px!important}"+
      ".topbar > div:nth-child(2){max-width:none!important;flex:1 1 auto!important}"+
      ".topbar > div:nth-child(2) .inp{height:38px!important;font-size:13px!important}"+
      ".topbar .icon-btn,.topbar #cc-ring-bell{width:38px!important;height:38px!important}"+
      ".cc-breach-bar{top:var(--tb-h,64px)!important}"+
    "}"
  ].join("");
  document.head.appendChild(style);

  /* ----------------------------------------------------------------
     2 · Ring bell — replace the emoji with a proper SVG, keep count
     ---------------------------------------------------------------- */
  function polishRingBell(){
    var bell = document.getElementById("cc-ring-bell");
    if(!bell || bell.getAttribute("data-cc-polished") === "1") return;
    bell.setAttribute("data-cc-polished","1");

    /* preserve the existing count element + its state */
    var oldCount = bell.querySelector(".cc-ring-count");
    var countShown = oldCount && oldCount.style && oldCount.style.display !== "none";
    var countNum = oldCount ? (oldCount.textContent || "0") : "0";

    bell.innerHTML =
      '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
        '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>'+
        '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'+
        '<path d="M19.5 3.5c1.2 1.4 1.9 3.1 1.9 4.9"/>'+
        '<path d="M4.5 3.5C3.3 4.9 2.6 6.6 2.6 8.4"/>'+
      '</svg>'+
      '<span class="cc-ring-count" id="cc-ring-count" style="display:'+(countShown?'grid':'none')+'">'+xesc(countNum)+'</span>';
  }

  /* ----------------------------------------------------------------
     3 · Topbar layout: re-order right cluster + widen search
     ---------------------------------------------------------------- */
  function findCluster(topbar){
    var kids = topbar.children;
    for(var i=0;i<kids.length;i++){
      var ch = kids[i];
      if(ch.tagName==="DIV" && (ch.getAttribute("style")||"").indexOf("margin-left:auto") >= 0){
        return ch;
      }
    }
    return null;
  }

  function polishTopbar(){
    var topbar = document.querySelector(".topbar");
    if(!topbar) return;
    var cluster = findCluster(topbar);
    if(!cluster) return;

    var scopeSel = cluster.querySelector('select.inp[onchange*="setPlantScope"]');
    var dateInp  = cluster.querySelector('input[type="date"]');
    var livePill = cluster.querySelector(".live-pill");

    /* role switcher wrapper — the div that directly contains #cc-role-switch */
    var roleSel  = document.getElementById("cc-role-switch");
    var roleWrap = roleSel ? roleSel.parentNode : null;

    /* app's own bell wrapper — a div containing an .icon-btn with the bell svg */
    var appBellWrap = null;
    var wrappers = cluster.querySelectorAll(":scope > div");
    for(var i=0;i<wrappers.length;i++){
      var w = wrappers[i];
      if(w.querySelector("button.icon-btn") && /M6 8a6 6 0 0 1 12 0/.test(w.innerHTML)){
        appBellWrap = w; break;
      }
    }

    var ringBell = document.getElementById("cc-ring-bell");

    var gearBtn = null;
    var allBtn = cluster.querySelectorAll("button.icon-btn");
    for(var j=0;j<allBtn.length;j++){
      if((allBtn[j].getAttribute("title")||"").indexOf("Reset") >= 0){ gearBtn = allBtn[j]; break; }
    }

    var avatarRow = cluster.querySelector(".tb-av") ? cluster.querySelector(".tb-av").closest(".row") : null;

    /* desired left→right order inside the right cluster */
    var ordered = [];
    if(scopeSel)    ordered.push(scopeSel);
    if(dateInp)     ordered.push(dateInp);
    if(livePill)    ordered.push(livePill);
    if(roleWrap)    ordered.push(roleWrap);
    if(ringBell)    ordered.push(ringBell);
    if(appBellWrap) ordered.push(appBellWrap);
    if(gearBtn)     ordered.push(gearBtn);
    if(avatarRow)   ordered.push(avatarRow);

    /* anything we didn't classify — keep at the end */
    var extras = [];
    Array.prototype.forEach.call(cluster.children, function(ch){
      if(ordered.indexOf(ch) < 0) extras.push(ch);
    });
    var desired = ordered.concat(extras);

    /* only re-order if the current order actually differs */
    var current = Array.prototype.slice.call(cluster.children);
    var same = current.length === desired.length && current.every(function(n,k){return n===desired[k]});
    if(!same){
      desired.forEach(function(n){ cluster.appendChild(n); });
    }
  }

  /* ----------------------------------------------------------------
     4 · Notification popup: anchor correctly, never overflow
     ---------------------------------------------------------------- */
  function polishNotifPop(){
    var pop = document.querySelector(".notif-pop");
    if(!pop) return;
    var wrap = pop.parentNode;
    if(wrap && getComputedStyle(wrap).position === "static"){
      wrap.style.position = "relative";
    }
    pop.style.right = "0px";
    pop.style.maxWidth = "min(440px, calc(100vw - 32px))";
  }

  /* ----------------------------------------------------------------
     5 · Search placeholder — consistent everywhere
     ---------------------------------------------------------------- */
  function polishSearch(){
    var tb = document.querySelector(".topbar input.inp");
    if(!tb) return;
    if(!tb.placeholder || tb.placeholder.indexOf("Search") !== 0){
      tb.placeholder = "Search plants, tickets, equipment, maker, engineer…";
    }
    tb.style.background = "#fff";
  }

  /* ----------------------------------------------------------------
     6 · Hook render (outermost — runs after every other wrapper)
     ---------------------------------------------------------------- */
  function runAll(){
    try{ polishRingBell(); }catch(e){ console.warn("[UI POLISH] ring bell", e); }
    try{ polishTopbar(); }catch(e){ console.warn("[UI POLISH] topbar", e); }
    try{ polishNotifPop(); }catch(e){ console.warn("[UI POLISH] notif", e); }
    try{ polishSearch(); }catch(e){ console.warn("[UI POLISH] search", e); }
  }

  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    runAll();
    /* second pass — in case other MutationObservers re-inject DOM after us */
    setTimeout(runAll, 60);
  };

  /* one extra boot-time pass after everything settles */
  setTimeout(runAll, 500);

  console.log("[UI POLISH v1] loaded — topbar · search · bells · notif · filters");
})();


