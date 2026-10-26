"""Browser + live FastAPI SQLite smoke. Run: python scripts/browser_smoke.py

Requires requirements-dev.txt and either a system Chromium or Playwright Chromium.
Test-only Clerk SDK stub runs *only* in the temporary Playwright page; no
bypass, credentials or mock identity is shipped into the application's JS.
"""
from pathlib import Path
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen, Request
from urllib.error import HTTPError

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SDK_STUB='''window.Clerk={load:async()=>{},session:{getToken:async()=>"isolated-browser-test-token"},signOut:async()=>{}};'''

def main():
    with tempfile.TemporaryDirectory(prefix="solar91-browser-") as td:
        db_file=Path(td)/"smoke.sqlite3"
        env={**os.environ,"SOLAR91_E2E_TEST_MODE":"1","APP_ENV":"test","DEBUG":"false",
             "DATABASE_URL":"sqlite:///"+db_file.as_posix(),
             "SUPABASE_URL":"https://example.invalid",
             "CLERK_PUBLISHABLE_KEY":"pk_test_c2lsdmVyLWV3ZS0yOS5jbGVyay5hY2NvdW50cy5kZXYk",
             "CLERK_SECRET_KEY":"sk_test_isolated_browser_smoke",
             "CLERK_ISSUER":"https://silver-ewe-29.clerk.accounts.dev",
             "PM_DAILY_JOB":"0"}
        with socket.socket() as sock:
            sock.bind(("127.0.0.1",0));port=sock.getsockname()[1]
        base=f"http://127.0.0.1:{port}"
        proc=subprocess.Popen([sys.executable,"-m","uvicorn","tests.e2e_server:app","--host","127.0.0.1","--port",str(port)],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        try:
            for _ in range(80):
                if proc.poll() is not None: raise RuntimeError("Test backend failed: "+proc.stderr.read()[-2500:])
                try:
                    with urlopen(base+"/health/ready",timeout=1) as response:
                        if json.load(response)["status"]=="ready":break
                except Exception:time.sleep(.15)
            else:raise RuntimeError("Test server did not become ready")
            with sync_playwright() as pw:
                browser_opts={"headless":True,"args":["--no-sandbox"]}
                chrome=shutil.which("chromium") or shutil.which("google-chrome") or shutil.which("chromium-browser")
                if chrome:browser_opts["executable_path"]=chrome
                browser=pw.chromium.launch(**browser_opts)
                page=browser.new_page(viewport={"width":1400,"height":900},reduced_motion="reduce")
                errors=[]
                page.on("pageerror",lambda exc: errors.append(str(exc)))
                page.route(re.compile(r"https://silver-ewe-29\.clerk\.accounts\.dev/npm/@clerk/clerk-js@6/"),lambda r:r.fulfill(status=200,content_type="application/javascript",body=SDK_STUB))
                page.route(re.compile(r"https://fonts\.googleapis\.com/|https://fonts\.gstatic\.com/"),lambda r:r.abort())

                # Some hosted environments prohibit Chromium from navigating to *any*
                # HTTP/file URL. In that case inject the exact project scripts into an
                # about:blank document and proxy fetch through Python to the *real*
                # local FastAPI process. This tests browser execution + real DB writes,
                # but does not certify native asset-network delivery or redirects.
                transport_mode={"inline":False}
                identity={"user":""}   # "" = O&M Head; "assignee" = QA Assignee (tests/e2e_server.py)
                def as_user(who):
                    identity["user"]=who
                    page.set_extra_http_headers({"X-S91-E2E-USER":who} if who else {})
                def transport(call):
                    url=call["url"]
                    if not url.startswith("/") or url.startswith("//"):
                        return {"status":400,"body":'{"detail":"Only local test API URLs permitted"}'}
                    body=call.get("body")
                    headers={str(k):str(v) for k,v in (call.get("headers") or {}).items()}
                    if identity["user"]:headers["X-S91-E2E-USER"]=identity["user"]
                    req=Request(base+url,data=body.encode("utf8") if body is not None else None,
                                headers=headers,method=call.get("method","GET"))
                    try:
                        with urlopen(req,timeout=65) as response:
                            return {"status":response.status,"body":response.read().decode("utf8")}
                    except HTTPError as error:
                        return {"status":error.code,"body":error.read().decode("utf8")}
                page.expose_function("__s91BrowserTransport",transport)
                def load():
                    nonlocal page
                    if not transport_mode["inline"]:
                        try:
                            page.goto(base,wait_until="domcontentloaded",timeout=20000)
                            return
                        except Exception as exc:
                            if "ERR_BLOCKED_BY_ADMINISTRATOR" not in str(exc):raise
                            transport_mode["inline"]=True
                            print("NOTE: Chromium forbids local URL navigation; using real API over test transport")
                    page.close()
                    page=browser.new_page(viewport={"width":1400,"height":900},reduced_motion="reduce")
                    page.on("pageerror",lambda exc:errors.append(str(exc)))
                    page.expose_function("__s91BrowserTransport",transport)
                    html=urlopen(base+"/",timeout=15).read().decode("utf8")
                    # Clerk is mocked only in this isolated browser test.
                    html=re.sub(r'<script defer crossorigin="anonymous" data-clerk-publishable-key="[^"]+" src="https://[^"]+/npm/@clerk/clerk-js@6/dist/clerk.browser.js" type="text/javascript"></script>',
                                '<script>'+SDK_STUB+'</script>',html)
                    scripts=re.findall(r'<script defer src="(/static/js/[^"]+)"></script>',html)
                    html=re.sub(r'<script defer src="/static/js/[^"]+"></script>','',html)
                    css=re.findall(r'<link rel="stylesheet" href="(/static/css/[^"]+)">',html)
                    html=re.sub(r'<link rel="stylesheet" href="/static/css/[^"]+">','',html)
                    page.set_content(html,wait_until="domcontentloaded")
                    page.evaluate('''() => {window.fetch=async (url,options={})=>{const result=await window.__s91BrowserTransport({url:String(url),method:options.method||'GET',body:options.body||null,headers:options.headers||{}});return new Response(result.body||'',{status:result.status,headers:{'Content-Type':'application/json'}})}}''')
                    for href in css:
                        f=ROOT/href.split("?",1)[0].lstrip("/").replace("static/","frontend/static/",1)
                        if f.exists():page.add_style_tag(content=f.read_text(encoding="utf8"))
                    for href in scripts:
                        f=ROOT/href.split("?",1)[0].lstrip("/").replace("static/","frontend/static/",1)
                        if not f.exists():raise AssertionError("Missing frontend asset "+href)
                        page.add_script_tag(content=f.read_text(encoding="utf8"))
                load()
                page.wait_for_selector(".shell",timeout=30000)
                assert "Command Center" in page.locator("#app").inner_text()
                print("PASS: real browser loads authenticated dashboard")
                # Create plant via actual HTTP API (no fake register state); reload to verify persistence.
                plant=page.evaluate('''async()=>{const r=await apiFetch("/api/plants",{method:"POST",body:{site_code:"BROWSER-01",plant_name:"Browser QA Solar Plant",district:"Jaipur"}});return r;}''')
                assert plant["site_code"]=="BROWSER01",plant
                edited=page.evaluate('''async id=>await apiFetch("/api/plants/"+id,{method:"PATCH",body:{district:"Ajmer"}})''',plant["id"])
                assert edited["district"]=="Ajmer",edited
                equipment=page.evaluate('''async id=>await apiFetch("/api/equipment",{method:"POST",body:{plant_id:id,equipment_name:"QA Inverter 1",equipment_code:"INV-E2E",equipment_type:"Inverter"}})''',plant["id"])
                assert equipment["equipment_code"]=="INV-E2E",equipment
                load();page.wait_for_selector(".shell",timeout=20000)
                assert page.evaluate('S.plants.some(p=>p.id==="BROWSER01")')
                assert page.evaluate('S.plants.find(p=>p.id==="BROWSER01").district')=="Ajmer"
                page.evaluate('goView("plants")')
                page.wait_for_selector(".shell",timeout=10000)
                assert "Browser QA Solar Plant" in page.locator("#app").inner_text()
                print("PASS: plant created, persisted and displayed in Plant Register")
                page.evaluate('goTab("issues")')
                page.wait_for_selector(".si-head",timeout=12000)
                assert "Site Issues" in page.locator("#app").inner_text()
                assert page.locator('select[aria-label="Plant"]').count()==1
                page.locator(".si-more").click()
                assert page.locator('select[aria-label="Status"]').count()==1
                assert page.locator("#issue-filter-from").count()==1
                assert page.evaluate('issueTrendRows(30,[],"0002-10-12","2100-01-01").length')<=366
                # Route used by the actual HTML UI; no backend mocking.
                page.evaluate('openModal("newTicket")')
                page.locator("#tk-plant").select_option(label="BROWSER01")
                page.locator('.wiz-ticket[data-step="1"] button').click()
                assert page.locator('.wiz-ticket[data-step="2"]').is_visible(),"Step 2 did not open"
                page.locator("#tk-vert").select_option("Inverter")
                page.locator('.wiz-ticket[data-step="2"] button',has_text="Next").click()
                assert page.locator('.wiz-ticket[data-step="3"]').is_visible(), "Step 3 did not open: "+str(page.evaluate('''[...document.querySelectorAll(".wiz-ticket")].map(x=>[x.dataset.step,x.style.display])'''))
                page.locator("#tk-desc").fill("Browser QA inverter overheating")
                page.locator('[data-wiz-final="ticket"]').click()
                page.wait_for_function('S.issues.some(x=>x.desc==="Browser QA inverter overheating")',timeout=30000)
                ticket=page.evaluate('S.issues.find(x=>x.desc==="Browser QA inverter overheating")')
                assert ticket["dbId"] and ticket["id"],ticket
                assert page.locator("#app").get_by_text(ticket["id"]).count()>=1
                print("PASS: create issue through 3-step UI, persisted by FastAPI")
                load();page.wait_for_selector(".shell",timeout=20000)
                assert page.evaluate('S.issues.some(x=>x.desc==="Browser QA inverter overheating")')
                page.evaluate('goTab("issues")');page.wait_for_selector(".si-head",timeout=12000)
                assert page.locator("#app").get_by_text(ticket["id"]).count()>=1
                print("PASS: issue survives refresh and renders in issue register")
                # Closing a dialog and opening another screen in one click (ticket -> "Open plant page") must stay there;
                # the dialog's deferred history step used to send the person back to Site Issues.
                page.evaluate('id=>openModal("ticket",{id})',ticket["id"]);page.wait_for_timeout(500)
                page.evaluate('()=>{closeModal();openPlantPage("BROWSER01")}');page.wait_for_timeout(900)
                assert page.evaluate("S.view")=="plant",page.evaluate("[S.view,location.hash]")
                page.evaluate("history.back()");page.wait_for_timeout(700)
                assert page.evaluate("S.modal")=="ticket","Back returns to the ticket the plant page was opened from"
                page.evaluate("closeModal()");page.wait_for_timeout(500)
                page.evaluate('goTab("issues")');page.wait_for_selector(".si-head",timeout=12000)
                print("PASS: closing a dialog and navigating in one click keeps the new screen; Back returns to the dialog")
                # O&M Head: default deadlines from the Site Issues header, saved on the server and used by the raise form.
                assert page.locator(".si-head button",has_text="Deadlines").count()==1
                page.locator(".si-head button",has_text="Deadlines").click()
                page.wait_for_selector("#s91-deadlines")
                page.locator("#dl-crit-n").fill("1");page.locator("#dl-crit-u").select_option("d")
                page.locator("#dl-med-n").fill("72");page.locator("#dl-med-u").select_option("h")
                # the server previews which open tickets would move (dry run); the QA ticket still has its default
                page.wait_for_function('/would|No open ticket|Could not/.test(document.getElementById("dl-preview").textContent)',timeout=15000)
                assert "would get the new deadline" in page.inner_text("#dl-preview"),page.inner_text("#dl-preview")
                page.locator("#dl-apply").check()
                page.once("dialog",lambda d:d.accept())
                page.locator("#dl-save").click()
                page.wait_for_function('!document.getElementById("s91-deadlines")',timeout=15000)
                assert page.evaluate('[ETC_HRS.Critical,ETC_HRS.Medium]')==[24,72]
                assert page.evaluate('async()=>(await apiFetch("/api/issues/deadlines")).hours')=={"Critical":24,"Medium":72}
                moved=page.evaluate('async q=>(await apiFetch("/api/issues/"+q+"/activity")).filter(a=>a.action==="issue.etc_changed").length',ticket["dbId"])
                assert moved==1,moved
                print("PASS: O&M Head changes Critical/Medium deadlines; preview, saved, open ticket moved and logged")
                # One edit dialog for details and dates; changing the priority moves an untouched deadline to its default.
                page.evaluate('id=>openModal("editTicket",{id})',ticket["id"])
                page.wait_for_selector("#edit-tk-reason")
                page.locator("#edit-tk-sev").select_option("Critical")
                assert "Critical default" in page.locator("#edit-tk-etc-note").inner_text()
                page.locator("#edit-tk-desc").fill("Browser QA inverter overheating (edited)")
                page.locator("#edit-tk-reason").fill("Priority corrected after site call")
                page.locator("#edit-tk-save").click()
                page.wait_for_function('S.issues.some(x=>x.desc==="Browser QA inverter overheating (edited)"&&x.severity==="Critical")',timeout=20000)
                stored=page.evaluate('async q=>(await apiFetch("/api/issues?q="+encodeURIComponent(q)))[0]',"overheating (edited)")
                assert stored["severity"]=="Critical" and stored["description"].endswith("(edited)"),stored
                print("PASS: edit dialog saves details and deadline through PATCH; persisted")
                # A validation error reads as a sentence, not "HTTP 422".
                msg=page.evaluate('''async id=>{try{await apiFetch("/api/issues/"+id,{method:"PATCH",body:{etc_at:"not-a-date"}});return "saved"}catch(e){return e.message}}''',ticket["dbId"])
                assert msg.startswith("Please check") and "HTTP" not in msg,msg
                print("PASS: API validation errors are readable")
                # Real HTTP workflow: assign, acknowledge, start, record work and
                # close directly (resolution needs uploaded photographic evidence).
                def action(path,body=None):
                    return page.evaluate('''async ({id,path,body})=>await apiFetch("/api/issues/"+id+path,{method:"POST",body:body||{}})''',{"id":ticket["dbId"],"path":path,"body":body})
                a=action("/assign",{"assignee_text":"QA Assignee"})
                assert a["status"]=="Assigned",a
                assert action("/acknowledge")["status"]=="Acknowledged"
                assert action("/start")["status"]=="In Progress"
                assert action("/progress",{"note":"Verified inverter temperature","hours":1})["status"]=="In Progress"
                # A second ticket for the Assignee to close themselves.
                second=page.evaluate('async pid=>await apiFetch("/api/issues",{method:"POST",body:{plant_id:pid,vertical:"Inverter",description:"Browser QA duplicate report",severity:"Medium"}})',plant["id"])
                page.evaluate('async id=>await apiFetch("/api/issues/"+id+"/assign",{method:"POST",body:{assignee_text:"QA Assignee"}})',second["id"])
                # ---- as the ticket's Assignee: edit details from the desk menu, close their own ticket ----
                as_user("assignee");load();page.wait_for_selector(".shell",timeout=20000)
                assert page.evaluate("AUTH_IDENTITY.role")=="Assignee"
                page.evaluate('goTab("issues")');page.wait_for_selector(".si-head",timeout=12000)
                assert page.locator(".si-head button",has_text="Deadlines").count()==0
                page.evaluate('id=>openModal("ticket",{id})',ticket["id"])
                # the desk redraws once the ticket history has loaded; open the menu after that, as a person would
                page.wait_for_function('id=>{const t=S.issues.find(x=>x.id===id);return t&&(t.activityLoaded||t.activityError)}',arg=ticket["id"],timeout=20000)
                page.wait_for_timeout(300)
                page.locator(".idk-menu summary").click()
                menu=page.locator(".idk-menu").inner_text()
                assert "Edit details" in menu and "Change dates" in menu and "Close without resolution" in menu and "Move to Deleted" not in menu,menu
                page.locator(".idk-menu button",has_text="Edit details").click()
                page.wait_for_selector("#edit-tk-reason")
                page.locator("#edit-tk-desc").fill("Browser QA inverter overheating (assignee note)")
                page.locator("#edit-tk-reason").fill("Fault narrowed down on site")
                page.locator("#edit-tk-save").click()
                page.wait_for_function('S.issues.some(x=>x.desc==="Browser QA inverter overheating (assignee note)")',timeout=20000)
                stored=page.evaluate('async q=>(await apiFetch("/api/issues?q="+encodeURIComponent(q)))[0]',"(assignee note)")
                assert stored and stored["description"].endswith("(assignee note)"),stored
                # a ticket that is not theirs offers neither edit nor close
                others=page.evaluate('S.issues.filter(x=>x.dbId&&!x.assignee).map(x=>x.id)')
                for oid in others:
                    assert not page.evaluate('id=>s91CanEditIssue(S.issues.find(x=>x.id===id))||s91CanCloseIssue(S.issues.find(x=>x.id===id))',oid),oid
                second_id=page.evaluate('db=>S.issues.find(x=>x.dbId===db).id',second["id"])
                page.evaluate('id=>ccCloseDialog(id)',second_id)
                page.locator("#dc-rem").fill("Same fault as the first QA ticket")
                page.locator("#dc-go").click()
                page.wait_for_function('id=>(S.issues.find(x=>x.id===id)||{}).status==="Closed"',arg=second_id,timeout=20000)
                print("PASS: the ticket's Assignee edits and closes their own tickets; other tickets offer neither")
                as_user("");load();page.wait_for_selector(".shell",timeout=20000)
                assert page.evaluate('db=>S.issues.find(x=>x.dbId===db).status',second["id"])=="Closed"
                page.evaluate('goTab("issues")');page.wait_for_selector(".si-head",timeout=12000)
                # Close through the ticket's close dialog (a reason is required for a direct close).
                page.evaluate('id=>ccCloseDialog(id)',ticket["id"])
                page.wait_for_selector("#cc-close-ovl #dc-go")
                page.locator("#dc-go").click()
                assert page.locator("#cc-close-ovl").count()==1,"closing without a reason must be refused"
                page.locator("#dc-rem").fill("QA direct-close verification without evidence")
                page.locator("#dc-go").click()
                page.wait_for_function('id=>(S.issues.find(x=>x.id===id)||{}).status==="Closed"',arg=ticket["id"],timeout=20000)
                load();page.wait_for_selector(".shell",timeout=20000)
                assert page.evaluate('S.issues.find(x=>x.dbId==='+json.dumps(ticket["dbId"])+').status')=="Closed"
                page.evaluate('goTab("issues")');page.wait_for_selector(".si-head",timeout=12000)
                assert page.locator("#app").get_by_text(ticket["id"]).count()>=1
                # The isolated server also seeds another active site-engineer fixture; only the just-closed QA ticket must disappear from the open queue.
                assert not page.evaluate('''id=>openTk(S.issues).some(row=>row.id===id)''',ticket['id'])
                print("PASS: assign, acknowledge, start, progress, close; data and metrics persist")
                # Validating chart fault isolation is essential to original failure.
                # The register opens on the priority chart; switch to the trend view, which is the chart under test.
                chart=page.evaluate('''()=>{const saved=window.issueSpark,by=S.siChartBy;S.siChartBy="trend";window.issueSpark=()=>{throw Error("simulated chart failure")};try{return renderIssues();}finally{window.issueSpark=saved;S.siChartBy=by}}''')
                assert "Trend chart unavailable" in chart and ticket["id"] in chart
                assert "START renderIssues" not in page.locator("body").inner_text()
                print("PASS: chart failure isolated; register remains visible; no red debug banner")
                # Invalid filter dates and enormous ranges must not cause an infinite loop.
                n=page.evaluate('''()=>{siSet({from:"0002-10-12",to:"2100-01-01"});return {n:issueTrendRows(100000,S.issues,"2000-01-01","2100-01-01").length,from:S.issF.from}}''')
                assert n["n"]<=366 and not n["from"],n
                page.evaluate('siSet({from:"",to:""})')
                print("PASS: 100-year ranges bounded; malformed dates rejected")
                assert not errors,"Unhandled browser errors: "+json.dumps(errors[-5:])
                print("PASS: zero uncaught browser JavaScript exceptions")
                browser.close()
        finally:
            proc.terminate()
            try:proc.communicate(timeout=6)
            except subprocess.TimeoutExpired:proc.kill();proc.communicate()

if __name__=="__main__":main()
