"""Washing done after all three cycles are complete must stay visible.

Some plants keep washing once the month's three cycles are full (robot cleaning, a re-wash after
dust or rain). ``_cycle_sequence`` keeps those days on the last cycle and flags them as extra, and
``_month_wash_summary`` counts them as ``extra_tables`` / ``extra_times``. These pin that the days
and the count survive all the way out to the API the washing page reads, so the Record washing grid
has something to show them on.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.models import Plant, WashingConfig, WashingDailyReport
from app.scheduled import washing_cycles
from tests.conftest import login_user

MONTH = "2026-10"
TABLES = 10          # a small plant, so three cycles fill quickly


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch):
    """Pin the business date to month end so every report below is in the past."""
    monkeypatch.setattr(washing_cycles, "business_today", lambda: date(2026, 10, 31))


def _plant_with_washing(db):
    plant = Plant(site_code="WX01", plant_name="Extra Wash Park")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=TABLES, active=True))
    db.commit()
    return plant


def _report(db, plant, day, tables):
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=MONTH, cycle_no=1, report_date=date(2026, 10, day),
        job_status="Done", tables_cleaned=tables, reported_by="Engineer",
        review_status="Confirmed",
    ))


def _fill_three_cycles_then_wash_again(db, plant):
    # Three full cycles: 10 tables each on the 5th, 15th and 24th.
    for day in (5, 15, 24):
        _report(db, plant, day, TABLES)
    # Then the plant washes everything again on the 28th - the case being fixed.
    _report(db, plant, 28, TABLES)
    db.commit()
    washing_cycles._resequence_month(db, plant.id, MONTH, TABLES)
    db.commit()


def test_a_wash_after_the_third_cycle_stays_on_the_last_cycle(client, db):
    login_user(client, db, role="O&M Head", name="Wash Head", email="wash-head@example.com")
    plant = _plant_with_washing(db)
    _fill_three_cycles_then_wash_again(db, plant)

    rows = list(db.scalars(
        __import__("sqlalchemy").select(WashingDailyReport)
        .where(WashingDailyReport.plant_id == plant.id)
        .order_by(WashingDailyReport.report_date)
    ))
    by_day = {row.report_date.day: row.cycle_no for row in rows}
    assert by_day[5] == 1 and by_day[15] == 2 and by_day[24] == 3
    # The extra wash is not dropped and does not invent a fourth cycle.
    assert by_day[28] == 3, by_day
    assert max(by_day.values()) == 3


def test_the_month_summary_counts_the_extra_wash(client, db):
    login_user(client, db, role="O&M Head", name="Wash Head 2", email="wash-head2@example.com")
    plant = _plant_with_washing(db)
    _fill_three_cycles_then_wash_again(db, plant)

    reports = list(db.scalars(
        __import__("sqlalchemy").select(WashingDailyReport)
        .where(WashingDailyReport.plant_id == plant.id)
    ))
    summary = washing_cycles._month_wash_summary(reports, TABLES)
    assert summary["cycles_completed"] == 3
    assert summary["extra_tables"] == TABLES, summary
    assert summary["extra_times"] == 1.0
    # 40 tables over a 10-table plant is four full washes.
    assert summary["times_washed"] == 4.0


def test_the_api_still_returns_the_extra_day_so_the_page_can_show_it(client, db):
    login_user(client, db, role="O&M Head", name="Wash Head 3", email="wash-head3@example.com")
    plant = _plant_with_washing(db)
    _fill_three_cycles_then_wash_again(db, plant)

    response = client.get(f"/api/scheduled/washing/plants/{plant.id}/cycles?month={MONTH}")
    assert response.status_code == 200, response.text
    payload = response.json()
    days = {entry["report_date"] for entry in payload["reports"]}
    assert "2026-10-28" in days, sorted(days)
    assert payload["summary"]["extra_tables"] == TABLES
    # The last cycle reports the extra day among its own, which is what the record grid reads.
    last = next(c for c in payload["cycles"] if c["cycle_no"] == 3)
    assert last["state"] == "Completed"
    assert last["reports"] >= 2, last
