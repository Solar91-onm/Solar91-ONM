"""Operations Calendar: real SQL date fields, roles, colours and plant isolation."""
from datetime import date, datetime, timezone
from uuid import uuid4

from app.core.models import Issue, OMTask, Plant, UserEquipmentTypeAssignment, UserPlantAssignment, WashingDailyReport
from tests.conftest import login_user


def plant(db, code):
    row = Plant(site_code=code, plant_name=f"Solar Park {code}", assigned_engineer=f"Engineer {code}")
    db.add(row); db.commit(); db.refresh(row)
    return row


def fixtures(db):
    a, b = plant(db, "CALA"), plant(db, "CALB")
    when = datetime(2026, 10, 29, 2, 0, tzinfo=timezone.utc)
    issues = [Issue(ticket_no=f"CALI-{i}", plant_id=p.id, severity=severity, status=status,
                    occurred_at=when, description=f"Actual inverter fault {i}", vertical="Inverter",
                    subcategory="DC Input", assignee_text="Ravi")
              for i, p, severity, status in [(1,a,"Critical","Open"),(2,a,"Medium","Resolved"),(3,b,"Critical","Open")]]
    tasks = [OMTask(work_order_no=f"CALPM-{i}", plant_id=a.id, task_name="Check inverter", task_type="Inverter",
                    equipment_ref=f"INV-{i}", due_on=date(2026,10,29), status=status, unit_no=i)
             for i, status in [(1,"Scheduled"),(2,"Completed")]]
    washing = WashingDailyReport(plant_id=a.id,cycle_month="2026-10",cycle_no=3,
        report_date=date(2026,10,29),job_status="Done",tables_cleaned=12,reported_by="Engineer CALA",
        review_status="Pending")
    db.add_all(issues+tasks+[washing]);db.commit()
    return a,b,issues,tasks,washing


def fetch(client, start='2026-10-29', end='2026-10-29', **filters):
    return client.get('/api/operations-calendar', params={'start':start,'end':end,**filters})


def test_mixed_day_multiple_pm_units_and_done_colours(client,db):
    login_user(client,db)
    fixtures(db)
    res=fetch(client)
    assert res.status_code==200, res.text
    rows=res.json()['events']
    assert len(rows)==6
    assert {r['kind'] for r in rows}=={'issue','pm','washing'}
    assert len({r['key'] for r in rows})==6
    assert {r['unit'] for r in rows if r['kind']=='pm'}=={1,2}
    assert {r['reference']:r['tone'] for r in rows}['CALI-1']=='critical'
    assert {r['reference']:r['tone'] for r in rows}['CALI-2']=='done'
    assert {r['reference']:r['tone'] for r in rows}['CALPM-2']=='done'
    assert next(r for r in rows if r['kind']=='washing')['tone']=='washing'


def test_scope_filters_and_detail_enforced(client,db):
    a,b,issues,tasks,wash=fixtures(db)
    user=login_user(client,db,role='Site Engineer',name='Field',email='cal-field@example.com')
    db.add(UserPlantAssignment(user_id=user.id,plant_id=a.id));db.commit()
    res=fetch(client)
    assert res.status_code==200
    rows=res.json()['events']
    assert len(rows)==5 and {x['plant_id'] for x in rows}=={str(a.id)}
    denied=fetch(client,plant_id=str(b.id))
    assert denied.status_code==403
    assert client.get(f'/api/operations-calendar/issue/{issues[2].id}').status_code==403
    assert client.get(f'/api/operations-calendar/issue/{issues[0].id}').status_code==200
    assert client.get(f'/api/operations-calendar/pm/{tasks[0].id}').status_code==200
    assert client.get(f'/api/operations-calendar/washing/{wash.id}').status_code==200


def test_assignee_type_and_washing_access(client,db):
    a,b,issues,tasks,wash=fixtures(db)
    user=login_user(client,db,role='Assignee',name='Inverter Team',email='calendar-assignee@example.com')
    db.add(UserEquipmentTypeAssignment(user_id=user.id,equipment_type='Inverter'));db.commit()
    rows=fetch(client).json()['events']
    assert len(rows)==5 and all(r['kind']!='washing' for r in rows)
    assert client.get(f'/api/operations-calendar/washing/{wash.id}').status_code==403


def test_query_filters_and_range_validation(client,db):
    login_user(client,db)
    fixtures(db)
    assert len(fetch(client,activity_type='pm').json()['events'])==2
    assert len(fetch(client,severity='Critical').json()['events'])==2
    assert len(fetch(client,status='Resolved').json()['events'])==1
    assert len(fetch(client,q='DC Input').json()['events'])==3  # search includes actual equipment subpart
    assert len(fetch(client,subpart='DC Input').json()['events'])==3
    assert len(fetch(client,equipment='Inverter').json()['events'])==5
    assert fetch(client,start='2026-10-30',end='2026-10-29').status_code==422
    assert fetch(client,start='2026-01-01',end='2026-10-29').status_code==422
    assert fetch(client,activity_type='imaginary').status_code==422


def test_timezone_boundary_and_leap_day(client,db):
    login_user(client,db)
    p=plant(db,'CAL-LEAP')
    db.add(Issue(ticket_no='LEAP',plant_id=p.id,severity='Medium',status='Open',vertical='Inverter',
        description='Local midnight',occurred_at=datetime(2024,2,28,19,0,tzinfo=timezone.utc)))
    db.commit()
    assert [r['reference'] for r in fetch(client,'2024-02-29','2024-02-29').json()['events']]==['LEAP']
    assert fetch(client,'2024-02-28','2024-02-28').json()['events']==[]


