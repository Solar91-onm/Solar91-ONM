"""New catalogue entries must appear without throwing away fast warm navigation."""
from pathlib import Path
import pytest
from tests.test_site_issue_responsibility_dialog import chromium
from tests.conftest import login_user
from app.core.models import Plant, UserPlantAssignment

ROOT = Path(__file__).resolve().parents[1]


def test_new_plant_is_visible_across_portfolios_without_schedules(client, db):
    head = login_user(client, db, role='O&M Head', email='catalogue-head@example.com')
    db.add_all([Plant(site_code=f'P{i:03}', plant_name=f'Plant {i}', status='active') for i in range(42)])
    db.commit()
    def counts():
        paths = ['/api/portal/plants', '/api/portal/overview', '/api/portal/overview/range?period=month',
                 '/api/pm-plan/tracking?month=2026-12&summary=true',
                 '/api/scheduled/washing/overview?summary=true&include_reports=false']
        data = []
        for path in paths:
            r = client.get(path)
            assert r.status_code == 200, (path, r.text[:300])
            b = r.json()
            if 'rows' in b: data.append({row['plant']['site_code'] for row in b['rows']})
            else: data.append({row['site_code'] for row in b.get('plants', []) + b.get('unconfigured', [])})
        return data
    assert all(len(c) == 42 for c in counts())
    result = client.post('/api/plants', json={'site_code':'NEW43','plant_name':'New plant','address':'Test address','status':'active'})
    assert result.status_code == 201, result.text
    assert all(len(c) == 43 and 'NEW43' in c for c in counts())
    for i in range(43,72):
        db.add(Plant(site_code=f'P{i:03}',plant_name=f'Plant {i}',status='active'))
    db.commit()
    # New entries created through the service invalidate the cleaning overview cache.
    from app.scheduled.washing_cycles import invalidate_overview_cache
    invalidate_overview_cache()
    assert all(len(c)==72 for c in counts())
    engineer = login_user(client, db, role='Site Engineer', email='catalogue-engineer@example.com')
    p = db.query(Plant).filter_by(site_code='P000').one()
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=p.id)); db.commit()
    assert {row['site_code'] for row in client.get('/api/portal/plants').json()['plants']} == {'P000'}
    assert {row['plant']['site_code'] for row in client.get('/api/portal/overview').json()['rows']} == {'P000'}


@pytest.mark.parametrize('width', [390, 1600])
def test_info_reopens_shared_cache_after_plant_change(chromium, width):
    page = chromium.new_page(viewport={'width': width, 'height': 900})
    try:
        page.set_content('<main id="host"></main>')
        page.evaluate('''() => {
          window.count=42; window.reads=0;
          window.apiFetch=async url=>{
            if(url!=='/api/portal/overview')throw Error(url);
            reads++; const n=count;
            await new Promise(r=>setTimeout(r,100));
            return {rows:Array.from({length:n},(_,i)=>({plant:{id:String(i),site_code:'P'+String(i).padStart(3,'0'),plant_name:'Plant '+i},profile:{}})),totals:{}};
          };
        }''')
        for js in ('portal-api.js','format.js','table-sort.js','table-column-filter.js','data-adapter.js','plants-table.js'):
            page.add_script_tag(path=str(ROOT/'assets/js'/js))
        def open_info():
            page.evaluate("Solar91PortalPlantsTable.show(document.querySelector('#host'), {})")
        open_info()
        page.get_by_text('All 42 plants',exact=True).wait_for(timeout=2000)
        for _ in range(3):open_info()
        assert page.evaluate('reads')==1
        page.evaluate('count=43; Solar91PortalData.invalidate(true)')
        # The actual Info/Health switch only dispatches an event; it does not remount.
        page.evaluate("document.dispatchEvent(new CustomEvent('portal:info-health-panel-opened',{detail:{section:'info'}}))")
        page.get_by_text('All 43 plants',exact=True).wait_for(timeout=2000)
        assert page.evaluate('reads')==2
        for _ in range(3):open_info()
        assert page.evaluate('reads')==2
        # Simulate a different user's addition after the existing 60s TTL.
        page.evaluate('count=72; const now=Date.now(); Date.now=()=>now+61000')
        open_info()
        page.get_by_text('All 72 plants',exact=True).wait_for(timeout=2000)
        assert page.evaluate('reads')==3
    finally:
        page.close()


def test_catalogue_cache_expiry_and_failed_read_are_bounded(chromium):
    page = chromium.new_page()
    try:
        page.set_content('<main></main>')
        page.add_script_tag(path=str(ROOT/'assets/js/portal-api.js'))
        outcome=page.evaluate('''async()=>{
          let reads=0, count=42, fail=false;
          let now=Date.now(); Date.now=()=>now;
          window.apiFetch=async url=>{
            if(url!=='/api/portal/plants')throw Error(url);
            reads++;
            if(fail){fail=false;throw Error('Network interrupted');}
            return {plants:Array.from({length:count},(_,i)=>({id:String(i),site_code:'P'+i,plant_name:'Plant '+i}))};
          };
          const api=Solar91PortalAPI;
          const first=api.plants();
          if(api.plants()!==first)throw Error('in-flight not shared');
          if((await first).length!==42)throw Error('initial count');
          await api.plants();
          if(reads!==1)throw Error('warm read duplicated');
          count=43; await api.plants(true);
          if((await api.plants()).length!==43 || reads!==2)throw Error('write refresh');
          count=72; now+=61000; fail=true;
          try{await api.plants();throw Error('failure not propagated');}catch(e){if(e.message!=='Network interrupted')throw e;}
          return {reads: (await api.plants(),reads), count:(await api.plants()).length};
        }''')
        assert outcome=={'reads':4,'count':72}
    finally:
        page.close()


