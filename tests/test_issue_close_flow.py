from __future__ import annotations

from uuid import UUID

import pytest

from app.core.models import Issue, IssueHistory, Notification, Plant, User, UserPlantAssignment
from tests.conftest import login_user


def _issue_in_progress(client, db, code="CLOSE01", started=True):
    head = login_user(client, db, role="O&M Head", email=f"{code.lower()}-head@example.com")
    plant = Plant(site_code=code, plant_name="Close flow plant")
    db.add(plant)
    db.flush()
    assignee = User(
        auth_provider="test",
        external_subject=f"{code}-assignee",
        email=f"{code.lower()}-assignee@example.com",
        display_name="Assigned Engineer",
        role="Assignee",
        is_active=True,
    )
    db.add(assignee)
    db.flush()
    db.add_all([
        UserPlantAssignment(user_id=head.id, plant_id=plant.id, assignment_role="O&M Head"),
        UserPlantAssignment(user_id=assignee.id, plant_id=plant.id, assignment_role="Assignee"),
    ])
    db.commit()
    issue_response = client.post("/api/issues", json={
        "plant_id": str(plant.id),
        "vertical": "Inverter",
        "description": "Inverter trips intermittently",
        "severity": "Medium",
    })
    assert issue_response.status_code == 201, issue_response.text
    issue = issue_response.json()
    assigned = client.post(f"/api/issues/{issue['id']}/assign", json={"assigned_to": str(assignee.id)})
    assert assigned.status_code == 200, assigned.text
    if not started:
        return head, assignee, plant, issue
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code == 200
    assert client.post(f"/api/issues/{issue['id']}/start").status_code == 200
    return head, assignee, plant, issue


def _set_user(db, user_id):
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, user_id)


def test_assignee_requests_closure_then_head_can_reject_with_a_remark(client, db):
    head, assignee, plant, issue = _issue_in_progress(client, db)

    response = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": False,
        "remark": "Monitoring confirmed the fault remains.",
    })
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "Pending Closure"
    history = db.query(IssueHistory).filter_by(issue_id=UUID(issue["id"])).all()
    requested = next(row for row in history if row.action == "issue.closure_requested")
    assert requested.note == "Monitoring confirmed the fault remains."
    assert requested.actor_id == assignee.id

    notification = db.query(Notification).filter_by(event_type="issue_closure_requested").one()
    assert notification.user_id == head.id
    assert notification.target_id == issue["ticket_no"]
    assert plant.site_code in notification.message
    assert "Monitoring confirmed" in notification.message

    assert client.post(f"/api/issues/{issue['id']}/status", json={"status": "Closed"}).status_code == 403
    assert client.post(f"/api/issues/{issue['id']}/status", json={
        "status": "In Progress", "note": "The investigation is not complete yet.",
    }).status_code == 403

    _set_user(db, head.id)
    rejected = client.post(f"/api/issues/{issue['id']}/status", json={
        "status": "In Progress", "note": "The investigation is not complete yet.",
    })
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "In Progress"
    history = db.query(IssueHistory).filter_by(issue_id=UUID(issue["id"])).all()
    rejection = next(row for row in history if row.action == "issue.closure_rejected")
    assert rejection.note == "The investigation is not complete yet."


def test_pending_closure_can_only_be_confirmed_by_an_om_head(client, db):
    head, assignee, _, issue = _issue_in_progress(client, db, "CLOSE02")
    _set_user(db, assignee.id)
    requested = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": False, "remark": "No repair completed.",
    })
    assert requested.status_code == 200 and requested.json()["status"] == "Pending Closure"

    confirmed_as_assignee = client.post(f"/api/issues/{issue['id']}/close", json={
        "direct": True, "note": "Trying to bypass approval",
    })
    assert confirmed_as_assignee.status_code == 403
    _set_user(db, head.id)
    confirmed = client.post(f"/api/issues/{issue['id']}/status", json={"status": "Closed"})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "Closed"
    db.expire_all()
    row = db.get(Issue, UUID(issue["id"]))
    assert row.closure["closure_request"]["remark"] == "No repair completed."
    assert row.closure["closed_by"] == head.display_name
    assert db.query(IssueHistory).filter_by(
        issue_id=row.id, action="issue.closure_confirmed",
    ).one().status_to == "Closed"


