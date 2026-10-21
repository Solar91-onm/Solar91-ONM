from __future__ import annotations

from datetime import datetime, timezone

from app.core.models import Issue, IssueHistory, Notification, Plant, User, UserEquipmentTypeAssignment
from tests.conftest import login_user


def _setup(db):
    plant = Plant(site_code="BLK01", plant_name="Bulk Plant")
    worker = User(auth_provider="clerk", external_subject="w", email="w@example.com", display_name="Worker", role="Assignee", is_active=True)
    other = User(auth_provider="clerk", external_subject="o", email="o@example.com", display_name="Other", role="Assignee", is_active=True)
    db.add_all([plant, worker, other]); db.flush()
    db.add(UserEquipmentTypeAssignment(user_id=worker.id, equipment_type="Inverter"))
    rows = {
        "open1": Issue(ticket_no="B-1", plant_id=plant.id, vertical="Inverter", description="d", severity="Critical", status="Open"),
        "open2": Issue(ticket_no="B-2", plant_id=plant.id, vertical="Transformer", description="d", severity="Medium", status="Open"),
        # a second ticket of the same not-yet-covered type: the type is granted once, not twice
        "open3": Issue(ticket_no="B-6", plant_id=plant.id, vertical="Transformer", description="d", severity="Medium", status="Open"),
        "taken": Issue(ticket_no="B-3", plant_id=plant.id, vertical="Inverter", description="d", severity="Medium", status="Assigned",
                       assigned_to=other.id, assignee_text="Other"),
        "done": Issue(ticket_no="B-4", plant_id=plant.id, vertical="Inverter", description="d", severity="Medium", status="Resolved"),
        "gone": Issue(ticket_no="B-5", plant_id=plant.id, vertical="Inverter", description="d", severity="Medium", status="Open",
                      deleted_at=datetime.now(timezone.utc)),
    }
    db.add_all(rows.values()); db.commit()
    return worker, other, rows


def test_head_assigns_many_tickets_in_one_request(client, db):
    head = login_user(client, db, email="head@example.com")
    worker, other, rows = _setup(db)
    ids = [str(r.id) for r in rows.values()]
    r = client.post("/api/issues/bulk-assign", json={"issue_ids": ids, "assigned_to": str(worker.id)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert sorted(i["ticket_no"] for i in body["assigned"]) == ["B-1", "B-2", "B-6"]
    reasons = {s["ticket_no"]: s["reason"] for s in body["skipped"]}
    assert "Already assigned to Other" in reasons["B-3"] and "Resolved" in reasons["B-4"] and reasons[None] == "Not found or deleted"
    db.expire_all()
    for key in ("open1", "open2"):
        row = db.get(Issue, rows[key].id)
        assert (row.assigned_to, row.assignee_text, row.status) == (worker.id, "Worker", "Assigned")
    assert db.get(Issue, rows["taken"].id).assigned_to == other.id
    # the O&M Head extends the Assignee's scope to the new category, exactly like single assignment
    assert {t.equipment_type for t in db.query(UserEquipmentTypeAssignment).filter_by(user_id=worker.id)} == {"Inverter", "Transformer"}
    assert db.query(IssueHistory).filter_by(issue_id=rows["open1"].id, action="issue.assigned").count() == 1
    notes = db.query(Notification).filter_by(user_id=worker.id).all()
    assert len(notes) == 1 and notes[0].title == "3 tickets assigned to you"


def test_reassign_flag_moves_already_assigned_tickets(client, db):
    login_user(client, db, email="head@example.com")
    worker, other, rows = _setup(db)
    r = client.post("/api/issues/bulk-assign", json={"issue_ids": [str(rows["taken"].id)], "assigned_to": str(worker.id), "reassign": True})
    assert r.status_code == 200 and [i["ticket_no"] for i in r.json()["assigned"]] == ["B-3"]
    db.expire_all()
    assert db.get(Issue, rows["taken"].id).assigned_to == worker.id


def test_bulk_assign_rules(client, db):
    login_user(client, db, email="head@example.com")
    worker, other, rows = _setup(db)
    viewer = User(auth_provider="clerk", external_subject="v", email="v@example.com", display_name="V", role="Viewer", is_active=True)
    db.add(viewer); db.commit()
    one = [str(rows["open1"].id)]
    assert client.post("/api/issues/bulk-assign", json={"issue_ids": one, "assigned_to": str(viewer.id)}).status_code == 422
    assert client.post("/api/issues/bulk-assign", json={"issue_ids": [], "assigned_to": str(worker.id)}).status_code == 422
    too_many = [str(rows["open1"].id)] * 501
    assert client.post("/api/issues/bulk-assign", json={"issue_ids": too_many, "assigned_to": str(worker.id)}).status_code == 422
    login_user(client, db, role="Assignee", email="a2@example.com")
    assert client.post("/api/issues/bulk-assign", json={"issue_ids": one, "assigned_to": str(worker.id)}).status_code == 403
    db.expire_all()
    assert db.get(Issue, rows["open1"].id).assigned_to is None
