from datetime import date, datetime, timedelta, timezone

from app.core.models import OMTask, PMDueChange, PMFollowUp, Plant, User
from app.pmplan.followups import get_follow_up_state
from tests.conftest import login_user


def _task(db, *, due_on=None, assignee_id=None):
    plant=Plant(site_code="FU01",plant_name="Follow-up Plant")
    db.add(plant)
    db.flush()
    task=OMTask(
        work_order_no="WO-FOLLOWUP",plant_id=plant.id,task_name="Clean inverter",
        task_type="Inverter",frequency="Monthly",due_on=due_on or date.today()-timedelta(days=2),
        status="Scheduled",assignee_user_id=assignee_id,assignee_text="Assignee",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def test_follow_up_state_covers_none_promised_missed_old_and_recent(db):
    task=_task(db)
    today=date(2026,10,9)
    assert get_follow_up_state(db,task,today)=="none"

    row=PMFollowUp(task_id=task.id,by_name="Ravi",how="Called",
                   outcome="Will finish by the promised date",promised_on=today+timedelta(days=2),
                   at=datetime(2026,10,8,8,tzinfo=timezone.utc))
    db.add(row); db.commit()
    assert get_follow_up_state(db,task,today)=="promised"

    row.promised_on=today-timedelta(days=1)
    db.commit()
    assert get_follow_up_state(db,task,today)=="missed"

    row.promised_on=None
    row.at=datetime(2026,10,6,8,tzinfo=timezone.utc)
    db.commit()
    assert get_follow_up_state(db,task,today)=="old"

    row.at=datetime(2026,10,8,8,tzinfo=timezone.utc)
    db.commit()
    assert get_follow_up_state(db,task,today)=="ok"


def test_head_and_assigned_assignee_can_log_followups(client,db):
    head=login_user(client,db,role="O&M Head",name="Head",email="fu-head@example.com")
    assignee=User(auth_provider="test",external_subject="fu-assignee",email="fu-assignee@example.com",
                  display_name="Ravi",role="Assignee",is_active=True)
    db.add(assignee); db.commit(); db.refresh(assignee)
    task=_task(db,assignee_id=assignee.id)
    body={
        "how":"Called","spoke_to":"Site engineer","outcome":"Blocked: waiting for parts",
        "promised_on":(date.today()+timedelta(days=2)).isoformat(),"note":"Spare is on order",
    }
    response=client.post(f"/api/scheduled/tasks/{task.work_order_no}/followups",json=body)
    assert response.status_code==200,response.text
    assert response.json()["by_name"]=="Head"
    assert client.get(f"/api/scheduled/tasks/{task.work_order_no}/followups").json()[0]["outcome"]==body["outcome"]

    from tests import conftest
    conftest._CURRENT_USER=db.get(User,assignee.id)
    response=client.post(f"/api/scheduled/tasks/{task.work_order_no}/followups",json={
        "how":"Messaged","outcome":"Could not reach anyone",
    })
    assert response.status_code==200,response.text
    assert response.json()["by_user_id"]==str(assignee.id)


def test_followups_reject_out_of_scope_roles_and_past_promises(client,db):
    engineer=login_user(client,db,role="Site Engineer",name="Engineer",email="fu-engineer@example.com")
    task=_task(db)
    url=f"/api/scheduled/tasks/{task.work_order_no}/followups"
    payload={"how":"Called","outcome":"Could not reach anyone"}
    assert client.post(url,json=payload).status_code==403
    assert client.get(url).status_code==403

    login_user(client,db,role="O&M Head",name="Head",email="fu-head2@example.com")
    past=client.post(url,json={**payload,"promised_on":(date.today()-timedelta(days=1)).isoformat()})
    assert past.status_code==422
    bad_outcome=client.post(url,json={**payload,"outcome":"Something else"})
    assert bad_outcome.status_code==422

    from tests import conftest
    conftest._CURRENT_USER=engineer
    assert client.post(url,json=payload).status_code==403


def test_overdue_due_date_moves_need_reason_and_are_recorded(client,db):
    login_user(client,db,role="O&M Head",name="Head",email="fu-due-head@example.com")
    task=_task(db,due_on=date.today()-timedelta(days=2))
    url=f"/api/scheduled/tasks/{task.work_order_no}/schedule"
    later=date.today()+timedelta(days=2)
    missing=client.patch(url,json={"due_on":later.isoformat()})
    assert missing.status_code==422
    changed=client.patch(url,json={"due_on":later.isoformat(),"reason":"Waiting for shutdown","quantity":15})
    assert changed.status_code==200,changed.text
    due_change=db.query(PMDueChange).filter_by(task_id=task.id).one()
    assert due_change.reason=="Waiting for shutdown"
    assert due_change.old_due==date.today()-timedelta(days=2) and due_change.new_due==later
    assert changed.json()["task"]["quantity"]==15


def test_task_output_includes_quantity_lateness_and_follow_up_state(client,db):
    head=login_user(client,db,role="O&M Head",name="Head",email="fu-out-head@example.com")
    task=_task(db)
    task.quantity=12
    db.add(PMFollowUp(
        task_id=task.id,by_user_id=head.id,by_name=head.display_name,how="Called",
        outcome="Will finish by the promised date",promised_on=date.today()+timedelta(days=3),
        at=datetime.now(timezone.utc),
    ))
    db.commit()
    result=client.get("/api/scheduled/tasks")
    assert result.status_code==200
    row=next(row for row in result.json() if row["id"]==task.work_order_no)
    assert row["quantity"]==12
    assert row["days_late"]==2
    assert row["follow_up_state"]=="promised"
    assert row["last_follow_up"]["by_name"]=="Head"
    assert row["planned_due_on"]==task.due_on.isoformat()