def test_yes_resolves_and_no_by_head_closes_immediately(client, db):
    _, assignee, _, issue = _issue_in_progress(client, db, "CLOSE03")
    _set_user(db, assignee.id)
    resolved = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": True, "remark": "Replaced the fuse and verified operation.",
    })
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "Resolved"
    assert resolved.json()["closure"]["note"] == "Replaced the fuse and verified operation."

    head, _, _, second = _issue_in_progress(client, db, "CLOSE04")
    _set_user(db, head.id)
    closed = client.post(f"/api/issues/{second['id']}/close", json={
        "resolved": False, "remark": "Closing after confirming the repeated alarm is not repairable.",
    })
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "Closed"


def test_head_force_closes_an_assigned_issue_marked_resolved(client, db):
    head, assignee, _, issue = _issue_in_progress(client, db, "CLOSE10", started=False)
    _set_user(db, assignee.id)
    refused = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": True, "remark": "Trying to skip the workflow.",
    })
    assert refused.status_code == 409

    _set_user(db, head.id)
    closed = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": True, "remark": "Fixed on site during the audit visit.",
    })
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "Closed"
    db.expire_all()
    row = db.get(Issue, UUID(issue["id"]))
    assert row.closure["closed_directly"] is True
    assert row.closure["direct_reason"] == "Fixed on site during the audit visit."
    assert db.query(IssueHistory).filter_by(
        issue_id=row.id, action="issue.closed_directly",
    ).one().status_from == "Assigned"


def test_head_marking_resolved_confirms_a_pending_closure(client, db):
    head, assignee, _, issue = _issue_in_progress(client, db, "CLOSE11")
    _set_user(db, assignee.id)
    assert client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": False, "remark": "Requesting review.",
    }).json()["status"] == "Pending Closure"

    _set_user(db, head.id)
    closed = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": True, "remark": "Reviewed and accepted.",
    })
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "Closed"
    assert db.query(IssueHistory).filter_by(
        issue_id=UUID(issue["id"]), action="issue.closure_confirmed",
    ).count() == 1


@pytest.mark.parametrize("resolved", [True, False])
def test_close_flow_rejects_blank_remarks(client, db, resolved):
    _, _, _, issue = _issue_in_progress(client, db, "CLOSE05" if resolved else "CLOSE06")
    response = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": resolved, "remark": "  ",
    })
    assert response.status_code == 422


def test_close_request_notification_failure_does_not_undo_status(client, db, monkeypatch):
    _, assignee, _, issue = _issue_in_progress(client, db, "CLOSE07")
    import app.notifications.service as notifications

    def fail_notification(*args, **kwargs):
        raise RuntimeError("notification service unavailable")

    monkeypatch.setattr(notifications, "notify_issue_assignee_and_heads", fail_notification)
    _set_user(db, assignee.id)
    response = client.post(f"/api/issues/{issue['id']}/close", json={
        "resolved": False, "remark": "Not repaired; request review.",
    })
    assert response.status_code == 200, response.text
    db.expire_all()
    assert db.get(Issue, UUID(issue["id"])).status == "Pending Closure"


@pytest.mark.parametrize(
    "payload",
    [
        {"equipment_running": False, "unit_count": 1, "description": "Drive fault"},
        {"equipment_running": False, "serial_no": "Unit 1", "description": "   "},
    ],
)
def test_breakdown_ticket_requires_a_unit_and_nonempty_remark(client, db, payload):
    login_user(client, db, email="breakdown-head@example.com")
    plant = Plant(site_code="BREAK01", plant_name="Breakdown plant")
    db.add(plant)
    db.commit()
    response = client.post("/api/issues", json={
        "plant_id": str(plant.id), "vertical": "Inverter", "severity": "Medium", **payload,
    })
    assert response.status_code == 422
