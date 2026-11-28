"""Workbook-derived templates, optional readings and backwards-compatible API payloads."""
from datetime import date
from urllib.parse import quote
from pathlib import Path
import pytest
from sqlalchemy import select, event
from app.core.models import Issue, SitePhoto
from app.pmplan import tracking
from app.pmplan.checklist_templates import CHECKLISTS, LEGACY_CHECKLISTS, guidance_for
from tests.conftest import login_user
from tests.test_pm_tracking import setup_rows, engineer, submit, act, BASE, state
from tests.test_site_issue_responsibility_dialog import chromium

COUNTS = {'Inverter':22, 'ACCB':28, 'IDT Transformer':28, 'VCB':22,
          '4 Pole + ACDB + Aux. TX':54, 'Transmission line':27, 'GSS visit':49,
          'Earth pit':1, 'Miscellaneous':4}


def test_catalogue_retains_stable_legacy_keys_and_workbook_guidance():
    assert {k:len(v) for k,v in CHECKLISTS.items()} == COUNTS
    assert sum(COUNTS.values()) == 235
    for equipment, tasks in CHECKLISTS.items():
        assert len(tasks) == len(set(tasks)) <= 64
        assert set(LEGACY_CHECKLISTS[equipment]) <= set(tasks)
        assert set(guidance_for(equipment)) <= set(tasks)
    assert [len(guidance_for(e)) for e in COUNTS] == [18,27,23,22,47,24,49,0,0]
    assert guidance_for('Inverter')['Check inverter cleanliness']['parameters'] == 'Surface and vent cleanliness'
    assert guidance_for('Inverter')['Check inverter cleanliness']['source_item'] == 1
    assert 'Check IR Values of HT nad LT Winding' in CHECKLISTS['IDT Transformer']
    assert 'Check OTI Alarm and Trip' in CHECKLISTS['IDT Transformer']
    assert all(t.startswith(('Four Pole — ', 'ACDB — ', 'Auxiliary Transformer — ')) for t in CHECKLISTS['4 Pole + ACDB + Aux. TX'])
    assert all(t.startswith('GSS-side ') for t in CHECKLISTS['GSS visit'])


