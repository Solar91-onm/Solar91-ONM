"""Browser check for the redesigned Preventive Maintenance page (no server, no credentials, no real data).

Renders frontend/static/js/29-pm-live-dashboard.js with every portal stylesheet and generated data for 40 plants, then
drives the toolbar menus, the view tabs (Overview, Calendar, Plants, Coverage, Work register), KPI/hero filters, the
month calendar and day planner search/status filters, the plants x equipment matrix, the register people filter and sort,
and the Assign dialog against a mocked API (one partial failure, then success). Also checks phone width for sideways scroll.

    python scripts/verify_pm_command_view.py
"""
import json, re, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def extract(path, start):
    s = (ROOT / path).read_text(encoding="utf-8")
    i = s.index(start); j = s.index("{", i); depth = 0
    for k in range(j, len(s)):
        if s[k] == "{": depth += 1
        elif s[k] == "}":
            depth -= 1
            if depth == 0: return s[i:k + 1]
    raise SystemExit("unbalanced " + start)

def harness_html(scenario):
    index = (ROOT / "frontend/templates/index.html").read_text(encoding="utf-8")
    css = re.findall(r'<link rel="stylesheet" href="/static/css/([^"]+)"', index)
    links = "".join(f'<link rel="stylesheet" href="{(ROOT / "frontend/static/css" / c).as_uri()}">' for c in css)
    helpers = "\n".join([
        extract("frontend/static/js/00-auth-data-and-imports.js", "function addDays("),
        extract("frontend/static/js/00-auth-data-and-imports.js", "function esc("),
        extract("frontend/static/js/00-auth-data-and-imports.js", "function fmtD("),
        extract("frontend/static/js/00-auth-data-and-imports.js", "function fmtDT("),
        extract("frontend/static/js/05-preventive-maintenance-and-washing.js", "function pmDisplayTaskName("),
        extract("frontend/static/js/00-auth-data-and-imports.js", "function ic("),
        "const " + extract("frontend/static/js/00-auth-data-and-imports.js", "I={") + ";",
        "const " + extract("frontend/static/js/08-actions-exports-and-submission.js", "CC_TINT={") + ";",
        extract("frontend/static/js/08-actions-exports-and-submission.js", "function ccKpiIcon("),
        extract("frontend/static/js/08-actions-exports-and-submission.js", "function kpiTile("),
    ])

    PLANTS = ["ABH01 Abhaneri 01","ALN01 Alaniyawas 01","ALN02 Alaniyawas 02","ALN03 Alaniyawas 03","ASA01 Asadi","AVK01 Avika Nagar 01",
     "BST01 Banasthali 01","BHT01 Bohat","BND01 Bundi Bijora","CHI01 Chirai 01","DDS01 Deorawas","DMS01 Dharam Sagar 01","DMS02 Dharam Sagar 02",
     "GUL01 Gullana 01","HDG01 Hadgil Harathi","HLM01 Halli Maysore","IND01 Indora","IMS01 Ishru Mehteb Dhani 01","IMS02 Ishru Mehteb Dhani 02",
     "JKD01 Jakharo Ki Dhani 01","JKD02 Jakharo Ki Dhani 02","JOD01 Jodhyasi","JGM01 Jogi Magra 01","KKN01 Kankarlanada 01","KKN03 Kankarlanada 03",
     "KRN01 Kerli Nadi","KHO01 Khorandi","LKT01 Lakheta 01","MNP01 Meenapada 01","MUW01 Muwana","NKD01 Nimeda Ki Dhani","NSR01 Noser 01",
     "PDA01 Padasala 01","PDA03 Padasala 03","PAL01 Palli 01","RJV01 Rajveer Nagar","RAM01 Ram Nagar 01","RRP01 Ramsagar Rampuriya",
     "RNR01 Raneri Village","TNF01 Tinwri Fanta"]
    PHASES = [("Inverter",None,1,7),("ACCB Panel",2,8,9),("MCCB",1,8,9),("VCB Panel",1,10,11),("Transformer",1,12,13),("Aux. Transformer",1,14,15),
     ("4 Pole",1,16,17),("Earthing",1,18,19),("Transmission line",1,23,24),("VCB - GSS side",1,25,26),("4 Pole - GSS side",1,27,28),
     ("Transmission line - GSS side",1,29,30)]
    NAMES = {"Inverter":"Cleaning from blower and checking tightness and fixing the required damage"}

    page_js = """
    const SCEN=%s,PLANTS=%s,PHASES=%s,NAMES=%s;
    window.TODAY=SCEN==="fresh"?"2026-10-25":"2026-11-12";
    const CYCLE="2026-11-01";
    const people=["Ravi Meena","Anil Kumar","Suresh Jat","Mahesh Gurjar"];
    window.TEAM_POOL=people.slice();
    window.S={view:"om-module",omTab:"scheduled",_roleLabel:"O&M Head",currentRole:"O&M Head",tasks:[],plants:PLANTS.map((p,i)=>({id:p.split(" ")[0],dbId:"uuid-"+i,name:p.split(" ").slice(1).join(" ")}))};
    let seq=1,rnd=7;const r=()=>{rnd=(rnd*9301+49297)%%233280;return rnd/233280};
    S.plants.forEach((pl,pi)=>{
     const inv=5+Math.floor(r()*11);
     PHASES.forEach(([type,n,d1,d2])=>{
      const units=n||inv,days=d2-d1+1,perDay=Math.ceil(units/days),cyc="c"+pi+type;
      for(let u=1;u<=units;u++){
       const off=units===1?d2-1:d1-1+Math.floor((u-1)/perDay),due=addDays(CYCLE,off),start=units===1?addDays(CYCLE,d1-1):due;
       let status="Scheduled",assignee=null;
       if(SCEN==="live"){
        assignee=pi%%5===4?null:people[pi%%4];
        if(due<TODAY){status=r()<(pi%%7===3?0.35:0.85)?"Completed":"In Progress"}
        else if(due===TODAY&&r()<0.3)status="In Progress";
       }
       S.tasks.push({id:"PM-"+(seq++),db_id:"db"+seq,plant:pl.name,type,name:(NAMES[type]||type+" preventive maintenance")+" — unit "+u+" of "+units+", day "+(off+1),unitNo:units>1?u:1,totalUnits:units,cycleId:cyc,freq:"Monthly",status,due,start,assignee,completion:status==="Completed"?{delay:0}:null});
      }
     });
    });
    window.esc=esc;window.pmImportPick=()=>{};window.pmOpenUnitCfg=()=>{};window.pmDownloadCsvTemplate=()=>{};window.openProblemScheduledTask=()=>{};window.exportScheduledOMCompliance=()=>{};
    window.renderScheduled=()=>"<p>Legacy</p>";window.renderModal=()=>"";
    window.openModal=(k,c)=>{window._opened={k,c}};window.toast=m=>{window._toast=m};window.closeModal=()=>{};
    window.apiFetch=async uri=>{if(uri.includes("/unit-config"))return {configs:[],register:[]};return []};
    window.render=()=>{document.getElementById("area").innerHTML=renderScheduled()};
    """ % (json.dumps(scenario), json.dumps(PLANTS), json.dumps(PHASES), json.dumps(NAMES))

    html = f"""<!doctype html><html><head><meta charset="utf-8">{links}<style>html,body,.shell,.main,.content{{height:auto!important;max-height:none!important;overflow:visible!important}}</style></head><body>
    <div id="app"><div class="shell"><div class="main"><div class="content"><div class="portal-page-stack" style="max-width:1440px;margin:0 auto;display:flex;flex-direction:column;gap:18px"><div id="area"></div></div></div></div></div></div>
    <script>{helpers}</script><script>{page_js}</script>
    <script src="{(ROOT / 'frontend/static/js/29-pm-live-dashboard.js').as_uri()}"></script>
    <script src="{(ROOT / 'frontend/static/js/41-glance-experience.js').as_uri()}"></script>
    <script>render();</script></body></html>"""
    return html


