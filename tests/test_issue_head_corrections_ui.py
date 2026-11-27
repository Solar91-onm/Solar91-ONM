"""Exercise the real register and Edit drawer with stubbed APIs at phone and desktop widths."""
from pathlib import Path
import pytest
from tests.test_site_issue_responsibility_dialog import chromium

root = Path(__file__).resolve().parents[1]

@pytest.mark.parametrize("role,width", [("O&M Head",1600),("O&M Head",390),("Assignee",390)])
def test_issue_editor_and_personal_register(chromium,role,width):
    page=chromium.new_page(viewport={'width':width,'height':844})
    try:
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content('<main id="host"></main>')
        page.evaluate('''role=>{
          window.Solar91PortalFormat={escape:v=>String(v==null?'':v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
          const user={id:'a',name:'Owner A',role}; const day=new Date().toISOString();
          const tickets=[{id:'i1',ticket_no:'ISS-0001',plant_id:'p',vertical:'Other',subcategory:'Other',description:'Camera bad',assigned_to:'a',assignee_text:'Owner A',status:'Assigned',created_at:day,occurred_at:day},{id:'i2',ticket_no:'ISS-0002',plant_id:'p',vertical:'Other',description:'Other owner',assigned_to:'b',assignee_text:'Owner B',status:'Assigned',created_at:day,occurred_at:day}];
          window.calls=[];window.Solar91PortalAPI={currentUser:()=>user,session:()=>Promise.resolve({user}),plants:()=>Promise.resolve([{dbId:'p',siteCode:'COR01',plantName:'Plant'}]),isPortalRoute:()=>true,request:(url,opts)=>{calls.push([url,opts||null]);if(url==='/api/categories')return Promise.resolve({categories:[{name:'Other',sub_problems:['Other']},{name:'CCTV',sub_problems:['No video']}]});if(url==='/api/issues/assignees')return Promise.resolve([{id:'a',name:'Owner A'},{id:'b',name:'Owner B'}]);if(url.startsWith('/api/issues?'))return Promise.resolve(url.includes('mine=true')?tickets.filter(t=>t.assigned_to==='a'):tickets);if(url==='/api/issues/i1' && opts.method==='PATCH'){Object.assign(tickets[0],opts.body,{assigned_to:'b',assignee_text:'Owner B'});return Promise.resolve(tickets[0]);}if(url.startsWith('/api/photos'))return Promise.resolve([]);return Promise.reject(new Error(url));}};
        }''',role)
        for name in ('tokens.css','site-issues.css'): page.add_style_tag(path=str(root/'assets/css'/name))
        for name in ('table-sort.js','table-column-filter.js','site-issues.js'):page.add_script_tag(path=str(root/'assets/js'/name))
        page.evaluate("Solar91PortalIssues.render(document.getElementById('host'), {})")
        page.locator('[data-issue-open="ISS-0001"]').wait_for(timeout=5000)
        if role=='Assignee':
            assert page.locator('[data-issue-owner-view]').input_value()=='mine'
            assert page.evaluate("calls.filter(c=>c[0].startsWith('/api/issues?'))[0][0].includes('mine=true')")
            assert page.locator('[data-issue-open="ISS-0002"]').count()==0
            page.locator('[data-issue-owner-view]').select_option('all')
            page.locator('[data-issue-open="ISS-0002"]').wait_for(timeout=5000)
            assert page.locator('[data-issue-edit="ISS-0002"]').count()==0
            page.locator('[data-issue-edit="ISS-0001"]').click()
            assert page.locator('[name=equipment]').count()==0 and page.locator('[name=problem]').count()==0
            page.locator('[data-issue-edit-form] [data-issue-action=close]').click()
            page.evaluate("Solar91PortalIssues.render(document.getElementById('host'), {resetOwnerView:true})")
            page.locator('[data-issue-open="ISS-0001"]').wait_for(timeout=5000)
            assert page.locator('[data-issue-owner-view]').input_value()=='mine'
            assert page.locator('[data-issue-open="ISS-0002"]').count()==0
            reads = page.evaluate("calls.filter(c=>c[0].startsWith('/api/issues?')).length")
            page.evaluate("Solar91PortalIssues.render(document.getElementById('host'), {resetOwnerView:true})")
            assert page.evaluate("calls.filter(c=>c[0].startsWith('/api/issues?')).length")==reads
            page.evaluate("const clock=Date.now;Date.now=()=>clock()+31000;Solar91PortalIssues.render(document.getElementById('host'), {resetOwnerView:true})")
            page.wait_for_function("n=>calls.filter(c=>c[0].startsWith('/api/issues?')).length===n",arg=reads+1)
            page.locator('[data-issue-open="ISS-0001"]').wait_for(timeout=5000)
        else:
            assert page.evaluate("calls.filter(c=>c[0]==='/api/categories'||c[0]==='/api/issues/assignees').length") == 0
            page.locator('[data-issue-edit="ISS-0001"]').click()
            page.locator('[name=equipment] option[value=CCTV]').wait_for(state='attached',timeout=5000)
            page.locator('[name=equipment]').select_option('CCTV')
            page.locator('[name=subpart]').select_option('No video')
            page.locator('[name=problem]').fill('')
            assert page.locator('[data-edit-manual-owner]').is_hidden()
            page.locator('[name=assignmentMode]').select_option('manual')
            assert page.locator('[data-edit-manual-owner]').is_visible()
            page.locator('[name=assignedTo]').select_option('b')
            page.locator('[name=assignmentMode]').select_option('on_change')
            page.locator('[data-issue-edit-form] button[type=submit]').click()
            page.get_by_text('ISS-0001 updated.').wait_for(timeout=5000)
            payload=page.evaluate("calls.find(c=>c[0]==='/api/issues/i1')[1].body")
            assert payload=={'vertical':'CCTV','subcategory':'No video','description':'','assignment_mode':'auto'},payload
        assert not errors,errors
    finally:
        page.close()
