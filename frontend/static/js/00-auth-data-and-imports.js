
"use strict";

const AUTH_PROVIDER = (window.S91_CONFIG && window.S91_CONFIG.authProvider) || "clerk";
const AUTH_IDENTITY={name:null,role:null};
const S91_CODE_RESEND_SECONDS=60;

function authSetupCard(title, detail){
  document.getElementById("app").innerHTML = '<div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#F4F6F5;font-family:Inter,system-ui,sans-serif"><div style="width:min(520px,100%);background:#fff;border:1px solid #E4E9E6;border-radius:16px;padding:24px;box-shadow:0 12px 38px rgba(16,24,20,.10)"><div style="display:flex;align-items:center;gap:10px"><img src="/static/brand/solar91-emblem.png" height="34" alt=""><img src="/static/brand/solar91-wordmark.png" height="22" alt="SOLAR 91"></div><h2 style="margin:8px 0 8px;font-size:22px">'+title+'</h2><p style="margin:0;color:#4F5B55;line-height:1.55">'+detail+'</p></div></div>';
}
async function ensureClerkReady(){
  if (AUTH_PROVIDER !== "clerk" || !window.S91_CONFIG?.clerkPublishableKey) {
    authSetupCard("Authentication setup required","Clerk is unavailable. Configure CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and CLERK_ISSUER on the server, then reload.");
    return false;
  }
  const deadline=Date.now()+10000;
  while(!window.Clerk&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  if (!window.Clerk || typeof window.Clerk.load !== "function") {
    authSetupCard("Authentication setup required","The Clerk sign-in service could not be loaded. Check your connection and reload.");
    return false;
  }
  await window.Clerk.load();
  return true;
}

function showClerkSignIn(errorMessage){
  const h=new Date().getHours();
  const greet=h<12?"Good morning":h<17?"Good afternoon":"Good evening";
  const EM='<img src="/static/brand/solar91-emblem.png" alt="">';
  const panels=Array.from({length:36},(_,i)=>'<div class="s91-pv" style="--d:'+((i%9)*0.25+Math.floor(i/9)*0.5)+'s"></div>').join("");
  document.getElementById("app").innerHTML=
   '<div class="s91-auth">'+
    '<aside class="s91-hero" aria-hidden="true">'+
      '<div class="s91-tone"></div>'+
      '<canvas class="s91-mesh"></canvas>'+
      '<div class="s91-mark91">91</div>'+
      '<div class="s91-sun"><i class="rip"></i><i class="rip"></i><i class="rip"></i><i class="rays"></i><i class="core">'+EM+'</i></div>'+
      '<div class="s91-cloud c1"></div><div class="s91-cloud c2"></div><div class="s91-cloud c3"></div>'+
      '<div class="s91-float f1">'+EM+'</div><div class="s91-float f2">'+EM+'</div><div class="s91-float f3">'+EM+'</div><div class="s91-float f4">'+EM+'</div>'+
      '<div class="s91-copy">'+
        '<div class="s91-hbrand">'+EM+'<img class="w" src="/static/brand/solar91-wordmark.png" alt="SOLAR 91"><small>Energizing India</small></div>'+
        '<span class="s91-pill">☀️ '+greet+', team!</span>'+
        '<h1>Powering India,<br><em>one sunrise</em> at a time.</h1>'+
        '<p>Every plant, every issue, every scheduled visit — together in one bright place.</p>'+
      '</div>'+
      '<div class="s91-chips">'+
        '<div class="s91-chip s91-ai"><span class="dot"></span><span class="lbl">Solar91 AI</span><span class="typed" id="s91-typed"></span><span class="caret"></span></div>'+
        '<div class="s91-chip s91-curve"><svg viewBox="0 0 200 60" width="200" height="60"><defs><linearGradient id="s91g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16A34A" stop-opacity=".45"/><stop offset="1" stop-color="#16A34A" stop-opacity="0"/></linearGradient></defs><path class="area" d="M0 54 C40 54 60 6 100 6 S160 54 200 54 V60 H0Z" fill="url(#s91g)"/><path class="line" d="M0 54 C40 54 60 6 100 6 S160 54 200 54" fill="none" stroke="#16A34A" stroke-width="3" stroke-linecap="round"/></svg><div class="cap"><i class="blip"></i>Generation curve · always on</div><i class="orb"></i></div>'+
        '<div class="s91-chip"><i>✨</i>Panels sparkling</div>'+
      '</div>'+
      '<svg class="s91-hills" viewBox="0 0 800 300" preserveAspectRatio="none"><path d="M0 170 Q160 90 340 150 T800 120 V300 H0Z" fill="#5CB97A" opacity=".85"/><path d="M0 220 Q220 150 430 205 T800 180 V300 H0Z" fill="#2E9B5A"/></svg>'+
      '<div class="s91-field"><div class="s91-grid">'+panels+'</div></div>'+
      '<div class="s91-ticker"><div class="s91-track">'+Array(8).join('<span>SOLAR 91 &nbsp;✦&nbsp; ENERGIZING INDIA &nbsp;✦&nbsp; </span>')+'</div></div>'+
    '</aside>'+
    '<main class="s91-side"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i>'+
      '<div class="s91-col">'+
        '<div class="s91-brand">'+EM.replace('<img','<img class="em"')+'<img class="wm" src="/static/brand/solar91-wordmark.png" alt="SOLAR 91"></div>'+
        '<h2 class="s91-title">O&amp;M Command Center</h2>'+
        '<p class="s91-sub">Sign in with the email your O&amp;M Head added</p>'+
        '<div class="s91-glow"></div>'+
        '<div class="s91-foot">Solar91 Cleantech Limited · <b>Energizing India</b></div>'+
      '</div>'+
    '</main>'+
   '</div>';
  s91ShowClerkCodeSignIn("",errorMessage);
  s91Alive(document.querySelector(".s91-mesh"));
}

/* ---- Clerk email-code sign-in ---- */
/* Same rule as app/auth/emails.py: Gmail ignores dots and +tags, so one mailbox = one account. Typos are never corrected. */
function s91CanonEmail(v){
  const e=String(v||"").trim().toLowerCase(),i=e.lastIndexOf("@");
  if(i<1)return e;
  const dom=e.slice(i+1);
  if(dom==="gmail.com"||dom==="googlemail.com"){
    const local=e.slice(0,i).split("+")[0].replace(/\./g,"");
    if(local)return local+"@gmail.com";
  }
  return e;
}
function s91CodeError(err){
  const clerkError=err&&Array.isArray(err.errors)&&err.errors[0];
  const m=String(clerkError&&(clerkError.longMessage||clerkError.message)||err&&err.message||"");
  if(err&&err.status===429||/rate limit|only request this after|seconds/i.test(m))return "Please wait a minute before asking for another code.";
  if(/signups not allowed|sign.?up.*disabled/i.test(m))return "This email has no Clerk account yet. Ask your O&M Head to add you.";
  if(/expired|invalid/i.test(m))return "That code is wrong or has expired. Check the newest email, or ask for a new code.";
  return m||"Something went wrong. Please try again.";
}
function s91ShowClerkCodeSignIn(prefillEmail,errorMessage){
  const box=document.querySelector(".s91-glow");
  if(!box)return;
  const fld='display:grid;gap:5px;font-size:12px;font-weight:600',inp='padding:11px;border:1px solid #D7DFD9;border-radius:8px',
        lnk='background:none;border:0;color:#16794A;font-size:12px;font-weight:600;cursor:pointer;padding:4px';
  box.innerHTML=
    '<form id="clerk-code-form" style="display:grid;gap:12px;background:#fff;padding:20px;border:1px solid #E4E9E6;border-radius:14px">'+
      '<label style="'+fld+'">Email<input id="clerk-code-email" name="email" type="email" autocomplete="email" required value="'+esc(prefillEmail||"")+'" style="'+inp+'"></label>'+
      '<label id="clerk-code-field" style="'+fld+';display:none">Code from your email<input id="clerk-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" style="'+inp+';letter-spacing:4px;font-size:18px;text-align:center"></label>'+
      '<p id="clerk-code-msg" role="status" style="margin:0;color:#2B4033;font-size:12px"></p>'+
      '<p id="clerk-code-error" role="alert" style="margin:0;color:#B42318;font-size:12px"></p>'+
      '<button id="clerk-code-submit" type="submit" style="padding:11px;border:0;border-radius:8px;background:#16A34A;color:white;font-weight:700;cursor:pointer">Email me a code</button>'+
      '<button id="clerk-code-resend" type="button" style="'+lnk+';display:none"></button>'+
    '</form>';
  const $=id=>document.getElementById(id);
  let sent=false,cool=0,timer=null,signInAttempt=null,signUpAttempt=null,flow=null;
  const msg=t=>{$("clerk-code-msg").textContent=t||""},fail=t=>{$("clerk-code-error").textContent=t||""};
  function tick(){
    const b=$("clerk-code-resend");
    if(!b||!document.body.contains(b)){clearInterval(timer);return}
    if(cool>0){b.disabled=true;b.textContent="Send a new code in "+cool+"s";cool-=1}
    else{clearInterval(timer);b.disabled=false;b.textContent="Send a new code"}
  }
  function startCooldown(){cool=S91_CODE_RESEND_SECONDS;clearInterval(timer);timer=setInterval(tick,1000);tick()}
  async function requestCode(){
    const email=s91CanonEmail($("clerk-code-email").value);
    try{
      signInAttempt=await window.Clerk.client.signIn.create({identifier:email});
      const factor=(signInAttempt.supportedFirstFactors||[]).find(item=>item.strategy==="email_code");
      if(!factor)throw new Error("Email sign-in codes are not enabled for this Clerk account.");
      flow="signIn";
      await signInAttempt.prepareFirstFactor({strategy:"email_code",emailAddressId:factor.emailAddressId});
    }catch(err){
      const notFound=err&&Array.isArray(err.errors)&&err.errors.some(item=>item.code==="form_identifier_not_found");
      if(!notFound)throw err;
      signUpAttempt=await window.Clerk.client.signUp.create({emailAddress:email});
      flow="signUp";
      await signUpAttempt.prepareEmailAddressVerification({strategy:"email_code"});
    }
  }
  async function sendCode(){
    const email=$("clerk-code-email").value.trim();
    await requestCode();
    sent=true;
    $("clerk-code-email").readOnly=true;
    $("clerk-code-field").style.display="grid";
    $("clerk-code-resend").style.display="block";
    $("clerk-code-submit").textContent="Verify and sign in";
    msg("Clerk emailed a code to "+email+". Check spam if you do not see it.");
    startCooldown();
    $("clerk-code").focus();
  }
  $("clerk-code-form").addEventListener("submit",async function(ev){
    ev.preventDefault();
    const submit=$("clerk-code-submit");fail("");
    submit.disabled=true;
    try{
      if(!sent){
        submit.textContent="Sending…";
        await sendCode();
      }else{
        const token=$("clerk-code").value.replace(/\D/g,"");
        if(token.length<6){fail("Enter the code from the email.");return}
        submit.textContent="Verifying…";
        const attempt=flow==="signIn"
          ?await signInAttempt.attemptFirstFactor({strategy:"email_code",code:token})
          :await signUpAttempt.attemptEmailAddressVerification({code:token});
        if(attempt.status!=="complete"||!attempt.createdSessionId)throw new Error("Clerk could not complete sign-in. Request a new code and try again.");
        await window.Clerk.setActive({session:attempt.createdSessionId});
        await startSolar91App();
        return;
      }
    }catch(err){
      fail(s91CodeError(err));
      submit.textContent=sent?"Verify and sign in":"Email me a code";
    }finally{
      if(document.body.contains(submit))submit.disabled=false;
    }
  });
  $("clerk-code-resend").addEventListener("click",async function(){
    fail("");
    try{await requestCode();msg("A new code was sent. Use the newest email only.");startCooldown()}catch(err){fail(s91CodeError(err))}
  });
  if(errorMessage)fail(errorMessage);
  $("clerk-code-email").focus();
}

/* ---- sign-in page life: neural mesh + typing AI line. Both stop by themselves once the page is replaced. ---- */
function s91Alive(canvas){
  const still=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* 1. typing "AI" status line */
  const el=document.getElementById("s91-typed");
  const msgs=["Scanning plant health…","Scheduling today’s O&M visits…","Predicting the next panel wash…","Prioritising open site issues…","Syncing every site team…"];
  let mi=0,ci=0,del=false;
  (function type(){
    if(!el||!document.body.contains(el)) return;
    const m=msgs[mi];
    if(still){el.textContent=m;return;}
    ci+=del?-1:1; el.textContent=m.slice(0,ci);
    let wait=del?22:48;
    if(!del&&ci===m.length){del=true;wait=1700;}
    else if(del&&ci===0){del=false;mi=(mi+1)%msgs.length;wait=350;}
    setTimeout(type,wait);
  })();
  /* 2. glowing neural mesh with travelling data packets */
  if(!canvas||!canvas.getContext) return;
  const ctx=canvas.getContext("2d"),dpr=Math.min(window.devicePixelRatio||1,2),LINK=120;
  let w=0,h=0,pts=[];
  function size(){
    const r=canvas.getBoundingClientRect(); w=r.width; h=r.height;
    canvas.width=w*dpr; canvas.height=h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    const n=Math.round(Math.min(70,Math.max(22,w*h/14000)));
    pts=Array.from({length:n},()=>({x:Math.random()*w,y:Math.random()*h*0.72,vx:(Math.random()-.5)*.28,vy:(Math.random()-.5)*.28,p:Math.random()*6.28}));
  }
  size(); window.addEventListener("resize",size);
  function frame(t){
    if(!document.body.contains(canvas)){window.removeEventListener("resize",size);return;}
    if(document.hidden){requestAnimationFrame(frame);return;}
    ctx.clearRect(0,0,w,h);
    for(const p of pts){
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0||p.x>w)p.vx*=-1;
      if(p.y<0||p.y>h*.72)p.vy*=-1;
    }
    for(let i=0;i<pts.length;i++){
      for(let j=i+1;j<pts.length;j++){
        const a=pts[i],b=pts[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<LINK){
          ctx.strokeStyle="rgba(255,255,255,"+((1-d/LINK)*.55)+")"; ctx.lineWidth=1;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
          if((i+j)%6===0){                       /* a golden "data packet" riding the link */
            const f=((t/1600)+i*.17)%1,px=a.x+(b.x-a.x)*f,py=a.y+(b.y-a.y)*f;
            ctx.fillStyle="rgba(255,196,40,.95)"; ctx.shadowColor="rgba(255,196,40,.9)"; ctx.shadowBlur=10;
            ctx.beginPath(); ctx.arc(px,py,2.2,0,6.283); ctx.fill(); ctx.shadowBlur=0;
          }
        }
      }
    }
    for(const p of pts){
      const r=1.8+Math.sin(t/650+p.p)*.7;
      ctx.fillStyle="rgba(255,255,255,.95)"; ctx.shadowColor="rgba(255,255,255,.95)"; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(p.x,p.y,r,0,6.283); ctx.fill(); ctx.shadowBlur=0;
    }
    if(!still) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}




async function clerkToken(){
  if (AUTH_PROVIDER !== "clerk") return null;
  try {
    if (window.Clerk?.session) return await window.Clerk.session.getToken();
  } catch (err) {
    console.warn("Clerk session could not be read.");
  }
  return null;
}
async function clerkSignOut(){
  try {
    if (window.Clerk && typeof window.Clerk.signOut === "function") await window.Clerk.signOut();
  } finally {
    window.location.assign("/");
  }
}
async function authenticatedFetch(url, options){
  const request=options||{};
  request.headers=Object.assign({},request.headers||{});
  const token=await clerkToken();
  if(token)request.headers.Authorization="Bearer "+token;
  const response=await fetch(url,request);
  if(response.status===401){
    await clerkSignOut();
    throw new Error("Authentication required");
  }
  return response;
}

/* ---------- helpers ---------- */
/* Business calendar = Asia/Kolkata (UTC+05:30, no DST). toISOString() is UTC and rolls over 5.5 h late in India. */
function s91BusinessDate(d){const t=(d instanceof Date?d:new Date()).getTime();if(!Number.isFinite(t))return "";return new Date(t+330*60000).toISOString().slice(0,10)}
/* Calendar day of a stored value: plain dates pass through; timestamps with Z/offset become the IST business day. */
function s91DayOf(value){const s=String(value||"");if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;if(/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)){const d=new Date(s);if(!isNaN(d.getTime()))return s91BusinessDate(d)}return s.slice(0,10)}
const INITIAL_NOW=new Date(); let TODAY=s91BusinessDate(INITIAL_NOW), NOW_ISO=INITIAL_NOW.toISOString(); const OM_HEAD="Arun Agarwal";
const pad2=n=>String(n).padStart(2,"0");
/* CSV/Excel formula-injection guard (OWASP): text starting with = + - @ or a control character is prefixed with an apostrophe so a spreadsheet shows it instead of running it. Plain numbers such as -5 stay numeric. */
function s91CsvText(v){const s=String(v==null?"":v);return /^[=+\-@\t\r]/.test(s)&&!/^[+-]?\d+(\.\d+)?$/.test(s.trim())?"'"+s:s}
function s91ValidDate(value){
 const s=String(value||"");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const year=Number(s.slice(0,4)),month=Number(s.slice(5,7)),day=Number(s.slice(8,10));
 if(year<2000||year>2100||month<1||month>12||day<1||day>31)return false;
 const d=new Date(Date.UTC(year,month-1,day));
 return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;
}
function fmtDate(iso){return iso?new Date(iso+"T00:00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}):"—"}
function fmtD(iso){return iso?new Date(iso+"T00:00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short"}):"—"}
/* Pure calendar arithmetic in UTC so the browser timezone cannot shift the result (IST returned day-1 before). */
function addDays(iso,d){const p=String(iso||"").slice(0,10).split("-").map(Number);const x=new Date(Date.UTC(p[0],(p[1]||1)-1,(p[2]||1)+Math.round(Number(d)||0)));return isNaN(x.getTime())?String(iso||""):x.toISOString().slice(0,10)}
function dayDiff(a,b){try{return Math.round((new Date(b+"T00:00:00")-new Date(a+"T00:00:00"))/86400000)}catch(e){return 0}}
function money(v){return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(v)}
let seq=1000; function uid(p){seq+=1;return p+"-"+seq}
function stamp(){const d=new Date();return fmtD(TODAY)+", "+pad2(d.getHours())+":"+pad2(d.getMinutes())}
function stampLong(){const d=new Date();return fmtDate(TODAY)+", "+pad2(d.getHours())+":"+pad2(d.getMinutes())}
function stampISO(){const d=new Date();return TODAY+"T"+pad2(d.getHours())+":"+pad2(d.getMinutes())}
/* Activity-log time: ISO timestamps with an offset are shown as a readable local date/time; legacy text stays as stored. */
function s91LogAt(v){const s=String(v==null?"":v);return /T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)&&typeof fmtDT==="function"?fmtDT(s):s}
function addHoursISO(iso,h){const hrs=Number(h);const d=new Date(iso);if(!iso||isNaN(d.getTime())||!Number.isFinite(hrs))return stampISO();d.setHours(d.getHours()+Math.round(hrs));if(isNaN(d.getTime()))return stampISO();const p=n=>String(n).padStart(2,"0");return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes())}
function hrsBetween(a,b){const x=new Date(a),y=new Date(b);if(isNaN(x.getTime())||isNaN(y.getTime()))return NaN;return (y-x)/3600000}
function fmtDT(s){if(!s)return"—";const d=new Date(s);if(isNaN(d.getTime()))return"—";return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})+", "+d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",hour12:false})}
function esc(q){return String(q==null?"":q).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function unspecified(v){return v==null||v===""||v==="—"?"Not specified":v}
function capLabel(c){return xlNum(c)?((c>=10?c.toFixed(1):String(c))+" mW"):(c&&String(c).trim()&&!isNaN(parseFloat(c))?parseFloat(c)+" mW":"Not specified")}
const FREQ_MAP={Daily:1,Weekly:7,Monthly:30,Quarterly:91,"Half-yearly":182,Annual:365};
/* ---------- persistence: FastAPI + Supabase PostgreSQL ---------- */
const PRE="s91v1_";
const PKEYS=["plants","handovers","tasks","washing","washMeta","washPlant","schedScope","issues","inventory","movements","ptw","incidents","docs","vendors","rules","sla","audit","offlineQueue","serviceRequests","scada","scadaConfig","view","omTab","extSub","hoOpen","events","opsDate","plantId","_seq","plantEnrich","customPlantColumns","plantCustomValues"];
const SERVER_STATE_KEYS=["plants","handovers","inventory","movements","ptw","incidents","docs","vendors","rules","sla","audit","offlineQueue","serviceRequests","events","scada","scadaConfig","plantEnrich","customPlantColumns","plantCustomValues","_seq"];
const UI_ONLY_KEYS=new Set(["view","omTab","extSub","hoOpen","plantId","washPlant","schedScope"]);
function loadK(k,f){
  if(!UI_ONLY_KEYS.has(k)) return f;
  try{const r=sessionStorage.getItem(PRE+k);return r==null?f:JSON.parse(r)}catch(e){return f}
}
function saveK(k,v){
  if(!UI_ONLY_KEYS.has(k)) return;
  try{sessionStorage.setItem(PRE+k,JSON.stringify(v))}catch(e){}
}
function clearK(){try{Object.keys(sessionStorage).filter(k=>k.startsWith(PRE)).forEach(k=>sessionStorage.removeItem(k))}catch(e){}}
async function apiFetch(url,opts,latency){
  opts=Object.assign({},opts||{});opts.headers=Object.assign({"Accept":"application/json"},opts.headers||{});
  const token=await clerkToken();
  if(token)opts.headers["Authorization"]="Bearer "+token;
  const isForm=(typeof FormData!=="undefined"&&opts.body instanceof FormData);
  if(opts.body&&typeof opts.body!=="string"&&!isForm)opts.body=JSON.stringify(opts.body);
  if(opts.body&&!isForm)opts.headers["Content-Type"]="application/json";
  const isRead=!opts.method||["GET","HEAD"].includes(String(opts.method).toUpperCase());
  const externalSignal=opts.signal;
  // Bounded requests: a sleeping server must not leave the portal in a permanent spinner.
  // Never retry writes automatically; a timed-out write could already have committed.
  async function attempt(){
    const controller=new AbortController(),abortFromCaller=()=>controller.abort();
    if(externalSignal){
      if(externalSignal.aborted)controller.abort();
      else externalSignal.addEventListener("abort",abortFromCaller,{once:true});
    }
    const timeout=setTimeout(()=>controller.abort(),isRead?45000:60000);
    const fetchStarted=latency&&typeof performance!=="undefined"?performance.now():0;
    try{
      const response=await fetch(url,{...opts,signal:controller.signal});
      if(latency){latency.status=response.status;latency.serverTiming=response.headers.get("Server-Timing")||"";latency.contentLength=Number(response.headers.get("Content-Length"))||null}
      return response;
    }finally{
      if(latency&&fetchStarted)latency.fetchMs+=performance.now()-fetchStarted;
      clearTimeout(timeout);if(externalSignal)externalSignal.removeEventListener("abort",abortFromCaller);
    }
  }
  let res;
  try{res=await attempt();}
  catch(error){
    if(externalSignal&&externalSignal.aborted)throw error;
    if(!isRead)throw new Error(error?.name==="AbortError"?"Request timed out. Check the record before retrying to avoid duplicates.":"No connection. Check connectivity and verify whether the change was saved.");
    await new Promise(resolve=>setTimeout(resolve,600));
    try{res=await attempt();}catch(retryError){if(externalSignal&&externalSignal.aborted)throw retryError;throw new Error("The server is unreachable or timed out. Retry the page once connectivity returns.");}
  }
  if(isRead&&[502,503,504].includes(res.status)){
    await new Promise(resolve=>setTimeout(resolve,600));
    try{res=await attempt();}catch(error){if(externalSignal&&externalSignal.aborted)throw error;throw new Error("The server did not respond. Please retry.");}
  }
  if(res.status===401){
    try{await window.Clerk?.signOut();}catch(e){}
    showClerkSignIn();
    throw new Error("Authentication required");
  }
  const data=res.status===204?null:await res.json().catch(()=>({}));
  if(!res.ok){
    const raw=data?.detail;
    const detail=typeof raw==="string"?raw:raw?.message||data?.error||"HTTP "+res.status;
    const err=new Error(detail);err.status=res.status;err.data=data;throw err;
  }
  return data;
}

// Opt-in browser sampling for separating Clerk/network/JSON time from the server's
// Server-Timing values. It stays in memory, groups by API family, and never stores IDs,
// query strings, payloads, tokens, or error messages.
if(typeof window!=="undefined"){
 const S91_LATENCY_SAMPLES=[];
 const percentile=(values,pct)=>{const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);return rows.length?Math.round(rows[Math.max(0,Math.ceil(rows.length*pct/100)-1)]*100)/100:null};
 const metric=(header,name)=>{const match=String(header||"").match(new RegExp("(?:^|,\\s*)"+name+";dur=([0-9.]+)"));return match?Number(match[1]):null};
 const routeFamily=url=>{
  try{const parts=new URL(url,location.href).pathname.split("/").filter(Boolean);return parts[0]==="api"?"/api/"+(parts[1]||"root"):"/"+(parts[0]||"root")}
  catch(e){return"unknown"}
 };
 const summarize=(rows,key)=>({p50:percentile(rows.map(row=>row[key]),50),p95:percentile(rows.map(row=>row[key]),95)});
 window.Solar91Latency={
  enabled:/[?&]s91_latency=1(?:&|$)/.test(String(location.search||"")),
  enable(){this.enabled=true;return"Sampling enabled for this tab; call Solar91Latency.report() after reproducing the delay."},
  disable(){this.enabled=false;return this.report()},
  clear(){S91_LATENCY_SAMPLES.length=0},
  report(){
   const groups=new Map();
   S91_LATENCY_SAMPLES.forEach(row=>{const key=row.method+" "+row.route;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});
   return{sample_count:S91_LATENCY_SAMPLES.length,groups:[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([route,rows])=>({route,samples:rows.length,failures:rows.filter(row=>row.failed).length,client_ms:summarize(rows,"clientMs"),fetch_ms:summarize(rows,"fetchMs"),server_total_ms:summarize(rows,"serverTotalMs"),server_app_ms:summarize(rows,"serverAppMs"),server_db_ms:summarize(rows,"serverDbMs"),content_length_bytes:summarize(rows,"contentLength")})),note:"Opt-in, in-memory browser samples; client time includes auth wait and JSON parsing, and content length is the response header value."}
  }
 };
 const apiFetchCore=apiFetch;
 apiFetch=async function(url,opts){
  const monitor=window.Solar91Latency.enabled&&typeof performance!=="undefined"?{started:performance.now(),fetchMs:0,status:null,serverTiming:"",contentLength:null}:null;
  try{return await apiFetchCore(url,opts,monitor)}
  finally{if(monitor){const elapsed=performance.now()-monitor.started;S91_LATENCY_SAMPLES.push({route:routeFamily(url),method:String(opts&&opts.method||"GET").toUpperCase(),clientMs:elapsed,fetchMs:monitor.fetchMs,serverTotalMs:metric(monitor.serverTiming,"total"),serverAppMs:metric(monitor.serverTiming,"app"),serverDbMs:metric(monitor.serverTiming,"db"),contentLength:monitor.contentLength,failed:!monitor.status||monitor.status>=400});if(S91_LATENCY_SAMPLES.length>500)S91_LATENCY_SAMPLES.splice(0,S91_LATENCY_SAMPLES.length-500)}}
 };
}

