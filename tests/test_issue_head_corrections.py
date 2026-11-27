"""Head-only corrections and database-filtered personal register."""
from uuid import UUID
import pytest
from sqlalchemy import event
from app.core.models import Issue, IssueHistory, UserPlantAssignment
from app.equipment.service import canonical_key
from tests.conftest import login_user, seed_work_categories
from tests.test_equipment_responsibility import _act_as, _assignee, _plants
from tests.test_site_issue_routing import set_rule

@pytest.fixture
def setup(client, db):
    p,q = _plants(db,'COR01','COR02')
    head = login_user(client,db,role='O&M Head')
    a = _assignee(db,'Owner A','cor-a@example.com')
    b = _assignee(db,'Owner B','cor-b@example.com')
    seed_work_categories(db,'Other','CCTV','Street Light',sub_problems=['No video','Other'])
    _act_as(db,head)
    return p,q,head,a,b

def create(client,plant,owner,remark='Camera faulty'):
    r=client.post('/api/issues',json={'plant_id':str(plant.id),'vertical':'Other','subcategory':'Other','description':remark,'assigned_to':str(owner.id)})
    assert r.status_code==201,r.text
    return r.json()

def test_head_correction_atomic_and_audited(client,db,setup):
    p,q,head,a,b=setup
    assert set_rule(client,[p],canonical_key('CCTV'),b,a).status_code==200
    old=create(client,p,a); url='/api/issues/'+old['id']
    r=client.patch(url,json={'vertical':'CCTV','subcategory':'No video','description':'','assignment_mode':'auto'})
    assert r.status_code==200,r.text
    out=r.json()
    assert (out['vertical'],out['subcategory'],out['description'],out['assigned_to'])==('CCTV','No video','',str(b.id))
    for key in ('id','ticket_no','created_at','status','photo_count','plant_id'): assert out[key]==old[key]
    h=db.query(IssueHistory).filter_by(issue_id=UUID(old['id']),action='issue.edited').one()
    assert h.metadata_json['assignment_rule']=='plant_equipment_primary'
    assert h.metadata_json['changes']['description']=={'before':'Camera faulty','after':''}
    for payload in ({'vertical':'Street Light','subcategory':'Bogus','description':'partial','assignment_mode':'retain'}, {'vertical':'Street Light','description':'partial','assignment_mode':'auto'}, {'description':'partial','assignment_mode':'manual','assigned_to':str(head.id)}):
        assert client.patch(url,json=payload).status_code==422
        db.expire_all(); row=db.get(Issue,UUID(old['id']))
        assert row.description=='' and row.vertical=='CCTV'
    assert db.query(IssueHistory).filter_by(issue_id=UUID(old['id']),action='issue.edited').count()==1

def test_retain_manual_and_closed_history(client,db,setup):
    p,q,head,a,b=setup
    old=create(client,p,a); url='/api/issues/'+old['id']
    r=client.patch(url,json={'vertical':'Street Light','assignment_mode':'retain'})
    assert r.status_code==200,r.text
    assert r.json()['assigned_to']==str(a.id) and r.json()['subcategory'] is None
    r=client.patch(url,json={'assignment_mode':'manual','assigned_to':str(b.id)})
    assert r.status_code==200,r.text
    assert r.json()['assigned_to']==str(b.id)
    assert client.post(url+'/close',json={'note':'Verified closure','direct':True}).status_code==200
    r=client.patch(url,json={'vertical':'CCTV','description':''})
    assert r.status_code==200,r.text
    assert r.json()['status']=='Closed' and r.json()['assigned_to']==str(b.id)
    assert client.patch(url,json={'assignment_mode':'manual','assigned_to':str(a.id)}).status_code==409

