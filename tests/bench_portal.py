"""Backend load benchmark for the Solar91 portal.

Builds a realistic portfolio in the tests' SQLite database, then times the endpoints the portal
calls, counting SQL statements and measuring response sizes.

usage:  python -m pytest -q -s tests/bench_portal.py      (run through the test harness)
This file is executed as a pytest module so it picks up tests/conftest.py's DB setup.
"""
from __future__ import annotations

import json
import time
from datetime import timedelta

from sqlalchemy import event

from app.core.database import engine
from app.core.models import (Issue, OMTask, Plant, WashingConfig, WashingDailyReport,
                             WashingTable, PMUnitConfig)
from app.core.timeutil import business_today
from tests.conftest import login_user

PLANTS = 42
ISSUES_PER_PLANT = 40
TASKS_PER_PLANT = 60
WASH_DAYS = 45
TABLES_PER_PLANT = 24


def build_portfolio(db):
    """A portfolio close to the live one: 42 plants with issue, PM and washing history."""
    today = business_today()
    for n in range(PLANTS):
        plant = Plant(site_code=f"BEN{n:02d}", plant_name=f"Benchmark Plant {n}",
                      project_company=f"Solar91 Project {n % 6 + 1}", district=f"District {n % 7}",
                      ac_capacity_kw=500 + n, dc_capacity_kw=700 + n, status="active")
        db.add(plant)
        db.flush()

        db.add(PMUnitConfig(plant_id=plant.id, equipment_type="Inverter", total_units=8, units_per_day=2))

        for i in range(ISSUES_PER_PLANT):
            db.add(Issue(
                ticket_no=f"BEN{n:02d}-{i:04d}", plant_id=plant.id,
                vertical="Inverter" if i % 3 == 0 else "Transformer",
                subcategory="Fan failure", description="Benchmark issue",
                severity="High" if i % 5 == 0 else "Medium",
                status=["Open", "In Progress", "Resolved", "Closed"][i % 4],
                occurred_at=None, unit_count=1 + (i % 3),
            ))

        for i in range(TASKS_PER_PLANT):
            db.add(OMTask(
                work_order_no=f"WO-BEN{n:02d}-{i:04d}", plant_id=plant.id,
                task_name=f"PM task {i}", task_type="Inverter",
                status=["Scheduled", "In Progress", "Completed", "Completed"][i % 4],
                due_on=today - timedelta(days=i % 30),
                frequency="Monthly",
            ))

        db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=TABLES_PER_PLANT, team=["Washer"]))
        for t in range(TABLES_PER_PLANT):
            db.add(WashingTable(plant_id=plant.id, table_code=f"T{t + 1:03d}",
                                legacy_id=f"{plant.site_code}-T{t + 1}"))
        for offset in range(WASH_DAYS):
            day = today - timedelta(days=offset)
            db.add(WashingDailyReport(
                plant_id=plant.id, report_date=day, cycle_month=day.strftime("%Y-%m"),
                cycle_no=(day.day - 1) // 10 + 1 if day.day <= 30 else 3,
                tables_cleaned=3, job_status="Done", review_status="Confirmed",
                reported_by="Washer", cleaned_table_codes=[f"T{((offset * 3 + k) % TABLES_PER_PLANT) + 1:03d}"
                                                           for k in range(3)],
            ))
    db.commit()


class Counter:
    """Counts SQL statements issued while it is active."""

    def __init__(self):
        self.n = 0

    def __enter__(self):
        self._hook = lambda *a, **k: setattr(self, "n", self.n + 1)
        event.listen(engine, "before_cursor_execute", self._hook)
        return self

    def __exit__(self, *exc):
        event.remove(engine, "before_cursor_execute", self._hook)


def measure(client, name, url, runs=3):
    with Counter() as counter:
        response = client.get(url)
    assert response.status_code == 200, (url, response.status_code, response.text[:200])
    queries = counter.n
    size = len(response.content)
    best = None
    for _ in range(runs):
        start = time.perf_counter()
        client.get(url)
        elapsed = (time.perf_counter() - start) * 1000
        best = elapsed if best is None else min(best, elapsed)
    body = response.json()
    return {"name": name, "url": url, "ms": round(best, 1), "kb": round(size / 1024, 1),
            "queries": queries, "rows": _row_count(body)}


def _row_count(body):
    if isinstance(body, list):
        return len(body)
    for key in ("rows", "plants", "entries", "issues", "activity", "configs"):
        if isinstance(body, dict) and isinstance(body.get(key), list):
            return len(body[key])
    return ""


def test_benchmark(client, db, capsys):
    login_user(client, db, role="O&M Head")
    build_portfolio(db)
    month = business_today().strftime("%Y-%m")
    today = business_today().isoformat()
    first = business_today().replace(day=1).isoformat()

    checks = [
        ("auth session", "/api/auth/session"),
        ("portal plants", "/api/portal/plants"),
        ("portal overview", "/api/portal/overview"),
        ("overview range", f"/api/portal/overview/range?start_date={first}&end_date={today}"),
        ("washing full", f"/api/scheduled/washing/overview?month={month}&include_reports=false"),
        ("washing summary", f"/api/scheduled/washing/overview?month={month}&include_reports=false&summary=true"),
        ("pm unit config", "/api/pm-plan/unit-config"),
        ("issues (inverter)", "/api/issues?vertical=Inverter&limit=200"),
        ("inverter summary", "/api/issues/equipment-summary?vertical=Inverter"),
        ("calendar washing", f"/api/portal/calendar?kind=washing&month={month}"),
        ("activity", "/api/portal/activity?limit=25"),
    ]
    results = []
    for name, url in checks:
        try:
            results.append(measure(client, name, url))
        except AssertionError as error:          # an endpoint that does not exist yet
            results.append({"name": name, "url": url, "ms": "-", "kb": "-", "queries": "-",
                            "rows": "missing"})

    # Same-run A/B for the Overview: the summary read against the full one it replaced.
    from app.portal import service as portal_service
    from app.scheduled.washing_cycles import get_overview as _get_overview
    original = portal_service._washing_rows

    def full_washing_rows(db, user, plant_ids=None):
        overview = _get_overview(db, user, include_reports=False, summary=False,
                                 plant_ids=set(plant_ids) if plant_ids is not None else None)
        return {row["plant_id"]: row for row in overview.get("plants", [])}

    portal_service._washing_rows = full_washing_rows
    results.append(measure(client, "portal overview (pre)", "/api/portal/overview"))
    portal_service._washing_rows = original

    with capsys.disabled():
        print("\n%-22s %8s %9s %9s %7s" % ("endpoint", "ms", "KB", "queries", "rows"))
        print("-" * 60)
        for r in results:
            print("%-22s %8s %9s %9s %7s" % (r["name"], r["ms"], r["kb"], r["queries"], r["rows"]))
        print("\nJSON " + json.dumps(results))
