"""Site Issues workflow rules: real Assignees from the database, one source of truth on the server,
O&M Head-only edit/close, and a state sync that can never undo a workflow step."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from app.core.models import Equipment, Issue, IssueETCChange, IssueHistory, IssueStep, Notification, Plant, User, UserEquipmentTypeAssignment, UserPlantAssignment
from tests.conftest import login_user


def _head_with_issue(client, db, *, vertical="Inverter", code="WR01"):
    assignee = User(auth_provider="test", external_subject="wr-assignee", email="wr-a@example.com",
                    display_name="Ravi Assignee", role="Assignee", is_active=True)
    db.add(assignee); db.commit(); db.refresh(assignee)
    login_user(client, db, role="O&M Head", name="Head", email="wr-head@example.com")
    plant = client.post("/api/plants", json={"site_code": code, "plant_name": "Workflow Rules Plant"}).json()
    issue = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": vertical,
                                             "description": "Inverter tripping", "severity": "High"}).json()
    return assignee, plant, issue


def _set_user(db, user_id):
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, user_id)


def _plant_today():
    return datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5,minutes=30))).date()


def test_assignees_endpoint_lists_every_active_assignee(client, db):
    assignee, _, _ = _head_with_issue(client, db)
    rows = client.get("/api/issues/assignees").json()
    assert str(assignee.id) in {r["id"] for r in rows}      # no equipment scope yet, still listed


def test_head_assigning_an_unscoped_assignee_grants_the_category_scope(client, db):
    assignee, _, issue = _head_with_issue(client, db)
    resp = client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["assigned_to"] == str(assignee.id) and body["assignee_text"] == "Ravi Assignee" and body["status"] == "Assigned"
    owned = [t.equipment_type for t in db.query(UserEquipmentTypeAssignment).filter_by(user_id=assignee.id)]
    assert owned == ["Inverter"]


def test_assignment_by_name_only_resolves_to_the_database_user(client, db):
    assignee, _, issue = _head_with_issue(client, db)
    resp = client.post(f"/api/issues/{issue['id']}/assign", json={"assignee_text": "ravi assignee"})
    assert resp.status_code == 200 and resp.json()["assigned_to"] == str(assignee.id)


def test_only_assignee_role_users_can_be_assigned(client, db):
    _, _, issue = _head_with_issue(client, db)
    tech = User(auth_provider="test", external_subject="wr-tech", email="wr-t@example.com",
                display_name="Some Engineer", role="Site Engineer", is_active=True)
    db.add(tech); db.commit(); db.refresh(tech)
    assert client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(tech.id)}).status_code == 422
    assert client.post(f"/api/issues/{issue['id']}/assign", json={"assignee_text": "Nobody Here"}).status_code == 422


def test_assigned_assignee_can_acknowledge_and_move_forward(client, db):
    assignee, _, issue = _head_with_issue(client, db)
    assert client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)}).status_code == 200
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code == 200
    assert client.post(f"/api/issues/{issue['id']}/start").status_code == 200


def test_ticket_assigned_by_name_only_can_still_be_acknowledged_by_that_assignee(client, db):
    assignee, plant, _ = _head_with_issue(client, db)
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Inverter"))
    row = Issue(ticket_no="TKT-LEGACY-1", plant_id=UUID(plant["id"]), vertical="Inverter", description="Legacy",
                severity="Medium", status="Assigned", assignee_text="Ravi Assignee", assigned_to=None)
    db.add(row); db.commit(); db.refresh(row)
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, assignee.id)
    resp = client.post(f"/api/issues/{row.id}/acknowledge")
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(Issue, row.id).assigned_to == assignee.id


def test_unassigned_ticket_cannot_be_acknowledged_by_an_assignee(client, db):
    assignee, _, issue = _head_with_issue(client, db)
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Inverter")); db.commit()
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code == 403


def test_only_the_head_can_edit_or_close_and_direct_close_needs_a_reason(client, db):
    assignee, _, issue = _head_with_issue(client, db)
    client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)})
    from tests import conftest
    head = conftest._CURRENT_USER
    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.patch(f"/api/issues/{issue['id']}", json={"description": "tampered"}).status_code == 403
    assert client.post(f"/api/issues/{issue['id']}/close", json={"note": "x", "direct": True}).status_code == 403
    conftest._CURRENT_USER = head
    assert client.patch(f"/api/issues/{issue['id']}", json={"severity": "Critical"}).status_code == 200
    assert client.post(f"/api/issues/{issue['id']}/close", json={"direct": True}).status_code == 422
    closed = client.post(f"/api/issues/{issue['id']}/close", json={"note": "Duplicate of another ticket", "direct": True})
    assert closed.status_code == 200 and closed.json()["status"] == "Closed"


def test_status_cannot_be_changed_through_edit(client, db):
    _, _, issue = _head_with_issue(client, db)
    client.patch(f"/api/issues/{issue['id']}", json={"status": "Closed", "description": "Edited text"})
    db.expire_all()
    row = db.get(Issue, UUID(issue["id"]))
    assert row.status == "Open" and row.description == "Edited text"


def test_stale_browser_state_cannot_undo_a_workflow_step(client, db):
    assignee, _, issue = _head_with_issue(client, db)
    client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)})
    stale = client.get("/api/bootstrap").json()                      # the head's screen still says "Assigned"
    from tests import conftest
    head = conftest._CURRENT_USER
    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code == 200
    conftest._CURRENT_USER = head
    resp = client.put("/api/state/sync", json={"revision": stale["revision"], "state": stale["state"]})
    assert resp.status_code in (200, 409)
    db.expire_all()
    assert db.get(Issue, UUID(issue["id"])).status == "Acknowledged"


def test_ticket_number_is_assigned_even_if_notifications_fail(client, db, monkeypatch):
    import app.notifications.service as notifications
    def boom(*args, **kwargs):
        raise RuntimeError("notification backend down")
    monkeypatch.setattr(notifications, "notify_issue_assignee_and_heads", boom)
    _, _, issue = _head_with_issue(client, db, code="WR02")
    assert issue["ticket_no"].startswith("ISS-") and issue["status"] == "Open"


def test_site_engineer_can_raise_equipment_issue_and_notifies_assignee_and_heads(client, db):
    head = login_user(client, db, role="O&M Head", name="Operations Head", email="raise-head@example.com")
    plant = Plant(site_code="WR-SE-ISSUE", plant_name="Site Engineer Issue Plant")
    db.add(plant)
    db.flush()
    engineer = User(auth_provider="test", external_subject="wr-se-issue", email="raise-se@example.com",
                    display_name="Field Engineer", role="Site Engineer", is_active=True)
    assignee = User(auth_provider="test", external_subject="wr-se-assignee", email="raise-assignee@example.com",
                    display_name="Inverter Assignee", role="Assignee", is_active=True)
    equipment = Equipment(plant_id=plant.id, equipment_code="INV-07", equipment_name="Inverter 7",
                          equipment_type="Inverter", status="active")
    db.add_all([engineer, assignee, equipment])
    db.flush()
    db.add_all([
        UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"),
        UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Inverter"),
    ])
    db.commit()
    _set_user(db, engineer.id)

    response = client.post("/api/issues", json={
        "plant_id": str(plant.id), "equipment_id": str(equipment.id), "equipment_ref": "INV-07",
        "vertical": "Inverter", "description": "Inverter trips on startup", "severity": "Medium",
        "assigned_to": str(assignee.id),
    })

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["equipment_id"] == str(equipment.id)
    assert body["equipment_ref"] == "INV-07"
    assert {(row.event_type, row.user_id) for row in db.query(Notification).all()} == {
        ("issue_created", head.id), ("issue_created", assignee.id),
    }

    message = client.post(f"/api/issues/{body['id']}/comments", json={
        "message": "INV-07 has tripped twice; please confirm before dispatch.",
    })
    assert message.status_code == 200, message.text
    assert message.json()["note"] == "INV-07 has tripped twice; please confirm before dispatch."
    _set_user(db, assignee.id)
    acknowledged = client.post(f"/api/issues/{body['id']}/acknowledge")
    assert acknowledged.status_code == 200 and acknowledged.json()["status"] == "Acknowledged"
    started = client.post(f"/api/issues/{body['id']}/start")
    assert started.status_code == 200 and started.json()["status"] == "In Progress"
    activity = client.get(f"/api/issues/{body['id']}/activity")
    assert activity.status_code == 200
    assert any(entry["action"] == "issue.message" for entry in activity.json())
    assert {(row.event_type, row.user_id) for row in db.query(Notification).all()
            if row.event_type == "issue_message"} >= {
        ("issue_message", head.id), ("issue_message", assignee.id),
    }

    _set_user(db, engineer.id)
    other_plant = Plant(site_code="WR-SE-OTHER", plant_name="Outside Plant")
    db.add(other_plant)
    db.commit()
    denied = client.post("/api/issues", json={
        "plant_id": str(other_plant.id), "equipment_ref": "INV-07", "vertical": "Inverter",
        "description": "Out-of-scope issue", "severity": "Medium",
    })
    assert denied.status_code == 403


def test_backdated_progress_steps_and_server_built_days(client, db):
    assignee, _, issue = _head_with_issue(client, db, code="WR03")
    head = __import__("tests.conftest", fromlist=["_CURRENT_USER"])._CURRENT_USER
    assert client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)}).status_code == 200
    _set_user(db, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code == 200
    assert client.post(f"/api/issues/{issue['id']}/start").status_code == 200

    issue_row = db.get(Issue, UUID(issue["id"]))
    today = _plant_today()
    issue_row.created_at=datetime.combine(today-timedelta(days=4),datetime.min.time(),tzinfo=timezone.utc)
    db.commit()
    added = client.post(f"/api/issues/{issue['id']}/steps", json={"title":"Replace fuse"})
    assert added.status_code == 200, added.text
    step_id=added.json()["id"]
    progress=client.post(f"/api/issues/{issue['id']}/progress", json={
        "note":"Fuse replaced","hours":2.5,"work_date":(today-timedelta(days=2)).isoformat(),
        "day_status":"Worked","step_ids_done":[step_id],
    })
    assert progress.status_code == 200, progress.text
    assert client.post(f"/api/issues/{issue['id']}/progress", json={
        "note":"Future update","work_date":(today+timedelta(days=1)).isoformat(),
    }).status_code == 422

    steps=client.get(f"/api/issues/{issue['id']}/steps")
    assert steps.status_code == 200
    assert steps.json()[0]["done"] is True
    assert steps.json()[0]["done_on"] == (today-timedelta(days=2)).isoformat()
    activity=client.get(f"/api/issues/{issue['id']}/activity?include_days=true")
    assert activity.status_code == 200
    days=activity.json()["days"]
    assert len(days)==5
    assert days[2]["date"]==(today-timedelta(days=2)).isoformat()
    assert days[2]["summary"]=="Worked · 2.5 hrs"
    assert days[1]["summary"]=="no update"
    assert {entry["action"] for entry in days[2]["entries"]} >= {"issue.progress","issue.step_done"}
    assert head.role=="O&M Head"


def test_steps_persist_on_reassignment_and_all_changes_are_dated(client, db):
    assignee, _, issue = _head_with_issue(client, db, code="WR04")
    second=User(auth_provider="test",external_subject="wr-second",email="wr-second@example.com",
                display_name="Second Assignee",role="Assignee",is_active=True)
    db.add(second); db.commit(); db.refresh(second)
    step=client.post(f"/api/issues/{issue['id']}/steps",json={"title":"Inspect connector"})
    assert step.status_code==200
    changed=client.patch(f"/api/issues/{issue['id']}/steps/{step.json()['id']}",json={
        "done":True,"done_on":_plant_today().isoformat(),"remark":"Connector seated",
    })
    assert changed.status_code==200 and changed.json()["done"] is True
    response=client.post(f"/api/issues/{issue['id']}/reassign",json={"assigned_to":str(second.id)})
    assert response.status_code==200,response.text
    assert client.get(f"/api/issues/{issue['id']}/steps").json()[0]["id"]==step.json()["id"]
    actions={entry.action for entry in db.query(IssueHistory).filter_by(issue_id=UUID(issue["id"]))}
    assert {"issue.step_added","issue.step_done","issue.reassigned"} <= actions


def test_etc_change_requires_reason_and_is_saved_to_history(client, db):
    assignee, _, issue = _head_with_issue(client, db, code="WR05")
    client.post(f"/api/issues/{issue['id']}/assign",json={"assigned_to":str(assignee.id)})
    _set_user(db,assignee.id)
    new_etc=(datetime.now(timezone.utc)+timedelta(days=3)).isoformat()
    assert client.post(f"/api/issues/{issue['id']}/etc",json={"new_etc":new_etc}).status_code==422
    result=client.post(f"/api/issues/{issue['id']}/etc",json={"new_etc":new_etc,"reason":"Waiting for the spare"})
    assert result.status_code==200,result.text
    change=db.query(IssueETCChange).filter_by(issue_id=UUID(issue["id"])).one()
    assert change.reason=="Waiting for the spare" and change.changed_by==assignee.id
    history=db.query(IssueHistory).filter_by(issue_id=UUID(issue["id"]),action="issue.etc_changed").one()
    assert history.work_date==_plant_today()


def test_resolution_computes_workdays_hours_and_verification_dates(client, db):
    assignee, _, issue = _head_with_issue(client, db, code="WR06")
    client.post(f"/api/issues/{issue['id']}/assign",json={"assigned_to":str(assignee.id)})
    today=_plant_today()
    row=db.get(Issue,UUID(issue["id"]))
    row.created_at=datetime.combine(today-timedelta(days=4),datetime.min.time(),tzinfo=timezone.utc)
    row.legacy_payload={**(row.legacy_payload or {}),"evidence":[{"id":"fix-photo","storage_path":"issues/fake.jpg"}]}
    db.commit()
    _set_user(db,assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code==200
    assert client.post(f"/api/issues/{issue['id']}/start").status_code==200
    for work_day,hours,note in ((today-timedelta(days=2),2.5,"Replaced fuse"),(today-timedelta(days=1),1,"Checked connectors")):
        response=client.post(f"/api/issues/{issue['id']}/progress",json={
            "note":note,"hours":hours,"work_date":work_day.isoformat(),
        })
        assert response.status_code==200,response.text
    resolved=client.post(f"/api/issues/{issue['id']}/resolve",json={
        "fixed_on":today.isoformat(),"root_cause":"Fuse failure","corrective_action":"Replaced fuse",
        "evidence_ids":["fix-photo"],"remark":"Returned to service",
    })
    assert resolved.status_code==200,resolved.text
    closure=resolved.json()["closure"]
    assert closure["days_open"]==5 and closure["days_worked"]==2 and closure["hours_total"]==3.5
    assert closure["fixed_on"]==today.isoformat() and closure["submitted_on"]==today.isoformat()
    assert closure["verified_on"] is None

    _set_user(db,head_id:=row.created_by)
    closed=client.post(f"/api/issues/{issue['id']}/close",json={"note":"Verified"})
    assert closed.status_code==200,closed.text
    assert closed.json()["closed_on"]==today.isoformat()
    assert closed.json()["closure"]["verified_on"]==today.isoformat()
    assert closed.json()["closure"]["verified_by_name"]=="Head"


def test_direct_close_requires_reason_and_reopen_keeps_second_round_history(client, db):
    _, _, issue = _head_with_issue(client, db, code="WR07")
    assert client.post(f"/api/issues/{issue['id']}/close",json={"direct":True}).status_code==422
    closed=client.post(f"/api/issues/{issue['id']}/close",json={"direct":True,"note":"Duplicate report"})
    assert closed.status_code==200,closed.text
    assert closed.json()["closed_on"]==_plant_today().isoformat()
    assert closed.json()["closure"]["closed_directly"] is True
    reopened=client.post(f"/api/issues/{issue['id']}/reopen",json={"reason":"Fault returned"})
    assert reopened.status_code==200 and reopened.json()["status"]=="Open"
    timeline=client.get(f"/api/issues/{issue['id']}/activity?include_days=true")
    assert timeline.status_code==200
    reopen_entry=next(entry for entry in timeline.json()["activity"] if entry["action"]=="issue.reopened")
    assert reopen_entry["date"]==_plant_today().isoformat()
    assert timeline.json()["days"][-1]["round_no"]==2


def test_site_engineer_can_read_steps_but_cannot_change_them(client, db):
    assignee, plant, issue = _head_with_issue(client, db, code="WR08")
    from tests import conftest
    head_id=conftest._CURRENT_USER.id
    engineer=login_user(client,db,role="Site Engineer",name="Engineer",email="wr-engineer@example.com")
    from app.core.models import UserPlantAssignment
    db.add(UserPlantAssignment(user_id=engineer.id,plant_id=UUID(plant["id"]),assignment_role="Site Engineer"))
    db.commit()
    _set_user(db,head_id)
    created=client.post(f"/api/issues/{issue['id']}/steps",json={"title":"Head step"})
    assert created.status_code==200
    _set_user(db,engineer.id)
    assert client.get(f"/api/issues/{issue['id']}/steps").status_code==200
    assert client.post(f"/api/issues/{issue['id']}/steps",json={"title":"Engineer step"}).status_code==403
    assert client.patch(f"/api/issues/{issue['id']}/steps/{created.json()['id']}",json={"done":True}).status_code==403