def test_backup_preserves_active_work(client,db,setup):
    p,q,head,a,b=setup
    assert set_rule(client,[p],canonical_key('CCTV'),a,b).status_code==200
    old=create(client,p,a);url='/api/issues/'+old['id']
    _act_as(db,a)
    assert client.post(url+'/acknowledge').status_code==200
    assert client.post(url+'/start').status_code==200
    _act_as(db,head); a.is_active=False;db.commit()
    r=client.patch(url,json={'vertical':'CCTV'})
    assert r.status_code==200,r.text
    assert (r.json()['assigned_to'],r.json()['status'])==(str(b.id),'In Progress')

def test_mine_filter_before_paging_and_role_restrictions(client,db,setup):
    p,q,head,a,b=setup
    mine=create(client,p,a,'Mine'); other=create(client,p,b,'Other owner'); elsewhere=create(client,q,a,'Another plant')
    db.get(Issue,UUID(other['id'])).assignee_text=a.display_name;db.commit()
    _act_as(db,a); statements=[]
    def capture(conn,cursor,sql,parameters,*args): statements.append(sql)
    event.listen(db.get_bind(),'before_cursor_execute',capture)
    try:
        r=client.get('/api/issues?mine=true&site_code='+p.site_code+'&limit=1')
        assert r.status_code==200,r.text
        assert [i['id'] for i in r.json()]==[mine['id']]
        assert len(statements)<=2,statements
    finally: event.remove(db.get_bind(),'before_cursor_execute',capture)
    assert {i['id'] for i in client.get('/api/issues?mine=true').json()}=={mine['id'],elsewhere['id']}
    assert {i['id'] for i in client.get('/api/issues').json()}=={mine['id'],other['id'],elsewhere['id']}
    for fields in ({'vertical':'CCTV'},{'subcategory':'No video'},{'description':''},{'description':'New remark'},{'assignment_mode':'manual','assigned_to':str(b.id)},{'assignment_mode':'auto'}):
        assert client.patch('/api/issues/'+mine['id'],json=fields).status_code==403
    assert client.patch('/api/issues/'+other['id'],json={'severity':'Critical'}).status_code==403
    assert client.patch('/api/issues/'+mine['id'],json={'severity':'Critical'}).status_code==200
    engineer=login_user(client,db,role='Site Engineer',email='cor-se@example.com')
    db.add(UserPlantAssignment(user_id=engineer.id,plant_id=p.id,assignment_role='Site Engineer'));db.commit()
    assert client.get('/api/issues?mine=true').json()==[]
    assert {i['id'] for i in client.get('/api/issues').json()}=={mine['id'],other['id']}
    assert client.patch('/api/issues/'+mine['id'],json={'description':''}).status_code==403


def test_personal_register_payload_and_query_budget_for_42_plants(client, db, setup):
    p,q,head,a,b=setup
    plants=[p,q]+_plants(db,*[f'COR{i:02}' for i in range(3,43)])
    for i in range(200):
        owner=a if i%4==0 else b
        db.add(Issue(ticket_no=f'COR-BUD-{i:04}',plant_id=plants[i%42].id,vertical='CCTV',
                     description='Synthetic field issue',severity='Medium',status='Assigned',
                     assigned_to=owner.id,assignee_text=owner.display_name))
    db.commit(); _act_as(db,a)
    statements=[]
    def capture(conn,cursor,sql,parameters,*args): statements.append(sql)
    event.listen(db.get_bind(),'before_cursor_execute',capture)
    try:
        all_rows=client.get('/api/issues?limit=200'); all_queries=len(statements)
        statements.clear()
        own_rows=client.get('/api/issues?limit=200&mine=true'); own_queries=len(statements)
        assert all_rows.status_code==own_rows.status_code==200
        assert len(all_rows.json())==200 and len(own_rows.json())==50
        assert own_queries==all_queries<=2
        assert len(own_rows.content)<len(all_rows.content)*0.30
        print(f'Personal register budget: {len(all_rows.content)} -> {len(own_rows.content)} response bytes; {all_queries} -> {own_queries} SQL statements')
    finally: event.remove(db.get_bind(),'before_cursor_execute',capture)