def run(scenario, tmp):
    harness = Path(tmp) / f"pm_{scenario}.html"
    harness.write_text(harness_html(scenario), encoding="utf-8")
    with sync_playwright() as p:
        args = ["--no-sandbox"] if sys.platform.startswith("linux") else []
        b = p.chromium.launch(headless=True, args=args)
        pg = b.new_page(viewport={"width": 1440, "height": 1000})
        errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(harness.as_uri()); pg.wait_for_timeout(300); pg.evaluate("render()")
        reg = lambda: pg.locator(".pml-consolidated-table tbody tr")
        if scenario=="fresh":
            # menus open, close on outside click and after choosing an item
            pg.click(".pmc-menu summary >> text=Upload plan");assert pg.locator(".pmc-menu[open]").count()==1
            pg.click(".pml-brand");assert pg.locator(".pmc-menu[open]").count()==0
            pg.click(".pmc-menu summary >> text=More");pg.click(".pmc-menu-list >> text=Unit counts");assert pg.locator(".pmc-menu[open]").count()==0
            # opens on the Overview; the day planner lives in the Calendar view
            assert pg.locator(".pmv-tab.on").inner_text().startswith("Overview") and pg.locator(".pmd-row").count()==0
            pg.click("[data-pmv-view=schedule]");assert pg.locator(".pmcal-cell").count()==42
            # day planner: today empty -> jump to the next planned day
            pg.click("[data-pmd-jump]");assert pg.locator(".pmd-row").count()==12,pg.locator(".pmd-row").count()
            assert "Show all 40" in pg.inner_text(".pmd-more")
            pg.click("[data-pmd-all]");assert pg.locator(".pmd-row").count()==40
            pg.fill(".pmd-search","jogi");pg.wait_for_timeout(300);assert pg.locator(".pmd-row").count()==1,pg.locator(".pmd-row").count()
            assert pg.evaluate("document.activeElement.classList.contains('pmd-search')"),"focus kept while typing"
            pg.fill(".pmd-search","");pg.wait_for_timeout(300)
            pg.click("[data-pmd-status=done]");assert pg.locator(".pmd-row").count()==0
            pg.click("[data-pmd-status=all]")
            # hero pill / KPI: unassigned focus filters the register and shows a chip
            pg.click("[data-pmv-view=overview]");pg.click(".pmc-pill.warn");assert pg.locator(".gx-focusbar").count()==1 and "No assignee" in pg.inner_text(".gx-focusbar")
            assert reg().count()==15
            pg.click(".gx-focusbar [data-pml-focus]");assert pg.locator(".gx-focusbar").count()==0
            # assign one group: two PATCH calls succeed, third fails -> partial message, nothing claimed
            pg.evaluate("""()=>{window._patched=[];window.apiFetch=async(uri,opts)=>{if(opts&&opts.method==='PATCH'){window._patched.push(uri);if(window._failAt&&window._patched.length===window._failAt){const e=new Error('Suresh Jat is not assigned to Inverter');throw e}return {assignee:opts.body.assignee}}if(uri.includes('/unit-config'))return {configs:[],register:[]};return []}}""")
            first=reg().first
            n=int(first.locator("td").first.inner_text().split("×")[1].split()[0])
            pg.evaluate("window._failAt=3")
            first.locator("[data-pmc-assign]").click()
            assert pg.locator(".pmc-assign").count()==1
            pg.select_option(".pmc-assign select","Suresh Jat");pg.click(".pmc-assign button[type=submit]")
            pg.wait_for_function("document.querySelector('.pmc-progress').textContent.startsWith('Saved')")
            msg=pg.inner_text(".pmc-progress");assert msg.startswith("Saved 2 of "+str(n)),msg
            assert pg.evaluate("S.tasks.filter(t=>t.assignee==='Suresh Jat').length")==2
            pg.click(".pmc-assign [data-pml-close] >> nth=0");assert pg.locator(".pmc-assign").count()==0
            # retry: all remaining succeed, toast confirms
            pg.evaluate("window._failAt=0;window._patched=[]")
            reg().first.locator("[data-pmc-assign]").click();pg.select_option(".pmc-assign select","Suresh Jat");pg.click(".pmc-assign button[type=submit]")
            pg.wait_for_function("!document.querySelector('.pmc-assign')")
            assert pg.evaluate("window._patched.length")==n-2,pg.evaluate("window._patched.length")
            assert "assigned to Suresh Jat" in pg.evaluate("window._toast")
            assert "Suresh Jat" in reg().first.inner_text() and reg().first.locator("[data-pmc-assign]").count()==0
            # coverage view shows the table
            pg.click("[data-pmv-view=coverage]");assert pg.locator(".pml-coverage-table").count()==1
            assert "not in register" not in pg.inner_text(".pml-coverage-table")
            # people filter + sort
            pg.click("[data-pmv-view=register]")
            pg.select_option('[data-pml-select="person"]',"Suresh Jat");assert reg().count()==1
            pg.select_option('[data-pml-select="person"]',"all")
            pg.select_option('[data-pml-select="sort"]',"plant");assert reg().first.locator("td").nth(1).inner_text().startswith("ABH01")
        else:
            pg.click("[data-pml-status=Overdue] >> nth=0")
            assert reg().count()>0 and all("Overdue" in reg().nth(i).inner_text() for i in range(reg().count()))
            pg.select_option('[data-pml-select="sort"]',"late")
            lates=[reg().nth(i).locator(".pmc-when").inner_text() for i in range(3)]
            assert lates[0].endswith("d late"), lates
            pg.click("[data-pml-action=clear] >> nth=0")
            pg.click("[data-pml-focus=today] >> nth=0");assert "On today’s plan" in pg.inner_text(".gx-focusbar")
            pg.click("[data-pml-action=clear] >> nth=0")
            # plants x equipment: worst plants first, a cell opens that plant + equipment in the register
            pg.click("[data-pmv-view=plants]");assert pg.locator(".pmm-table tbody tr").count()==30
            assert "Show all 40" in pg.inner_text(".pmm .pmd-more")
            pg.fill(".pmm-search","jogi");pg.wait_for_timeout(300);assert pg.locator(".pmm-table tbody tr").count()==1
            assert pg.evaluate("document.activeElement.classList.contains('pmm-search')"),"focus kept while typing"
            pg.fill(".pmm-search","");pg.wait_for_timeout(300)
            cell=pg.locator(".pmm-c.late button").first;plant,typ=cell.get_attribute("data-pmm-cell").split("|");cell.click()
            assert pg.locator(".pmv-tab.on").inner_text().startswith("Work register")
            assert pg.evaluate("[S.pmLive.plant,S.pmLive.equipment]")==[plant,typ]
            assert reg().count()>0 and all(typ in reg().nth(i).inner_text() for i in range(reg().count()))
            pg.click("[data-pml-action=clear] >> nth=0");pg.evaluate("S.pmLive.plant='all';render()")
            # overview: upcoming day opens the calendar on that day
            pg.click("[data-pmv-view=overview]");day=pg.locator("[data-pmup-day]").nth(1).get_attribute("data-pmup-day")
            pg.locator("[data-pmup-day]").nth(1).click()
            assert pg.locator(".pmcal-cell.on").get_attribute("data-pmcal-day")==day and pg.evaluate("S.pmLive.day")==day
            pg.click("[data-pmcal-shift='1']");assert pg.evaluate("S.pmLive.calMonth")>day[:7]
            # finished work older than the loaded history window is labelled, not silently missing
            assert pg.locator(".pmcal-note").count()==0
            pg.evaluate("S.tasksHistoryFrom='2026-10-01';render()")
            assert "since 01 Oct" in pg.inner_text(".gx-kpis")
            pg.click("[data-pmcal-shift='-1']");pg.click("[data-pmcal-shift='-1']")
            assert "Export compliance" in pg.inner_text(".pmcal-note")
            pg.evaluate("delete S.tasksHistoryFrom;render()")
        pg.set_viewport_size({"width": 390, "height": 844}); pg.evaluate("render()"); pg.wait_for_timeout(200)
        over = pg.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
        assert over <= 0, f"phone layout scrolls sideways by {over}px"
        assert not errors, errors
        b.close()
    print("PASS", scenario)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        for scenario in ("fresh", "live"):
            run(scenario, tmp)
