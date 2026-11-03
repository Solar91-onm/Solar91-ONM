"""Washing, Views tab: pick a date and see which plants recorded washing on it, and which did not.

The portfolio washing page answered "this month, this plant". Picking a date asks a different
question - one day, every plant - and the thing operators actually want from it is the plants with
no entry at all. ``day_activity`` already produced that per-plant status; these pin the statuses the
new filter groups on, so the page cannot quietly start reporting a plant as recorded when it is not.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.models import Plant, User, UserPlantAssignment, WashingConfig, WashingDailyReport
from app.scheduled import washing_cycles
from tests.conftest import login_user

DAY = date(2026, 10, 12)


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch):
    monkeypatch.setattr(washing_cycles, "business_today", lambda: date(2026, 10, 31))


def _plant(db, code, *, active=True):
    plant = Plant(site_code=code, plant_name="Day " + code)
    db.add(plant)
    db.commit()
    db.refresh(plant)
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=10, active=active))
    db.commit()
    return plant


def _report(db, plant, **kwargs):
    db.add(WashingDailyReport(plant_id=plant.id, cycle_month="2026-10", cycle_no=1,
                              report_date=DAY, reported_by="Engineer", **kwargs))
    db.commit()


@pytest.fixture
def three_plants(client, db):
    login_user(client, db, role="O&M Head", name="Day Head", email="day-head@example.com")
    confirmed = _plant(db, "DA01")
    awaiting = _plant(db, "DA02")
    silent = _plant(db, "DA03")
    _report(db, confirmed, job_status="Done", tables_cleaned=5, review_status="Confirmed")
    _report(db, awaiting, job_status="Done", tables_cleaned=3, review_status="Pending")
    # DA03 records nothing at all - the case the filter exists for.
    return confirmed, awaiting, silent


def _by_code(body):
    return {row["site_code"]: row for row in body["plants"]}


def test_a_date_separates_recorded_awaiting_and_not_recorded_plants(three_plants, client):
    body = client.get(f"/api/scheduled/washing/day-activity?day={DAY}").json()
    rows = _by_code(body)
    assert rows["DA01"]["status"] == "confirmed"
    assert rows["DA01"]["cleaned_confirmed"] == 5
    assert rows["DA02"]["status"] == "awaiting"
    assert rows["DA02"]["cleaned_pending"] == 3
    # The plant with no entry is listed, not omitted - otherwise it could not be chased.
    assert rows["DA03"]["status"] == "not_reported"
    assert rows["DA03"]["cleaned_confirmed"] == 0


def test_a_plant_that_reported_not_done_is_distinct_from_one_that_said_nothing(client, db):
    login_user(client, db, role="O&M Head", name="Day Head", email="day-head@example.com")
    excused = _plant(db, "DA04")
    _report(db, excused, job_status="Not done", tables_cleaned=0,
            review_status="Confirmed", exception_reason="Water tanker did not arrive")
    _plant(db, "DA05")

    rows = _by_code(client.get(f"/api/scheduled/washing/day-activity?day={DAY}").json())
    assert rows["DA04"]["status"] == "not_done"
    assert rows["DA04"]["not_done_reason"] == "Water tanker did not arrive"
    assert rows["DA05"]["status"] == "not_reported"


def test_a_future_date_is_upcoming_rather_than_a_missed_record(client, db):
    login_user(client, db, role="O&M Head", name="Day Head", email="day-head@example.com")
    _plant(db, "DA06")
    future = date(2026, 11, 20)      # business_today is pinned to 2026-10-31
    rows = _by_code(client.get(f"/api/scheduled/washing/day-activity?day={future}").json())
    assert rows["DA06"]["status"] == "upcoming", "a day that has not happened is not a missed record"


def test_the_day_view_only_lists_plants_the_caller_can_see(client, db):
    login_user(client, db, role="O&M Head", name="Day Head", email="day-head@example.com")
    mine = _plant(db, "DA07")
    _plant(db, "DA08")
    _report(db, mine, job_status="Done", tables_cleaned=4, review_status="Confirmed")

    engineer = User(auth_provider="test", external_subject="day-engineer",
                    email="day-engineer@example.com", display_name="Day Engineer",
                    role="Site Engineer", is_active=True)
    db.add(engineer)
    db.commit()
    db.refresh(engineer)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=mine.id, assignment_role="Site Engineer"))
    db.commit()
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, engineer.id)

    rows = _by_code(client.get(f"/api/scheduled/washing/day-activity?day={DAY}").json())
    assert set(rows) == {"DA07"}, set(rows)


def test_not_recorded_is_offered_in_the_daily_summary_status_filter():
    """It lives in the Daily summary overlay, which is already scoped to one date.

    The main washing page keeps no date control of its own: the overlay opens on the date that was
    clicked, so asking the question there needs no second date picker.
    """
    calendar = (__import__("pathlib").Path(__file__).resolve().parents[1]
                / "assets" / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    assert 'var NOT_RECORDED = "__not_recorded"' in calendar
    assert ">Not recorded</option>" in calendar
    assert "offerNotRecorded" in calendar
    assert "/api/scheduled/washing/day-activity?day=" in calendar
    # It lists the plants that reported nothing, not the ones excused with a reason.
    assert 'row.status === "not_reported"' in calendar
    # No date filter on the washing page toolbar: the overlay carries the date.
    assert 'data-calendar-filter="day"' not in calendar
    assert 'data-calendar-action="clear-day"' not in calendar


def test_every_day_status_the_server_returns_has_a_label():
    calendar = (__import__("pathlib").Path(__file__).resolve().parents[1]
                / "assets" / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    for status in washing_cycles.DAY_STATUS_ORDER:
        assert status in calendar, status
