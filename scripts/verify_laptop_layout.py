"""Laptop layout check of the real portal: local SQLite test server, synthetic data (40 plants, ~900 PM work orders,
~120 tickets), signed in as the O&M Head. Every main screen is opened at the effective sizes of 14", 15.6" and 16"
laptops (and 1920x1080); the run fails if a page scrolls sideways, content sticks out of the page or top bar, or the
browser reports a JavaScript error. Screenshots are kept for a visual review.

    python scripts/verify_laptop_layout.py                 # all sizes, screenshots in a temp folder
    python scripts/verify_laptop_layout.py 1366x768 --out shots
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time
from datetime import timedelta
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
ARGS = sys.argv[1:]
OUT = Path(ARGS[ARGS.index("--out") + 1]) if "--out" in ARGS else Path(tempfile.mkdtemp(prefix="s91-laptop-shots-"))
SIZES = [tuple(map(int, a.split("x"))) for a in ARGS if "x" in a and a[0].isdigit()] or [(1280, 720), (1366, 768), (1440, 900), (1536, 864), (1728, 1117), (1920, 1080)]
PROBLEMS = []
SDK_STUB = 'window.Clerk={load:async()=>{},session:{getToken:async()=>"t"},signOut:async()=>{}};'

SEED = r'''
import os, random
from datetime import timedelta, datetime, timezone
from app.core.database import Base, SessionLocal, engine
from app.core.models import Plant, Issue, OMTask, Equipment, User
from app.core.timeutil import business_today
Base.metadata.create_all(engine)
random.seed(4)
today = business_today()
types = ["Inverter","ACCB Panel","MCCB","VCB Panel","Transformer","Aux. Transformer","4 Pole","Earthing","Transmission line","VCB - GSS side"]
people = ["Ravi Meena","Anil Kumar","Suresh Jat","Mahesh Gurjar"]
with SessionLocal() as db:
    plants = []
    names = ["Abhaneri","Alaniyawas","Asadi","Avika Nagar","Banasthali","Bohat","Bundi Bijora","Chirai","Deorawas","Dharam Sagar","Gullana","Hadgil Harathi","Halli Maysore","Indora","Ishru Mehteb Dhani","Jakharo Ki Dhani","Jodhyasi","Jogi Magra","Kankarlanada","Kerli Nadi"]
    for i in range(40):
        p = Plant(site_code=f"SL{i+1:03d}", plant_name=f"{names[i % 20]} {i // 20 + 1:02d} Solar Plant", district=random.choice(["Jaipur","Ajmer","Tonk","Bundi"]), dc_capacity_kw=random.randint(1000, 12000), ac_capacity_kw=random.randint(800, 10000), status="active")
        db.add(p); plants.append(p)
    db.flush()
    n = 0
    for p in plants:
        for t in types:
            units = random.randint(6, 14) if t == "Inverter" else random.randint(1, 2)
            for u in range(1, units + 1):
                n += 1
                due = today + timedelta(days=random.randint(-12, 25))
                done = due < today and random.random() < 0.7
                db.add(OMTask(work_order_no=f"PM-{n:05d}", plant_id=p.id, task_name=f"{t} preventive maintenance and torque check", task_type=t, frequency="Monthly",
                              status="Completed" if done else "Scheduled", due_on=due, start_on=due, actual_completed_on=due if done else None,
                              assignee_text=None if random.random() < 0.15 else random.choice(people), unit_no=u if units > 1 else None, total_units=units))
        for k in range(3):
            db.add(Issue(ticket_no=f"ISS-{p.site_code}-{k}", plant_id=p.id, vertical=random.choice(types), description=random.choice(["Inverter tripping on DC earth fault since morning, string 4 isolated","Transformer oil level low, top-up needed","VCB not charging spring after trip","Communication loss on RMS for block B"]),
                         severity=random.choice(["Critical","Medium"]), status=random.choice(["Open","Assigned","In Progress","Resolved"]),
                         assignee_text=random.choice(people), etc_at=datetime.now(timezone.utc) + timedelta(hours=random.randint(-60, 90))))
    db.commit()
print("seeded", n)
'''


def main():
    tmp = tempfile.mkdtemp(prefix="s91-laptop-")
    env = {**os.environ, "SOLAR91_E2E_TEST_MODE": "1", "APP_ENV": "test", "DEBUG": "false", "PM_DAILY_JOB": "0",
           "DATABASE_URL": "sqlite:///" + (Path(tmp) / "l.sqlite3").as_posix(), "SUPABASE_URL": "https://example.invalid",
           "CLERK_PUBLISHABLE_KEY": "pk_test_c2lsdmVyLWV3ZS0yOS5jbGVyay5hY2NvdW50cy5kZXYk", "CLERK_SECRET_KEY": "sk_test_x", "CLERK_ISSUER": "https://silver-ewe-29.clerk.accounts.dev"}
    r = subprocess.run([sys.executable, "-c", SEED], cwd=ROOT, env=env, capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr[-600:])
    assert "seeded" in r.stdout
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "tests.e2e_server:app", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                if json.load(urlopen(base + "/health/ready", timeout=1))["status"] == "ready": break
            except Exception: time.sleep(.2)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(headless=True, executable_path=shutil.which("chromium") or shutil.which("google-chrome"), args=["--no-sandbox"])
            for w, h in SIZES:
                pg = b.new_page(viewport={"width": w, "height": h}, reduced_motion="reduce")
                errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
                pg.route(re.compile(r"https://silver-ewe-29\.clerk\.accounts\.dev/.*"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=SDK_STUB))
                pg.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
                pg.goto(base, wait_until="domcontentloaded"); pg.wait_for_selector(".shell", timeout=30000); pg.wait_for_timeout(800)
                d = OUT / f"{w}x{h}"; d.mkdir(parents=True, exist_ok=True)
                screens = [
                    ("dashboard", "goView('dashboard')"), ("plants", "goView('plants')"), ("issues", "goTab('issues')"),
                    ("ticket", "goTab('issues');openModal('ticket',{id:S.issues[0].id})"),
                    ("pm_overview", "S.pmLive=Object.assign(S.pmLive||{},{view:'overview'});goScheduledOM('maintenance')"),
                    ("pm_calendar", "S.pmLive.view='schedule';goScheduledOM('maintenance')"), ("pm_plants", "S.pmLive.view='plants';goScheduledOM('maintenance')"),
                    ("pm_register", "S.pmLive.view='register';goScheduledOM('maintenance')"), ("washing", "goScheduledOM('washing')"),
                    ("work", "goView('work')"), ("performance", "goView('performance')"), ("reports", "goView('reports')"),
                    ("handover", "goTab('handover')"), ("settings", "goView('settings')"),
                ]
                print(f"== {w}x{h}")
                for name, js in screens:
                    try:
                        pg.evaluate("()=>{S.modal=null;" + js + "}")
                    except Exception as e:
                        print(f"  {name}: navigation failed {str(e)[:80]}"); continue
                    pg.wait_for_timeout(500)
                    pg.screenshot(path=str(d / f"{name}.png"), full_page=False)
                    if name == "dashboard" and pg.locator(".ccx").count():
                        pg.evaluate("document.querySelectorAll('.cc-toast').forEach(t=>t.remove())")
                        pg.locator(".ccx").screenshot(path=str(d / "zz_dashboard_overview_cards.png"))
                    rep = pg.evaluate(OVERFLOW_JS)
                    bad = rep["pageX"] > 0 or rep["clipped"] or rep["topbar"]
                    flag = "  <-- " if bad else ""
                    if bad: PROBLEMS.append(f"{w}x{h} {name}")
                    print(f"  {name:12} pageX={rep['pageX']} clipped={rep['clipped'][:6]} topbar={rep['topbar'][:4]}{flag}")
                if errors:
                    print("  JS errors:", errors[:3]); PROBLEMS.append(f"{w}x{h} JS errors")
                pg.close()
            b.close()
    finally:
        proc.terminate()
    print("screenshots:", OUT)
    if PROBLEMS:
        sys.exit("FAIL: " + ", ".join(PROBLEMS))
    print("PASS: no sideways scroll, clipped content or JS errors at", ", ".join(f"{w}x{h}" for w, h in SIZES))


OVERFLOW_JS = r'''()=>{
 const name=el=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'');
 const inScroller=(el,stop)=>{for(let p=el.parentElement;p&&p!==stop;p=p.parentElement){const cs=getComputedStyle(p);if(/(auto|scroll|hidden|clip)/.test(cs.overflowX)&&p!==stop)return true}return false};
 const report=(root)=>{if(!root)return[];const rr=root.getBoundingClientRect(),seen=new Map();
  root.querySelectorAll('*').forEach(el=>{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return;const cs=getComputedStyle(el);if(cs.position==='fixed'||cs.visibility==='hidden')return;
   if((r.right>rr.right+2||r.left<rr.left-2)&&!inScroller(el,root)){const k=name(el);seen.set(k,Math.max(seen.get(k)||0,Math.round(Math.max(r.right-rr.right,rr.left-r.left))))}});
  return [...seen.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+'+'+v)};
 const modal=document.querySelector('.idk,.modal');
 return {pageX:document.documentElement.scrollWidth-document.documentElement.clientWidth,clipped:report(modal||document.querySelector('.content')),topbar:report(document.querySelector('.topbar'))};
}'''

if __name__ == "__main__":
    main()
