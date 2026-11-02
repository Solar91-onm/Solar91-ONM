from __future__ import annotations

from datetime import timedelta

from app.core.models import Plant, UserPlantAssignment
from app.core.timeutil import business_today
from tests.conftest import login_user


def _plants(db):
    assigned = Plant(site_code="OVERVIEW-A", plant_name="Overview Plant A")
    other = Plant(site_code="OVERVIEW-B", plant_name="Overview Plant B")
    db.add_all([assigned, other])
    db.commit()
    return assigned, other


def test_overview_and_range_show_portfolio_to_assignees(client, db):
    assigned, other = _plants(db)
    user = login_user(client, db, role="Assignee", email="overview-assignee@example.com")
    db.add(UserPlantAssignment(
        user_id=user.id,
        plant_id=assigned.id,
        assignment_role="Assignee",
    ))
    db.commit()

    overview = client.get("/api/portal/overview")
    date_range = client.get(
        "/api/portal/overview/range",
        params={
            "start_date": business_today().isoformat(),
            "end_date": business_today().isoformat(),
        },
    )

    assert overview.status_code == 200, overview.text
    assert date_range.status_code == 200, date_range.text
    expected = {assigned.site_code, other.site_code}
    assert {row["plant"]["site_code"] for row in overview.json()["rows"]} == expected
    assert overview.json()["scope"] == "portfolio"
    assert {row["plant"]["site_code"] for row in date_range.json()["rows"]} == expected


def test_site_engineer_overview_and_range_remain_limited_to_assigned_plant(client, db):
    assigned, other = _plants(db)
    user = login_user(client, db, role="Site Engineer", email="overview-engineer@example.com")
    db.add(UserPlantAssignment(
        user_id=user.id,
        plant_id=assigned.id,
        assignment_role="Site Engineer",
    ))
    db.commit()

    overview = client.get("/api/portal/overview")
    date_range = client.get(
        "/api/portal/overview/range",
        params={
            "start_date": business_today().isoformat(),
            "end_date": business_today().isoformat(),
        },
    )

    assert overview.status_code == 200, overview.text
    assert date_range.status_code == 200, date_range.text
    assert [row["plant"]["site_code"] for row in overview.json()["rows"]] == [assigned.site_code]
    assert overview.json()["scope"] == "assigned"
    assert [row["plant"]["site_code"] for row in date_range.json()["rows"]] == [assigned.site_code]


def test_viewer_cannot_read_overview_portfolio(client, db):
    _plants(db)
    login_user(client, db, role="Viewer", email="overview-viewer@example.com")

    overview = client.get("/api/portal/overview")
    date_range = client.get(
        "/api/portal/overview/range",
        params={
            "start_date": business_today().isoformat(),
            "end_date": (business_today() + timedelta(days=1)).isoformat(),
        },
    )

    assert overview.status_code == 403
    assert date_range.status_code == 403
