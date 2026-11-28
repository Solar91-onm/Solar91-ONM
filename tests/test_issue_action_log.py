"""The Edit drawer's action log: the Assignee records what was done, stamped and kept.

Writing the first action on a ticket that has not started walks it Assigned -> Acknowledged ->
In Progress first, the same stage walk Resolve already uses, then records the entry.
"""
from pathlib import Path

import pytest
from tests.test_site_issue_responsibility_dialog import chromium  # noqa: F401  (browser fixture)

ROOT = Path(__file__).resolve().parents[1]

SETUP = """(opts) => {
  window.Solar91PortalFormat={escape:v=>String(v==null?'':v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  const user={id:'a',name:'Owner A',role:opts.role};
  const day=new Date().toISOString();
  const ticket={id:'i1',ticket_no:'ISS-0001',plant_id:'p',vertical:'Other',subcategory:'Other',
    description:'Laptop charger not working',assigned_to:'a',assignee_text:'Owner A',
    status:opts.status,created_at:day,occurred_at:day};
  window.calls=[];window.activity=opts.activity||[];
  window.Solar91PortalAPI={currentUser:()=>user,session:()=>Promise.resolve({user}),
    plants:()=>Promise.resolve([{dbId:'p',siteCode:'COR01',plantName:'Plant'}]),isPortalRoute:()=>true,
    request:(url,opts2)=>{
      calls.push([url,opts2||null]);
      if(url==='/api/categories')return Promise.resolve({categories:[{name:'Other',sub_problems:['Other']}]});
      if(url==='/api/issues/assignees')return Promise.resolve([{id:'a',name:'Owner A'}]);
      if(url.startsWith('/api/issues?'))return Promise.resolve([ticket]);
      if(url==='/api/issues/i1/activity')return Promise.resolve(window.activity);
      if(url==='/api/issues/i1/status'){ticket.status=opts2.body.status;return Promise.resolve(ticket);}
      if(url==='/api/issues/i1/progress'){
        window.activity=window.activity.concat([{id:'h'+window.activity.length,action:'issue.progress',
          note:opts2.body.note,actor:'Owner A',at:'2026-11-28T09:02:00+00:00',
          work_date:opts2.body.work_date,day_status:opts2.body.day_status,
          metadata:{hours:opts2.body.hours},next_step:null}]);
        return Promise.resolve(ticket);
      }
      if(url.startsWith('/api/photos'))return Promise.resolve([]);
      return Promise.reject(new Error(url));
    }};
}"""


def open_editor(browser, role="Assignee", status="Assigned", activity=None, width=1280):
    page = browser.new_page(viewport={"width": width, "height": 900})
    page.set_default_timeout(5000)
    page.set_content('<main id="host"></main>')
    for css in ("tokens.css", "site-issues.css"):
        page.add_style_tag(path=str(ROOT / "assets/css" / css))
    page.evaluate(SETUP, {"role": role, "status": status, "activity": activity or []})
    for js in ("table-sort.js", "table-column-filter.js", "site-issues.js"):
        page.add_script_tag(path=str(ROOT / "assets/js" / js))
    page.evaluate("Solar91PortalIssues.render(document.getElementById('host'), {})")
    if page.locator('[data-issue-edit="ISS-0001"]').count() == 0:
        # The register opens on active work; a finished ticket needs its status filter.
        page.locator('[data-issue-status="All"]').click()
    page.locator('[data-issue-edit="ISS-0001"]').click()
    page.locator(".ep-issues__action-log").wait_for()
    return page


@pytest.mark.parametrize("width", [1280, 390])
def test_assignee_records_an_action_and_the_ticket_starts_itself(chromium, width):
    page = open_editor(chromium, width=width)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        log = page.locator(".ep-issues__action-log")
        assert "No action recorded yet." in log.inner_text()
        assert "Recording the first action starts this ticket" in log.inner_text()
        assert page.evaluate("calls.filter(c=>c[0]==='/api/issues/i1/activity').length") == 1

        page.locator('[name=actionNote]').fill("Replaced the charger pin and tested the laptop.")
        page.locator('[name=actionStatus]').select_option("Worked")
        page.locator('[name=actionHours]').fill("2")
        page.locator('[data-issue-action="add-action"]').click()
        page.locator(".ep-issues__action-entry").wait_for()

        # Assigned -> Acknowledged -> In Progress, then the entry itself.
        posts = page.evaluate("calls.filter(c=>c[1]&&c[1].method==='POST').map(c=>[c[0],c[1].body])")
        assert [p[0] for p in posts] == ["/api/issues/i1/status", "/api/issues/i1/status", "/api/issues/i1/progress"]
        assert [p[1]["status"] for p in posts[:2]] == ["Acknowledged", "In Progress"]
        assert posts[2][1]["note"] == "Replaced the charger pin and tested the laptop."
        assert posts[2][1]["day_status"] == "Worked" and posts[2][1]["hours"] == 2

        entry = page.locator(".ep-issues__action-entry").first
        assert "Owner A" in entry.inner_text()
        # Stamped in plant time: 09:02 UTC is 14:32 in Asia/Kolkata.
        assert "28 Nov 2026" in entry.inner_text() and "14:32" in entry.inner_text()
        assert "Replaced the charger pin" in entry.inner_text()
        assert "Worked" in entry.inner_text() and "2 hrs" in entry.inner_text()
        assert "Action log · 1" in page.locator(".ep-issues__action-log legend").inner_text()
        assert page.locator('[name=actionNote]').input_value() == ""  # cleared for the next one
        # Started now, so the hint is gone but the box stays open.
        assert "Recording the first action starts this ticket" not in page.locator(".ep-issues__action-log").inner_text()
        assert page.locator('[data-issue-action="add-action"]').is_enabled()
        assert not errors, errors
    finally:
        page.close()


