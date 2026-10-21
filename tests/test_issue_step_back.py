from __future__ import annotations

from datetime import date

from app.core.models import Issue, IssueHistory, Plant, User, UserEquipmentTypeAssignment
from tests import conftest
from tests.conftest import login_user


def _ticket(db, status="Assigned", assignee=None, **extra):
    plant = db.query(Plant).first() or Plant(site_code="SB01", plant_name="Step Plant")
    db.add(plant); db.flush()
    row = Issue(ticket_no=f"SB-{db.query(Issue).count() + 1}", plant_id=plant.id, vertical="Inverter", description="d",
                severity="Critical", status=status, assigned_to=assignee.id if assignee else None,
                assignee_text=assignee.display_name if assignee else None, **extra)
    db.add(row); db.commit(); db.refresh(row)
    return row


def _assignee(db, name="Pranjal Dave"):
    u = User(auth_provider="clerk", external_subject=name, email=f"{name.split()[0].lower()}@example.com", display_name=name, role="Assignee", is_active=True)
    db.add(u); db.flush(); db.add(UserEquipmentTypeAssignment(user_id=u.id, equipment_type="Inverter")); db.commit(); db.refresh(u)
    return u


def _back(client, row, reason="Site engineer report was wrong"):
    return client.post(f"/api/issues/{row.id}/step-back", json={"reason": reason})


def test_head_moves_someone_elses_ticket_forward_and_back(client, db):
    login_user(client, db, email="head@example.com")
    worker = _assignee(db)
    row = _ticket(db, "Assigned", worker)
    # forward on the Assignee's behalf (e.g. they confirmed by phone)
    assert client.post(f"/api/issues/{row.id}/acknowledge").json()["status"] == "Acknowledged"
    assert client.post(f"/api/issues/{row.id}/start").json()["status"] == "In Progress"
    # and back, one stage at a time
    steps = [_back(client, row).json() for _ in range(3)]
    assert [s["status"] for s in steps] == ["Acknowledged", "Assigned", "Open"]
    assert steps[-1]["assigned_to"] is None and steps[-1]["assignee_text"] is None
    history = db.query(IssueHistory).filter_by(issue_id=row.id, action="issue.stepped_back").all()
    assert len(history) == 3 and all(h.note == "Site engineer report was wrong" for h in history)
    assert _back(client, row).status_code == 409          # Open has no earlier stage


def test_withdrawn_resolution_goes_back_to_in_progress_and_is_kept_in_history(client, db):
    login_user(client, db, email="head@example.com")
    worker = _assignee(db)
    row = _ticket(db, "Resolved", worker, fixed_on=date(2026, 10, 20),
                  closure={"rootCause": "Loose lug", "corrective": "Tightened"})
    r = _back(client, row, "Inverter tripped again after the fix")
    assert r.status_code == 200 and r.json()["status"] == "In Progress"
    db.expire_all()
    fresh = db.get(Issue, row.id)
    assert fresh.closure is None and fresh.fixed_on is None and fresh.assigned_to == worker.id
    h = db.query(IssueHistory).filter_by(issue_id=row.id, action="issue.stepped_back").one()
    assert h.metadata_json["withdrawn_resolution"]["rootCause"] == "Loose lug"


def test_assignee_moves_only_their_own_ticket_and_cannot_unassign(client, db):
    worker, other = _assignee(db), _assignee(db, "Ravi Kumar")
    mine = _ticket(db, "Acknowledged", worker)
    theirs = _ticket(db, "Acknowledged", other)
    conftest._CURRENT_USER = worker
    assert _back(client, mine).json()["status"] == "Assigned"
    assert _back(client, mine).status_code == 403          # taking it off the Assignee is the O&M Head's call
    assert _back(client, theirs).status_code == 403


def test_step_back_rules(client, db):
    worker = _assignee(db)
    closed = _ticket(db, "Closed", worker)
    open_row = _ticket(db, "In Progress", worker)
    login_user(client, db, role="Site Engineer", email="se@example.com")
    assert _back(client, open_row).status_code == 403      # Site Engineers report; they do not move stages
    login_user(client, db, email="head@example.com")
    assert _back(client, closed).status_code == 409        # closed tickets use Reopen
    assert _back(client, open_row, "x").status_code == 422  # a reason is required
    db.expire_all()
    assert db.get(Issue, open_row.id).status == "In Progress"