let _syncTimer=null,_syncing=false,_syncQueued=false,_lastServerState={},_syncRetryDelay=500;
function stateSnapshot(){const out={};SERVER_STATE_KEYS.forEach(k=>{if(k==="_seq")out[k]=seq;else if(S[k]!==undefined)out[k]=S[k]});return out}
function cloneStateValue(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}
function setLastServerState(snapshot){_lastServerState=cloneStateValue(snapshot||stateSnapshot())||{}}
function syncDelta(snapshot){const delta={};Object.keys(snapshot).forEach(k=>{if(JSON.stringify(snapshot[k])!==JSON.stringify(_lastServerState[k]))delta[k]=snapshot[k]});return delta}
function mergeServerValue(local,remote,base){
 if(Array.isArray(local)&&Array.isArray(remote)){
  const result=remote.slice(),positions=new Map(),baseRows=new Map();
  result.forEach((row,index)=>{const id=row&&(row.id||row.site_code||row.work_order_no||row.ticket_no);if(id!=null)positions.set(String(id),index)});
  (Array.isArray(base)?base:[]).forEach(row=>{const id=row&&(row.id||row.site_code||row.work_order_no||row.ticket_no);if(id!=null)baseRows.set(String(id),row)});
  local.forEach(row=>{
   const id=row&&(row.id||row.site_code||row.work_order_no||row.ticket_no);
   if(id==null){result.push(row);return}
   const key=String(id),index=positions.get(key),original=baseRows.get(key);
   if(index===undefined){
    if(!original||JSON.stringify(row)!==JSON.stringify(original))result.push(row);
    return;
   }
   result[index]=original?mergeServerValue(row,result[index],original):row;
  });
  return result;
 }
 if(local&&remote&&typeof local==="object"&&typeof remote==="object"&&!Array.isArray(local)&&!Array.isArray(remote)){
  const merged=Object.assign({},remote),original=base&&typeof base==="object"&&!Array.isArray(base)?base:{};
  new Set([...Object.keys(original),...Object.keys(local)]).forEach(field=>{
   const hasLocal=Object.prototype.hasOwnProperty.call(local,field);
   const hasBase=Object.prototype.hasOwnProperty.call(original,field);
   if(hasLocal===hasBase&&JSON.stringify(local[field])===JSON.stringify(original[field]))return;
   if(!hasLocal)delete merged[field];
   else if(Object.prototype.hasOwnProperty.call(merged,field))merged[field]=mergeServerValue(local[field],merged[field],original[field]);
   else merged[field]=local[field];
  });
  return merged;
 }
 return JSON.stringify(local)===JSON.stringify(base)?remote:local;
}
function mergeServerCollection(local,remote,base){
 return mergeServerValue(local,remote,base);
}
async function refreshServerCollections(keys){
 const url="/api/state/collections?keys="+encodeURIComponent(keys.join(","));
 const data=await apiFetch(url),remote=data.state||{};
 keys.forEach(key=>{
  if(remote[key]!==undefined){
  S[key]=mergeServerCollection(S[key],remote[key],_lastServerState[key]);
   _lastServerState[key]=cloneStateValue(remote[key]);
  }
  S._collectionRevisions=S._collectionRevisions||{};
  S._collectionRevisions[key]=Number((data.collection_revisions||{})[key]||0);
 });
}
async function apiSyncNow(){
  if(_syncing){_syncQueued=true;return}
  const snap=stateSnapshot(),delta=syncDelta(snap),keys=Object.keys(delta);
  if(!keys.length)return;
  _syncing=true;
  try{
   const versions={};keys.forEach(key=>{versions[key]=Number((S._collectionRevisions||{})[key]||0)});
   const data=await apiFetch("/api/state/sync",{method:"PUT",body:{revision:null,collection_revisions:versions,state:delta}});
   S._serverRevision=data.revision;
   S._collectionRevisions=Object.assign({},S._collectionRevisions||{},data.collection_revisions||{});
   keys.forEach(key=>{_lastServerState[key]=cloneStateValue(delta[key])});
   _syncRetryDelay=500;
  }catch(e){
   if(e.status===409){
    const detail=e.data&&e.data.detail||{},changed=detail.changed_collections||{},conflicted=Object.keys(changed);
    if(!conflicted.length){console.error("Solar91 persistence conflict",e);toast("Save conflict — your edits remain on this device. Please retry.");return}
    try{
     await refreshServerCollections(conflicted);
     toast("A saved collection changed elsewhere. Your edits are preserved and will be retried.");
     setTimeout(apiSyncNow,500);
    }catch(refreshError){console.error("Solar91 conflict refresh",refreshError);toast("Could not refresh the changed collection. Your edits remain on this device.");}
   }else{
    console.error("Solar91 persistence",e);toast("Save failed — server data was not changed. "+e.message);
    setTimeout(apiSyncNow,_syncRetryDelay);_syncRetryDelay=Math.min(30000,_syncRetryDelay*2);
   }
  }finally{_syncing=false;if(_syncQueued){_syncQueued=false;scheduleSync()}}
}
function scheduleSync(){clearTimeout(_syncTimer);_syncTimer=setTimeout(apiSyncNow,250)}
function toast(m){const t=document.createElement("div");t.className="toast";t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),3200)}
/* ---------- icons (inline SVG) ---------- */
function ic(paths,size){return '<svg width="'+(size||18)+'" height="'+(size||18)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>'}
const I={
 dash:p=>ic('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',p),
 wrench:p=>ic('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',p),
 boxes:p=>ic('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="8" y="13" width="8" height="8" rx="1"/>',p),
 sun:p=>ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',p),
 menu:p=>ic('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',p),
 search:p=>ic('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',p),
 bell:p=>ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',p),
 gear:p=>ic('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/>',p),
 check:p=>ic('<polyline points="20 6 9 17 4 12"/>',p),
 x:p=>ic('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',p),
 plus:p=>ic('<path d="M5 12h14"/><path d="M12 5v14"/>',p),
 chev:p=>ic('<polyline points="9 18 15 12 9 6"/>',p),
 send:p=>ic('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',p),
 xcirc:p=>ic('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',p),
 fsig:p=>ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M14 2v6h6"/><path d="M8 17c2 0 2-2 4-2s2 2 4 2"/>',p),
 fcheck:p=>ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>',p),
 bcheck:p=>ic('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',p),
 hist:p=>ic('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',p),
 alert:p=>ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',p),
 drop:p=>ic('<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',p),
 gauge:p=>ic('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',p),
 clipc:p=>ic('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',p),
 clipl:p=>ic('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',p),
 ftext:p=>ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/>',p),
 dl:p=>ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',p),
};
/* ---------- chart (inline SVG) ---------- */
function areaChart(data){
 if(!data||!data.length)return '<div style="padding:28px 0;text-align:center;font-size:12px;color:var(--muted-foreground)">No generation data available</div>';
 const w=700,h=230,pad=30;
 let max=1; data.forEach(d=>{max=Math.max(max,d.generation,d.target||0)}); max*=1.12;
 const X=i=>pad+i*((w-2*pad)/Math.max(1,data.length-1));
 const Y=v=>h-pad-(v/max)*(h-2*pad);
 const gen=data.map((d,i)=>X(i).toFixed(1)+","+Y(d.generation).toFixed(1)).join(" ");
 const hasT=data.every(d=>d.target!=null);const tgt=hasT?data.map((d,i)=>X(i).toFixed(1)+","+Y(d.target).toFixed(1)).join(" "):"";
 const area=pad+","+(h-pad)+" "+gen+" "+X(data.length-1).toFixed(1)+","+(h-pad);
 let grid="";[0.25,0.5,0.75,1].forEach(f=>{grid+='<line x1="'+pad+'" x2="'+(w-pad)+'" y1="'+Y(max*f).toFixed(1)+'" y2="'+Y(max*f).toFixed(1)+'" stroke="var(--border)" stroke-dasharray="3 3"/>'});
 let dots="";const stp=Math.ceil(data.length/8),bwh=(w-2*pad)/Math.max(1,data.length-1);data.forEach((d,i)=>{dots+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(d.generation).toFixed(1)+'" r="'+(data.length>14?2.5:3.5)+'" fill="var(--primary)"/>'+(i%stp===0?'<text x="'+X(i).toFixed(1)+'" y="'+(h-8)+'" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">'+d.day+'</text>':'')+'<rect class="hit chart-hit" data-act="chart" data-id="'+esc(d.date||d.day)+'" x="'+(X(i)-bwh/2).toFixed(1)+'" y="0" width="'+bwh.toFixed(1)+'" height="'+h+'" data-tip="'+esc(d.day+"\nGeneration: "+d.generation+" mWh"+(d.target!=null?"\nPV Syst target: "+d.target+" mWh\nAchievement: "+(d.target?Math.round(d.generation/d.target*100):0)+"%":"")+"\nClick to open plants")+'"/>'});
 return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:240px" preserveAspectRatio="none">'+grid+
  '<polygon points="'+area+'" fill="var(--primary)" opacity="0.12"/>'+
  '<polyline points="'+gen+'" fill="none" stroke="var(--primary)" stroke-width="2.5"/>'+
  (hasT?'<polyline points="'+tgt+'" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" stroke-dasharray="5 4"/>':'')+dots+
  '<text x="'+(w-pad)+'" y="16" text-anchor="end" font-size="11" fill="var(--primary)" font-weight="600">— Generation</text>'+
  (hasT?'<text x="'+(w-pad)+'" y="30" text-anchor="end" font-size="11" fill="var(--muted-foreground)">– – PV Syst target</text>':'')+'</svg>';
}
/* ---------- badges ---------- */
const TONE={Healthy:"success",Completed:"success",Approved:"success",Available:"success",Active:"success",Resolved:"success",Verified:"success","On track":"success","Active O&M":"success","Washed today":"success",Synced:"success",Compliant:"success","Closed (verified)":"success","Ready for Approval":"success",Warning:"warning",Attention:"warning",High:"warning",Medium:"warning",Pending:"warning","Pending Review":"warning","Approval Pending":"warning","Pending Approval":"warning","Nearing ETC":"warning","Pending sync":"warning",Queued:"warning","Due soon":"warning",Exception:"warning","Pending — Rescheduled":"warning","Pending Vendor":"warning","Changes Requested":"warning","In Progress":"info",Acknowledged:"info",Requested:"info",Assigned:"info","Submitted for Review":"info",Submitted:"info",Ordered:"info",Client:"info",Solved:"success",Critical:"danger",Overdue:"danger",Breached:"danger",Expired:"danger",Rejected:"danger",Open:"danger",Breach:"danger",Low:"muted",Normal:"muted",Scheduled:"muted","Not Started":"muted",Closed:"success",Internal:"muted",OK:"muted","N/A":"muted","—":"muted",Region:"muted","Own projects":"muted","Assigned items":"muted","Assigned tickets":"muted",Site:"muted",Portfolio:"info"};
function bg(st){const t=TONE[st]||"muted";return {success:"b-success",warning:"b-warning",info:"b-info",danger:"b-danger",muted:"b-muted"}[t]}
function badge(st){return '<span class="badge '+bg(st)+'">'+esc(st)+'</span>'}

const EXCEL_META={};
const EXCEL_PLANT_DATA=[
 {"siteCode":"KRN01","plantName":"Kerli Nadi ","projectCompany":"Solar91 Project Nine Pvt. Ltd.","commissionedOn":"2024-10-18","capacitykW":3159.1,"capacitymW":3.159,"acCapacitykW":2520},
 {"siteCode":"ASA01","plantName":"Asadi","projectCompany":"Solar91 Project Eight Pvt. Ltd.","commissionedOn":"2025-03-29","capacitykW":3412.41,"capacitymW":3.412,"acCapacitykW":2520},
 {"siteCode":"IND01","plantName":"Indora","projectCompany":"Solar91 Project Six Pvt. Ltd.","commissionedOn":"2024-10-22","capacitykW":1663.2,"capacitymW":1.663,"acCapacitykW":1330},
 {"siteCode":"JOD01","plantName":"Jodhyasi","projectCompany":"Solar91 Project Four Pvt. Ltd.","commissionedOn":"2024-12-06","capacitykW":3361.2,"capacitymW":3.361,"acCapacitykW":2680},
 {"siteCode":"KH001","plantName":"Khorandi","projectCompany":"Solar91 Project Three Pvt. Ltd.","commissionedOn":"2024-12-26","capacitykW":3357.2,"capacitymW":3.357,"acCapacitykW":2680},
 {"siteCode":"MUW01","plantName":"Muwana","projectCompany":"Solar91 Project Five Pvt. Ltd.","commissionedOn":"2025-02-18","capacitykW":2371.6,"capacitymW":2.372,"acCapacitykW":1890},
 {"siteCode":"ALN01","plantName":"Alaniyawas 01","projectCompany":"Solar91 Project Fourteen pvt. Ltd.","commissionedOn":"2025-04-25","capacitykW":3295.0,"capacitymW":3.295,"acCapacitykW":2630},
 {"siteCode":"ALN02","plantName":"Alaniyawas 02","projectCompany":"Solar91 Project Sixteen pvt. Ltd.","commissionedOn":"2025-05-26","capacitykW":1971.2,"capacitymW":1.971,"acCapacitykW":1560},
 {"siteCode":"ALN03","plantName":"Alaniyawas 03","projectCompany":"Solar91 Project Fourteen pvt. Ltd.","commissionedOn":"2025-04-25","capacitykW":3803.8,"capacitymW":3.804,"acCapacitykW":3040},
 {"siteCode":"KKN01","plantName":"KANKARLANADA 01","projectCompany":"Solar91 Project Fifteen pvt. Ltd.","commissionedOn":"2025-05-12","capacitykW":3148.47,"capacitymW":3.148,"acCapacitykW":2520},
 {"siteCode":"KKN03","plantName":"KANKARLANADA 03","projectCompany":"Solar91 Project Fifteen pvt. Ltd.","commissionedOn":"2025-05-12","capacitykW":3148.47,"capacitymW":3.148,"acCapacitykW":2520},
 {"siteCode":"PDA01","plantName":"PADASALA 01","projectCompany":"Solar91 Project Twenty pvt. Ltd.","commissionedOn":"2025-05-22","capacitykW":3158.82,"capacitymW":3.159,"acCapacitykW":2520},
 {"siteCode":"PDA03","plantName":"PADASALA 03","projectCompany":"Solar91 Project Twenty pvt. Ltd.","commissionedOn":"2025-05-22","capacitykW":3158.82,"capacitymW":3.159,"acCapacitykW":2520},
 {"siteCode":"JKD01","plantName":"JAKHARO KI DHANI 01","projectCompany":"Solar91 Project Nineteen Pvt. Ltd.","commissionedOn":"2025-07-19","capacitykW":3158.82,"capacitymW":3.159,"acCapacitykW":2520},
 {"siteCode":"JKD02","plantName":"JAKHARO KI DHANI 02","projectCompany":"Solar91 Project Nineteen Pvt. Ltd.","commissionedOn":"2025-07-19","capacitykW":3158.82,"capacitymW":3.159,"acCapacitykW":2520},
 {"siteCode":"IMS01","plantName":"Ishru Mehteb Dhani 01","projectCompany":"Solar91 Project Twenty Six pvt. Ltd.","commissionedOn":"2025-08-06","capacitykW":3158.82,"capacitymW":3.159,"acCapacitykW":2520},
 {"siteCode":"IMS02","plantName":"Ishru Mehteb Dhani 02","projectCompany":"Solar91 Project Twenty Six pvt. Ltd.","commissionedOn":"2025-08-23","capacitykW":3157.02,"capacitymW":3.157,"acCapacitykW":2520},
 {"siteCode":"DDS01","plantName":"DewDawas 01","projectCompany":"Solar91 Project Thirty Seven pvt. Ltd.","commissionedOn":"2025-07-12","capacitykW":3433.5,"capacitymW":3.433,"acCapacitykW":2740},
 {"siteCode":"ABH01","plantName":"ABHANERI 01","projectCompany":"Solar91 Project Thirty Five pvt. Ltd.","commissionedOn":"2025-06-25","capacitykW":5371.52,"capacitymW":5.372,"acCapacitykW":4300},
 {"siteCode":"MNP01","plantName":"Meenapada 01","projectCompany":"Solar91 Project Thirty Five pvt. Ltd.","commissionedOn":"2025-06-26","capacitykW":1968.54,"capacitymW":1.969,"acCapacitykW":1570},
 {"siteCode":"GUL01","plantName":"Gullana 01","projectCompany":"Solar91 Project Thirty Seven pvt. Ltd.","commissionedOn":"2025-07-26","capacitykW":1441.9,"capacitymW":1.442,"acCapacitykW":1160},
 {"siteCode":"LKT01","plantName":"Lakheta 01","projectCompany":"Solar91 Project Twenty Five pvt. Ltd.","commissionedOn":"2025-09-13","capacitykW":3121.56,"capacitymW":3.122,"acCapacitykW":2520},
 {"siteCode":"JGM01","plantName":"Jogi Magra 01","projectCompany":"Solar91 Project Twenty Eight pvt. Ltd.","commissionedOn":"2025-11-06","capacitykW":3129.36,"capacitymW":3.129,"acCapacitykW":2520},
 {"siteCode":"PAL01","plantName":"Palli 01","projectCompany":"Solar91 Project Twenty Five pvt. Ltd.","commissionedOn":"2025-11-10","capacitykW":5000,"capacitymW":5.0,"acCapacitykW":4000},
 {"siteCode":"RAM01","plantName":"Ram Nagar 01","projectCompany":"Solar91 Project Twenty Nine pvt. Ltd.","commissionedOn":"2025-11-14","capacitykW":3123.9,"capacitymW":3.124,"acCapacitykW":2520},
 {"siteCode":"BST01","plantName":"Banasthali 01","projectCompany":"Solar91 Project Thirty Seven pvt. Ltd.","commissionedOn":"2025-11-14","capacitykW":1670.11,"capacitymW":1.67,"acCapacitykW":1340},
 {"siteCode":"AVK01","plantName":"Avika Nagar 01","projectCompany":"Solar91 Project Thirty Seven pvt. Ltd.","commissionedOn":"2025-12-24","capacitykW":1871.48,"capacitymW":1.871,"acCapacitykW":1500},
 {"siteCode":"NSR01","plantName":"Noser","projectCompany":"Solar91 Project Twenty Four Pvt. Ltd.","commissionedOn":"2026-01-10","capacitykW":4924.14,"capacitymW":4.924,"acCapacitykW":4000},
 {"siteCode":"DMS01","plantName":"Dharam Sagar 01","projectCompany":"Solar91 Project Twenty Three Pvt. Ltd.","commissionedOn":"2026-01-11","capacitykW":3150.42,"capacitymW":3.15,"acCapacitykW":2520},
 {"siteCode":"DMS02","plantName":"Dharam Sagar 02","projectCompany":"Solar91 Project Twenty Three Pvt. Ltd.","commissionedOn":"2026-01-25","capacitykW":3120,"capacitymW":3.12,"acCapacitykW":2520},
 {"siteCode":"CRI01","plantName":"Chirai","projectCompany":"Solar91 Project Twenty One Pvt. Ltd.","commissionedOn":"2026-01-16","capacitykW":1687.4,"capacitymW":1.687,"acCapacitykW":2520},
 {"siteCode":"RNR01","plantName":"Raneri Village","projectCompany":"Solar91 Project Twenty Nine Pvt. Ltd.","commissionedOn":"2026-02-01","capacitykW":3173.17,"capacitymW":3.173,"acCapacitykW":2520},
 {"siteCode":"NKD01","plantName":"Nimeda Ki Dhani ","projectCompany":"Solar91 Project Seventeen Pvt. Ltd.","commissionedOn":"2026-03-16","capacitykW":1953.85,"capacitymW":1.954,"acCapacitykW":1560},
 {"siteCode":"RJV01","plantName":"Rajveer Nagar","projectCompany":"Solar91 Project Twenty Nine Pvt. Ltd.","commissionedOn":"2026-03-28","capacitykW":5000.84,"capacitymW":5.001,"acCapacitykW":4000},
 {"siteCode":"RRP01","plantName":"Ramnagar Rampuriya ","projectCompany":"Solar91 Project Thirty pvt. Ltd.","commissionedOn":"2026-04-08","capacitykW":3139.22,"capacitymW":3.139,"acCapacitykW":2520},
 {"siteCode":"HLM01","plantName":"Halli Maysore","projectCompany":"Solar91 Project Fourty one pvt. Ltd.","commissionedOn":"2026-07-18","capacitykW":3555.58,"capacitymW":3.556,"acCapacitykW":3543},
 {"siteCode":"TNF01","plantName":"Tinwri Fanta","projectCompany":"Solar91 Project Thirty pvt. Ltd.","commissionedOn":"2026-08-14","capacitykW":1466.4,"capacitymW":1.466,"acCapacitykW":2520},
 {"siteCode":"BHT01","plantName":"Bohat","projectCompany":"Solar91 Project Thirty pvt. Ltd.","commissionedOn":"2026-08-27","capacitykW":null,"capacitymW":null,"acCapacitykW":2000}
];
const EXCEL_MONTHLY_DATA=[];
const EXCEL_GENERATION_DATA={dates:[],series:{}};
const EXCEL_PVSYST_UNMAPPED=[];
/* ---- derived helpers (read ONLY from the EXCEL_* constants above) ---- */
const DATA_VERSION="plants-only-v1";
const XL_MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const XL_BY={};EXCEL_PLANT_DATA.forEach(p=>{XL_BY[p.siteCode]=p});
const XL_MONTHLY={};EXCEL_MONTHLY_DATA.forEach(r=>{(XL_MONTHLY[r.siteCode]=XL_MONTHLY[r.siteCode]||{})[r.month]=r});
const XL_LAST=TODAY;   /* Excel reporting date (last day with data) — distinct from the app date TODAY */
const xlNum=v=>typeof v==="number"&&isFinite(v);
const xlNA=v=>v==null?"N/A":v;
const xlPct=v=>xlNum(v)?v+"%":"—";
const capStr=c=>xlNum(c)?c+" mW":"Not specified";
const kWStr=v=>xlNum(v)?v.toLocaleString("en-IN",{maximumFractionDigits:2}):"—";
/* Plant Registry AC/DC column — same value as kWStr but WITHOUT thousands separators (e.g. 1500 not 1,500). */
const kWStrPlain=v=>xlNum(v)?String(Math.round(v*100)/100):"—";
/* kW total shown as MW with up to 2 decimals (e.g. 123200 -> "123.2"). Units are written by the caller, never patched into the DOM afterwards. */
const s91Mw=kw=>xlNum(kw)?(Math.round(kw/10)/100).toLocaleString("en-IN",{maximumFractionDigits:2}):"—";
/* One source of truth for plant AC/DC capacity (kW). Same order everywhere (table, KPI totals, profile, export):
   value on the plant record (manual add/edit or import) > original Excel registry > legacy MW field. Plants added later
   are therefore counted, and totals always equal the sum of what the registry table shows. */
function plantDcKw(p){
  if(!p)return null;
  if(xlNum(p.dcCapacitykW))return Number(p.dcCapacitykW);
  const x=XL_BY[p.id];if(x&&xlNum(x.capacitykW))return Number(x.capacitykW);
  if(xlNum(p.capacity))return Math.round(Number(p.capacity)*1000*100)/100;
  return null;
}
function plantAcKw(p){
  if(!p)return null;
  if(xlNum(p.acCapacitykW))return Number(p.acCapacitykW);
  const x=XL_BY[p.id];if(x&&xlNum(x.acCapacitykW))return Number(x.acCapacitykW);
  return null;
}
function plantCapMw(p){const k=plantDcKw(p);return k==null?null:k/1000}
function totalPlantCapacitykW(plants,field){
  const f=field==="acCapacitykW"?plantAcKw:plantDcKw;
  return (plants||[]).reduce((s,p)=>{const v=f(p);return s+(v==null?0:v)},0);
}
/* Plant Registry Plant Name column — display only the first line of a multi-line plant name; the
   full value on the record (plant.name) is never touched, so Edit Plant still shows the complete text. */
function firstLineOnly(s){const t=String(s==null?"":s);const i=t.search(/\r\n|\r|\n/);return (i>=0?t.slice(0,i):t).trim()}

function plantDisplayName(s){const t=firstLineOnly(s);const stripped=t.replace(/\s*-\s*\d+(?:\.\d+)?\s*mW\.?\s*$/i,"").trim();return stripped||t}

function displayCode(id){return String(id==null?"":id).replace(/_/g,"")}
const xlDim=(y,m)=>new Date(y,m,0).getDate();
const xlFmtD=iso=>iso?iso.slice(8,10)+" "+XL_MON[+iso.slice(5,7)-1]:"—";
const xlFmtDY=iso=>iso?xlFmtD(iso)+" "+iso.slice(0,4):"—";
const xlEnergy=mWh=>mWh>=100?(mWh/1000).toFixed(2)+" GWh":mWh.toFixed(1)+" mWh";
function xlCodes(plants){return plants.map(p=>p.id).filter(c=>XL_BY[c]&&EXCEL_GENERATION_DATA.series[c])}
function xlPvDaily(code,iso){const p=XL_BY[code];if(!p||!p.pvSystMonthlykWh)return null;return p.pvSystMonthlykWh[XL_MON[+iso.slice(5,7)-1]]/xlDim(+iso.slice(0,4),+iso.slice(5,7))}
/* last n reported days. all = every reporting plant; cg/ct = like-for-like on plants that also have a PV Syst target */
function xlDaily(plants,n){const codes=xlCodes(plants),D=EXCEL_GENERATION_DATA.dates,out=[];
 for(let i=Math.max(0,D.length-n);i<D.length;i++){let all=0,cg=0,ct=0,rep=0,cmp=0;
  codes.forEach(c=>{const g=EXCEL_GENERATION_DATA.series[c][i];if(!xlNum(g))return;rep++;all+=g;const t=xlPvDaily(c,D[i]);if(t!=null){cmp++;cg+=g;ct+=t}});
  out.push({date:D[i],all,cg,ct,rep,cmp});}
 return out}
/* last n calendar months; part month (latest) is month-to-date with pro-rated target */
function xlMonthly(plants,n){const codes=xlCodes(plants),ms=new Set();
 codes.forEach(c=>Object.keys(XL_MONTHLY[c]||{}).forEach(m=>ms.add(m)));
 return [...ms].sort().slice(-n).map(m=>{const y=+m.slice(0,4),mo=+m.slice(5,7),dim=xlDim(y,mo);let all=0,cg=0,ct=0,cmp=0;
  codes.forEach(c=>{const r=(XL_MONTHLY[c]||{})[m];if(!r)return;all+=r.generationkWh;const p=XL_BY[c];if(p.pvSystMonthlykWh){cmp++;cg+=r.generationkWh;ct+=p.pvSystMonthlykWh[XL_MON[mo-1]]*r.daysReported/dim}});
  return{month:m,all,cg,ct,cmp,partial:m===XL_LAST.slice(0,7)&&+XL_LAST.slice(8)<dim}})}
function xlPlantMtd(code){const r=(XL_MONTHLY[code]||{})[XL_LAST.slice(0,7)],p=XL_BY[code];if(!r||!p)return null;
 let t=null;if(p.pvSystMonthlykWh){const mo=+r.month.slice(5,7);t=p.pvSystMonthlykWh[XL_MON[mo-1]]*r.daysReported/xlDim(+r.month.slice(0,4),mo)}
 return{gen:r.generationkWh,tgt:t,pct:t?Math.round(r.generationkWh/t*100):null,days:r.daysReported}}
function trendFor(plants,n){const rows=xlDaily(plants,n),like=rows.some(r=>r.cmp>0);
 return rows.map(r=>({date:r.date,day:xlFmtD(r.date),generation:+((like?r.cg:r.all)/1000).toFixed(1),target:like?+(r.ct/1000).toFixed(1):null}))}
function monthLabel(r){const mo=+r.month.slice(5,7);return r.partial?XL_MON[mo-1]+" MTD":XL_MON[mo-1]+" '"+r.month.slice(2,4)}
function monthSeries(plants,n){const rows=xlMonthly(plants,n),like=rows.some(r=>r.cmp>0);
 return{hours:rows.map(monthLabel),gen:rows.map(r=>+((like?r.cg:r.all)/1000).toFixed(1)),tgt:like?rows.map(r=>+(r.ct/1000).toFixed(1)):null,title:"Monthly generation vs PV Syst target (mWh)"}}
/* Excel rows -> the plant shape the dashboard already uses. Fields the workbook does not contain stay null (never fabricated). */
function excelPlantsFromData(){return EXCEL_PLANT_DATA.map(x=>({id:x.siteCode,name:x.plantName,capacity:xlNum(x.capacitymW)?x.capacitymW:null,status:null,generation:null,genDate:null,availability:null,pr:null,alarms:null,source:"excel",project:x.projectCompany||"",location:x.location||x.projectCompany||""}))}
function xlRefreshPlants(stored){const fresh=excelPlantsFromData(),ids=new Set(fresh.map(p=>p.id));
 return fresh.concat((stored||[]).filter(p=>p&&p.source==="handover"&&!ids.has(p.id)))}
const PLANTS_SEED=excelPlantsFromData();
const TREND=trendFor(PLANTS_SEED,7);   /* portfolio last-7-reported-days, Excel-derived */


const SB={client:null,configured:false,connected:false,loading:false,error:null,source:"fastapi",plantIdByCode:{}};
function sbConfigured(){return false}
function sbClient(){return null}
async function sbFetchPlants(){return []}
async function sbFetchEquipment(){return []}
async function sbSeedPlantsFromExcel(){toast("Plant imports are handled by the FastAPI backend.");return []}
async function sbInsertPlant(){throw new Error("Direct browser database access is disabled; FastAPI owns persistence.")}
async function sbUpdatePlant(){throw new Error("Direct browser database access is disabled; FastAPI owns persistence.")}
async function sbUpdatePlantCustomFields(){return null}
async function sbInsertEquipment(){throw new Error("Direct browser database access is disabled; FastAPI owns persistence.")}
async function sbUpdateEquipment(){throw new Error("Direct browser database access is disabled; FastAPI owns persistence.")}
async function loadMasterDataFromSupabase(){return null}
window.Solar91DB={status:()=>({source:"fastapi",connected:true})};
window.Solar91Equipment={insert:sbInsertEquipment,update:sbUpdateEquipment,list:()=>S.equipment||[]};


const PLANT_MATCH_KEY="id"; /* the plant field imported rows are matched against */
function normalizeSiteCode(code){const n=String(code==null?"":code).trim().toUpperCase().replace(/[^A-Z0-9]/g,"");return n==="KHO01"?"KH001":n}
/* Known corrections where a source file's code doesn't normalize to match
   the app's site code, but is confirmed to be the same plant.
   Key = normalized code as it appears in the imported file(s).
   Value = normalized code as it appears in S.plants (plant.id). */
const PLANT_CODE_ALIASES={
 "KHO01":"KH001" /* Confirmed Khorandi alias; no global O/0 substitution */
};
function plantIndexByCode(plants){const idx={};(plants||[]).forEach(p=>{const code=normalizeSiteCode(p[PLANT_MATCH_KEY]);if(code&&(!idx[code]||p[PLANT_MATCH_KEY]===code))idx[code]=p});return idx}
function resolvePlantByCode(rawCode,idx){
 const n=normalizeSiteCode(rawCode);
 if(idx[n])return idx[n];
 const alias=PLANT_CODE_ALIASES[n];
 if(alias&&idx[alias])return idx[alias];
 return null;
}


const EXCEL_PLANT_INFO_SEED=[
 {"siteCode":"ABH01","project":"Solar91 Project Thirty Five Private Limited","district":"Dausa","discom":"JVVNL","dcCapacitykW":5371.52,"acCapacitykW":4300,"cod":"2025-06-25"},
 {"siteCode":"ALN01","project":"Solar91 Project Fourteen Private Limited","district":"Nagaur","discom":"AVVNL","dcCapacitykW":3295.6,"acCapacitykW":2630,"cod":"2025-04-25"},
 {"siteCode":"ALN02","project":"Solar91 Project Sixteen Private Limited","district":"Nagaur","discom":"AVVNL","dcCapacitykW":1971.2,"acCapacitykW":1560,"cod":"2025-05-26"},
 {"siteCode":"ALN03","project":"Solar91 Project Fourteen Private Limited","district":"Nagaur","discom":"AVVNL","dcCapacitykW":3803.8,"acCapacitykW":3040,"cod":"2025-04-25"},
 {"siteCode":"ASA01","project":"Solar91 Project Eight Private Limited","district":"Barmer","discom":"JDVVNL","dcCapacitykW":3412.41,"acCapacitykW":2520,"cod":"2025-03-29"},
 {"siteCode":"AVK01","project":"Solar91 Project Thirty Seven Private Limited","district":"Tonk","discom":"JVVNL","dcCapacitykW":1886.82,"acCapacitykW":1500,"cod":"2025-12-24"},
 {"siteCode":"BHT01","project":"Solar91 Project Thirty pvt. Ltd.","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":2502.64,"acCapacitykW":2000,"cod":"2026-08-27"},
 {"siteCode":"BST01","project":"Solar91 Project Thirty Seven Private Limited","district":"Tonk","discom":"JVVNL","dcCapacitykW":1672.06,"acCapacitykW":1340,"cod":"2025-11-14"},
 {"siteCode":"CRI01","project":"Solar91 Project Twenty One Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3158.82,"acCapacitykW":2520,"cod":"2026-01-16"},
 {"siteCode":"DDS01","project":"Solar91 Project Thirty Seven Private Limited","district":"dewrawas, Tehsil Duni Tonk","discom":"JVVNL","dcCapacitykW":3433.5,"acCapacitykW":2740,"cod":"2025-07-12"},
 {"siteCode":"DMS01","project":"Solar91 Project Twenty Three Private Limited","district":"phalodi","discom":"JDVVNL","dcCapacitykW":3150.42,"acCapacitykW":2520,"cod":"2026-01-12"},
 {"siteCode":"DMS02","project":"Solar91 Project Twenty Three Private Limited","district":"phalodi","discom":"JDVVNL","dcCapacitykW":3120,"acCapacitykW":2520,"cod":"2026-01-25"},
 {"siteCode":"GUL01","project":"Solar91 Project Thirty Seven Private Limited","district":"Dausa","discom":"JVVNL","dcCapacitykW":1441.9,"acCapacitykW":1160,"cod":"2025-07-26"},
 {"siteCode":"HLM01","project":"Solar91 Project Fourty one pvt. Ltd.","district":"Hassan","discom":"CESCOM","dcCapacitykW":3555.58,"acCapacitykW":3543,"cod":"2026-07-18"},
 {"siteCode":"IMS01","project":"Solar91 Project Twenty Six Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3158.82,"acCapacitykW":2520,"cod":"2025-08-07"},
 {"siteCode":"IMS02","project":"Solar91 Project Twenty Six Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3157.02,"acCapacitykW":2520,"cod":"2025-08-23"},
 {"siteCode":"IND01","project":"Solar91 Project Six Private Limited","district":"Chittorgarh","discom":"AVVNL","dcCapacitykW":1663.2,"acCapacitykW":1330,"cod":"2024-10-22"},
 {"siteCode":"JGM01","project":"Solar91 Project Twenty Eight Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3129.36,"acCapacitykW":2520,"cod":"2025-11-05"},
 {"siteCode":"JKD01","project":"Solar91 Project Nineteen Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3158.82,"acCapacitykW":2520,"cod":"2025-07-19"},
 {"siteCode":"JKD02","project":"Solar91 Project Nineteen Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3158.82,"acCapacitykW":2520,"cod":"2025-07-19"},
 {"siteCode":"JOD01","project":"Solar91 Project Four Private Limited","district":"Nagaur","discom":"AVVNL","dcCapacitykW":3361.2,"acCapacitykW":2680,"cod":"2024-12-06"},
 {"siteCode":"KH001","project":"Solar91 Project Three Private Limited","district":"Didwana kuchaman","discom":"AVVNL","dcCapacitykW":3357.2,"acCapacitykW":2680,"cod":"2024-12-26"},
 {"siteCode":"KKN01","project":"Solar91 Project Fifteen Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3148.47,"acCapacitykW":2520,"cod":"2025-05-12"},
 {"siteCode":"KKN03","project":"Solar91 Project Fifteen Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3148.47,"acCapacitykW":2520,"cod":"2025-05-12"},
 {"siteCode":"KRN01","project":"Solar91 Project Nine Private Limited","district":"Barmer","discom":"JDVVNL","dcCapacitykW":3159.1,"acCapacitykW":2520,"cod":"2024-10-18"},
 {"siteCode":"LKT01","project":"Solar91 Project Twenty Five Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3121.56,"acCapacitykW":2520,"cod":"2025-09-13"},
 {"siteCode":"MNP01","project":"Solar91 Project Thirty Five Private Limited","district":"Dausa","discom":"JVVNL","dcCapacitykW":1968.54,"acCapacitykW":1570,"cod":"2025-06-26"},
 {"siteCode":"MUW01","project":"Solar91 Project Five Private Limited","district":"Nagaur","discom":"AVVNL","dcCapacitykW":2371.6,"acCapacitykW":1890,"cod":"2025-02-18"},
 {"siteCode":"NKD01","project":"Solar91 Project Seventeen Private Limited","district":"Sikar","discom":"AVVNL","dcCapacitykW":1953.85,"acCapacitykW":1560,"cod":"2026-03-16"},
 {"siteCode":"NSR01","project":"Solar91 Project Twenty Four Private Limited","district":"jodhpur","discom":"JDVVNL","dcCapacitykW":4924.14,"acCapacitykW":4000,"cod":"2026-01-11"},
 {"siteCode":"PAL01","project":"Solar91 Project Twenty Five Private Limited","district":"phalodi","discom":"JDVVNL","dcCapacitykW":5000,"acCapacitykW":4000,"cod":"2025-11-10"},
 {"siteCode":"PDA01","project":"Solar91 Project Twenty Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3158.82,"acCapacitykW":2520,"cod":"2025-05-22"},
 {"siteCode":"PDA03","project":"Solar91 Project Twenty Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3158.82,"acCapacitykW":2520,"cod":"2025-05-22"},
 {"siteCode":"RAM01","project":"Solar91 Project Twenty Nine Private Limited","district":"Phalodi","discom":"JDVVNL","dcCapacitykW":3123.9,"acCapacitykW":2520,"cod":"2025-11-15"},
 {"siteCode":"RJV01","project":"Solar91 Project Twenty Nine Private Limited","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":5000.84,"acCapacitykW":4000,"cod":"2026-03-28"},
 {"siteCode":"RNR01","project":"Solar91 Project Twenty Nine Private Limited","district":"phalodi","discom":"JDVVNL","dcCapacitykW":3173.17,"acCapacitykW":2520,"cod":"2026-02-01"},
 {"siteCode":"RRP01","project":"Solar91 Project Thirty pvt. Ltd.","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":3139.22,"acCapacitykW":2520,"cod":"2026-04-08"},
 {"siteCode":"TNF01","project":"Solar91 Project Thirty pvt. Ltd.","district":"Jodhpur","discom":"JDVVNL","dcCapacitykW":1466.4,"acCapacitykW":2520,"cod":"2026-08-14"}
];
/* Keyed by normalized site code for O(1) lookup — built once, used by applyPlantEnrichment(). */
const EXCEL_PLANT_INFO_BY_CODE={};
EXCEL_PLANT_INFO_SEED.forEach(r=>{EXCEL_PLANT_INFO_BY_CODE[normalizeSiteCode(r.siteCode)]=r});


const LOCATION_SEED=[
 {"siteCode":"ABH01","city":"Dausa","lat":27.020194,"lng":76.615389},
 {"siteCode":"ALN01","city":"Nagaur","lat":26.511361,"lng":74.313278},
 {"siteCode":"ALN02","city":"Nagaur","lat":26.511361,"lng":74.313278},
 {"siteCode":"ALN03","city":"Nagaur","lat":26.511361,"lng":74.313278},
 {"siteCode":"ASA01","city":"Barmer","lat":26.077528,"lng":70.713667},
 {"siteCode":"AVK01","city":"Tonk","lat":26.313528,"lng":75.460611},
 {"siteCode":"BST01","city":"Tonk","lat":26.428639,"lng":75.849139},
 {"siteCode":"CRI01","city":"Jodhpur","lat":26.677,"lng":72.692361},
 {"siteCode":"DDS01","city":"Dewrawas, The. Duni Tonk","lat":25.96,"lng":75.593778},
 {"siteCode":"DMS01","city":"Phalodi","lat":26.998417,"lng":72.757306},
 {"siteCode":"DMS02","city":"Phalodi","lat":26.998417,"lng":72.757306},
 {"siteCode":"GUL01","city":"Dausa","lat":27.103222,"lng":76.587472},
 {"siteCode":"IMS01","city":"Jodhpur","lat":27.082389,"lng":72.919361},
 {"siteCode":"IMS02","city":"Jodhpur","lat":27.082389,"lng":72.919361},
 {"siteCode":"IND01","city":"Chhitorgarh","lat":25.046351,"lng":74.517092},
 {"siteCode":"JGM01","city":"Jodhpur","lat":26.585917,"lng":72.964806},
 {"siteCode":"JKD01","city":"Jodhpur","lat":26.783306,"lng":72.620472},
 {"siteCode":"JKD02","city":"Jodhpur","lat":26.795889,"lng":72.635083},
 {"siteCode":"JOD01","city":"Nagaur","lat":27.409694,"lng":73.785694},
 {"siteCode":"KH001","city":"Didwana-Kuchaman","lat":27.310944,"lng":75.086556},
 {"siteCode":"KKN01","city":"Jodhpur","lat":26.905,"lng":72.935583},
 {"siteCode":"KKN03","city":"Jodhpur","lat":26.905,"lng":72.935583},
 {"siteCode":"KRN01","city":"Barmer","lat":25.645806,"lng":72.376222},
 {"siteCode":"LKT01","city":"Jodhpur","lat":26.917111,"lng":72.888361},
 {"siteCode":"MNP01","city":"Dausa","lat":26.9935,"lng":76.702361},
 {"siteCode":"MUW01","city":"Nagaur","lat":27.167611,"lng":75.072111},
 {"siteCode":"NKD01","city":"Sikar","lat":27.522833,"lng":75.570306},
 {"siteCode":"NSR01","city":"Jodhpur","lat":26.934083,"lng":72.80125},
 {"siteCode":"PAL01","city":"Phalodi","lat":26.92925,"lng":72.697917},
 {"siteCode":"PDA01","city":"Jodhpur","lat":26.887778,"lng":72.89075},
 {"siteCode":"PDA03","city":"Jodhpur","lat":26.887778,"lng":72.89075},
 {"siteCode":"RAM01","city":"Phalodi","lat":27.101306,"lng":72.992194},
 {"siteCode":"RJV01","city":"Jodhpur","lat":27.186444,"lng":72.751556},
 {"siteCode":"RNR01","city":"Phalodi","lat":27.38375,"lng":72.101972},
 {"siteCode":"RRP01","city":"Jodhpur","lat":26.499056,"lng":73.024278},
 {"siteCode":"BHT01","city":"","lat":25.250833,"lng":76.48775},
 {"siteCode":"TNF01","city":"","lat":26.665083,"lng":72.913694}
];

const LOCATION_SEED_BY_CODE={};
LOCATION_SEED.forEach(r=>{
 if(!validLat(r.lat)||!validLng(r.lng))return; /* seed obeys the same validation as a live import — never seed an invalid point */
 const norm=normalizeSiteCode(r.siteCode);
 const resolved=PLANT_CODE_ALIASES[norm]||norm;
 LOCATION_SEED_BY_CODE[resolved]={lat:r.lat,lng:r.lng,city:r.city||"",source:"excel"};
});


const PLANT_EXCEL_FIELD_MAPPING={
 siteCode:["SITE CODE","SITECODE","SITE","PLANT CODE","PLANT/SITE CODE"],
 project:["PROJECT COMPANY","PROJECT COMPANY NAME","PROJECT","SPV","SPV NAME","SPV / PROJECT"],
 district:["DISTRICT"],
 discom:["DISCOM"],
 dcCapacitykW:["DC(kW)","DC (kW)","DC","DC CAPACITY","DC CAPACITY KW","DC CAPACITY KWP","DC (KWP)","DC KWP","INSTALLED DC CAPACITY (KWP)"],
 acCapacitykW:["AC","AC(kW)","AC (kW)","AC CAPACITY","AC CAPACITY KW","INSTALLED AC CAPACITY (KW)"],
 cod:["COD","COMMISSIONED ON","COMMISSIONED","COMMISSIONING DATE"]
};


const LOCATION_FIELD_MAPPING={
 plantNameCol:["PLANT_NAME","PLANT NAME","SITE","SITE CODE"],
 cityCol:["CITY","DISTRICT"],
 latCol:["LATITUDE","LAT"],
 lngCol:["LONGITUDE","LON","LNG","LONG"]
};
function extractSiteCodeFromLabel(label){ /* "ABH01 (Abhaneri, Dausa)" -> "ABH01"; "RNR-01" -> "RNR-01" */
 const s=String(label==null?"":label).trim();
 const i=s.indexOf("(");
 return (i>=0?s.slice(0,i):s).trim();
}

/* ---------- generic header lookup shared by both importers ---------- */
function findHeaderIndex(headers,aliases){
 const key=value=>String(value||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
 const H=headers.map(key);
 for(const a of aliases){const i=H.indexOf(key(a));if(i>=0)return i}
 return -1;
}
let _xlsxLoadPromise=null;
function ensureXlsxLoaded(){
 if(window.XLSX&&window.XLSX.utils)return Promise.resolve(window.XLSX);
 if(_xlsxLoadPromise)return _xlsxLoadPromise;
 _xlsxLoadPromise=new Promise((resolve,reject)=>{
  const script=document.createElement("script");
  script.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  script.crossOrigin="anonymous";
  script.onload=()=>window.XLSX&&window.XLSX.utils?resolve(window.XLSX):reject(new Error("Excel library loaded without its API."));
  script.onerror=()=>reject(new Error("Excel library download failed."));
  document.head.appendChild(script);
 }).catch(error=>{_xlsxLoadPromise=null;throw error});
 return _xlsxLoadPromise;
}
/* Reads any sheet/CSV into {headers:[...], rows:[[...],...]} using SheetJS for .xlsx/.xls
   and a small quoted-CSV splitter for .csv — kept local to the Plants module. */
function readTableFile(file,cb){
 const name=(file.name||"").toLowerCase();
 if(name.endsWith(".csv")){
  const rd=new FileReader();
  rd.onload=()=>{
   const split=line=>{const out=[];let cur="",q=false;for(let i=0;i<line.length;i++){const c=line[i];if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++}else q=false}else cur+=c}else{if(c==='"')q=true;else if(c===","){out.push(cur);cur=""}else cur+=c}}out.push(cur);return out.map(x=>x.trim())};
   const lines=String(rd.result||"").split(/\r?\n/).filter(l=>l.trim());
   cb(lines.length?{headers:split(lines[0]),rows:lines.slice(1).map(split)}:{headers:[],rows:[]});
  };
  rd.onerror=()=>cb(null);
  rd.readAsText(file);
 }else{
  ensureXlsxLoaded().then(()=>{
   const rd=new FileReader();
   rd.onload=()=>{
    try{
     const wb=XLSX.read(new Uint8Array(rd.result),{type:"array",cellDates:true});
     const ws=wb.Sheets[wb.SheetNames[0]];
     const aoa=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
     const headers=(aoa[0]||[]).map(x=>String(x||""));
     const rows=aoa.slice(1).filter(r=>r.some(c=>String(c||"").trim()!==""));
     cb({headers,rows});
    }catch(error){console.error("Could not read Excel workbook",error);cb(null)}
   };
   rd.onerror=()=>cb(null);
   rd.readAsArrayBuffer(file);
  }).catch(error=>{
   console.error("Could not load Excel import library",error);
   toast("Excel support could not load. Check your connection and retry, or use a CSV file.");
   cb(null);
  });
 }
}

function validLat(v){const n=parseFloat(v);return Number.isFinite(n)&&n>=-90&&n<=90}
function validLng(v){const n=parseFloat(v);return Number.isFinite(n)&&n>=-180&&n<=180}


function ensurePlantEnrich(){S.plantEnrich=S.plantEnrich||{};return S.plantEnrich}

function validatePlantLocations(){
 const withValid=[],withoutCoords=[],withInvalid=[];
 (S.plants||[]).forEach(p=>{
  if(!p.geo){withoutCoords.push(p.id);return}
  if(validLat(p.geo.lat)&&validLng(p.geo.lng))withValid.push(p.id);
  else withInvalid.push(p.id);
 });
 const report={
  totalPlants:(S.plants||[]).length,
  registered:withValid.length,
  notRegistered:withoutCoords.length,
  invalidStored:withInvalid.length, /* should always be 0 — validation happens before storage */
  notRegisteredIds:withoutCoords,
  invalidIds:withInvalid
 };
 console.table([report]);
 return report;
}

function applyPlantEnrichment(plants){
 const en=S.plantEnrich||{};
 return (plants||[]).map(p=>{
  const code=normalizeSiteCode(p.id);
  const seed=EXCEL_PLANT_INFO_BY_CODE[code];
  const e=en[code];
  /* LOCATION_SEED_BY_CODE is already keyed by the resolved (alias-applied) app-side
     code — see its construction above — so this is a direct lookup by plant.id. */
  const geoSeed=LOCATION_SEED_BY_CODE[code]||null;
  if(!seed&&!e&&!geoSeed)return p;
  const pick=(field)=>{ /* live import > embedded seed > whatever the plant already had */
   if(e&&e[field]!=null)return e[field];
   if(seed&&seed[field]!=null)return seed[field];
   return p[field];
  };
  return {...p,
   name:pick("name"), /* Edit Plant can rename a plant; Excel imports never send a name so this only ever comes from a manual edit */
   location:pick("location"),
   project:pick("project"),
   district:pick("district"),
   discom:pick("discom"),
   dcCapacitykW:pick("dcCapacitykW"),
   acCapacitykW:pick("acCapacitykW"),
   cod:pick("cod"),

   geo:e&&e.geo!=null?e.geo:(geoSeed||p.geo),
   jenAenOffice:p.jenAenOffice!=null?p.jenAenOffice:null /* not present in any import file — left empty on purpose (see PLANT_TABLE_COLUMNS) */
  };
 });
}

/* ----------------------------------------------------------------------
   PLANT EXCEL IMPORT — match / no-match / duplicate handling
   ---------------------------------------------------------------------- */
function importPlantExcel(file){
 readTableFile(file,parsed=>{
  if(!parsed||!parsed.rows.length){toast("Could not read that file — choose a Plant Information Excel file.");return}
  const H=parsed.headers,M=PLANT_EXCEL_FIELD_MAPPING;
  const ix={siteCode:findHeaderIndex(H,M.siteCode),project:findHeaderIndex(H,M.project),district:findHeaderIndex(H,M.district),discom:findHeaderIndex(H,M.discom),dc:findHeaderIndex(H,M.dcCapacitykW),ac:findHeaderIndex(H,M.acCapacitykW),cod:findHeaderIndex(H,M.cod)};
  if(ix.siteCode<0){toast("Could not find a Site Code column in that file.");return}
  const idx=plantIndexByCode(S.plants),en=ensurePlantEnrich();
  let matched=0,unmatched=[],duplicate=[];
  const seenNorm={};
  parsed.rows.forEach((r,i)=>{
   const rawCode=r[ix.siteCode];if(!String(rawCode||"").trim())return;
   const norm=normalizeSiteCode(rawCode);
   if(seenNorm[norm]){duplicate.push(rawCode);return} /* same code appears twice in the source file itself */
   seenNorm[norm]=1;
   const plant=resolvePlantByCode(rawCode,idx);
   if(!plant){unmatched.push(rawCode);return}
   const target=normalizeSiteCode(plant.id);
   const update={},setText=(field,index)=>{if(index<0)return;const value=String(r[index]||"").trim();if(value)update[field]=value},setNumber=(field,index)=>{if(index<0||r[index]==null||String(r[index]).trim()==="")return;const value=parseFloat(r[index]);if(Number.isFinite(value))update[field]=value};
   setText("project",ix.project);setText("district",ix.district);setText("discom",ix.discom);setText("cod",ix.cod);
   setNumber("dcCapacitykW",ix.dc);setNumber("acCapacitykW",ix.ac);
   en[target]=Object.assign({},en[target],update);
   matched++;
  });
  S.plantEnrich=en;S.plants=applyPlantEnrichment(S.plants);
  const warnings=[];if(ix.dc<0)warnings.push("No recognized DC capacity column; DC values were not changed.");if(ix.ac<0)warnings.push("No recognized AC capacity column; AC values were not changed.");
  S.plantImportReport={type:"plant",file:file.name,total:parsed.rows.length,matched,unmatched,duplicate,warnings,at:stampLong()};
  persist();render();
  toast("Plant data import — "+matched+" matched"+(unmatched.length?", "+unmatched.length+" unmatched":"")+(duplicate.length?", "+duplicate.length+" duplicate":"")+".");
 });
}

/* ----------------------------------------------------------------------
   LOCATION FILE IMPORT — coordinates only, never shown as raw columns
   ---------------------------------------------------------------------- */
function importLocationFile(file){
 readTableFile(file,parsed=>{
  if(!parsed||!parsed.rows.length){toast("Could not read that file — choose a plant coordinates file.");return}
  const H=parsed.headers,M=LOCATION_FIELD_MAPPING;
  const ix={name:findHeaderIndex(H,M.plantNameCol),city:findHeaderIndex(H,M.cityCol),lat:findHeaderIndex(H,M.latCol),lng:findHeaderIndex(H,M.lngCol)};
  if(ix.name<0||ix.lat<0||ix.lng<0){toast("Could not find plant name / latitude / longitude columns in that file.");return}
  const idx=plantIndexByCode(S.plants),en=ensurePlantEnrich();
  let matched=0,unmatched=[],invalid=[],duplicate=[];
  const seenNorm={};
  parsed.rows.forEach(r=>{
   const label=r[ix.name];if(!String(label||"").trim())return;
   const rawCode=extractSiteCodeFromLabel(label);
   const norm=normalizeSiteCode(rawCode);
   const lat=r[ix.lat],lng=r[ix.lng];
   if(String(lat).trim()===""&&String(lng).trim()==="")return; /* blank coordinates never create a location */
   if(!validLat(lat)||!validLng(lng)){invalid.push(label);return}
   if(seenNorm[norm]){duplicate.push(label);return}
   seenNorm[norm]=1;
   const plant=resolvePlantByCode(rawCode,idx);
   if(!plant){unmatched.push(label);return}
   const target=normalizeSiteCode(plant.id);
   en[target]=Object.assign({},en[target],{geo:{lat:parseFloat(lat),lng:parseFloat(lng),city:ix.city>=0?String(r[ix.city]||"").trim():"",source:"excel"}});
   matched++;
  });
  S.plantEnrich=en;S.plants=applyPlantEnrichment(S.plants);
  S.locationImportReport={type:"location",file:file.name,total:parsed.rows.length,matched,unmatched,invalid,duplicate,at:stampLong()};
  persist();render();
  toast("Location import — "+matched+" matched"+(unmatched.length?", "+unmatched.length+" unmatched":"")+(invalid.length?", "+invalid.length+" invalid":"")+(duplicate.length?", "+duplicate.length+" duplicate":"")+".");
 });
}
async function importPlantExcelServer(file){
 const fd=new FormData();fd.append("file",file);
 try{
  const res=await apiFetch("/api/imports/plants",{method:"POST",body:fd});
  const mapped=res.mapped_columns||{},missingCapacity=["dc_capacity_kw","ac_capacity_kw"].filter(k=>!Object.prototype.hasOwnProperty.call(mapped,k)),warnings=missingCapacity.length?["No recognized "+missingCapacity.map(k=>k==="dc_capacity_kw"?"DC":"AC").join(" / ")+" capacity column; those values were not changed."]:[];
  S.plantImportReport={type:"plant",file:file.name,total:(res.created||0)+(res.updated||0)+(res.invalid_rows||[]).length,matched:(res.created||0)+(res.updated||0),unmatched:(res.invalid_rows||[]).map(x=>x.site_code||("row "+x.row)),duplicate:(res.invalid_rows||[]).filter(x=>/duplicate/i.test(x.error||"")).map(x=>x.site_code),warnings,at:stampLong()};
 try{await refreshServerCollections(["plants","plantEnrich"])}catch(refreshError){console.error("Solar91 plant import refresh",refreshError);toast("Plant import completed, but refreshed plant data could not be loaded. "+refreshError.message);return}
  toast("Plant data import — "+(res.created||0)+" created, "+(res.updated||0)+" updated"+((res.invalid_rows||[]).length?", "+res.invalid_rows.length+" invalid":"")+".");
  render();
 }catch(e){toast("Plant import failed: "+e.message)}
}
function pickPlantExcel(input){const f=input.files&&input.files[0];if(f){if(/\.(xlsx|xlsm|csv)$/i.test(f.name))importPlantExcelServer(f);else importPlantExcel(f)}input.value=""}
async function importLocationExcelServer(file){
 const fd=new FormData();fd.append("file",file);
 try{
  const res=await apiFetch("/api/imports/locations",{method:"POST",body:fd});
  S.locationImportReport={type:"location",file:file.name,total:res.total||0,matched:res.updated||0,unmatched:(res.unmatched||[]),invalid:(res.invalid_rows||[]).map(x=>x.label||("row "+x.row)),duplicate:(res.duplicates||[]),at:stampLong()};
  try{await refreshServerCollections(["plants","plantEnrich"])}catch(refreshError){console.error("Solar91 location import refresh",refreshError);toast("Location import completed, but refreshed plant data could not be loaded. "+refreshError.message);return}
  toast("Location import — "+(res.updated||0)+" matched"+((res.unmatched||[]).length?", "+res.unmatched.length+" unmatched":"")+((res.invalid_rows||[]).length?", "+res.invalid_rows.length+" invalid":"")+".");
  render();
 }catch(e){toast("Location import failed: "+e.message)}
}
function pickLocationFile(input){const f=input.files&&input.files[0];if(f)importLocationFile(f);input.value=""}

function googleMapsUrl(geo){return "https://www.google.com/maps?q="+geo.lat+","+geo.lng+"&t=k"} /* &t=k = satellite layer */
function osmEmbedUrl(geo){
 const d=0.02; /* small bbox around the pin */
 return "https://www.openstreetmap.org/export/embed.html?bbox="+(geo.lng-d)+"%2C"+(geo.lat-d)+"%2C"+(geo.lng+d)+"%2C"+(geo.lat+d)+"&layer=mapnik&marker="+geo.lat+"%2C"+geo.lng;
}

function satelliteEmbedUrl(geo,zoom){return "https://maps.google.com/maps?q="+geo.lat+","+geo.lng+"&t=k&z="+(zoom||16)+"&output=embed"}
function locationPreviewHtml(plant){
 const geo=plant.geo;
 if(!geo)return '<div style="padding:22px 10px;text-align:center;color:var(--muted-foreground);font-size:12.5px">Location unavailable — this plant has no registered coordinates yet.</div>';
 return '<div>'+
  '<div style="font-weight:700;font-size:14px">'+esc(plant.name||plant.id)+'</div>'+
  '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:2px">Site Code: '+esc(plant.id)+(geo.city?' · '+esc(geo.city):'')+'</div>'+
  '<div style="margin-top:10px;border-radius:10px;overflow:hidden;border:1px solid var(--border)"><iframe src="'+satelliteEmbedUrl(geo)+'" style="width:100%;height:190px;border:0" loading="lazy" title="Registered plant location — satellite view"></iframe></div>'+
  '<div class="row between" style="margin-top:10px;align-items:center"><span style="font-size:12px;color:var(--muted-foreground)">Registered geographic point · satellite view</span>'+
  '<a class="btn p sm" href="'+googleMapsUrl(geo)+'" target="_blank" rel="noopener">Open in Google Maps →</a></div>'+
  '</div>';
}

const PLANT_TABLE_COLUMNS=[
 {key:"plantName",label:"Plant",visible:true,render:p=>'<div style="font-weight:600;white-space:normal;overflow-wrap:break-word;word-break:break-word;max-width:220px">'+(p.name?esc(plantDisplayName(p.name)):'<span style="color:var(--danger)">Name missing</span>')+'</div>'},
 {key:"cod",label:"COD",visible:true,render:p=>p.cod?esc(p.cod):"—"},
 {key:"siteCode",label:"Plant Code",visible:true,render:p=>esc(displayCode(p.id))},
 {key:"project",label:"SPV / Project",visible:true,render:p=>esc(plantProject(p)||"—")},
 {key:"acCapacity",label:"AC CAPACITY (kW)",visible:true,render:p=>plantAcKw(p)!=null?kWStrPlain(plantAcKw(p)):"—"},
 {key:"dcCapacity",label:"DC CAPACITY (kWp) ",visible:true,render:p=>plantDcKw(p)!=null?kWStrPlain(plantDcKw(p)):capStr(p.capacity)},
 {key:"location",label:"Location",visible:true,render:p=>p.geo?'<button type="button" class="btn o sm" data-act="plantLocation" data-id="'+esc(p.id)+'">📍 View Location</button>':'<span style="font-size:12.5px;color:var(--muted-foreground)">— Not registered —</span>'},
 {key:"district",label:"District",visible:true,render:p=>esc(p.district||(p.geo&&p.geo.city)||p.location||"—")},
 {key:"discom",label:"DISCOM",visible:true,render:p=>esc(p.discom||"—")},
 {key:"jenAenOffice",label:"JEN/AEN Office",visible:true,render:p=>'<span style="color:var(--muted-foreground)">—</span>'}, /* not in any import file yet — always blank */
 {key:"status",label:"Status",visible:true,render:p=>badge(plantHealth(p))},
 {key:"open",label:"Open",visible:true,render:p=>{const oi=openTk(S.issues).filter(t=>t.plant===p.name),crit=oi.filter(t=>t.severity==="Critical").length;return oi.length?("<b>"+oi.length+"</b>"+(crit?'<div style="font-size:12.5px;color:var(--muted-foreground)">'+crit+' critical</div>':"")):"0"}},
 {key:"critical",label:"Critical",visible:true,render:p=>{const oi=openTk(S.issues).filter(t=>t.plant===p.name);return oi.filter(t=>t.severity==="Critical").length||"—"}},
 {key:"engineer",label:"Engineer",visible:true,render:p=>{const eng=plantEngineer(p);return eng?'<span data-act="workWho" data-id="'+esc(eng)+'">'+esc(eng)+'</span>':"—"}},
 {key:"lastActivity",label:"Last activity",visible:true,render:p=>{const last=plantLastActivity(p);return last?fmtDT(last):"—"}},
 {key:"actions",label:"Actions",visible:true,render:p=>'<button type="button" class="btn o sm" data-act="editPlant" data-id="'+esc(p.id)+'">'+I.wrench(12)+' Edit</button>'}
];


function slugifyColKey(label){
 const base=String(label||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
 return "custom_"+(base||"field");
}
function addPlantColumn(){
 const input=document.getElementById("apc-name");
 const label=((input&&input.value)||"").trim();
 if(!label){toast("Enter a column name.");return}
 S.customPlantColumns=S.customPlantColumns||[];
 if(S.customPlantColumns.some(c=>c.label.toLowerCase()===label.toLowerCase())){toast("A column named \""+label+"\" already exists.");return}
 let key=slugifyColKey(label),used=new Set(S.customPlantColumns.map(c=>c.key)),uniq=key,n=2;
 while(used.has(uniq)){uniq=key+"_"+n;n++}
 S.customPlantColumns.push({key:uniq,label});
 S.modal=null;persist();render();toast("Column \""+label+"\" added to the Plant Registry.");
}
function customPlantColumnDefs(){
 return (S.customPlantColumns||[]).map(c=>({
  key:c.key,label:c.label,visible:true,
  render:p=>{
   const v=(S.plantCustomValues&&S.plantCustomValues[p.id]&&S.plantCustomValues[p.id][c.key]!=null)?S.plantCustomValues[p.id][c.key]:"";
   return '<input class="inp" style="min-width:110px;padding:4px 6px;font-size:12px" value="'+esc(v)+'" placeholder="—" onclick="event.stopPropagation()" onchange="updateCustomPlantValue(\''+esc(p.id)+'\',\''+esc(c.key)+'\',this.value)"/>';
  }
 }));
}
function updateCustomPlantValue(plantId,colKey,value){
 S.plantCustomValues=S.plantCustomValues||{};
 S.plantCustomValues[plantId]=Object.assign({},S.plantCustomValues[plantId],{[colKey]:value});
 persist(); /* no render() here — re-rendering on every cell edit would drop focus, and this input already reflects the new value */
 
 if(SB.connected){
  sbUpdatePlantCustomFields(plantId,S.plantCustomValues[plantId]).catch(err=>{
   toast("Custom field not saved to Supabase: "+((err&&err.message)||"unknown error"));
  });
 }
}


function plantFormHtml(plant){
 const isEdit=!!plant,geo=plant&&plant.geo||null;
 const fld=(id,label,val,opts)=>{opts=opts||{};return '<div class="field" style="flex:'+(opts.flex||1)+'"><span class="lbl">'+label+'</span><input id="'+id+'" class="inp" type="'+(opts.type||"text")+'"'+(opts.step?' step="'+opts.step+'"':'')+' value="'+esc(val==null?"":val)+'" placeholder="'+esc(opts.ph||"")+'"'+(opts.dis?' disabled style="opacity:.6;cursor:not-allowed"':'')+'/></div>'};
 return '<div class="row" style="gap:12px">'+
  fld("pf-name","Plant Name *",plant?plant.name:"",{ph:"e.g. ABC Solar Plant"})+
  fld("pf-code","Plant / Site Code *",plant?plant.id:"",{ph:"e.g. ABC-001",dis:isEdit})+
  '</div>'+
  (isEdit?'<div style="font-size:12px;color:var(--muted-foreground);margin:-6px 0 10px">Site Code is locked once a plant exists — it keeps issues, tasks and history linked correctly.</div>':'')+
  '<div class="row" style="gap:12px">'+
  fld("pf-project","SPV / Project",plantProject(plant)||"")+
  fld("pf-district","District / District",plant&&plant.district||"")+
  '</div><div class="row" style="gap:12px">'+
  fld("pf-discom","DISCOM",plant&&plant.discom||"")+
  fld("pf-cod","Commissioning date (COD)",plant&&plant.cod||"",{type:"date"})+
  '</div><div class="row" style="gap:12px">'+
  fld("pf-ac","AC capacity (kW)",plant&&xlNum(plant.acCapacitykW)?plant.acCapacitykW:"",{type:"number",step:"0.01",ph:"Optional"})+
  fld("pf-dc","DC capacity (kWp)",plant&&xlNum(plant.dcCapacitykW)?plant.dcCapacitykW:"",{type:"number",step:"0.01",ph:"Optional"})+
  '</div>'+
  '<div style="margin-top:4px;padding-top:12px;border-top:1px solid var(--border)">'+
  '<div style="font-size:12.5px;font-weight:700;margin-bottom:8px">📍 Location</div>'+
  '<div class="row" style="gap:12px">'+fld("pf-city","City / Place",(geo&&geo.city)||plant&&plant.location||"")+'</div>'+
  '<div class="row" style="gap:12px">'+
  fld("pf-lat","Latitude",geo?geo.lat:"",{ph:"-90 to 90"})+
  fld("pf-lng","Longitude",geo?geo.lng:"",{ph:"-180 to 180"})+
  '</div>'+
  '<div class="row" style="gap:10px;align-items:center;margin-top:2px"><button type="button" class="btn o sm" onclick="previewPlantFormLocation()">Preview on map</button>'+
  '<span id="pf-locmsg" style="font-size:12.5px;color:var(--muted-foreground)">'+(geo?"Registered — source: "+(geo.source==="manual"?"manually entered":"imported"):"Not registered yet — optional, can be added later via Edit")+'</span></div>'+
  '<div id="pf-locpreview"></div>'+
  '</div>';
}
/* Reads lat/lng out of the open Add/Edit form and validates them — used both by the
   inline "Preview on map" button and by save. Returns: undefined = both fields blank
   (no change intended), false = filled in but invalid (save must be blocked), or a
   clean {lat,lng,city} object. */
function readPlantFormGeo(){
 const latRaw=(document.getElementById("pf-lat").value||"").trim(),lngRaw=(document.getElementById("pf-lng").value||"").trim();
 if(!latRaw&&!lngRaw)return undefined;
 if(!validLat(latRaw)||!validLng(lngRaw))return false;
 return {lat:parseFloat(latRaw),lng:parseFloat(lngRaw),city:(document.getElementById("pf-city").value||"").trim()};
}
function previewPlantFormLocation(){
 const msg=document.getElementById("pf-locmsg"),box=document.getElementById("pf-locpreview"),geo=readPlantFormGeo();
 if(geo===undefined){msg.textContent="Enter latitude and longitude to preview.";msg.style.color="var(--muted-foreground)";box.innerHTML="";return}
 if(geo===false){msg.textContent="Invalid coordinates — latitude must be -90 to 90, longitude -180 to 180.";msg.style.color="var(--danger)";box.innerHTML="";return}
 msg.textContent="Valid coordinates.";msg.style.color="var(--success)";
 box.innerHTML='<div style="margin-top:8px;border-radius:10px;overflow:hidden;border:1px solid var(--border)"><iframe src="'+satelliteEmbedUrl(geo,15)+'" style="width:100%;height:160px;border:0" loading="lazy" title="Location preview — satellite view"></iframe></div>';
}
function parseOptNum(id){const v=document.getElementById(id).value;if(v==null||v==="")return undefined;const n=parseFloat(v);return Number.isFinite(n)?n:undefined}
/* Rename cascades to every module that keys its records off the plant NAME
   (site code never changes, so nothing keyed off plant.id needs updating). */
function renamePlantEverywhere(oldName,newName){
 if(!oldName||!newName||oldName===newName)return;
 [S.issues,S.tasks,S.washing,S.inventory,S.docs,S.incidents].forEach(list=>(list||[]).forEach(x=>{if(x.plant===oldName)x.plant=newName}));
 if(S.washMeta&&S.washMeta[oldName]){S.washMeta[newName]=S.washMeta[oldName];delete S.washMeta[oldName]}
 if(S.washPlant===oldName)S.washPlant=newName;
 if(S.dashPlant===oldName)S.dashPlant=newName;
}
async function saveAddPlant(){
 const name=(document.getElementById("pf-name").value||"").trim();
 const rawCode=(document.getElementById("pf-code").value||"").trim();
 if(!name||!rawCode){toast("Plant Name and Plant/Site Code are both required.");return}
 if(resolvePlantByCode(rawCode,plantIndexByCode(S.plants))){toast("A plant with that Plant/Site Code already exists — use Edit instead.");return}
 const geo=readPlantFormGeo();
 if(geo===false){toast("Invalid coordinates — latitude must be -90 to 90, longitude -180 to 180. Plant was not saved.");return}
 const city=(document.getElementById("pf-city").value||"").trim();
 const p={id:rawCode,name,capacity:null,status:null,generation:null,genDate:null,availability:null,pr:null,alarms:null,source:"handover",
  project:(document.getElementById("pf-project").value||"").trim()||undefined,
  district:(document.getElementById("pf-district").value||"").trim()||undefined,
  discom:(document.getElementById("pf-discom").value||"").trim()||undefined,
  dcCapacitykW:parseOptNum("pf-dc"),acCapacitykW:parseOptNum("pf-ac"),
  cod:document.getElementById("pf-cod").value||undefined,
  location:city||undefined,
  geo:geo?Object.assign({},geo,{source:"manual"}):undefined};
 /* Supabase is the source of truth for master data — if it's connected, the
    row must be written there first. Only on success does it also land in
    S.plants, so a failed insert never leaves the UI showing a plant that
    isn't actually saved anywhere. If Supabase isn't configured/reachable
    this falls back to the original local-only behaviour. */
 if(SB.connected){
  try{
   const row=plantFormToSbRow();row.site_code=rawCode;
   const saved=await sbInsertPlant(row);
   SB.plantIdByCode[saved.site_code]=saved.id;
   S.plants.unshift(sbRowToPlant(saved));
   audit("Plants","Plant added — "+p.id+(name?" ("+name+")":""),OM_HEAD,"—","Registered (Supabase)");
   S.modal=null;S.tablePages.plants=1;persist();render();toast("Plant added to Supabase — "+p.id);
  }catch(err){
   toast("Could not save to Supabase: "+((err&&err.message)||"unknown error")+". Plant was not saved.");
  }
  return;
 }
 if(window._s91SavingPlant)return;
 window._s91SavingPlant=true;
 try{
  const saved=await apiFetch("/api/plants",{method:"POST",body:{site_code:rawCode,plant_name:name,project_company:p.project||null,district:p.district||null,discom:p.discom||null,location:city||null,latitude:geo?geo.lat:null,longitude:geo?geo.lng:null,dc_capacity_kw:xlNum(p.dcCapacitykW)?p.dcCapacitykW:null,ac_capacity_kw:xlNum(p.acCapacitykW)?p.acCapacitykW:null,commissioned_on:p.cod||null}});
  p.id=saved.site_code||p.id;p.dbId=saved.id;p.source="database";p.active=saved.status!=="inactive";
 }catch(err){toast("Plant was not saved: "+((err&&err.message)||"server error"));return}
 finally{window._s91SavingPlant=false}
 S.plants.unshift(p);
 if(typeof _lastServerState!=="undefined"&&Array.isArray(_lastServerState.plants))_lastServerState.plants=[cloneStateValue(p)].concat(_lastServerState.plants);
 audit("Plants","Plant added — "+p.id+(name?" ("+name+")":""),(AUTH_IDENTITY&&AUTH_IDENTITY.name)||OM_HEAD,"—","Registered");
 S.modal=null;S.tablePages.plants=1;persist();render();toast("Plant added — "+p.id+(geo?"":" (location can be added later via Edit)"));
}
async function saveEditPlant(id){
 const plant=(S.plants||[]).find(z=>z.id===id);
 if(!plant){toast("Plant not found.");closeModal();return}
 const name=(document.getElementById("pf-name").value||"").trim();
 if(!name){toast("Plant Name is required.");return}
 const geo=readPlantFormGeo();
 if(geo===false){toast("Invalid coordinates — latitude must be -90 to 90, longitude -180 to 180. Changes were not saved.");return}
 const city=(document.getElementById("pf-city").value||"").trim();
 if(SB.connected){
  try{
   const row=plantFormToSbRow();
   if(geo)row.latitude=geo.lat,row.longitude=geo.lng;
   const saved=await sbUpdatePlant(plant.id,row);
   if(name!==plant.name)renamePlantEverywhere(plant.name,name);
   S.plants=S.plants.map(z=>z.id===plant.id?sbRowToPlant(saved):z);
   audit("Plants","Plant edited — "+plant.id,OM_HEAD,"—","Updated (Supabase)");
   S.modal=null;persist();render();toast("Plant updated in Supabase — "+plant.id);
  }catch(err){
   toast("Could not save to Supabase: "+((err&&err.message)||"unknown error")+". Changes were not saved.");
  }
  return;
 }
 const code=normalizeSiteCode(plant.id),en=ensurePlantEnrich();
 en[code]=Object.assign({},en[code],{
  name,
  project:(document.getElementById("pf-project").value||"").trim()||undefined,
  district:(document.getElementById("pf-district").value||"").trim()||undefined,
  discom:(document.getElementById("pf-discom").value||"").trim()||undefined,
  dcCapacitykW:parseOptNum("pf-dc"),acCapacitykW:parseOptNum("pf-ac"),
  cod:document.getElementById("pf-cod").value||undefined,
  location:city||undefined
 });
 if(geo)en[code].geo=Object.assign({},geo,{source:"manual"}); /* only touch geo when the form actually supplied valid coordinates — never silently erase a registered location */
 S.plantEnrich=en;
 if(name!==plant.name)renamePlantEverywhere(plant.name,name);
 S.plants=applyPlantEnrichment(S.plants);
 audit("Plants","Plant edited — "+plant.id,OM_HEAD,"—","Updated");
 S.modal=null;persist();render();toast("Plant updated — "+plant.id+(SB.configured?" (offline — will not sync until Supabase is reachable)":""));
}
/* ---- UI helpers: chart tooltips, focus-safe search, generic list controls (search + filter + 6 per page) ---- */
(function(){const st=document.createElement("style");
 st.textContent=".hit{fill:transparent;cursor:crosshair}.hit:hover{fill:rgba(34,197,94,.10)}#chart-tip{position:fixed;z-index:9999;pointer-events:none;background:#111814;color:#fff;font-size:12.5px;line-height:1.5;padding:7px 10px;border-radius:8px;max-width:260px;box-shadow:0 6px 20px rgba(0,0,0,.25);display:none;white-space:pre-line}";
 document.head.appendChild(st);
 const tip=document.createElement("div");tip.id="chart-tip";document.body.appendChild(tip);
 document.addEventListener("mousemove",e=>{const t=e.target.closest&&e.target.closest("[data-tip]");if(!t){tip.style.display="none";return}
  tip.textContent=t.getAttribute("data-tip");tip.style.display="block";
  tip.style.left=Math.max(8,Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8))+"px";tip.style.top=Math.min(e.clientY+16,innerHeight-tip.offsetHeight-8)+"px"});})();
const LIST_SIZE=6;
function listCtl(key,rows,o){S.lf=S.lf||{};const st=S.lf[key]=S.lf[key]||{q:"",f:"all"},q=st.q.trim().toLowerCase(),size=o.size||LIST_SIZE;
 const facets=o.facet?[...new Set(rows.map(o.facet))].filter(Boolean):[];
 const fl=rows.filter(r=>(!q||o.text(r).toLowerCase().includes(q))&&(st.f==="all"||!o.facet||o.facet(r)===st.f));
 const pages=Math.max(1,Math.ceil(fl.length/size));S.tablePages[key]=Math.min(S.tablePages[key]||1,pages);const page=S.tablePages[key];
 const bar='<div class="row wrap" style="gap:8px;padding:'+(o.pad||"0 20px 12px")+';align-items:flex-end"><div class="field" style="min-width:200px;flex:2"><span class="lbl">Search</span><input class="inp" value="'+esc(st.q)+'" placeholder="'+esc(o.ph||"Search…")+'" oninput="S.lf[\''+key+'\'].q=this.value;S.tablePages[\''+key+'\']=1;renderSoon()"/></div>'+
  (o.facet?'<div class="field" style="min-width:150px;flex:1"><span class="lbl">'+esc(o.facetLabel||"Filter")+'</span><select class="inp" onchange="S.lf[\''+key+'\'].f=this.value;S.tablePages[\''+key+'\']=1;render()"><option value="all">All</option>'+facets.map(f=>'<option value="'+esc(f)+'"'+(st.f===f?" selected":"")+'>'+esc(f)+'</option>').join("")+'</select></div>':'')+
  '<button class="btn o sm" onclick="S.lf[\''+key+'\']={q:\'\',f:\'all\'};S.tablePages[\''+key+'\']=1;render()">Clear</button></div>';
 return{rows:fl.slice((page-1)*size,page*size),all:fl,n:fl.length,bar,pager:tablePager(key,fl.length,size)}}
/* dashboard plant list: search + filters + sort, 6 per page */
function plantListRows(sp){const f=S.plF=Object.assign({q:"",rep:"all",tgt:"all",cap:"all",ach:"all",sort:"name",health:"all",site:"all",project:"all",assignee:"all",maker:"all",district:"all",loc:"all"},S.plF||{}),q=f.q.trim().toLowerCase();
 const issueStats=new Map();
 (S.issues||[]).forEach(t=>{
  if(!t.plant)return;
  let stats=issueStats.get(t.plant);
  if(!stats){stats={makers:new Set(),open:0};issueStats.set(t.plant,stats)}
  if(t.maker)stats.makers.add(t.maker);
  if(t.status!=="Closed"&&t.status!=="Resolved")stats.open++;
 });
 const r=sp.filter(p=>{const x=XL_BY[p.id],m=xlPlantMtd(p.id),has=!!(x&&x.pvSystMonthlykWh),eng=plantEngineer(p),proj=plantProject(p);
  if(q&&!(p.name+" "+p.id+" "+proj+" "+eng+" "+(p.district||"")+" "+(p.geo&&p.geo.city||"")).toLowerCase().includes(q))return false;
  if(f.district&&f.district!=="all"&&(p.district||"—")!==f.district)return false;
  if(f.loc==="yes"&&!p.geo)return false;if(f.loc==="no"&&p.geo)return false;
  if(f.rep==="rep"&&p.genDate!==XL_LAST)return false;if(f.rep==="not"&&p.genDate===XL_LAST)return false;
  if(f.tgt==="yes"&&!has)return false;if(f.tgt==="no"&&has)return false;
  if(f.cap==="s"&&!((plantCapMw(p)!=null)&&plantCapMw(p)<2.5))return false;if(f.cap==="m"&&!((plantCapMw(p)!=null)&&plantCapMw(p)>=2.5&&plantCapMw(p)<3.5))return false;if(f.cap==="l"&&!((plantCapMw(p)!=null)&&plantCapMw(p)>=3.5))return false;
  const a=m&&m.pct!=null?m.pct:null;
  if(f.ach==="hi"&&!(a!=null&&a>=100))return false;if(f.ach==="mid"&&!(a!=null&&a>=90&&a<100))return false;if(f.ach==="lo"&&!(a!=null&&a<90))return false;
  if(f.health&&f.health!=="all"&&plantHealth(p)!==f.health)return false;
  if(f.site&&f.site!=="all"&&p.id!==f.site)return false;
  if(f.project&&f.project!=="all"&&proj!==f.project)return false;
  if(f.assignee&&f.assignee!=="all"&&eng!==f.assignee)return false;
  if(f.maker&&f.maker!=="all"&&!(issueStats.get(p.name)&&issueStats.get(p.name).makers.has(f.maker)))return false;
  return true});
 const val={name:p=>p.name.toLowerCase(),cap:p=>plantCapMw(p)!=null?-plantCapMw(p):1,gen:p=>-(p.generation||0),ach:p=>{const m=xlPlantMtd(p.id);return -(m&&m.pct!=null?m.pct:-1)},issues:p=>-((issueStats.get(p.name)||{}).open||0)}[f.sort]||(p=>p.name.toLowerCase());
 return r.slice().sort((a,b)=>{const x=val(a),y=val(b);return x<y?-1:x>y?1:0})}
function plantListBar(){const f=S.plF,sel=(k,opts)=>'<select class="inp" onchange="S.plF.'+k+'=this.value;S.tablePages.plants=1;render()">'+opts.map(([v,l])=>'<option value="'+v+'"'+(f[k]===v?" selected":"")+'>'+l+'</option>').join("")+'</select>',fld=(l,c,w)=>'<div class="field" style="min-width:'+w+'px;flex:1"><span class="lbl">'+l+'</span>'+c+'</div>';
 const sites=[...new Set((S.plants||[]).map(p=>p.id))].sort(),projs=[...new Set((S.plants||[]).map(plantProject).filter(Boolean))].sort();
 const engs=[...new Set((S.plants||[]).map(plantEngineer).filter(Boolean))].sort(),makers=[...new Set((S.issues||[]).map(t=>t.maker).filter(Boolean))].sort();
 const districts=[...new Set((S.plants||[]).map(p=>p.district).filter(Boolean))].sort();
 return '<div class="row wrap" style="gap:8px;padding:0 20px 12px;align-items:flex-end"><div class="field" style="min-width:210px;flex:2"><span class="lbl">Search plant, site, project, location</span><input class="inp" value="'+esc(f.q)+'" placeholder="e.g. Kerli, PDA_01, KUSUM, Nagaur" oninput="S.plF.q=this.value;S.tablePages.plants=1;renderSoon()"/></div>'+
  fld("Health",sel("health",[["all","All health"],["Healthy","Healthy"],["Warning","Warning"],["Critical","Critical"]]),120)+
  fld("Site code",sel("site",[["all","All sites"]].concat(sites.map(s=>[s,s]))),130)+
  fld("Project",sel("project",[["all","All projects"]].concat(projs.map(s=>[s,s]))),150)+
  (districts.length?fld("District",sel("district",[["all","All districts"]].concat(districts.map(s=>[s,s]))),140):"")+
  fld("Location",sel("loc",[["all","All plants"],["yes","📍 Registered"],["no","Not registered"]]),140)+
  fld("Engineer",sel("assignee",[["all","All engineers"]].concat(engs.map(s=>[s,s]))),140)+
  (makers.length?fld("Maker",sel("maker",[["all","All makers"]].concat(makers.map(s=>[s,s]))),130):"")+
  fld("Sort by",sel("sort",[["name","Name"],["issues","Open issues"],["cap","Capacity"]]),130)+
  '<button class="btn o sm" onclick="S.plF={q:\'\',rep:\'all\',tgt:\'all\',cap:\'all\',ach:\'all\',sort:\'name\',health:\'all\',site:\'all\',project:\'all\',assignee:\'all\',maker:\'all\',district:\'all\',loc:\'all\'};S.tablePages.plants=1;render()">Clear</button></div>'}
  /* ---- Analytics: section reports (Generation from Excel + Handover / Preventive Maintenance / Washing / Issues) ---- */
const REP_TABS=[["generation","Generation"],["handover","Handover"],["scheduled","Preventive Maintenance"],["washing","Washing"],["issues","Issues"]];
function xlMonthsList(){const s=new Set(EXCEL_MONTHLY_DATA.map(r=>r.month));return [...s].sort().reverse()}
function secRepData(tab){
 if(tab==="generation"){const mo=S.repMonth||XL_LAST.slice(0,7),y=+mo.slice(0,4),m=+mo.slice(5,7),dim=xlDim(y,m);
  const rows=S.plants.filter(p=>XL_BY[p.id]&&(XL_MONTHLY[p.id]||{})[mo]).map(p=>{const x=XL_BY[p.id],r=XL_MONTHLY[p.id][mo],t=x.pvSystMonthlykWh?x.pvSystMonthlykWh[XL_MON[m-1]]*r.daysReported/dim:null,a=t?Math.round(r.generationkWh/t*100):null;
   return [p.name,p.id,p.capacity,r.daysReported,+(r.generationkWh/1000).toFixed(1),t==null?"—":+(t/1000).toFixed(1),a==null?"—":a+"%",x.capacitykW?Math.round(r.generationkWh/x.capacitykW*10)/10:"—",a==null?"No PV Syst target":a>=100?"≥ 100%":a>=90?"90 – 99%":"< 90%"]});
  const G=rows.reduce((s,r)=>s+r[4],0),cmp=rows.filter(r=>r[5]!=="—"),CG=cmp.reduce((s,r)=>s+r[4],0),CT=cmp.reduce((s,r)=>s+r[5],0);
  return{title:"Generation report — "+XL_MON[m-1]+" "+y+(mo===XL_LAST.slice(0,7)&&+XL_LAST.slice(8)<dim?" (month-to-date to "+xlFmtD(XL_LAST)+")":""),cols:["Plant","Site code","Capacity (mW)","Days reported","Generation (mWh)","PV Syst target (mWh)","Achievement","Yield (kWh/kWp)"],rows,facetName:"Achievement",facetIdx:8,textIdx:[0,1],
   sum:[["Plants reporting",rows.length],["Generation",xlEnergy(G)],["PV Syst target",xlEnergy(CT)],["Achievement",CT?Math.round(CG/CT*100)+"%":"—"]]}}
 if(tab==="handover"){const rows=S.handovers.map(h=>{const pr=hoProg(h),od=h.items.filter(i=>i.mandatory&&itemOD(i)>0&&!counted(i)).length;return[h.handoverId||h.id,h.name,h.location||"—",capLabel(h.capacity),HO_STAGES[hoStage(h)-1],pr.pct+"%",od,h.status==="active_om"?"Active O&M":h.status==="pending_approval"?"Pending approval":"In flight"]});
  return{title:"Handover report",cols:["Handover","Project","Location","Capacity","Stage","Progress","Overdue mandatory","Status"],rows,facetName:"Stage",facetIdx:4,textIdx:[0,1,2],sum:[["Projects",rows.length],["In flight",rows.filter(r=>r[7]!=="Active O&M").length],["Overdue mandatory items",rows.reduce((s,r)=>s+r[6],0)],["Active O&M",rows.filter(r=>r[7]==="Active O&M").length]]}}
 if(tab==="scheduled"){const by={};S.tasks.forEach(t=>{(by[t.plant]=by[t.plant]||[]).push(t)});
  const rows=Object.keys(by).map(pn=>{const a=by[pn],done=a.filter(t=>t.status==="Completed"),od=a.filter(t=>taskOD(t)>0).length,ot=done.filter(t=>t.completion&&t.completion.date<=t.due).length;return[pn,a.length,a.length-done.length,od,done.length,done.length?Math.round(100*ot/done.length)+"%":"—",od?"Has overdue":"On track"]});
  return{title:"Preventive Maintenance report — by plant",cols:["Plant","Tasks","Open","Overdue","Completed","On-time (completed)","Health"],rows,facetName:"Health",facetIdx:6,textIdx:[0],sum:[["Tasks",S.tasks.length],["Open",rows.reduce((s,r)=>s+r[2],0)],["Overdue",rows.reduce((s,r)=>s+r[3],0)],["PM on-time",pmOnTimePct()+"%"]]}}
 if(tab==="washing"){const rows=S.plants.filter(p=>S.washing.some(t=>t.plant===p.name)).map(p=>{const w=S.washing.filter(t=>t.plant===p.name),fq=(S.washMeta[p.name]||{freq:14}).freq,ok=w.filter(t=>daysSince(t)<=fq).length,red=w.filter(t=>wColor(t)==="red").length,pc=Math.round(100*ok/w.length);return[p.name,w.length,fq+" d",pc+"%",red,pc>=WASH_TH?"Compliant":"Below threshold"]});
  return{title:"Washing report — by plant",cols:["Plant","Tables in cycle","Frequency","Compliance","Red-zone tables","Status"],rows,facetName:"Status",facetIdx:5,textIdx:[0],sum:[["Plants tracked",rows.length],["Tables",S.washing.length],["Red-zone",rows.reduce((s,r)=>s+r[4],0)],["Compliance",washCompliancePct()+"%"]]}}
 const by={};S.issues.forEach(t=>{(by[t.plant]=by[t.plant]||[]).push(t)});
 const rows=Object.keys(by).map(pn=>{const a=by[pn],o=openTk(a),br=o.filter(t=>slaState(t)==="breach").length;return[pn,a.length,o.length,o.filter(isCriticalIssue).length,br,a.length-o.length,br?"SLA breach":o.length?"Open":"Clear"]});
 return{title:"Issues report — by plant",cols:["Plant","Tickets","Open","Critical (open)","SLA breaches","Closed","Status"],rows,facetName:"Status",facetIdx:6,textIdx:[0],sum:[["Tickets",S.issues.length],["Open",openTk(S.issues).length],["Critical open",openTk(S.issues).filter(isCriticalIssue).length],["SLA breaches",rows.reduce((s,r)=>s+r[4],0)]]}}
function downloadSecRep(){const tab=S.repTab||"generation",d=secRepData(tab),k="rep_"+tab,st=(S.lf&&S.lf[k])||{q:"",f:"all"},q=st.q.trim().toLowerCase();
 const rows=d.rows.filter(r=>(!q||d.textIdx.map(i=>r[i]).join(" ").toLowerCase().includes(q))&&(st.f==="all"||r[d.facetIdx]===st.f));
 const csv=[[d.title]].concat([d.cols],rows.map(r=>r.slice(0,d.cols.length))).map(r=>r.map(c=>'"'+s91CsvText(c).replace(/"/g,'""')+'"').join(",")).join("\r\n");
 const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}));a.download="solar91-"+tab+"-report-"+TODAY+".csv";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),800);
 audit("Reports","Downloaded "+d.title+"",OM_HEAD);toast("Downloaded "+a.download)}
function renderSecReports(){const tab=S.repTab||"generation",d=secRepData(tab),k="rep_"+tab;
 const lc=listCtl(k,d.rows.map(r=>({r})),{facet:x=>x.r[d.facetIdx],facetLabel:d.facetName,text:x=>d.textIdx.map(i=>x.r[i]).join(" "),ph:"Search "+(REP_TABS.find(t=>t[0]===tab)||[])[1]});
 const mo=tab==="generation"?'<div class="field" style="min-width:150px"><span class="lbl">Month</span><select class="inp" onchange="S.repMonth=this.value;S.tablePages.'+k+'=1;render()">'+xlMonthsList().map(m=>'<option value="'+m+'"'+((S.repMonth||XL_LAST.slice(0,7))===m?" selected":"")+'>'+XL_MON[+m.slice(5)-1]+" "+m.slice(0,4)+'</option>').join("")+'</select></div>':"";
 return '<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap" style="gap:10px"><div><h2 style="font-size:15px;font-weight:700">'+esc(d.title)+'</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin:3px 0 10px">Section reports · search, filter and page through the data · download the filtered view as CSV</p></div><div class="row" style="gap:8px;align-items:flex-end">'+mo+'<button class="btn p sm" onclick="downloadSecRep()">'+I.dl(13)+' Download CSV</button></div></div>'+
  '<div class="row wrap" style="gap:6px;margin-bottom:12px">'+REP_TABS.map(t=>'<button class="pill sev-pill'+(tab===t[0]?" active":"")+'" onclick="S.repTab=\''+t[0]+'\';render()">'+t[1]+'</button>').join("")+'</div>'+
  '<div class="row wrap" style="gap:10px;margin-bottom:12px">'+d.sum.map(s=>'<div class="metric" style="flex:1;min-width:130px;padding:10px 12px"><div style="font-size:12px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.04em">'+esc(s[0])+'</div><div style="font-size:17px;font-weight:700;margin-top:2px">'+esc(s[1])+'</div></div>').join("")+'</div></div>'+lc.bar+
  '<table><thead><tr>'+d.cols.map(c=>'<th>'+esc(c)+'</th>').join("")+'</tr></thead><tbody>'+(lc.rows.length?lc.rows.map(x=>'<tr>'+x.r.slice(0,d.cols.length).map((c,i)=>'<td'+(i===0?' style="font-weight:600"':'')+'>'+esc(c)+'</td>').join("")+'</tr>').join(""):'<tr><td colspan="'+d.cols.length+'" style="text-align:center;color:var(--muted-foreground);padding:18px">No records match the current search / filter.</td></tr>')+'</tbody></table>'+lc.pager+'</div>'}
const CATEGORIES=["Documentation","Physical asset verification","Electrical safety","Spares & tools handover","Access & credentials","Manpower & site readiness"];
const CAT_HINT={"Documentation":"As-built drawings, SLDs, O&M manuals, warranties, datasheets, insurance, statutory approvals.","Physical asset verification":"Inverter/module counts & serials, tracker confirmation, transformer/switchyard, CCTV, fencing, signage.","Electrical safety":"Earthing pits, DC/AC cable routing & labeling, protection relays, SCADA access.","Spares & tools handover":"Initial spares inventory received from EPC, tools/equipment left on site.","Access & credentials":"SCADA login, inverter portal, gate keys/access cards, local authority contacts.","Manpower & site readiness":"Security deployment, site office, safety signage, first-aid kit, PPE availability."};
const CHECKLIST=[
 {c:"Documentation",t:"As-built drawings received & verified",m:true},{c:"Documentation",t:"Single Line Diagrams (SLD) verified",m:true},
 {c:"Documentation",t:"O&M manuals handed over",m:false},{c:"Documentation",t:"Statutory approvals (net-metering, grid, fire NOC)",m:true},
 {c:"Physical asset verification",t:"Inverter count & serial numbers logged",m:true},{c:"Physical asset verification",t:"Module count verified against BOQ",m:false},
 {c:"Physical asset verification",t:"Transformer / switchyard inspection completed",m:true},{c:"Physical asset verification",t:"CCTV, fencing & signage verified",m:true},
 {c:"Electrical safety",t:"Earthing pit checks logged",m:false},{c:"Electrical safety",t:"DC/AC cable routing & labeling verified",m:true},
 {c:"Electrical safety",t:"Protection relay settings verified",m:false},{c:"Spares & tools handover",t:"Initial spares inventory received from EPC",m:false},
 {c:"Spares & tools handover",t:"Tools / equipment left on site logged",m:false},{c:"Access & credentials",t:"SCADA login credentials issued",m:false},
 {c:"Access & credentials",t:"Gate keys / access cards handed over",m:false},{c:"Manpower & site readiness",t:"Safety signage installed",m:true},
 {c:"Manpower & site readiness",t:"First-aid kit & PPE availability confirmed",m:false}];
const ASSIGNEES=[];
const ASSIGNEE_NAMES=[];
function mkItem(id,c,t,m,assignee,due,status,ev){return{id,category:c,title:t,mandatory:m,assignee,due,status,evidence:ev||0,priority:m?"Critical":"Normal",instructions:"Follow the approved site SOP and attach the required evidence.",reworkNote:null,naJustification:null,custom:false}}
function seedHandover(){return[]}
const HO_ST={in_progress:"In Progress",pending_checklist:"Pending Checklist",active_om:"Active O&M",pending_approval:"Pending Approval"};
const ITEM_ST={completed:"Completed",submitted:"Pending Review",in_progress:"In Progress",not_started:"Not Started",na:"N/A",rejected:"Changes Requested"};
const TASK_TYPES=[
 {name:"Inverter",vertical:"Inverter",sub:["Fan / filter cleaning","Alarm & fault-history review","DC / AC terminal torque check","Insulation resistance reading","Firmware / communication health"]},
 {name:"Module",vertical:"Module",sub:["Visual crack / hotspot inspection","Connector & junction check","Clamp / mounting check","Thermal scan where required","Cleaning / soiling observation"]},
 {name:"Transformer",vertical:"Transformer",sub:["Oil level / leakage inspection","BDV / moisture / DGA test as scheduled","Bushing & breather inspection","Protection / temperature checks","Earthing & terminal tightening"]},
 {name:"Aux. Transformer",vertical:"Aux. Transformer",sub:["Oil / enclosure inspection","Bushing & cable check","Voltage / current reading","Protection check","Earthing continuity"]},
 {name:"VCB Panel",vertical:"VCB Panel",sub:["Breaker mechanical operation","Contact / terminal inspection","Relay & trip-circuit test","Spring charging mechanism","Interlock / indication check"]},
 {name:"VCB-Kiosk",vertical:"VCB-Kiosk",sub:["Breaker & relay check","Kiosk enclosure / heater inspection","Cable termination thermal scan","Interlock / annunciation check","Earthing check"]},
 {name:"ACCB Panel",vertical:"ACCB Panel",sub:["Breaker operation check","Busbar / terminal thermal scan","Protection & metering check","Cable gland / lug inspection","Panel cleaning"]},
 {name:"Switchyard - Plant side",vertical:"Switchyard - Plant side",sub:["Isolator / earth switch operation","CT / PT / insulator inspection","Breaker / structure check","Hotspot / corona inspection","Earthing & yard housekeeping"]},
 {name:"Switchyard - GSS side",vertical:"Switchyard - GSS side",sub:["Isolator / earth switch operation","CT / PT / insulator inspection","Breaker / termination check","Hotspot / corona inspection","Interface / metering coordination check"]},
 {name:"Transmission line",vertical:"Transmission line",sub:["Line patrol","Conductor / sag inspection","Insulator / jumper inspection","Tower / pole / foundation inspection","Vegetation & ROW clearance"]},
 {name:"RMS",vertical:"RMS",sub:["Communication availability","Data-gap / timestamp review","Router / modem / network check","Power / UPS backup check","Portal value validation"]},
 {name:"WMS",vertical:"WMS",sub:["Sensor cleaning","Irradiance / temperature sensor validation","Communication check","Calibration comparison","Mounting / cable inspection"]},
 {name:"CCTV",vertical:"CCTV",sub:["Camera feed check","Lens / housing cleaning","NVR / DVR recording & storage check","UPS / network check","Coverage / night-vision verification"]},
 {name:"Boundary wall",vertical:"Boundary wall",sub:["Wall / fencing patrol","Crack / settlement inspection","Gate / access check","Breach / damage repair review","Drainage / erosion observation"]},
 {name:"String",vertical:"String",sub:["String-current comparison","Fuse / SPD / connector check","IV curve / insulation test as scheduled","Cable / termination inspection","Underperformance tagging"]},
 {name:"Earthing",vertical:"Earthing",sub:["Earth-pit condition","Resistance measurement","Connection tightening","Corrosion check","Watering / treatment where applicable"]},
 {name:"LA",vertical:"LA",sub:["Visual condition","Counter reading","Connection tightening","Earth continuity","Post-lightning inspection"]},
 {name:"Water pipe line",vertical:"Water pipe line",sub:["Leak / blockage inspection","Pump / valve operation","Pressure / flow observation","Joint / support inspection","Repair / flushing requirement"]},
 {name:"Vegetation",vertical:"Vegetation",sub:["Grass / weed cutting","Module shading check","Fire-risk / dry biomass removal","ROW / access clearing","Waste disposal"]},
 {name:"Modules cleaning",vertical:"Modules cleaning",sub:["Cleaning schedule confirmation","Water quality / availability","Table / string completion check","Damage observation during cleaning","Exception / reschedule logging"]},
 {name:"ABT meters",vertical:"ABT meters",sub:["Meter reading validation","RTC / time sync","Seal / wiring inspection","Communication availability","Energy-data reconciliation"]},
 {name:"Street Light",vertical:"Street Light",sub:["Fixture operation","Timer / controller check","Cable / pole inspection","Earthing check","Night operation verification"]},
 {name:"MMS",vertical:"MMS",sub:["Bolt / torque inspection","Corrosion / coating check","Foundation / settlement inspection","Alignment / tracker check","Structural damage inspection"]},
  {name:"MCCB",vertical:"MCCB",sub:["Visual / thermal inspection","Terminal tightening","Trip and manual operation test","Rating / label verification","Panel cleaning"]},
  {name:"OLTC(RTCC)",vertical:"OLTC(RTCC)",sub:["Tap-changer position / indication check","Auto-manual mode operation","Control wiring and relay inspection","Communication / SCADA signal check","Panel cleaning"]},
  {name:"4 Pole",vertical:"4 Pole",sub:["Structure and foundation inspection","Insulator / jumper inspection","Earthing connection check","Hardware tightening","Hotspot / corona inspection"]},
  {name:"VCB - GSS side",vertical:"VCB - GSS side",sub:["Breaker mechanical operation","Contact / terminal inspection","Relay & trip-circuit test","Spring charging mechanism","Interlock / indication check"]},
  {name:"BIKE",vertical:"BIKE",sub:[
   "Bike Not Starting",
   "Accident / Body Damage",
   "Functional check",
   "Engine Problem",
   "Corrective action review"
 ]},

 {name:"Piling and Foundation",vertical:"Piling and Foundation",sub:[
   "Foundation inspection",
   "Pile condition check",
   "Settlement / alignment check",
   "Crack / damage inspection",
   "Corrective action review"
 ]},
 
 {name:"Other",vertical:"Other",sub:["Define task-specific checklist","Capture measurements / readings","Attach photo / video evidence","Record remarks / anomalies","Escalate problem to Issue if required"]}
];
/* Maintenance Scope Library grouping. Organisation/filtering only: Add PM task and Add PM template still list EVERY type.
   Any type not listed here (including types added later) falls into Miscellaneous. */
const SCOPE_DEFAULTS={
 pv:["Inverter","Piling and Foundation","WMS"],
 plant:["ACCB Panel","VCB Panel","MCCB","Transformer","Aux. Transformer","OLTC(RTCC)","RMS","Earthing","ABT meters","LA","CCTV"],
 gss:["VCB - GSS side","4 Pole","Transmission line"],
 hidden:["Module","String","Modules cleaning","MMS","Switchyard - Plant side","Switchyard - GSS side","VCB-Kiosk"]};
const SCOPE_SECTIONS=[
 {key:"pv",title:"PV Area / Photovoltaic Area",types:SCOPE_DEFAULTS.pv.slice()},
 {key:"plant",title:"Plant Side",types:SCOPE_DEFAULTS.plant.slice()},
 {key:"gss",title:"GSS Side",types:SCOPE_DEFAULTS.gss.slice()},
 {key:"misc",title:"Miscellaneous",types:null}
];
/* Hidden = not offered in Add PM task / Add PM template / the scope library (data and washing are untouched). O&M Head can edit this. */
let PM_HIDDEN=SCOPE_DEFAULTS.hidden.slice();
function pmTypeVisible(n){return PM_HIDDEN.indexOf(n)<0}
function applyScopeConfig(c){
 const d=c&&c.customised?c:{sections:SCOPE_DEFAULTS,hidden:SCOPE_DEFAULTS.hidden};
 SCOPE_SECTIONS.forEach(s=>{if(s.types)s.types=(d.sections[s.key]||[]).slice()});
 PM_HIDDEN=(d.hidden||[]).slice();
}
function scopeSectionOf(name){const s=SCOPE_SECTIONS.find(x=>x.types&&x.types.indexOf(name)>=0);return s?s.title:"Miscellaneous"}
const TVERT={};TASK_TYPES.forEach(t=>TVERT[t.name]=t.vertical);
const TSUB={};TASK_TYPES.forEach(t=>TSUB[t.name]=t.sub);
const ESC_M=[{d:1,a:"Reminder sent to assignee"},{d:3,a:"Supervisor notified"},{d:7,a:"O&M Head notified"}];
function seedTasks(){return[]}
const WASH_TEAM={};
const WASH_FREQ={};
const WASH_TH=85;
function buildTables(plant,ninv,tpi,team){
 const rows=[];
 for(let inv=1;inv<=ninv;inv++)for(let t=1;t<=tpi;t++)rows.push({id:uid("TBL"),plant,inv,invSecondary:null,tableId:"INV-"+pad2(inv)+"-T-"+pad2(t),history:[],rescheduledTo:null,nextDue:null});  /* history starts empty = never washed; filled only by real wash logs */
 return rows;
}
function seedWashing(){const rows=[];Object.keys(WASH_TEAM).forEach(p=>{rows.push(...buildTables(p,6,4,WASH_TEAM[p]))});return rows}
const EXC_REASONS=["Rain","Water shortage","Equipment breakdown","Access restriction","Safety stand-down","Other"];
const VERTICALS=["Inverter", "Module", "Transformer", "Aux. Transformer", "VCB Panel", "VCB-Kiosk", "ACCB Panel", "Switchyard - Plant side", "Switchyard - GSS side", "Transmission line", "RMS", "WMS", "CCTV", "Boundary wall", "String", "Earthing", "LA", "Water pipe line", "Vegetation", "Modules cleaning", "ABT meters", "Street Light", "MMS", "Other", "MCCB", "OLTC(RTCC)", "4 Pole", "VCB - GSS side"];
/* old category names (saved data from earlier versions) -> new vertical list */
const VERT_MIGRATE={"Module/String":"Module","Combiner Box":"String","SCADA/Monitoring":"RMS","Civil/Structural":"Boundary wall","Security":"CCTV","Grid/Evacuation":"Transmission line","Weather Damage":"Other"};
const SUBCATS={"Inverter": ["Fault code", "Communication loss", "Fan failure", "IGBT failure", "FirmWare"], "Module": ["Hotspot", "Glass breakage", "Delamination / discolouration", "Connector burn"], "Transformer": ["Oil leak", "DGA abnormality", "Bushing", "Tap changer"], "Aux. Transformer": ["Oil leak", "Tripping", "Bushing"], "VCB Panel": ["Breaker trip", "Relay fault", "Spring charging failure", "Terminal heating"], "VCB-Kiosk": ["Breaker trip", "Relay fault", "Door / enclosure damage"], "ACCB Panel": ["Breaker trip", "Terminal heating", "Metering fault"], "Switchyard - Plant side": ["Isolator fault", "CT / PT issue", "Insulator damage", "Earth switch"], "Switchyard - GSS side": ["Isolator fault", "CT / PT issue", "Insulator damage", "Breaker"], "Transmission line": ["Feeder trip", "Conductor damage", "Insulator damage", "Tower / pole damage"], "RMS": ["Communication loss", "Data gap", "Sensor failure"], "WMS": ["Sensor failure", "Communication loss", "Data gap", "Calibration"], "CCTV": ["Camera outage", "DVR / NVR failure", "Recording gap"], "Boundary wall": ["Crack / settlement", "Collapse", "Fence breach"], "String": ["Fuse failure", "String underperformance", "Terminal loose", "Cable damage"], "Earthing": ["High resistance", "Pit damage", "Loose connection"], "LA": ["Lightning strike damage", "Loose connection", "Counter fault"], "Water pipe line": ["Leakage", "Blockage", "Pump failure"], "Vegetation": ["Overgrowth", "Shading on modules", "Fire risk"], "Modules cleaning": ["Missed cleaning", "Water shortage", "Equipment failure"], "ABT meters": ["Communication loss", "Meter fault", "Data mismatch"], "Street Light": ["Fixture failure", "Cable fault", "Timer / control fault"], "MMS": ["Structure corrosion", "Loose bolts", "Foundation damage", "Tracker fault"], "Other": ["Other"]};
/* Issues have two levels, Critical and Medium. Older records may say High (= Critical) or Low (= Medium).
   A resolved or closed issue is shown as the green "Solved" level instead of its old priority (issueLevel). */
const SEV=["Critical","Medium"];
const SEV_RANK={Critical:0,Medium:1,Solved:2};
const ETC_HRS={Critical:48,Medium:96};
const ISSUE_LEVELS=["Critical","Medium","Solved"];
const SEV_COLOR={Critical:"#DC4C3E",Medium:"#3B82F6",Solved:"#16A34A"};
function normalizeIssueSeverity(severity){const s=String(severity==null?"":severity).trim().toLowerCase();return s==="critical"||s==="high"?"Critical":s==="medium"||s==="low"?"Medium":severity}
function isCriticalIssue(issue){return normalizeIssueSeverity(issue&&issue.severity)==="Critical"}
function issueSolved(issue){return !!issue&&(issue.status==="Resolved"||issue.status==="Closed")}
function issueLevel(issue){return issueSolved(issue)?"Solved":(normalizeIssueSeverity(issue&&issue.severity)||"Medium")}
function etcHrs(sev){const n=Number(ETC_HRS[normalizeIssueSeverity(sev)]);return Number.isFinite(n)&&n>0?n:48}
function sevOpts(sel){const v=normalizeIssueSeverity(sel);return SEV.map(s=>'<option'+(v===s?" selected":"")+'>'+s+'</option>').join("")}
const VERT_BASE={};
const TEAM_POOL=[];
const ISSUE_ASSIGNEES=[];
const SITE_ENG_POOL=[]; /* Site Engineers only (not O&M team assignees) — drives Performance, Work/Assignments and washing crew lists */
function seedIssues(){return[]}
function slaState(tk){if(tk.status==="Closed"||tk.status==="Resolved")return null;if(!tk.etc)return null;const left=hrsBetween(NOW_ISO,tk.etc);if(!Number.isFinite(left))return null;if(left<0)return"breach";if(isCriticalIssue(tk)&&left<=24)return"nearing";return null}
function openTk(ts){return ts.filter(t=>t.status!=="Closed"&&t.status!=="Resolved")}
function issueDay(t){const s=s91DayOf(t.occurred||t.created||t.updated||"");return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:TODAY}
function issueCreatedDay(t){const s=String(t.created||t.created_at||"").slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:null}
function issueAgeDays(t){const d=issueDay(t);return d?Math.max(0,dayDiff(d,TODAY)):0}
function ageBucket(t){const d=issueAgeDays(t);if(d<=1)return"0–1 days";if(d<=3)return"2–3 days";if(d<=7)return"4–7 days";if(d<=14)return"8–14 days";return"15+ days"}
function isOverdueIssue(t){return slaState(t)==="breach"}
function plantRec(name){return (S.plants||[]).find(p=>p.name===name)}
function plantProject(p){if(!p)return"";return p.project||((XL_BY[p.id]&&XL_BY[p.id].projectCompany)||"")}
function plantHealth(p){return plantHealthOf(p,S.issues)}
function plantEngineer(p){const counts={};(S.issues||[]).filter(t=>t.plant===p.name&&t.assignee).forEach(t=>counts[t.assignee]=(counts[t.assignee]||0)+1);const top=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];if(top)return top[0];const w=S.washMeta&&S.washMeta[p.name];return (w&&w.team&&w.team[0])||p.engineer||""}
function plantLastActivity(p){const hits=(S.issues||[]).filter(t=>t.plant===p.name).map(t=>t.updated||t.created||"");const aud=(S.audit||[]).filter(a=>String(a.text||"").includes(p.name)).map(a=>a.at);return hits.concat(aud)[0]||""}
function blankIssF(extra){return Object.assign({plant:"all",sev:"all",vert:"all",from:"",to:"",assignee:"all",status:"all",sort:"etc",q:"",site:"all",project:"all",equip:"all",aging:"all",chip:"all",maker:"all",bucket:"all",health:"all"},extra||{})}
function emptyState(title,note){return '<div class="empty-box"><b>'+esc(title)+'</b>'+esc(note||"")+'</div>'}
function equipmentAliases(e){
 return [e&&e.id,e&&e.equipment_code,e&&e.equipment_name,e&&e.serial_number].map(v=>String(v||"").trim().toLowerCase()).filter(Boolean);
}
function equipmentFilterMatches(reference,filter,plant){
 if(!filter||filter==="all")return true;
 filter=String(filter);
 const value=String(reference||"").trim().toLowerCase();
 if(!value)return false;
 let aliases=[];
 if(filter.indexOf("eq:")===0){
  const e=(S.equipment||[]).find(x=>"eq:"+x.id===filter);
  const ePlant=e&&(S.plants||[]).find(p=>String(p.dbId||p.id)===String(e.plant_id));
  if(plant&&ePlant&&plant!==ePlant.name)return false;
  aliases=e?equipmentAliases(e):[];
 }else if(filter.indexOf("ref:")===0){
  const parts=filter.slice(4).split("|");
  if(parts.length>1){
   const plantId=decodeURIComponent(parts.shift());
   const refPlant=(S.plants||[]).find(p=>String(p.dbId||p.id)===plantId);
   if(plant&&refPlant&&plant!==refPlant.name)return false;
   aliases=[decodeURIComponent(parts.join("|")).trim().toLowerCase()];
  }else aliases=[parts[0].trim().toLowerCase()];
 }else aliases=[filter.trim().toLowerCase()];
 return aliases.includes(value);
}
function ccEquipmentCategory(filter){
 return String(filter||"").indexOf("type:")===0?String(filter).slice(5):"";
}
function ccEquipmentCategoryMatches(category,record,plant){
 const wanted=String(category||"").trim().toLowerCase();
 if(!wanted)return false;
 const values=[record&&record.type,record&&record.vertical,record&&record.equip,record&&record.name].map(v=>String(v||"").trim().toLowerCase());
 if(values.includes(wanted))return true;
 const reference=String(record&&record.equip||"").trim().toLowerCase();
 if(!reference)return false;
 return (S.equipment||[]).some(e=>{
  const ePlant=(S.plants||[]).find(p=>String(p.dbId||p.id)===String(e.plant_id));
  return (!plant||!ePlant||plant===ePlant.name)&&equipmentAliases(e).includes(reference)&&
   [e.equipment_type,e.equipment_name].some(v=>String(v||"").trim().toLowerCase()===wanted);
 });
}
function ccDashboardEquipmentMatches(record,filter){
 if(!filter||filter==="all")return true;
 const category=ccEquipmentCategory(filter);
 if(category)return ccEquipmentCategoryMatches(category,record,record&&record.plant);
 return equipmentFilterMatches(record&&record.equip,filter,record&&record.plant);
}
function equipmentFilterLabel(filter){
 if(ccEquipmentCategory(filter))return ccEquipmentCategory(filter)+" · PM category";
 if(filter&&filter.indexOf("eq:")===0){
  const e=(S.equipment||[]).find(x=>"eq:"+x.id===filter);
  if(e)return [e.equipment_code,e.equipment_name].filter(Boolean).join(" · ")||"Equipment";
 }
 if(filter&&filter.indexOf("ref:")===0){
  const parts=filter.slice(4).split("|");
  if(parts.length>1){
   const id=decodeURIComponent(parts.shift()),value=decodeURIComponent(parts.join("|"));
   const p=(S.plants||[]).find(x=>String(x.dbId||x.id)===id);
   return value+(p?" · "+(p.id||p.name):"");
  }
 }
 return String(filter||"").replace(/^ref:/,"");
}
function dashboardEquipmentOptions(plant){
 const visiblePlants=dashScope().filter(p=>!plant||plant==="all"||p.name===plant);
 const visibleNames=new Set(visiblePlants.map(p=>p.name));
 const visibleIds=new Set(visiblePlants.map(p=>String(p.dbId||p.id)));
 const options=[],known=new Set();
 (TASK_TYPES||[]).forEach(type=>options.push({value:"type:"+type.name,label:type.name+" · PM category"}));
 (S.equipment||[]).filter(e=>visibleIds.has(String(e.plant_id))).forEach(e=>{
  const aliases=equipmentAliases(e);
  const p=visiblePlants.find(x=>String(x.dbId||x.id)===String(e.plant_id));
  aliases.forEach(a=>known.add(JSON.stringify([p&&p.name,a])));
  const label=[e.equipment_code,e.equipment_name,e.equipment_type,e.maker,p&&p.id].filter(Boolean).join(" · ");
  options.push({value:"eq:"+e.id,label:label||"Equipment"});
 });
 const addReference=(reference,recordPlant)=>{
  const value=String(reference||"").trim();
  if(!value||value==="—"||!visibleNames.has(recordPlant))return;
  const p=visiblePlants.find(x=>x.name===recordPlant);
  const key=JSON.stringify([recordPlant,value.toLowerCase()]);
  if(known.has(key))return;
  known.add(key);options.push({value:"ref:"+encodeURIComponent(String(p.dbId||p.id))+"|"+encodeURIComponent(value),label:value+" · "+(p.id||p.name)});
 };
 (S.issues||[]).forEach(t=>addReference(t.equip,t.plant));
 (S.tasks||[]).forEach(t=>addReference(t.equip,t.plant));
 (S.washing||[]).forEach(t=>addReference("INV-"+pad2(t.inv),t.plant));
 return options.sort((a,b)=>a.label.localeCompare(b.label));
}
function ccPlantSearchScope(){
 const isSE=(S._roleLabel||S.currentRole)==="Site Engineer";
 if(isSE&&S._sePlant){
  const mine=S.plants.filter(p=>p.name===S._sePlant||p.id===S._sePlant);
  if(mine.length)return mine;
 }
 return S.plants||[];
}
function ccOpsDonut(total,segments,label){
 const visible=total?segments.filter(segment=>segment.value>0):[];
 let progress=0;
 const arcs=visible.map(segment=>{
  const start=progress;
  progress+=segment.value/total*360;
  const gap=Math.min(1,((progress-start)*0.12));
  const action=segment.act?' class="cc-ops-arc" role="button" tabindex="0" data-act="'+segment.act+'" data-id="'+esc(segment.id||segment.label)+'" aria-label="'+esc(segment.label+": "+segment.value+" — open filtered register")+'"':"";
  return '<path d="'+donutSlicePath(64,64,60,46,start+gap,progress-gap)+'" fill="'+segment.color+'"'+action+'><title>'+esc(segment.label+": "+segment.value)+'</title></path>';
 });
 const ring=arcs.length?'<svg viewBox="0 0 128 128" aria-hidden="false">'+arcs.join("")+'</svg>':'<div class="cc-ops-empty-ring" aria-hidden="true"></div>';
 return '<div class="cc-ops-donut" role="group" aria-label="'+esc(total+" "+label)+'">'+ring+'<div><b>'+total+'</b><span>'+esc(label)+'</span></div></div>';
}
function scrollToDashboardRegister(selector){
 let attempts=0;
 (function locate(){
  const register=document.querySelector(selector||"#section-results, .pml-register, #wc-register");
  if(!register&&attempts++<12){setTimeout(locate,90);return}
  if(register)register.scrollIntoView({behavior:"smooth",block:"start"});
 })();
}
function openDashboardIssueQueue(queue){
 const f=S.issF||blankIssF(),role=S._roleLabel||S.currentRole;
 const plant=role==="Site Engineer"&&S._sePlant?S._sePlant:(f.plant||"all");
 S.issF=blankIssF({plant:plant,equip:f.equip||"all",maker:f.maker||"all",queue:queue});
 S.tablePages.issues=1;
 goTab("issues");
 scrollToDashboardRegister();
}
function openDashboardPmQueue(queue){
 const f=S.issF||blankIssF(),role=S._roleLabel||S.currentRole;
 S.schedScope=role==="Site Engineer"&&S._sePlant?S._sePlant:(f.plant&&f.plant!=="all"?f.plant:"all");
 S.schedF=Object.assign({},S.schedF||{},{asset:"all",dashEquip:f.equip||"all",queue:queue});
 S.tablePages.scheduled=1;
 // The 2026 PM register owns its own filter state, so sync classic Command Centre clicks.
 const live=S.pmLive||(S.pmLive={});
 Object.assign(live,{plant:S.schedScope||"all",status:queue==="overdue"?"Overdue":queue==="due7"?"Due soon":queue==="upcoming"?"Upcoming":"all",equipment:"all",week:"all",age:"all",page:1});
 goTab("scheduled");
 scrollToDashboardRegister(".pml-register");
}
function setDashboardPlantFilter(value){
 const plant=value==="all"?"all":ccPlantSearchScope().find(p=>p.name===value)?.name;
 if(!plant)return;
 S.issF.plant=plant;
 S.dashPlant=plant;
 S.issF.equip="all";
 S.tablePages.issues=1;
 render();
}
function setDashboardEquipmentFilter(value){
 const options=dashboardEquipmentOptions((S.issF||{}).plant);
 if(value!=="all"&&!options.some(option=>option.value===value))return;
 S.issF.equip=value;
 S.tablePages.issues=1;
 render();
}

function polar(cx,cy,r,deg){const a=(deg-90)*Math.PI/180;return[cx+r*Math.cos(a),cy+r*Math.sin(a)]}
function donutSlicePath(cx,cy,ro,ri,a0,a1){
 const sweep=Math.max(0.01,Math.min(359.999,a1-a0));a1=a0+sweep;const large=sweep>180?1:0;
 if(sweep>=359.9)return "M "+cx+" "+(cy-ro)+" A "+ro+" "+ro+" 0 1 1 "+cx+" "+(cy+ro)+" A "+ro+" "+ro+" 0 1 1 "+cx+" "+(cy-ro)+" M "+cx+" "+(cy-ri)+" A "+ri+" "+ri+" 0 1 0 "+cx+" "+(cy+ri)+" A "+ri+" "+ri+" 0 1 0 "+cx+" "+(cy-ri);
 const p0=polar(cx,cy,ro,a0),p1=polar(cx,cy,ro,a1),p2=polar(cx,cy,ri,a1),p3=polar(cx,cy,ri,a0);
 return "M "+p0[0].toFixed(2)+" "+p0[1].toFixed(2)+" A "+ro+" "+ro+" 0 "+large+" 1 "+p1[0].toFixed(2)+" "+p1[1].toFixed(2)+" L "+p2[0].toFixed(2)+" "+p2[1].toFixed(2)+" A "+ri+" "+ri+" 0 "+large+" 0 "+p3[0].toFixed(2)+" "+p3[1].toFixed(2)+" Z";
}


function issueClosedDay(t){if(t.closure&&t.closure.closedAt)return String(t.closure.closedAt).slice(0,10);if(t.status==="Resolved"||t.status==="Closed")return String(t.updated||t.created||"").slice(0,10)||null;return null}
function issueTrendRows(days,list,from,to){
 const createdByDay=new Map(),closedByDay=new Map(),backlogClosuresByDay=new Map();
 let latest=s91ValidDate(TODAY)?TODAY:s91BusinessDate();
 (Array.isArray(list)?list:(S.issues||[])).forEach(t=>{
  if(!t||typeof t!=="object")return;
  const created=issueCreatedDay(t),closed=issueClosedDay(t);
  if(s91ValidDate(created)){
   createdByDay.set(created,(createdByDay.get(created)||0)+1);
   if(created>latest)latest=created;
  }
  if(s91ValidDate(closed)){
   closedByDay.set(closed,(closedByDay.get(closed)||0)+1);
   if(closed>latest)latest=closed;
   if(s91ValidDate(created)&&created<=closed)
    backlogClosuresByDay.set(closed,(backlogClosuresByDay.get(closed)||0)+1);
  }
 });
 const period=Math.min(366,Math.max(1,Number.isFinite(Number(days))?Math.trunc(Number(days)):14));
 const end=s91ValidDate(to)?to:latest;
 let start=s91ValidDate(from)?from:addDays(end,-period+1);
 if(start>end)return [];
 if(dayDiff(start,end)>365)start=addDays(end,-365);
 let open=0;
 createdByDay.forEach((count,d)=>{if(d<start)open+=count});
 backlogClosuresByDay.forEach((count,d)=>{if(d<start)open-=count});
 const rows=[];
 for(let d=start;d<=end&&rows.length<366;d=addDays(d,1)){
  open+=(createdByDay.get(d)||0)-(backlogClosuresByDay.get(d)||0);
  rows.push({d,o:createdByDay.get(d)||0,c:closedByDay.get(d)||0,open:Math.max(0,open)});
 }
 return rows;
}

function statusBucket(t){if(t.status==="Closed")return"Closed";if(t.status==="Resolved")return"Resolved";if(t.status==="Assigned")return"Assigned";if(t.status==="Open")return"Open";return"In Progress"}
function plantHealthOf(p,issues){const oi=openTk((issues||S.issues||[]).filter(t=>t.plant===p.name));const crit=oi.some(t=>t.severity==="Critical");const od=oi.filter(isOverdueIssue).length;if(crit||od>=2||oi.length>=3)return"Critical";if(oi.length)return"Warning";return"Healthy"}
function stayFilter(patch){S.issF=Object.assign(blankIssF(),S.issF||{},patch||{});S.tablePages.issues=1;persist();render()}
function toggleStay(field,val,extra){const cur=(S.issF||{})[field];const next=cur===val?"all":val;stayFilter(Object.assign({},extra||{},{[field]:next}))}
function ccFilterActive(){const f=S.issF||blankIssF();return["plant","maker","chip","sev","vert","status","bucket","assignee","health"].some(k=>f[k]&&f[k]!=="all")||!!f.from||!!f.to||!!(f.q)||!!f.queue||(S.plF&&S.plF.health&&S.plF.health!=="all")}
function wfStrip(st,id){
 const steps=["Open","Assigned","Acknowledged","In Progress","Resolved","Closed"];
 const ix=steps.indexOf(st);
 return '<div class="wf" title="'+(id?'O&M Head status control':'')+'">'+steps.map((s,i)=>
  '<span class="'+(i<=ix&&ix>=0?"on":"")+'" '+(id?'onclick="event.stopPropagation();omHeadMoveTicket(\''+esc(id)+'\',\''+esc(s)+'\')"':'')+'>'+s+'</span>'
 ).join("")+'</div>'
}
function omHeadMoveTicket(id,next){
 const t=(S.issues||[]).find(x=>x.id===id);
 if(!t)return;
 if(OM_HEAD!=="Arun Agarwal"){toast("Only O&M Head can change ticket stage.");return;}
 const order=["Open","Assigned","Acknowledged","In Progress","Resolved","Closed"];
 const old=t.status;
 if(old===next)return;
 const oldIndex=order.indexOf(old), newIndex=order.indexOf(next);
 if(newIndex<0)return;
 let note="";
 if(next==="Assigned"){
   note="Ticket assigned by O&M Head"+(t.assignee?" to "+t.assignee:"");
 }else if(next==="Acknowledged"){
   note="Ticket acknowledged by "+(t.assignee||"assignee");
 }else if(next==="In Progress"){
   note="Work started by "+(t.assignee||"assignee");
 }else if(next==="Resolved"){
   note="Issue marked resolved by O&M Head — awaiting verification";
   t.closure=t.closure||{rootCause:"Pending update",corrective:"Pending update",photos:0,resolutionHrs:0};
 }else if(next==="Closed"){
   note="Ticket closed by O&M Head after verification";
   t.closure=t.closure||{};
   t.closure.closedAt=stampISO();
   t.closure.verifiedBy=OM_HEAD;
 }else{
   note="Ticket reopened by O&M Head";
 }
 t.status=next;
 t.updated=stampISO();
 t.progress=[{at:stampISO(),note:note,parts:"—",hrs:0}].concat(t.progress||[]);
 audit("Issues","Workflow change "+id+" : "+old+" → "+next,OM_HEAD,old,next);
 persist();
 render();
 toast("Ticket moved to "+next);
}
/* Row actions are handled by the page-level data-act listener, which acts on the innermost [data-act] (the button,
   not the row). The wrapper used to call event.stopPropagation(), which blocked that listener: View, Assign and
   Plant did nothing when clicked from issue rows. */
function issueQuickActs(t){const p=plantRec(t.plant),isHead=AUTH_IDENTITY.role==="O&M Head";let a='<div class="row" style="gap:4px;flex-wrap:wrap" data-row-actions="1">';a+='<button class="btn g sm" data-act="issue" data-id="'+esc(t.id)+'">View</button>';if(isHead&&t.status!=="Closed"&&t.status!=="Resolved")a+='<button class="btn o sm'+(t.assignee?'':' si-act-main')+'" data-act="assignQuick" data-id="'+esc(t.id)+'">'+(t.assignee?"Reassign":"Assign")+'</button>';if(p)a+='<button class="btn g sm" data-act="plant" data-id="'+esc(p.id)+'">Plant</button>';return a+'</div>'}
function setTrendDays(n){S.trendDays=n;render()}
function seedESR(){return[]}
function seedInventory(){return[]}
function seedMovements(){return[]}
function seedPTW(){return[]}
function seedIncidents(){return[]}
function seedDocs(){return[]}
function seedVendors(){return[]}
function seedRules(){return[
 {id:uid("RUL"),event:"Critical issue created",channel:"Call + SMS + app + email",to:"O&M Head, assignee",tiers:"Immediate",on:true},
 {id:uid("RUL"),event:"Issue nearing ETC (Critical)",channel:"App + email",to:"Assignee, O&M Head",tiers:"At 75% of ETC",on:true},
 {id:uid("RUL"),event:"SLA breach (past ETC)",channel:"App + email + SMS",to:"O&M Head, management",tiers:"Breach, then daily",on:true},
 {id:uid("RUL"),event:"Scheduled task overdue",channel:"App",to:"Assignee",tiers:"1d reminder → 3d supervisor → 7d O&M Head",on:true},
 {id:uid("RUL"),event:"Washing compliance below threshold",channel:"Email",to:"Washing supervisor",tiers:"Weekly check",on:true},
 {id:uid("RUL"),event:"Spares low stock",channel:"App + email",to:"Stores, O&M Head",tiers:"On crossing min",on:true},
 {id:uid("RUL"),event:"Document expiry approaching",channel:"App + email",to:"Document owner",tiers:"30d / 14d / 7d / on expiry",on:true},
 {id:uid("RUL"),event:"Task anomaly flagged on completion",channel:"App + email",to:"O&M Head",tiers:"Immediate",on:false}];}
const ROLES=[
 {role:"O&M Head",handover:"Full · approve / reject",sched:"Full · create / assign / execute / approve",washing:"Full · setup / log / exceptions",issues:"Full · assign / progress / close",docs:"Full",scope:"Portfolio"},
 {role:"Assignee",handover:"Execute assigned items",sched:"Execute assigned maintenance",washing:"Log assigned / field work",issues:"Assigned tickets · raise / progress / resolve",docs:"View",scope:"Assigned work · portfolio"},
 {role:"Administration",handover:"Dashboard / reports only",sched:"Read-only reporting",washing:"Read-only reporting",issues:"Read-only reporting",docs:"Read-only reporting",scope:"Executive"},
 {role:"Site Engineer",handover:"Hidden in field view",sched:"Execute plant schedule",washing:"Log plant washing",issues:"Raise / progress / resolve · plant only",docs:"View where linked",scope:"Single plant"}
];
function seedSLA(){return[]}
const WEATHER=[];
function seedQueue(){return[]}
const EQUIP_MTB=[];
function seedAudit(){return[]}
function seedEvents(){return[]}
