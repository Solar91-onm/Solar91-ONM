from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta

from app.core.models import Plant, WashingConfig, WashingDailyReport
from app.core.timeutil import business_today
from tests.conftest import login_user


def test_overview_range_includes_confirmed_washing_cycles_in_selected_month(client, db):
    login_user(client, db)
    current_month = business_today().replace(day=1)
    last_month = current_month - timedelta(days=1)
    start = last_month.replace(day=1)
    end = last_month.replace(day=monthrange(last_month.year, last_month.month)[1])
    plant = Plant(site_code="RANGE01", plant_name="Range test plant")
    db.add(plant)
    db.flush()
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=8))
    db.add(WashingDailyReport(
        plant_id=plant.id,
        cycle_month=start.strftime("%Y-%m"),
        cycle_no=1,
        report_date=date(start.year, start.month, 10),
        job_status="Done",
        tables_cleaned=8,
        cleaned_table_codes=[],
        reported_by="Test Assignee",
        review_status="Confirmed",
        cycle_completed=True,
    ))
    db.commit()

    response = client.get(
        "/api/portal/overview/range",
        params={"start_date": start.isoformat(), "end_date": end.isoformat()},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    row = next(item for item in body["rows"] if item["plant"]["site_code"] == plant.site_code)
    assert row["profile"]["washing"]["completed"] == 1
    assert body["totals"]["washingCompleted"] >= 1