def test_real_add_plant_overlay_refreshes_info_and_shared_catalogue(chromium):
    page=chromium.new_page(viewport={'width':390,'height':844})
    try:
        page.set_content('<main id="host"></main>')
        page.evaluate('''()=>{
          window.records=Array.from({length:42},(_,i)=>({id:String(i),site_code:'P'+String(i).padStart(3,'0'),plant_name:'Plant '+i}));
          window.calls=[];window.changes=0;window.sidebarCount=0;
          window.apiFetch=async(url,opts)=>{
            calls.push([url,opts?.method||'GET']);
            if(url==='/api/plants'&&opts.method==='POST'){
              const record={...opts.body,id:'new43'};records.push(record);return record;
            }
            if(url==='/api/portal/plants')return {plants:records.slice()};
            if(url==='/api/portal/overview')return {rows:records.map(plant=>({plant,profile:{}})),totals:{}};
            throw Error(url);
          };
          document.addEventListener('portal:plants-changed',()=>changes++);
          window.Solar91PortalNav={loadPlants:async()=>{sidebarCount=(await Solar91PortalAPI.plants()).length;}};
        }''')
        for js in ('portal-api.js','format.js','table-sort.js','table-column-filter.js','data-adapter.js','plant-details.js','plants-table.js'):
            page.add_script_tag(path=str(ROOT/'assets/js'/js))
        page.evaluate("Solar91PortalAPI.setSession({user:{id:'head',role:'O&M Head'}}); Solar91PortalPlantsTable.show(document.querySelector('#host'),{})")
        page.get_by_text('All 42 plants',exact=True).wait_for()
        page.locator('[data-pt-add]').click()
        modal=page.locator('.ep-pd__modal')
        fields={'site_code':'NEW43','plant_name':'New plant','project_company':'SPV 1','ac_capacity_kw':'1000','dc_capacity_kw':'1200','district':'Test','discom':'Test','assigned_engineer':'Test Engineer','commissioned_on':'2026-11-27','address':'Test address','latitude':'26','longitude':'73'}
        for key,value in fields.items():modal.locator(f'[name="{key}"]').fill(value)
        modal.locator('[type="submit"]').click()
        page.get_by_text('All 43 plants',exact=True).wait_for()
        page.wait_for_function('sidebarCount===43')
        assert page.evaluate('changes')==1
        assert page.evaluate("calls.filter(x=>x[0]==='/api/plants'&&x[1]==='POST').length")==1
        assert page.evaluate("calls.filter(x=>x[0]==='/api/portal/plants').length")==1
        assert page.evaluate("calls.filter(x=>x[0]==='/api/portal/overview').length")==2
    finally:page.close()


def test_mounted_health_selector_reloads_after_plant_creation(chromium):
    page=chromium.new_page(viewport={'width':390,'height':844})
    try:
        page.set_content('<main id="host"></main>')
        page.evaluate('''()=>{
          window.plantCount=42;window.issueReads=0;window.plantReads=0;
          const user={id:'head',role:'O&M Head'};
          window.Solar91PortalAPI={currentUser:()=>user,session:()=>Promise.resolve({user}),isPortalRoute:()=>true,
            plants:()=>{plantReads++;return Promise.resolve(Array.from({length:plantCount},(_,i)=>({dbId:String(i),siteCode:'P'+String(i).padStart(3,'0'),plantName:'Plant '+i})));},
            request:url=>{if(url.startsWith('/api/issues?')){issueReads++;return Promise.resolve([]);}if(url==='/api/categories')return Promise.resolve({categories:[{name:'CCTV',sub_problems:['Other']}]});throw Error(url);}};
        }''')
        for js in ('format.js','table-sort.js','table-column-filter.js','site-issues.js'):
            page.add_script_tag(path=str(ROOT/'assets/js'/js))
        page.evaluate("Solar91PortalIssues.render(document.querySelector('#host'),{})")
        selector=page.locator('[data-issue-filter="plant"]')
        selector.locator('option[value="P041"]').wait_for(state='attached')
        assert selector.locator('option[value="P042"]').count()==0
        page.evaluate("plantCount=43;document.dispatchEvent(new CustomEvent('portal:plants-changed'));document.dispatchEvent(new CustomEvent('portal:info-health-panel-opened',{detail:{section:'health'}}))")
        selector.locator('option[value="P042"]').wait_for(state='attached')
        for _ in range(3):page.evaluate("document.dispatchEvent(new CustomEvent('portal:info-health-panel-opened',{detail:{section:'health'}}))")
        assert page.evaluate('[issueReads,plantReads]')==[2,2]
    finally:page.close()
