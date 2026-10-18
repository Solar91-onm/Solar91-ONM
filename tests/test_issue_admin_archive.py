"""Safe issue deletion: auditable, reversible, role-protected, and absent from all live registers."""
from uuid import UUID
from app.core.models import Issue, IssueHistory, Plant
from tests.conftest import login_user


def prepare(client, db):
    plant=Plant(site_code='ARCH-QA',plant_name='Archive Test Solar Plant')
    db.add(plant);db.commit();db.refresh(plant)
    login_user(client,db,role='O&M Head',name='Archive Manager',email='archive-manager@example.com')
    response=client.post('/api/issues',json={'plant_id':str(plant.id),'description':'Wrong alarm mistakenly logged','severity':'Low','vertical':'Inverter'})
    assert response.status_code==201,response.text
    return plant,response.json()


def test_head_soft_deletes_restores_and_preserves_history(client,db):
    plant,issue=prepare(client,db)
    iid=issue['id'];ticket=issue['ticket_no']
    invalid=client.request('DELETE',f'/api/issues/{iid}',json={'confirm_ticket':ticket,'reason':'short'})
    assert invalid.status_code==422
    mismatch=client.request('DELETE',f'/api/issues/{iid}',json={'confirm_ticket':'WRONG','reason':'Duplicate entered by mistake'})
    assert mismatch.status_code==422
    assert len(client.get('/api/issues').json())==1
    deleted=client.request('DELETE',f'/api/issues/{iid}',json={'confirm_ticket':ticket,'reason':'Accidentally entered the same ticket twice'})
    assert deleted.status_code==200,deleted.text
    assert deleted.json()=={'ticket_no':ticket,'deleted':True,'restorable':True}
    assert client.get('/api/issues').json()==[]
    assert client.get('/api/bootstrap').json()['state']['issues']==[]
    archived=client.get('/api/issues/deleted').json()
    assert len(archived)==1 and archived[0]['ticket_no']==ticket
    assert archived[0]['deleted_at'] and archived[0]['deletion_reason']
    assert client.post(f'/api/issues/{iid}/progress',json={'note':'Attempt on deleted record'}).status_code==404
    assert client.patch(f'/api/issues/{iid}',json={'description':'Update deleted ticket'}).status_code==404
    assert client.request('DELETE',f'/api/issues/{iid}',json={'confirm_ticket':ticket,'reason':'Accidentally entered the same ticket twice'}).status_code==409
    assert client.post(f'/api/issues/{iid}/restore',json={'reason':'short'}).status_code==422
    restored=client.post(f'/api/issues/{iid}/restore',json={'reason':'Verified the alarm and the ticket is genuine'})
    assert restored.status_code==200,restored.text
    assert restored.json()['deleted_at'] is None
    assert len(client.get('/api/issues').json())==1
    assert client.get('/api/issues/deleted').json()==[]
    assert client.post(f'/api/issues/{iid}/restore',json={'reason':'Duplicate restoration request'}).status_code==409
    history=[h.action for h in db.query(IssueHistory).filter(IssueHistory.issue_id==UUID(iid))]
    assert 'issue.deleted' in history and 'issue.restored' in history


def test_non_head_cannot_read_archived_or_edit_delete_restore(client,db):
    plant,issue=prepare(client,db)
    iid=issue['id'];ticket=issue['ticket_no']
    login_user(client,db,role='Site Engineer',name='Field Engineer',email='field-archive@example.com')
    assert client.get('/api/issues/deleted').status_code==403
    assert client.patch(f'/api/issues/{iid}',json={'description':'Unauthorized correction'}).status_code==403
    assert client.request('DELETE',f'/api/issues/{iid}',json={'confirm_ticket':ticket,'reason':'Cannot archive without management'}).status_code==403
    assert client.post(f'/api/issues/{iid}/restore',json={'reason':'Cannot restore without management'}).status_code==403


def test_edit_recorded_with_old_and_new_values(client,db):
    plant,issue=prepare(client,db)
    iid=issue['id']
    response=client.patch(f'/api/issues/{iid}',json={'description':'Correct alarm message','severity':'Critical','change_reason':'Corrected wrong site observation'})
    assert response.status_code==200,response.text
    assert response.json()['description']=='Correct alarm message'
    history=db.query(IssueHistory).filter(IssueHistory.issue_id==UUID(iid),IssueHistory.action=='issue.edited').first()
    assert history and history.metadata_json['changes']['description']['before']=='Wrong alarm mistakenly logged'
    assert history.metadata_json['changes']['description']['after']=='Correct alarm message'
    assert client.patch(f'/api/issues/{iid}',json={'description':'  ','change_reason':'Wrong entry'}).status_code==422


def test_archived_issue_not_resurrected_by_legacy_state_sync(client,db):
    plant,issue=prepare(client,db)
    iid=issue['id'];ticket=issue['ticket_no']
    client.request('DELETE',f'/api/issues/{iid}',json={'confirm_ticket':ticket,'reason':'Duplicate entered by mistake'})
    from app.core.legacy_state import _sync_state_head
    from sqlalchemy import select
    from app.core.models import User
    manager=db.scalar(select(User).where(User.email=='archive-manager@example.com'))
    _sync_state_head(db,{'issues':[{'id':ticket,'plant':plant.plant_name,'desc':'Stale client copy'}]},None,manager)
    db.expire_all()
    saved=db.get(Issue,UUID(iid))
    assert saved.deleted_at is not None and saved.description=='Wrong alarm mistakenly logged'
    assert client.get('/api/issues').json()==[]
