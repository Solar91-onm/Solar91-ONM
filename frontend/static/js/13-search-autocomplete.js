"use strict";
/* ================================================================
   SEARCH FIX — controlled input + autocomplete dropdown
   Removes the render() cycle from the topbar search so typing is
   never interrupted. Loads after UI POLISH v1, before init().
   ================================================================ */
(function(){
  if(window._ccSearchFix) return;
  window._ccSearchFix = true;

  function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

  var dropdownEl = null;
  var debTimer = null;
  var searchFocused = false;
  var searchCaret = 0;
  var activeIndex = -1;

  /* ---- locate the topbar search input (survives rebuilds) ---- */
  function getSearchInput(){
    var topbar = document.querySelector(".topbar");
    if(!topbar) return null;
    var inputs = topbar.querySelectorAll("input.inp");
    for(var i=0;i<inputs.length;i++){
      if(inputs[i].getAttribute("data-cc-search") === "1") return inputs[i];
      var ph = inputs[i].placeholder || "";
      if(/^Search/i.test(ph)) return inputs[i];
    }
    return null;
  }

  /* ---- dropdown lifecycle ---- */
  function ensureDropdown(input){
    /* stale reference after a rebuild? discard and rebuild */
    if(dropdownEl && !dropdownEl.parentNode) dropdownEl = null;
    if(dropdownEl) return dropdownEl;
    var parent = input.parentNode;
    if(!parent) return null;
    if(getComputedStyle(parent).position === "static") parent.style.position = "relative";

    dropdownEl = document.createElement("div");
    dropdownEl.id = "cc-search-drop";
    dropdownEl.className = "cc-search-drop";
    /* inline positional styles guarantee the box floats below the input */
    dropdownEl.style.cssText =
      "position:absolute;top:calc(100% + 6px);left:0;right:0;"+
      "background:#fff;border:1px solid #dfe5e1;border-radius:12px;"+
      "box-shadow:0 22px 50px rgba(11,20,15,.18),0 4px 12px rgba(11,20,15,.06);"+
      "z-index:210;overflow-y:auto;max-height:min(70vh,440px);display:none";
    parent.appendChild(dropdownEl);
    return dropdownEl;
  }

  function hideDropdown(){
    if(dropdownEl) dropdownEl.style.display = "none";
    activeIndex = -1;
  }

  /* ---- suggestion builder ---- */
  function buildQuickActions(){
    return '<div class="cc-sd-group">'+
        '<div class="cc-sd-head">Quick actions</div>'+
        '<div class="cc-sd-item" data-cc-act="newTicket"><b>+ Raise issue</b><span>Open the ticket wizard</span></div>'+
        '<div class="cc-sd-item" data-cc-act="goPlants"><b>Browse plants</b><span>Plant registry &amp; health</span></div>'+
        '<div class="cc-sd-item" data-cc-act="goIssues"><b>Open Site Issues</b><span>Ticket register with filters</span></div>'+
        '<div class="cc-sd-item" data-cc-act="goScheduled"><b>Open Preventive Maintenance</b><span>Tasks &amp; calendar</span></div>'+
      '</div>';
  }

  function renderSuggestions(){
    var input = getSearchInput();
    if(!input) return;
    var q = (input.value || "").trim();
    S.quickSearch = q;
    var dd = ensureDropdown(input);
    if(!dd) return;

    if(q.length === 0){
      dd.innerHTML = buildQuickActions();
      dd.style.display = "block";
      activeIndex = -1;
      return;
    }

    if(q.length < 2){
      dd.innerHTML =
        '<div class="cc-sd-empty">Keep typing — matches appear from <b>2 characters</b>.<br>'+
        'Try <b>INV</b>, <b>Asadi</b>, <b>ticket</b>, or an engineer name.</div>';
      dd.style.display = "block";
      activeIndex = -1;
      return;
    }

    var results = [];
    try{ results = (typeof quickSearchResults === "function") ? quickSearchResults() : []; }catch(e){ results = []; }

    if(!results.length){
      dd.innerHTML = '<div class="cc-sd-empty">No matches for &ldquo;<b>'+escHtml(q)+'</b>&rdquo;.<br>Try a plant code, an issue ID, or an equipment name.</div>';
      dd.style.display = "block";
      activeIndex = -1;
      return;
    }

    /* group by type, preserve a sensible order */
    var order = ["plant","issue","task","handover","person"];
    var labels = { plant:"Plants", issue:"Tickets", task:"Tasks", handover:"Handovers", person:"People" };
    var groups = {};
    results.forEach(function(r){ (groups[r.type] = groups[r.type]||[]).push(r); });

    var html = "", idx = 0;
    order.forEach(function(t){
      var list = groups[t];
      if(!list || !list.length) return;
      html += '<div class="cc-sd-group"><div class="cc-sd-head">'+labels[t]+' · '+list.length+'</div>';
      list.forEach(function(r){
        html += '<div class="cc-sd-item" data-cc-idx="'+idx+'" data-type="'+escHtml(r.type)+'" data-id="'+escHtml(r.id)+'">'+
          '<b>'+escHtml(r.title)+'</b>'+
          '<span>'+escHtml(r.meta||"")+'</span>'+
        '</div>';
        idx++;
      });
      html += '</div>';
    });
    dd.innerHTML = html;
    dd.style.display = "block";
    activeIndex = -1;
  }

  /* ---- wire the input (idempotent — safe across rebuilds) ---- */
  function attachInput(input){
    if(input.getAttribute("data-cc-search") === "1") return;
    input.setAttribute("data-cc-search","1");

    /* kill the render-per-keystroke handler */
    input.removeAttribute("oninput");
    input.removeAttribute("onchange");
    input.setAttribute("autocomplete","off");
    input.setAttribute("spellcheck","false");

    /* prefill from persisted state */
    if(S.quickSearch && !input.value) input.value = S.quickSearch;

    input.addEventListener("input", function(){
      S.quickSearch = input.value;
      searchCaret = input.selectionStart || 0;
      clearTimeout(debTimer);
      debTimer = setTimeout(renderSuggestions, 90);
    });

    input.addEventListener("focus", function(){
      searchFocused = true;
      renderSuggestions();
    });

    input.addEventListener("blur", function(){
      searchFocused = false;
      /* delay so a click on a suggestion lands before blur hides the dropdown */
      setTimeout(hideDropdown, 180);
    });

    input.addEventListener("keydown", function(e){
      if(e.key === "Escape"){ hideDropdown(); input.blur(); return; }
      if(!dropdownEl || dropdownEl.style.display === "none") return;

      var items = dropdownEl.querySelectorAll(".cc-sd-item");
      if(!items.length) return;

      function setActive(n){
        items.forEach(function(el,k){ el.classList.toggle("is-active", k===n); });
        if(items[n] && items[n].scrollIntoView) items[n].scrollIntoView({block:"nearest"});
      }

      if(e.key === "ArrowDown"){
        e.preventDefault();
        activeIndex = Math.min(items.length-1, activeIndex+1);
        setActive(activeIndex);
      } else if(e.key === "ArrowUp"){
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex-1);
        setActive(activeIndex);
      } else if(e.key === "Enter"){
        e.preventDefault();
        var pick = items[activeIndex >= 0 ? activeIndex : 0];
        if(pick) pick.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));
      }
    });

    /* delegate clicks inside the dropdown */
    var parent = input.parentNode;
    if(parent && !parent.getAttribute("data-cc-search-host")){
      parent.setAttribute("data-cc-search-host","1");
      parent.addEventListener("mousedown", function(e){
        var it = e.target.closest ? e.target.closest(".cc-sd-item") : null;
        if(!it) return;
        e.preventDefault();
        var type = it.getAttribute("data-type");
        var id   = it.getAttribute("data-id");
        var act  = it.getAttribute("data-cc-act");
        hideDropdown();
        if(act){
          if(act === "newTicket"  && typeof openModal === "function") openModal("newTicket");
          if(act === "goPlants"   && typeof goView    === "function") goView("plants");
          if(act === "goIssues"   && typeof goTab     === "function") goTab("issues");
          if(act === "goScheduled"&& typeof goTab     === "function") goTab("scheduled");
          return;
        }
        if(type && id && typeof openSearchResult === "function"){
          S.quickSearch = "";
          input.value = "";
          try{ if(typeof persist === "function") persist(); }catch(e){}
          openSearchResult(type, id);
        }
      }, true);
    }
  }

  /* ---- restore focus + caret after any render the app fires behind us ---- */
  function restoreFocus(){
    var input = getSearchInput();
    if(!input) return;
    if(searchFocused && document.activeElement !== input){
      input.focus();
      try{ input.setSelectionRange(searchCaret, searchCaret); }catch(e){}
    }
  }

  /* track caret continuously */
  document.addEventListener("input", function(e){
    if(e.target && e.target.getAttribute && e.target.getAttribute("data-cc-search") === "1"){
      searchCaret = e.target.selectionStart || 0;
    }
  }, true);
  document.addEventListener("keyup", function(e){
    if(e.target && e.target.getAttribute && e.target.getAttribute("data-cc-search") === "1"){
      searchCaret = e.target.selectionStart || 0;
    }
  }, true);
  document.addEventListener("click", function(e){
    /* click outside the search host closes the dropdown */
    var host = e.target.closest ? e.target.closest('[data-cc-search-host="1"]') : null;
    if(!host) hideDropdown();
  }, true);

  /* ---- styles ---- */
  var st = document.createElement("style");
  st.textContent =
    /* suppress the legacy inline dropdown — the new one takes over */
    ".topbar > div:nth-child(2) > .search-results{display:none!important}"+
    ".cc-search-drop{font-family:inherit}"+
    ".cc-sd-group{padding:6px 0}"+
    ".cc-sd-group + .cc-sd-group{border-top:1px solid #eef2ef}"+
    ".cc-sd-head{font-size:12px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#86948d;padding:9px 16px 5px}"+
    ".cc-sd-item{padding:9px 16px;cursor:pointer;transition:background .1s;border-left:3px solid transparent}"+
    ".cc-sd-item b{display:block;font-size:12.5px;font-weight:600;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"+
    ".cc-sd-item span{display:block;font-size:12.5px;color:var(--muted-foreground);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"+
    ".cc-sd-item:hover,.cc-sd-item.is-active{background:#f2f8f4;border-left-color:var(--primary)}"+
    ".cc-sd-empty{padding:16px;font-size:12px;color:var(--muted-foreground);line-height:1.6}"+
    ".cc-sd-empty b{color:var(--foreground)}";
  document.head.appendChild(st);

  /* ---- hook render (outermost) so we re-attach after every rebuild ---- */
  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    try{ var i = getSearchInput(); if(i) attachInput(i); }catch(e){ console.warn("[SEARCH FIX] post-render", e); }
    /* second pass — lets any downstream MutationObserver settle first */
    setTimeout(function(){
      try{ var i = getSearchInput(); if(i) attachInput(i); restoreFocus(); }catch(e){}
    }, 40);
  };

  /* boot pass */
  setTimeout(function(){
    try{ var i = getSearchInput(); if(i) attachInput(i); }catch(e){}
  }, 300);

  console.log("[SEARCH FIX] loaded — controlled input + autocomplete dropdown");
})();