def test_popup_detail_uses_actual_fields_and_evidence_is_not_preloaded(client,db):
    login_user(client,db)
    a,b,issues,tasks,washing=fixtures(db)
    items=fetch(client).json()['events']
    assert all('evidence' not in item and 'description' not in item for item in items)
    issue=client.get(f'/api/operations-calendar/issue/{issues[0].id}').json()
    assert issue['description']=='Actual inverter fault 1' and issue['subpart']=='DC Input'
    pm=client.get(f'/api/operations-calendar/pm/{tasks[0].id}').json()
    assert pm['completed_on'] is None and pm['unit']==1
    wash=client.get(f'/api/operations-calendar/washing/{washing.id}').json()
    assert wash['status']=='Pending' and wash['tables_cleaned']==12 and wash['target_count'] is None


def test_planned_washing_cycle_deadline_is_distinct_from_actual_report(client, db):
    """A configured cycle deadline is a schedule, never an invented daily report."""
    from app.core.models import WashingConfig
    login_user(client, db)
    p = plant(db, 'CAL-SCHEDULE')
    db.add(WashingConfig(plant_id=p.id, active=True, tables_per_cycle=50,
        cycle_overrides={'2026-10': {'1': '2026-10-29', 's1': '2026-10-01'}}))
    db.add(WashingDailyReport(plant_id=p.id, cycle_month='2026-10', cycle_no=1,
        report_date=date(2026, 10, 29), job_status='Done', tables_cleaned=18,
        reported_by='Actual Engineer', review_status='Pending', cycle_completed=True))
    db.commit()
    rows = fetch(client, plant_id=str(p.id)).json()['events']
    assert len(rows) == 2
    scheduled = next(x for x in rows if x.get('source') == 'cycle')
    actual = next(x for x in rows if x.get('source') != 'cycle')
    assert scheduled['status'] == 'In progress' and scheduled['tone'] != 'done'
    assert actual['status'] == 'Pending' and actual['tone'] != 'done'
    assert scheduled['key'] != actual['key']
    detail = client.get(f'/api/operations-calendar/washing-cycle/{p.id}/2026-10/1')
    assert detail.status_code == 200, detail.text
    assert detail.json()['target_count'] == 50
    assert detail.json()['reports'] == 1
    assert detail.json()['completed_on'] is None
    assert detail.json()['date'] == '2026-10-29'


def test_confirmed_washing_cycle_is_green_but_same_day_report_is_separate(client, db):
    from app.core.models import WashingConfig
    login_user(client, db)
    p = plant(db, 'CAL-CONFIRMED')
    db.add(WashingConfig(plant_id=p.id, active=True, tables_per_cycle=35,
        cycle_overrides={'2026-10': {'1': '2026-10-29'}}))
    db.add(WashingDailyReport(plant_id=p.id, cycle_month='2026-10', cycle_no=1,
        report_date=date(2026, 10, 29), job_status='Done', tables_cleaned=35,
        reported_by='Actual Engineer', review_status='Confirmed', cycle_completed=True))
    db.commit()
    rows = fetch(client, plant_id=str(p.id)).json()['events']
    assert len(rows) == 2 and all(x['tone'] == 'done' for x in rows)
    assert len({x['key'] for x in rows}) == 2
    assert next(x for x in rows if x.get('source') == 'cycle')['status'] == 'Completed'


def test_cycle_deadline_is_denied_to_unauthorised_site_engineer(client, db):
    from app.core.models import WashingConfig
    own, foreign = plant(db, 'CAL-OWN'), plant(db, 'CAL-FOREIGN')
    db.add_all([WashingConfig(plant_id=own.id, active=True),
                WashingConfig(plant_id=foreign.id, active=True)])
    db.commit()
    user = login_user(client, db, role='Site Engineer', name='Scoped Engineer',
                      email='cal-new-field@example.com')
    db.add(UserPlantAssignment(user_id=user.id, plant_id=own.id)); db.commit()
    own_rows = fetch(client, '2026-10-31', '2026-10-31').json()['events']
    assert len(own_rows) == 1 and own_rows[0]['plant_id'] == str(own.id)
    assert client.get(f'/api/operations-calendar/washing-cycle/{foreign.id}/2026-10/3').status_code == 403


def test_overdue_filter_uses_real_due_date_and_uncompleted_status(client, db):
    from app.core.timeutil import business_today
    login_user(client, db)
    p = plant(db, 'CAL-OVERDUE')
    due = business_today()
    from datetime import timedelta
    late = due - timedelta(days=7)
    db.add_all([OMTask(work_order_no='LATE-01', plant_id=p.id, task_name='Service module',
                       task_type='Inverter', due_on=late, status='Scheduled'),
                OMTask(work_order_no='LATE-02', plant_id=p.id, task_name='Done module',
                       task_type='Inverter', due_on=late, status='Completed')])
    db.commit()
    rows = fetch(client, late.isoformat(), late.isoformat(), status='Overdue').json()['events']
    assert [r['reference'] for r in rows] == ['LATE-01']
    assert rows[0]['tone'] == 'overdue'
