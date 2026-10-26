"""Configurable Critical / Medium deadlines (O&M Head) and ticket edit / dates / close by the ticket's Assignee."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from app.core.models import AppSetting, AuditLog, Issue, IssueETCChange, IssueHistory, User, UserEquipmentTypeAssignment
from app.issues.deadlines import DEADLINE_SETTING
from tests import conftest
from tests.conftest import login_user


def _utc(value: str) -> datetime:
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _setup(client, db, code="DL01"):
    head = login_user(client, db, role="O&M Head", name="Head", email=f"dl-head-{code}@example.com")
    assignee = User(auth_provider="test", external_subject=f"dl-a-{code}", email=f"dl-a-{code}@example.com",
                    display_name="Deadline Assignee", role="Assignee", is_active=True)
    db.add(assignee); db.commit(); db.refresh(assignee)
    plant = client.post("/api/plants", json={"site_code": code, "plant_name": f"Deadline Plant {code}"}).json()
    return head, assignee, plant


def test_default_deadlines_are_served_and_only_the_head_can_change_them(client, db):
    head, assignee, _ = _setup(client, db)
    body = client.get("/api/issues/deadlines").json()
    assert body["hours"] == {"Critical": 48, "Medium": 96} and body["defaults"] == {"Critical": 48, "Medium": 96}

    saved = client.put("/api/issues/deadlines", json={"critical_hours": 24, "medium_hours": 120})
    assert saved.status_code == 200, saved.text
    assert saved.json()["hours"] == {"Critical": 24, "Medium": 120}
    assert db.get(AppSetting, DEADLINE_SETTING).setting_value == {"Critical": 24, "Medium": 120}
    log = db.query(AuditLog).filter_by(entity_id=DEADLINE_SETTING).one()
    assert log.metadata_json == {"from": {"Critical": 48, "Medium": 96}, "to": {"Critical": 24, "Medium": 120}, "open_tickets": None}

    assert client.put("/api/issues/deadlines", json={"critical_hours": 0, "medium_hours": 96}).status_code == 422
    assert client.put("/api/issues/deadlines", json={"critical_hours": 24, "medium_hours": 24 * 91}).status_code == 422

    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.get("/api/issues/deadlines").json()["hours"] == {"Critical": 24, "Medium": 120}
    assert client.put("/api/issues/deadlines", json={"critical_hours": 1, "medium_hours": 1}).status_code == 403


def test_new_ticket_without_a_deadline_uses_the_configured_duration_and_old_tickets_keep_theirs(client, db):
    _, _, plant = _setup(client, db, "DL02")
    before = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Inverter",
                                              "description": "Old rule ticket", "severity": "Critical"}).json()
    old_gap = _utc(before["etc_at"]) - _utc(before["created_at"])
    assert abs(old_gap - timedelta(hours=48)) < timedelta(minutes=5)

    client.put("/api/issues/deadlines", json={"critical_hours": 12, "medium_hours": 72})
    after = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Transformer",
                                             "description": "New rule ticket", "severity": "Medium"}).json()
    assert abs((_utc(after["etc_at"]) - _utc(after["created_at"])) - timedelta(hours=72)) < timedelta(minutes=5)
    # an explicit deadline from the form still wins
    explicit = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Inverter", "description": "Explicit",
                                                "severity": "Critical", "etc_at": "2031-01-05T10:00:00Z"}).json()
    assert explicit["etc_at"].startswith("2031-01-05")
    # the earlier ticket's deadline is not rewritten
    db.expire_all()
    stored = db.get(Issue, UUID(before["id"])).etc_at
    stored = stored if stored.tzinfo else stored.replace(tzinfo=timezone.utc)
    assert abs(stored - _utc(before["etc_at"])) < timedelta(seconds=1)


def test_assigned_assignee_can_edit_details_and_deadline_with_a_logged_change(client, db):
    head, assignee, plant = _setup(client, db, "DL03")
    issue = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Inverter",
                                             "description": "Inverter tripping", "severity": "Medium"}).json()
    assert client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)}).status_code == 200
    conftest._CURRENT_USER = db.get(User, assignee.id)
    new_etc = (datetime.now(timezone.utc) + timedelta(days=10)).replace(microsecond=0)
    resp = client.patch(f"/api/issues/{issue['id']}", json={
        "description": "Inverter tripping on IGBT fault", "severity": "Critical",
        "etc_at": new_etc.isoformat(), "change_reason": "Vendor visit confirmed"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["description"] == "Inverter tripping on IGBT fault" and body["severity"] == "Critical"
    assert abs(_utc(body["etc_at"]) - new_etc) < timedelta(seconds=1)
    change = db.query(IssueETCChange).filter_by(issue_id=UUID(issue["id"])).one()
    assert change.reason == "Vendor visit confirmed" and change.changed_by == assignee.id
    edited = db.query(IssueHistory).filter_by(issue_id=UUID(issue["id"]), action="issue.edited").one()
    assert set(edited.metadata_json["changes"]) == {"description", "severity", "etc_at"}

    # a deadline before the start date is refused
    assert client.patch(f"/api/issues/{issue['id']}", json={"etc_at": "2000-01-01T00:00:00Z"}).status_code == 422
    # moving the ticket to equipment outside the Assignee's scope is refused
    assert client.patch(f"/api/issues/{issue['id']}", json={"vertical": "Transformer"}).status_code == 403
    # the dates endpoint stays open to them as well
    dates = client.patch(f"/api/issues/{issue['id']}/dates", json={"etc_at": (new_etc + timedelta(days=1)).isoformat(), "reason": "Parts late"})
    assert dates.status_code == 200, dates.text


def test_assigned_assignee_can_close_their_ticket_and_closed_tickets_are_head_only(client, db):
    head, assignee, plant = _setup(client, db, "DL04")
    issue = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Inverter",
                                             "description": "Duplicate report", "severity": "Medium"}).json()
    client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)})
    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/close", json={"direct": True}).status_code == 422   # reason required
    closed = client.post(f"/api/issues/{issue['id']}/close", json={"note": "Same fault as ISS-0001", "direct": True})
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "Closed" and closed.json()["closure"]["closed_by"] == "Deadline Assignee"
    assert db.query(IssueHistory).filter_by(issue_id=UUID(issue["id"]), action="issue.closed_directly").count() == 1
    # once closed, only the O&M Head may correct it
    assert client.patch(f"/api/issues/{issue['id']}", json={"description": "late edit"}).status_code == 409
    conftest._CURRENT_USER = head
    assert client.patch(f"/api/issues/{issue['id']}", json={"description": "Duplicate report (merged)"}).status_code == 200


def test_site_engineer_still_cannot_edit_close_or_change_deadlines(client, db):
    head, _, plant = _setup(client, db, "DL05")
    issue = client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Inverter",
                                             "description": "Engineer test", "severity": "Medium"}).json()
    engineer = login_user(client, db, role="Site Engineer", name="Engineer", email="dl-se@example.com")
    from app.core.models import UserPlantAssignment
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=UUID(plant["id"]), assignment_role="Site Engineer")); db.commit()
    assert client.patch(f"/api/issues/{issue['id']}", json={"description": "x"}).status_code == 403
    assert client.post(f"/api/issues/{issue['id']}/close", json={"note": "x", "direct": True}).status_code == 403
    assert client.put("/api/issues/deadlines", json={"critical_hours": 5, "medium_hours": 5}).status_code == 403


def test_open_tickets_on_the_old_default_move_only_when_asked_and_hand_set_deadlines_stay(client, db):
    head, _, plant = _setup(client, db, "DL06")
    def raise_ticket(desc, severity, **extra):
        return client.post("/api/issues", json={"plant_id": plant["id"], "vertical": "Inverter", "description": desc, "severity": severity, **extra}).json()
    on_default = raise_ticket("Default critical", "Critical")
    # raised from the old form: deadline stored 5.5 h late (local time read as UTC) -> still recognised as the default
    shifted = raise_ticket("Shifted critical", "Critical")
    row = db.get(Issue, UUID(shifted["id"])); row.etc_at = _utc(shifted["etc_at"]) + timedelta(hours=5, minutes=30); db.commit()
    own_target = raise_ticket("Own target", "Critical", etc_at="2031-01-05T10:00:00Z")
    by_hand = raise_ticket("Changed by hand", "Critical")
    client.patch(f"/api/issues/{by_hand['id']}/dates", json={"etc_at": (_utc(by_hand["etc_at"]) + timedelta(days=1)).isoformat(), "reason": "Vendor late"})
    closed = raise_ticket("Closed", "Critical")
    client.post(f"/api/issues/{closed['id']}/close", json={"note": "duplicate", "direct": True})
    medium = raise_ticket("Medium untouched", "Medium")

    preview = client.put("/api/issues/deadlines", json={"critical_hours": 24, "medium_hours": 96, "dry_run": True, "apply_to_open": True})
    assert preview.status_code == 200, preview.text
    assert preview.json()["preview"]["open_tickets"] == {"moved": 2, "by_severity": {"Critical": 2, "Medium": 0}, "kept_changed_by_hand": 1, "kept_own_target": 1}
    assert preview.json()["hours"] == {"Critical": 48, "Medium": 96}          # nothing saved by a dry run
    assert db.query(IssueETCChange).count() == 1

    # without apply_to_open nothing existing moves
    client.put("/api/issues/deadlines", json={"critical_hours": 36, "medium_hours": 96})
    db.expire_all()
    assert abs(_stored(db, on_default) - _utc(on_default["etc_at"])) < timedelta(seconds=1)

    saved = client.put("/api/issues/deadlines", json={"critical_hours": 24, "medium_hours": 96, "apply_to_open": True}).json()
    assert saved["hours"]["Critical"] == 24
    db.expire_all()
    # the earlier save set the default to 36 h; the 48 h tickets no longer match it, so a second, matching run is needed
    assert saved["open_tickets"]["moved"] == 0
    client.put("/api/issues/deadlines", json={"critical_hours": 48, "medium_hours": 96})
    saved = client.put("/api/issues/deadlines", json={"critical_hours": 24, "medium_hours": 96, "apply_to_open": True}).json()
    assert saved["open_tickets"]["moved"] == 2
    db.expire_all()
    for ticket in (on_default, shifted):
        assert abs(_stored(db, ticket) - (_utc(ticket["created_at"]) + timedelta(hours=24))) < timedelta(seconds=1)
        assert db.query(IssueHistory).filter_by(issue_id=UUID(ticket["id"]), action="issue.etc_changed").count() == 1
    assert _stored(db, own_target).year == 2031
    assert abs(_stored(db, by_hand) - (_utc(by_hand["etc_at"]) + timedelta(days=1))) < timedelta(seconds=1)
    assert abs(_stored(db, closed) - _utc(closed["etc_at"])) < timedelta(seconds=1)
    assert abs(_stored(db, medium) - _utc(medium["etc_at"])) < timedelta(seconds=1)


def _stored(db, ticket):
    value = db.get(Issue, UUID(ticket["id"])).etc_at
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
