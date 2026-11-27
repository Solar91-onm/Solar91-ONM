"""42-plant regression guard; fixture is synthetic, never uses production credentials."""
from datetime import date
from statistics import median
from time import perf_counter
import json
from sqlalchemy import event
from app.core.models import Plant
from app.pmplan import tracking
from tests.conftest import login_user


def test_pm_portfolio_scale_budget(client, db, monkeypatch):
    monkeypatch.setattr(tracking, 'business_today', lambda: date(2026,12,8))
    login_user(client,db,role='O&M Head',email='scale-pm@example.com')
    for i in range(42):
        p=Plant(site_code=f'SCALE{i:02d}',plant_name=f'Scale plant {i:02d}',status='active');db.add(p);db.flush()
        if i>=33: continue
        for j in range(9 if i<28 else 8):
            db.add(tracking.PMTrackingActivity(plant_id=p.id,equipment='Inverter',equipment_id=f'INV {j+1}',scheduled_on=date(2026,12,1+(j*3+i)%28)))
        for j,equipment in enumerate(e for e in tracking.CHECKLISTS if e!='Inverter'):
            db.add(tracking.PMTrackingActivity(plant_id=p.id,equipment=equipment,equipment_id=equipment,scheduled_on=date(2026,12,1+(j*4+i)%28)))
    db.commit()
    bind=db.get_bind(); statements=[]; materialized=[]; original=tracking._rows
    def watched(*a,**kw):
        rows=original(*a,**kw);materialized.append(len(rows));return rows
    monkeypatch.setattr(tracking,'_rows',watched)
    def capture(conn,cursor,statement,*args):statements.append(statement)
    event.listen(bind,'before_cursor_execute',capture)
    try:
        measurements={}
        for key,params in [('month',{}),('day',{'date':'2026-12-08'})]:
            times=[]
            for i in range(6):
                statements.clear();materialized.clear();t=perf_counter()
                response=client.get('/api/pm-plan/tracking',params={'month':'2026-12','summary':True,**params})
                times.append((perf_counter()-t)*1000); assert response.status_code==200,response.text
            data=response.json();measurements[key]={'queries':len(statements),'activity_rows_hydrated_by_rows':sum(materialized),'response_bytes':len(response.content),'activities':len(data['activities']),'plants':len(data['plants']),'median_ms':round(median(times[1:]),2)}
        print('PM_SCALE '+json.dumps(measurements,sort_keys=True))
        assert measurements['month']['activities']==556 and measurements['month']['plants']==42
        assert measurements['month']['response_bytes']<350_000
        assert measurements['month']['queries']<=12 and measurements['day']['queries']<=14
        assert measurements['day']['response_bytes']<40_000
        assert measurements['day']['activity_rows_hydrated_by_rows']==measurements['day']['activities']
    finally:event.remove(bind,'before_cursor_execute',capture)
