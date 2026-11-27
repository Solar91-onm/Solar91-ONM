"""The real Site Issue register labels corrective tickets without another API."""
from pathlib import Path
import pytest
from tests.test_site_issue_responsibility_dialog import chromium

ROOT = Path(__file__).resolve().parents[1]

@pytest.mark.parametrize('width', [390, 1600])
def test_pm_source_badge_and_write_invalidation(chromium, width):
    page = chromium.new_page(viewport={'width': width, 'height': 844})
    try:
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content('<main id="host"></main>')
        page.evaluate('''() => {
          window.Solar91PortalFormat={escape:v=>String(v==null?'':v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
          const user={id:'a',name:'Owner A',role:'Assignee'}, day=new Date().toISOString();
          window.tickets=[{id:'i1',ticket_no:'ISS-0001',plant_id:'p',vertical:'Inverter',subcategory:'PM checklist: Not OK',description:'Dust and debris',assigned_to:'a',assignee_text:'Owner A',status:'Assigned',created_at:day,occurred_at:day,source_task:'PM:activity:check'}, {id:'i2',ticket_no:'ISS-0002',plant_id:'p',vertical:'CCTV',description:'Manual issue',assigned_to:'a',assignee_text:'Owner A',status:'Assigned',created_at:day,occurred_at:day}];
          window.calls=[];window.Solar91PortalAPI={currentUser:()=>user,session:()=>Promise.resolve({user}),plants:()=>Promise.resolve([{dbId:'p',siteCode:'COR01',plantName:'Plant'}]),isPortalRoute:()=>true,request:(url)=>{calls.push(url);if(url.startsWith('/api/issues?'))return Promise.resolve(tickets);if(url.startsWith('/api/photos'))return Promise.resolve([]);if(url.startsWith('/api/issues/i1/activity'))return Promise.resolve({history:[],steps:[],days:[]});return Promise.reject(new Error(url));}};
        }''')
        for name in ('tokens.css','site-issues.css'):
            page.add_style_tag(path=str(ROOT/'assets/css'/name))
        for name in ('table-sort.js','table-column-filter.js','site-issues.js'):
            page.add_script_tag(path=str(ROOT/'assets/js'/name))
        page.evaluate("Solar91PortalIssues.render(document.getElementById('host'), {})")
        page.locator('[data-issue-open="ISS-0001"]').wait_for(timeout=5000)
        badge = page.locator('tr').filter(has=page.locator('[data-issue-open="ISS-0001"]')).locator('.ep-issues__pm-source')
        assert badge.inner_text() == 'From Preventive Maintenance'
        assert page.locator('tr').filter(has=page.locator('[data-issue-open="ISS-0002"]')).locator('.ep-issues__pm-source').count() == 0
        assert page.evaluate("calls.filter(x=>x.startsWith('/api/issues?')).length") == 1
        page.evaluate("Solar91PortalIssues.render(document.getElementById('host'), {})")
        assert page.evaluate("calls.filter(x=>x.startsWith('/api/issues?')).length") == 1
        # A successful PM write elsewhere drops the old snapshot, but makes no
        # immediate register request while the user is still recording PM.
        page.evaluate("Solar91PortalIssues.invalidate()")
        assert page.evaluate("calls.filter(x=>x.startsWith('/api/issues?')).length") == 1
        page.evaluate("tickets.push({...tickets[0], id:'i3', ticket_no:'ISS-0003'});Solar91PortalIssues.render(document.getElementById('host'), {})")
        page.locator('[data-issue-open="ISS-0003"]').wait_for(timeout=5000)
        assert page.evaluate("calls.filter(x=>x.startsWith('/api/issues?')).length") == 2
        assert not errors, errors
    finally:
        page.close()
