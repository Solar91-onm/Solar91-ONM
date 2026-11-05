from __future__ import annotations

from datetime import datetime, time

from app.core.models import (
    Issue,
    OMTask,
    Plant,
    UserPlantAssignment,
    WashingConfig,
    WashingDailyReport,
)
from app.core.timeutil import BUSINESS_TZ, business_today
from tests.conftest import login_user


def _plants(db):
    selected = Plant(site_code="TREND-A", plant_name="Trend Plant A", district="Jaipur")
    other = Plant(site_code="TREND-B", plant_name="Trend Plant B", district="Jodhpur")
    db.add_all([selected, other])
    db.commit()
    return selected, other


def test_overview_trend_returns_grouped_compliance_and_active_issue_series(client, db):
    selected, other = _plants(db)
    today = business_today()
    start = today.replace(day=1)
    first_issue = Issue(
        ticket_no="TREND-ISSUE-1",
        plant_id=selected.id,
        description="Currently open site issue",
        severity="Critical",
        status="Open",
        occurred_at=datetime.combine(today, time(10), tzinfo=BUSINESS_TZ),
    )
    outside_issue = Issue(
        ticket_no="TREND-ISSUE-3",
        plant_id=other.id,
        description="Another plant's issue",
        severity="Critical",
        status="Open",
        occurred_at=datetime.combine(today, time(10), tzinfo=BUSINESS_TZ),
    )
    task = OMTask(
        work_order_no="TREND-PM-1",
        plant_id=selected.id,
        task_name="On-time PM",
        status="Completed",
        due_on=today,
        actual_completed_on=today,
    )
    config = WashingConfig(
        plant_id=selected.id,
        tables_per_cycle=8,
        cycle_overrides={today.strftime("%Y-%m"): {"1": today.isoformat()}},
    )
    washing = WashingDailyReport(
        plant_id=selected.id,
        cycle_month=today.strftime("%Y-%m"),
        cycle_no=1,
        report_date=today,
        job_status="Done",
        tables_cleaned=8,
        cleaned_table_codes=[],
        reported_by="Trend Assignee",
        review_status="Confirmed",
        cycle_completed=True,
    )
    db.add_all([first_issue, outside_issue, task, config, washing])
    db.commit()
    login_user(client, db, email="overview-trend@example.com")
    params = {"start_date": start.isoformat(), "end_date": today.isoformat()}

    response = client.get("/api/portal/overview/trend", params=params)
    selected_trend = client.get(
        "/api/portal/overview/trend",
        params={"site_code": selected.site_code, **params},
    )

    assert response.status_code == 200, response.text
    assert selected_trend.status_code == 200, selected_trend.text
    body = response.json()
    assert body["bucket"] == "day"
    assert len(body["labels"]) == (today - start).days + 1
    assert [series["key"] for series in body["series"]] == ["washing", "pm", "issues", "solved"]
    assert [series["axis"] for series in body["series"]] == ["percent", "percent", "count", "count"]
    assert body["series"][0]["values"][-1] == 100
    assert body["series"][1]["values"][-1] == 100
    assert body["series"][2]["values"][-1] == 2
    assert selected_trend.json()["series"][2]["values"][-1] == 1


def test_site_engineer_trend_cannot_select_an_unassigned_plant(client, db):
    assigned, other = _plants(db)
    engineer = login_user(
        client,
        db,
        role="Site Engineer",
        email="overview-trend-engineer@example.com",
    )
    db.add(UserPlantAssignment(
        user_id=engineer.id,
        plant_id=assigned.id,
        assignment_role="Site Engineer",
    ))
    db.commit()
    today = business_today()

    response = client.get(
        "/api/portal/overview/trend",
        params={
            "start_date": today.isoformat(),
            "end_date": today.isoformat(),
            "site_code": other.site_code,
        },
    )

    assert response.status_code == 404