def test_guidance_is_role_gated_and_not_in_calendar_payload(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    engineer(client,db,plant)
    url = BASE + '/guidance/' + quote('4 Pole + ACDB + Aux. TX',safe='')
    resp=client.get(url);assert resp.status_code==200,resp.text
    assert len(resp.json()['items']) == 47
    assert len(resp.content)<30_000
    assert client.get(BASE+'/guidance/not-a-category').status_code==404
    regular=client.get(BASE,params={'month':'2026-11','site_code':plant.site_code})
    assert regular.status_code==200
    assert 'parameters' not in regular.text and 'corrective_actions' not in regular.text
    login_user(client,db,role='Technician')
    assert client.get(url).status_code==403


def test_optional_measurements_are_saved_audited_and_in_corrective_ticket(client,db,monkeypatch):
    plant,_,rows=setup_rows(db,monkeypatch);row=rows[0]
    head=login_user(client,db,role='O&M Head',email='measure-head@test.example')
    engineer(client,db,plant)
    checks=[{'result':'OK','item_id':tracking._checklist_item_id(row.id,t)} for t in CHECKLISTS[row.equipment]]
    checks[0].update(result='Not OK',note='Recorded abnormality',measurements=[{'value':0,'unit':'V','context':'L1'},{'value':1.25,'unit':'Ω','context':'Earth pit'}])
    bad=[dict(c) for c in checks];bad[0]['item_id']='wrong'
    assert submit(client,row,bad).status_code==409
    bad=[dict(c) for c in checks];bad[0]['measurements']=[{'value':1,'unit':'invalid'}]
    assert submit(client,row,bad).status_code==422
    resp=submit(client,row,checks);assert resp.status_code==200,resp.text
    saved=state(client)[row.equipment_id]['checklist'][0]
    assert saved['measurements']==checks[0]['measurements']
    assert db.scalar(select(Issue)) is None  # nothing is raised until the reviewer chooses
    login_user(client,db,role='O&M Head',email='measure-raise@test.example')
    raised=client.post(f"{BASE}/{row.id}/raise-issues",json={'item_ids':[checks[0]['item_id']]})
    assert raised.status_code==200,raised.text
    issue=db.scalar(select(Issue));assert '0.0 V' in issue.description and '1.25 Ω' in issue.description
    assert issue.legacy_payload['pm_source']['measurements']==checks[0]['measurements']
    login_user(client,db,role='O&M Head',email='measure-review@test.example')
    assert act(client,row,'return','Review').status_code==200
    engineer(client,db,plant,email='measure-return@test.example')
    # An old client without the new measurement field must not erase existing readings.
    checks[0].pop('measurements')
    resp=submit(client,row,checks);assert resp.status_code==200,resp.text
    assert state(client)[row.equipment_id]['checklist'][0]['measurements']==saved['measurements']
    assert len(list(db.scalars(select(Issue))))==1


def test_compact_plant_payload_keeps_history_and_query_budget(client,db,monkeypatch):
    plant,_,rows=setup_rows(db,monkeypatch)
    for j in range(5,17):
        db.add(tracking.PMTrackingActivity(plant_id=plant.id,equipment='Inverter',equipment_id=f'INV-{j}',scheduled_on=date(2026,11,5)))
    rows[0].checklist=[{'task':'Original task','result':'OK','note':'recorded'}];rows[0].status='Approved'
    db.commit();engineer(client,db,plant)
    params={'month':'2026-11','site_code':plant.site_code};calls=[]
    def capture(conn,cursor,stmt,*args):calls.append(stmt)
    bind=db.get_bind();event.listen(bind,'before_cursor_execute',capture)
    try:
        legacy=CHECKLISTS.copy()
        monkeypatch.setattr(tracking,'CHECKLISTS',LEGACY_CHECKLISTS)
        before=client.get(BASE,params=params);q_before=len(calls);calls.clear()
        monkeypatch.setattr(tracking,'CHECKLISTS',legacy)
        full=client.get(BASE,params=params);q_full=len(calls);calls.clear()
        compact=client.get(BASE,params={**params,'compact':True});q_compact=len(calls)
        assert before.status_code==full.status_code==compact.status_code==200
        f,c=full.json(),compact.json()
        for activity in c['activities']:
            if 'checks' not in activity:activity['checks']=c['templates'][activity['equipment']]
        assert c['activities']==f['activities']
        assert c['activities'][0]['checklist'][0]['task']=='Original task'
        assert q_before==q_full==q_compact
        assert len(compact.content)<len(full.content)
        assert len(compact.content)<=len(before.content)*1.15
        print('PM_V2_PAYLOAD',len(before.content),len(full.content),len(compact.content),q_before,q_compact)
    finally:event.remove(bind,'before_cursor_execute',capture)


ROOT=Path(__file__).resolve().parents[1]
@pytest.mark.parametrize('width',[320,390,1600])
def test_mobile_guidance_and_optional_readings_are_lazy_and_submit(chromium,width):
    page=chromium.new_page(viewport={'width':width,'height':900})
    page.set_default_timeout(5000)
    try:
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content('<main id="host"></main>')
        for css in ('tokens.css','pm-tracking.css'):
            page.add_style_tag(path=str(ROOT/'assets/css'/css))
        page.evaluate('''() => {
          window.Solar91PortalFormat={escape:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
          window.Solar91PortalNav={getState:()=>({activeView:'plant-sub',selectedPlant:'P1',selectedSubPage:'pm',pmCalendarOpen:true})};
          window.calls=[];window.saved=[];
          const activity={id:'a1',plant_id:'p1',equipment:'Inverter',equipment_id:'INV 1',date:'2026-12-01',status:'Scheduled',label:'Due today',can_submit:true,checklist:[],checklistItemIds:['id1','id2'],permission:'None'};
          const body={month:'2026-12',today:'2026-12-01',role:'Assignee',plants:[{id:'p1',site_code:'P1',name:'Test plant',configured:true}],activities:[activity],templates:{Inverter:['Check inverter cleanliness','Check cooling fan']},legacy:[],categories:['Inverter'],covered:['Inverter']};
          window.Solar91PortalAPI={request:(url,opt)=>{calls.push(url);if(opt?.method==='POST'){saved.push(opt.body);return Promise.resolve({corrective_issues:[]});}if(url.includes('/guidance/'))return Promise.resolve({items:{'Check inverter cleanliness':{description:'Check inverter cleanliness',parameters:'Surface and vent cleanliness',abnormalities:'Dust',corrective_actions:'OEM approved procedure',source_sheet:'Inverter',source_item:1}}});return Promise.resolve(body);}};
        }''')
        page.add_script_tag(path=str(ROOT/'assets/js/pm-tracking.js'))
        page.evaluate("Solar91PMTracking.show(document.getElementById('host'),{siteCode:'P1',calendar:true,initialMonth:'2026-12',eventId:'a1'})")
        page.get_by_role('button',name='Record PM').click()
        assert page.evaluate("calls.filter(x=>x.includes('/guidance/')).length")==0
        form=page.locator('[data-pmx-submit-form]')
        assert form.locator('[name=result0]').count()==1
        form.locator('[name=result0]').select_option('OK');form.locator('[name=result1]').select_option('OK')
        first=form.locator('[data-pmx-guide="0"]');first.locator('summary').click()
        first.get_by_text('Surface and vent cleanliness').wait_for()
        form.locator('[data-pmx-guide="1"] summary').click()
        assert page.evaluate("calls.filter(x=>x.includes('/guidance/')).length")==1
        assert form.locator('[name=result0]').input_value()=='OK'
        readings=form.locator('[data-pmx-measure="0"]');readings.locator('summary').click()
        readings.locator('[name=mv0_0]').fill('0');readings.locator('[name=mu0_0]').select_option('V');readings.locator('[name=mc0_0]').fill('L1')
        box=readings.bounding_box();assert box['x']>=0 and box['x']+box['width']<=width+1
        form.get_by_role('button',name='Submit for approval').click()
        page.wait_for_function('saved.length===1')
        assert page.evaluate('saved[0].checks[0].measurements')==[{'value':0,'unit':'V','context':'L1'}]
        assert page.evaluate('saved[0].checks[1].measurements')==[]
        assert not errors,errors
    finally:page.close()
