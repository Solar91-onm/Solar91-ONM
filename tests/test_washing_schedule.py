"""Washing cycle schedule for any month (past months included), the repeating monthly pattern,
and the rule that field work is assigned only to people with the Assignee role."""
from __future__ import annotations

from datetime import date, timedelta

from app.core.timeutil import business_today
from app.core.models import OMTask, Plant, UserPlantAssignment
from tests.test_washing_cycles import BASE, _act_as, _plant, _setup_cycle_users
from tests.conftest import login_user


def _month(value: date) -> str:
    return value.strftime("%Y-%m")


def _cycles(first: date, *days):
    return [{"cycle_no": n, "start_date": first.replace(day=s).isoformat(), "due_date": first.replace(day=d).isoformat()}
            for n, (s, d) in enumerate(days, start=1)]


def test_any_month_can_be_scheduled_and_a_pattern_repeats_from_then_on(client, db):
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    _act_as(head)
    this_month = business_today().replace(day=1)
    last_month = (this_month - timedelta(days=1)).replace(day=1)

    past = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": _month(last_month)})
    assert past.status_code == 200, past.text
    assert [c["state"] for c in past.json()["cycles"]] == ["Missed", "Missed", "Missed"]

    # a past month: any day of that month, saved for that month only
    saved = client.put(f"{BASE}/plants/{plant.id}/cycle-schedule", json={
        "month": _month(last_month), "cycles": _cycles(last_month, (1, 8), (9, 18), (19, 26))})
    assert saved.status_code == 200, saved.text
    assert [c["due_date"][-2:] for c in saved.json()["cycles"]] == ["08", "18", "26"]
    assert saved.json()["pattern"] is None

    # dates outside the month, or cycles out of order, are refused
    outside = _cycles(last_month, (1, 8), (9, 18), (19, 26))
    outside[2]["due_date"] = this_month.isoformat()
    assert client.put(f"{BASE}/plants/{plant.id}/cycle-schedule", json={"month": _month(last_month), "cycles": outside}).status_code == 422
    assert client.put(f"{BASE}/plants/{plant.id}/cycle-schedule", json={
        "month": _month(last_month), "cycles": _cycles(last_month, (9, 18), (1, 8), (19, 26))}).status_code == 422

    # this month, applied to every following month
    pattern = client.put(f"{BASE}/plants/{plant.id}/cycle-schedule", json={
        "month": _month(this_month), "cycles": _cycles(this_month, (2, 9), (10, 19), (20, 27)), "apply_to_future": True})
    assert pattern.status_code == 200, pattern.text
    assert pattern.json()["pattern"]["cycles"][0] == {"cycle_no": 1, "start_day": 2, "due_day": 9}
    next_month = (this_month + timedelta(days=32)).replace(day=1)
    later = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": _month(next_month)}).json()
    assert [(c["start_date"][-2:], c["due_date"][-2:]) for c in later["cycles"]] == [("02", "09"), ("10", "19"), ("20", "27")]
    # the earlier month keeps its own dates
    earlier = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": _month(last_month)}).json()
    assert [c["due_date"][-2:] for c in earlier["cycles"]] == ["08", "18", "26"]
    # the live overview uses the new schedule for this month
    overview = client.get(f"{BASE}/overview").json()
    row = next(p for p in overview["plants"] if p["plant_id"] == str(plant.id))
    assert [c["due_date"][-2:] for c in row["cycles"]] == ["09", "19", "27"]


def test_site_engineer_can_read_but_not_change_the_schedule(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Wash Engineer", email="wash-se@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer")); db.commit()
    month = business_today().replace(day=1)
    view = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": _month(month)})
    assert view.status_code == 200 and view.json()["can_edit"] is False
    assert client.put(f"{BASE}/plants/{plant.id}/cycle-schedule", json={
        "month": _month(month), "cycles": _cycles(month, (1, 10), (11, 20), (21, 28))}).status_code == 403
    other = Plant(site_code="OTHERW1", plant_name="Other Wash Plant"); db.add(other); db.commit()
    assert client.get(f"{BASE}/plants/{other.id}/cycles", params={"month": _month(month)}).status_code in (403, 409)


def test_scheduled_work_is_only_reassigned_to_assignees(client, db):
    head = login_user(client, db, role="O&M Head", name="Work Head", email="work-head@example.com")
    plant = Plant(site_code="ASSN01", plant_name="Assign Plant"); db.add(plant); db.commit()
    db.add(OMTask(work_order_no="WO-ASSN-1", plant_id=plant.id, task_name="Inspect", task_type="Inverter", status="Scheduled",
                  due_on=business_today() + timedelta(days=3)))
    db.commit()
    refused = client.patch("/api/scheduled/tasks/WO-ASSN-1/assignee", json={"assignee": head.display_name})
    assert refused.status_code == 422 and "Assignee role" in refused.json()["detail"]
