"""The Overview trend must read as a trend: continuous compliance, and a steady x axis.

Compliance used to be computed per bucket, so a bucket with nothing due was null. Washing has three
cycle due dates a month and PM only as many as there are tasks due, which left those two series as a
handful of isolated points on a daily range while Active site issues drew a full line. These pin the
cumulative reading that replaced it, and the property that makes it trustworthy: the last bucket is
the compliance for the whole range, which is the number the tiles above the chart show.
"""
from __future__ import annotations

from datetime import timedelta
from uuid import UUID

from app.core.models import OMTask
from app.core.timeutil import business_today
from app.portal import service
from tests.conftest import login_user


def _plant(client, code="TR01"):
    created = client.post("/api/plants", json={"site_code": code, "plant_name": "Trend " + code})
    assert created.status_code == 201, created.text
    return created.json()


def _series(payload, key):
    return next(item for item in payload["series"] if item["key"] == key)


def test_pm_compliance_is_continuous_from_the_first_due_task_to_the_end_of_the_range(client, db):
    login_user(client, db, role="O&M Head", name="Trend Head", email="trend-head@example.com")
    plant = _plant(client)
    today = business_today()
    start = today - timedelta(days=20)
    # Two tasks due early in the range, one done on time and one not. Nothing is due afterwards.
    db.add(OMTask(work_order_no="TR-1", plant_id=UUID(plant["id"]), task_name="On time",
                  task_type="Inverter", status="Completed", due_on=start + timedelta(days=2),
                  actual_completed_on=start + timedelta(days=2)))
    db.add(OMTask(work_order_no="TR-2", plant_id=UUID(plant["id"]), task_name="Late",
                  task_type="Inverter", status="Completed", due_on=start + timedelta(days=3),
                  actual_completed_on=start + timedelta(days=9)))
    db.commit()

    payload = service.portfolio_trend(db, [UUID(plant["id"])], start, today)
    values = _series(payload, "pm")["values"]

    # Before anything was due there is no verdict to give.
    assert values[0] is None and values[1] is None
    # From the first due date onward every bucket carries a reading - that is the line.
    tail = values[2:]
    assert all(value is not None for value in tail), tail
    # One of two tasks was on time, so the running figure settles at 50% and stays there
    # rather than dropping back to null once nothing more is due.
    assert values[2] == 100          # first task, on time
    assert values[3] == 50           # second task late: 1 of 2
    assert values[-1] == 50          # still 1 of 2 at the end of the range


def test_the_last_bucket_is_the_compliance_for_the_whole_range(client, db):
    login_user(client, db, role="O&M Head", name="Trend Head 2", email="trend-head2@example.com")
    plant = _plant(client, "TR02")
    today = business_today()
    start = today - timedelta(days=15)
    for index in range(4):
        on_time = index < 3            # 3 of 4 on time => 75%
        due = start + timedelta(days=index + 1)
        db.add(OMTask(work_order_no=f"TR2-{index}", plant_id=UUID(plant["id"]),
                      task_name=f"Task {index}", task_type="Inverter", status="Completed",
                      due_on=due, actual_completed_on=due if on_time else due + timedelta(days=4)))
    db.commit()

    payload = service.portfolio_trend(db, [UUID(plant["id"])], start, today)
    assert _series(payload, "pm")["values"][-1] == 75


def test_a_range_with_nothing_due_stays_null_rather_than_claiming_zero_percent(client, db):
    login_user(client, db, role="O&M Head", name="Trend Head 3", email="trend-head3@example.com")
    plant = _plant(client, "TR03")
    today = business_today()
    payload = service.portfolio_trend(db, [UUID(plant["id"])], today - timedelta(days=10), today)
    for key in ("pm", "washing"):
        values = _series(payload, key)["values"]
        assert all(value is None for value in values), (key, values)


def test_active_issue_counts_are_left_per_bucket_not_accumulated(client, db):
    """Issues are a count on the day they were reported, not a ratio; accumulating would double-count."""
    login_user(client, db, role="O&M Head", name="Trend Head 4", email="trend-head4@example.com")
    plant = _plant(client, "TR04")
    raised = client.post("/api/issues", json={"plant_id": plant["id"], "description": "Trend issue",
                                              "vertical": "Inverter", "severity": "Medium"})
    assert raised.status_code == 201, raised.text
    today = business_today()
    # The trend counts issues by the day the fault occurred; a ticket raised without one has
    # occurred_at null, so give it a date inside the range.
    from app.core.models import Issue
    from datetime import datetime, time
    from app.portal.service import BUSINESS_TZ
    issue = db.query(Issue).one()
    issue.occurred_at = datetime.combine(today - timedelta(days=2), time(9, 0), tzinfo=BUSINESS_TZ)
    db.commit()
    values = _series(service.portfolio_trend(db, [UUID(plant["id"])], today - timedelta(days=5), today),
                     "issues")["values"]
    # Exactly one issue, on one bucket - not carried forward across the rest of the range.
    assert sum(values) == 1, values
