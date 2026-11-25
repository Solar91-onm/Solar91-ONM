"""The notification centre: the bell's list and badge, Action Required, and PM routing.

Covers what the API promises the frontend:

* a recipient only ever reads their own notifications (plus portal-wide broadcasts);
* the unread badge and Action Required come from one cheap ``/summary`` call;
* Action Required is computed from the live records under the user's plant scope, and
  marking a notification read does not make it go away;
* a PM checklist action notifies the right people, once, with enough context to open the
  activity itself, and a retry cannot produce a second copy.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.core.models import Notification, Plant, User, UserPlantAssignment
from app.pmplan.tracking import CHECKLISTS, PMTrackingActivity
from tests import conftest
from tests.conftest import login_user

BASE = "/api/notifications"
PM = "/api/pm-plan/tracking"


def _act_as(db, user):
    """Continue as a user who already exists, the way the other suites switch roles."""
    conftest._CURRENT_USER = db.get(User, user.id)
    return conftest._CURRENT_USER


def _plant(db, code="NOT01", name="Notify Plant"):
    plant = Plant(site_code=code, plant_name=name, status="active")
    db.add(plant)
    db.flush()
    return plant


def _engineer(client, db, plant, email="notify-engineer@example.com"):
    user = login_user(client, db, role="Site Engineer", name="Field Person", email=email)
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return user


def _activity(db, plant, equipment="Inverter", unit="INV-01", day=1, **kwargs):
    row = PMTrackingActivity(plant_id=plant.id, equipment=equipment, equipment_id=unit,
                             scheduled_on=date(2026, 11, day), **kwargs)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _submit(client, row):
    return client.post(f"{PM}/{row.id}/action", json={
        "action": "submit", "inspected_on": "2026-11-25",
        "checks": [{"result": "OK"} for _ in CHECKLISTS[row.equipment]]})


# ── the list, the badge and reading ─────────────────────────────────────────


def test_a_recipient_reads_only_their_own_notifications_and_broadcasts(client, db):
    mine = login_user(client, db, role="O&M Head", name="Head", email="head@example.com")
    other = login_user(client, db, role="Assignee", name="Other", email="other@example.com")
    db.add_all([
        Notification(user_id=mine.id, event_type="issue_created", title="Mine"),
        Notification(user_id=other.id, event_type="issue_created", title="Not mine"),
        Notification(user_id=None, event_type="role_changed", title="Everyone"),
    ])
    db.commit()
    _act_as(db, mine)

    body = client.get(BASE).json()
    titles = [n["title"] for n in body["notifications"]]
    assert "Mine" in titles and "Everyone" in titles
    assert "Not mine" not in titles
    assert body["unread_count"] == 2


def test_unread_filter_paginates_and_marking_read_updates_the_badge(client, db):
    user = login_user(client, db, role="O&M Head", email="pager@example.com")
    for index in range(25):
        db.add(Notification(user_id=user.id, event_type="issue_created", title=f"Ticket {index}"))
    db.commit()

    first = client.get(f"{BASE}?limit=20").json()
    assert len(first["notifications"]) == 20 and first["has_more"] is True
    assert first["next_before"], "a keyset cursor is returned for the next page"
    second = client.get(
        f"{BASE}?limit=20&before={first['next_before']}&before_id={first['next_before_id']}").json()
    assert len(second["notifications"]) == 5 and second["has_more"] is False
    assert not ({n["id"] for n in first["notifications"]} & {n["id"] for n in second["notifications"]})

    target = first["notifications"][0]["id"]
    read = client.post(f"{BASE}/{target}/read", json={})
    assert read.status_code == 200
    assert read.json()["unread_count"] == 24
    assert client.get(f"{BASE}?unread=true&limit=50").json()["unread_count"] == 24
    assert target not in [n["id"] for n in client.get(f"{BASE}?unread=true&limit=50").json()["notifications"]]

    assert client.post(f"{BASE}/read-all", json={}).json()["unread_count"] == 0
    assert client.get(f"{BASE}?unread=true").json()["notifications"] == []


def test_another_users_notification_cannot_be_marked_read(client, db):
    owner = login_user(client, db, role="Assignee", email="owner@example.com")
    row = Notification(user_id=owner.id, event_type="issue_created", title="Theirs")
    db.add(row)
    db.commit()
    db.refresh(row)
    login_user(client, db, role="O&M Head", email="intruder@example.com")

    assert client.post(f"{BASE}/{row.id}/read", json={}).status_code == 404
    db.refresh(row)
    assert row.read_at is None


def test_category_priority_and_link_travel_with_each_notification(client, db):
    user = login_user(client, db, role="O&M Head", email="shape@example.com")
    db.add(Notification(user_id=user.id, event_type="critical_issue", title="Critical",
                        target_type="issue", target_id="ISS-1",
                        payload={"page": "health", "site_code": "NOT01", "plant_name": "Notify Plant"}))
    db.commit()

    item = client.get(BASE).json()["notifications"][0]
    assert item["category"] == "issue"
    assert item["priority"] == "critical"
    assert item["tone"] == "red"
    assert item["link"]["site_code"] == "NOT01"
    assert item["link"]["page"] == "health"
    assert item["read"] is False


# ── Action Required ────────────────────────────────────────────────────────


def test_action_required_is_read_from_the_records_and_survives_marking_read(client, db, monkeypatch):
    monkeypatch.setattr("app.core.timeutil.business_today", lambda: date(2026, 11, 25))
    plant = _plant(db)
    db.commit()
    login_user(client, db, role="O&M Head", email="actions-head@example.com")
    _activity(db, plant, unit="INV-01", day=2, status="Pending approval")
    _activity(db, plant, unit="INV-02", day=3)                      # overdue, still Scheduled
    db.add(Notification(user_id=None, event_type="pm_submitted", title="Broadcast"))
    db.commit()

    summary = client.get(f"{BASE}/summary").json()
    kinds = {action["kind"]: action for action in summary["actions"]}
    assert kinds["pm_pending_approval"]["count"] == 1
    assert kinds["pm_overdue"]["count"] == 1
    assert kinds["pm_pending_approval"]["page"] == "pm"

    client.post(f"{BASE}/read-all", json={})
    still = {a["kind"] for a in client.get(f"{BASE}/summary").json()["actions"]}
    assert {"pm_pending_approval", "pm_overdue"} <= still, "reading a notification resolves nothing"


def test_action_required_never_counts_a_plant_the_user_cannot_open(client, db, monkeypatch):
    monkeypatch.setattr("app.core.timeutil.business_today", lambda: date(2026, 11, 25))
    mine = _plant(db, code="SCO01", name="Mine")
    theirs = _plant(db, code="SCO02", name="Theirs")
    db.commit()
    _activity(db, theirs, unit="INV-OTHER", day=2, status="Returned")
    _activity(db, mine, unit="INV-MINE", day=2, status="Returned")
    _engineer(client, db, mine, email="scoped-engineer@example.com")

    actions = {a["kind"]: a for a in client.get(f"{BASE}/summary").json()["actions"]}
    assert actions["pm_returned"]["count"] == 1, "only their own plant is counted"
    plants = client.get(f"{BASE}/plants").json()["plants"]
    assert [p["site_code"] for p in plants] == ["SCO01"]


# ── Preventive Maintenance routing ─────────────────────────────────────────


def test_submitting_a_checklist_notifies_the_head_once_with_the_activity_link(client, db, monkeypatch):
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 11, 25))
    plant = _plant(db, code="PMN01", name="PM Notify")
    head = login_user(client, db, role="O&M Head", name="Head", email="pm-head@example.com")
    db.commit()
    row = _activity(db, plant, unit="INV-07", day=2)
    _engineer(client, db, plant, email="pm-engineer@example.com")

    assert _submit(client, row).status_code == 200

    sent = list(db.scalars(select(Notification).where(Notification.user_id == head.id)))
    pm = [n for n in sent if n.event_type == "pm_submitted"]
    assert len(pm) == 1, "the approver is told exactly once"
    assert pm[0].target_type == "pm_activity" and pm[0].target_id == str(row.id)
    assert pm[0].payload["site_code"] == "PMN01"
    assert pm[0].payload["month"] == "2026-11"
    assert pm[0].payload["activity_id"] == str(row.id)
    assert "INV-07" in (pm[0].message or "")
    # The engineer who submitted it is not notified about their own action.
    assert not [n for n in db.scalars(select(Notification))
                if n.event_type == "pm_submitted" and n.user_id != head.id]


def test_approval_and_return_notify_the_engineer_who_submitted(client, db, monkeypatch):
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 11, 25))
    plant = _plant(db, code="PMN02", name="PM Review")
    head = login_user(client, db, role="O&M Head", name="Head", email="review-head@example.com")
    db.commit()
    row = _activity(db, plant, unit="INV-02", day=2)
    engineer = _engineer(client, db, plant, email="review-engineer@example.com")
    assert _submit(client, row).status_code == 200

    _act_as(db, head)
    assert client.post(f"{PM}/{row.id}/action", json={"action": "return", "reason": "Redo check 4"}).status_code == 200
    returned = [n for n in db.scalars(select(Notification).where(Notification.user_id == engineer.id))
                if n.event_type == "pm_returned"]
    assert len(returned) == 1
    assert "Redo check 4" in (returned[0].message or "")

    _act_as(db, engineer)
    assert _submit(client, row).status_code == 200
    _act_as(db, head)
    assert client.post(f"{PM}/{row.id}/action", json={"action": "approve"}).status_code == 200
    approved = [n for n in db.scalars(select(Notification).where(Notification.user_id == engineer.id))
                if n.event_type == "pm_approved"]
    assert len(approved) == 1
    assert approved[0].payload["activity_id"] == str(row.id)


def test_permission_request_and_decision_reach_the_right_person(client, db, monkeypatch):
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 11, 25))
    plant = _plant(db, code="PMN03", name="PM Sequence")
    head = login_user(client, db, role="O&M Head", name="Head", email="seq-head@example.com")
    db.commit()
    first = _activity(db, plant, unit="INV-01", day=2)
    second = _activity(db, plant, unit="INV-02", day=3)
    engineer = _engineer(client, db, plant, email="seq-engineer@example.com")

    asked = client.post(f"{PM}/{second.id}/action", json={"action": "request", "reason": "Earlier unit locked"})
    assert asked.status_code == 200, asked.text
    requests = [n for n in db.scalars(select(Notification).where(Notification.user_id == head.id))
                if n.event_type == "pm_permission_requested"]
    assert len(requests) == 1 and "Earlier unit locked" in (requests[0].message or "")

    _act_as(db, head)
    granted = client.post(f"{PM}/{second.id}/action", json={"action": "grant", "reason": "Approved by phone"})
    assert granted.status_code == 200, granted.text
    told = [n for n in db.scalars(select(Notification).where(Notification.user_id == engineer.id))
            if n.event_type == "pm_permission_granted"]
    assert len(told) == 1
    assert first.status == "Scheduled", "nothing about the earlier activity changed"


def test_a_future_locked_activity_raises_no_reminder_and_reminders_do_not_repeat(client, db, monkeypatch):
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 11, 25))
    monkeypatch.setattr("app.core.timeutil.business_today", lambda: date(2026, 11, 25))
    from app.pmplan.tracking import check_pm_tracking_reminders

    plant = _plant(db, code="PMN04", name="PM Overdue")
    head = login_user(client, db, role="O&M Head", name="Head", email="overdue-head@example.com")
    db.commit()
    _activity(db, plant, unit="INV-01", day=2)                        # overdue
    _activity(db, plant, unit="INV-02", day=28)                       # future: locked, not a reminder
    _activity(db, plant, unit="INV-03", day=3, status="Pending approval")

    first = check_pm_tracking_reminders(db, date(2026, 11, 25))
    assert first["overdue_plants_notified"] == 1
    assert first["pending_approval_notified"] == 1
    check_pm_tracking_reminders(db, date(2026, 11, 25))               # the hourly tick runs again
    rows = [n for n in db.scalars(select(Notification).where(Notification.user_id == head.id))]
    assert len([n for n in rows if n.event_type == "pm_overdue"]) == 1, "one reminder per plant per day"
    assert len([n for n in rows if n.event_type == "pm_submitted"]) == 1
    assert all("INV-02" not in (n.message or "") for n in rows)