def test_existing_entries_show_newest_first_with_waiting_states(chromium):
    history = [
        {"id": "h1", "action": "issue.created", "note": "raised", "actor": "Site Engineer",
         "at": "2026-11-26T04:00:00+00:00", "metadata": {}},
        {"id": "h2", "action": "issue.progress", "note": "Inspected; spare pin not in store.",
         "actor": "Owner A", "at": "2026-11-27T03:45:00+00:00", "work_date": "2026-11-27",
         "day_status": "Waiting for parts", "metadata": {}, "next_step": "Collect pin from store"},
        {"id": "h3", "action": "issue.progress", "note": "Pin collected, refitted.",
         "actor": "Owner A", "at": "2026-11-28T09:02:00+00:00", "work_date": "2026-11-28",
         "day_status": "Worked", "metadata": {"hours": 1.5}},
    ]
    page = open_editor(chromium, status="In Progress", activity=history)
    try:
        entries = page.locator(".ep-issues__action-entry")
        assert entries.count() == 2  # only progress entries, not issue.created
        assert "Pin collected" in entries.nth(0).inner_text()      # newest first
        assert "spare pin not in store" in entries.nth(1).inner_text()
        assert "1.5 hrs" in entries.nth(0).inner_text()
        assert "Waiting for parts" in entries.nth(1).inner_text()
        assert "Next: Collect pin from store" in entries.nth(1).inner_text()
        assert page.locator(".ep-issues__action-tag.is-waiting").count() == 1
        # Already in progress, so no auto-start hint.
        assert "starts this ticket" not in page.locator(".ep-issues__action-log").inner_text()
    finally:
        page.close()


def test_a_blank_action_is_refused_without_calling_the_server(chromium):
    page = open_editor(chromium)
    try:
        page.locator('[name=actionNote]').fill("   ")
        page.locator('[data-issue-action="add-action"]').click()
        page.get_by_text("Write what was done before recording the action.").wait_for()
        assert page.evaluate("calls.filter(c=>c[1]&&c[1].method==='POST').length") == 0
    finally:
        page.close()


@pytest.mark.parametrize("status,expected", [
    ("Resolved", "its action log is now a record"),
    ("Pending Vendor", "Move this ticket back to In Progress"),
])
def test_closed_and_waiting_tickets_show_the_log_read_only(chromium, status, expected):
    history = [{"id": "h1", "action": "issue.progress", "note": "Work done.", "actor": "Owner A",
                "at": "2026-11-28T09:02:00+00:00", "work_date": "2026-11-28",
                "day_status": "Worked", "metadata": {}}]
    page = open_editor(chromium, status=status, activity=history)
    try:
        log = page.locator(".ep-issues__action-log")
        assert expected in log.inner_text()
        assert page.locator('[name=actionNote]').count() == 0        # no add box
        assert page.locator(".ep-issues__action-entry").count() == 1  # history still readable
    finally:
        page.close()


def test_a_failed_log_read_offers_a_retry_and_never_reads_as_empty(chromium):
    page = open_editor(chromium, activity=None)
    try:
        page.evaluate("() => { window.Solar91PortalAPI.request = function (u, o) {"
                      " window.calls.push([u, o || null]);"
                      " return Promise.reject(new Error('network down')); }; }")
        page.keyboard.press("Escape")
        page.locator('[data-issue-edit="ISS-0001"]').click()
        page.get_by_text("network down").wait_for()
        log = page.locator(".ep-issues__action-log")
        assert "No action recorded yet." not in log.inner_text()
        assert page.locator('[data-issue-action="retry-actions"]').count() == 1
    finally:
        page.close()
