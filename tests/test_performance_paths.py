"""Performance paths must not change any figure, hide a failure, or truncate silently.

Covers: the washing overview's summary mode (no report list, light rows), the single-plant washing filter, the
Overview's handling of a washing failure, the calendar truncation flag, stable issue paging, and pool-wait timing.
"""
from __future__ import annotations

import threading
import time
from datetime import timedelta

from sqlalchemy import create_engine, event, text

from app.core.models import Issue, OMTask, Plant, WashingConfig, WashingDailyReport, WashingTable
from app.core.observability import TimedQueuePool, _stats
from app.core.timeutil import business_today
from app.portal import service
from app.scheduled import washing_cycles
from app.scheduled.washing_cycles import get_overview
from tests.conftest import login_user


def _washing_portfolio(db, plants=3, days=40):
    """Plants with washing set up and a varied report history: confirmed, pending, rejected, excused (rain),
    exceptions, completed cycles, and an old report still awaiting review."""
    today = business_today()
    created = []
    for n in range(plants):
        plant = Plant(site_code=f"PERF{n:02d}", plant_name=f"Perf Plant {n}")
        db.add(plant)
        db.flush()
        overrides = None
        if n == 0:   # cycle 1 moved to start 12 days before this month: excused days there must still count
            first = today.replace(day=1)
            overrides = {first.strftime("%Y-%m"): {"s1": (first - timedelta(days=12)).isoformat()}}
        db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=6, team=["Washer"], cycle_overrides=overrides))
        for t in range(6):
            db.add(WashingTable(plant_id=plant.id, table_code=f"T{t + 1:03d}", legacy_id=f"{plant.site_code}-T{t + 1}"))
        for offset in range(days):
            day = today - timedelta(days=offset)
            status = ("Confirmed", "Confirmed", "Pending", "Rejected")[(offset + n) % 4]
            rain = offset % 9 == 4
            db.add(WashingDailyReport(
                plant_id=plant.id, cycle_month=day.strftime("%Y-%m"),
                cycle_no=1 if day.day <= 10 else 2 if day.day <= 20 else 3, report_date=day,
                job_status="Not done" if rain else "Done", tables_cleaned=0 if rain else 2,
                cleaned_table_codes=[] if rain else [f"T{(offset % 6) + 1:03d}"],
                remarks="Rain all day" if rain else "Routine", exception_reason="Rain" if rain else None,
                evidence=[{"id": f"e{offset}", "kind": "before", "storage_path": "x"}],
                reported_by=f"Washer {offset % 2}", review_status=status,
                cycle_completed=status == "Confirmed" and day.day in (9, 19, 28),
            ))
        # An old report still awaiting review is always included in the overview.
        db.add(WashingDailyReport(
            plant_id=plant.id, cycle_month=(today - timedelta(days=200)).strftime("%Y-%m"), cycle_no=1,
            report_date=today - timedelta(days=200), job_status="Done", tables_cleaned=1, cleaned_table_codes=[],
            evidence=[], reported_by="Washer 0", review_status="Pending", cycle_completed=False,
        ))
        created.append(plant)
    db.commit()
    return created


def test_summary_overview_figures_match_the_full_overview(client, db):
    head = login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    _washing_portfolio(db)
    full = get_overview(db, head)
    summary = get_overview(db, head, include_reports=False)
    assert summary["plants"] == full["plants"], "every per-plant figure must be identical"
    assert summary["portfolio"] == full["portfolio"], "portfolio totals, including pending_reviews, must be identical"
    assert summary["overdue_matrix"] == full["overdue_matrix"]
    assert summary["monthly"] == [] and full["monthly"], "the 12-month chart is left out of the summary (one query less)"
    assert summary["cycle_events"] == [], "cycle events need the whole window, so the summary leaves them out"
    assert full["cycle_events"], "the full overview still lists them"
    assert full["reports"] and full["reports_included"] is True
    assert summary["reports"] == [] and summary["reports_included"] is False
    assert full["portfolio"]["pending_reviews"] > 0


def test_summary_matches_full_for_a_past_month_and_reads_fewer_reports(client, db):
    head = login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    _washing_portfolio(db, days=75)
    last_month = (business_today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    full = get_overview(db, head, month=last_month)
    summary = get_overview(db, head, month=last_month, include_reports=False)
    assert summary["plants"] == full["plants"] and summary["portfolio"] == full["portfolio"]
    # And as of today, with 75 days of history (most of it outside the summary's shorter read).
    assert get_overview(db, head, include_reports=False)["plants"] == get_overview(db, head)["plants"]


def test_summary_overview_never_reads_the_json_columns(client, db):
    head = login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    _washing_portfolio(db, plants=1, days=5)
    statements = []
    bind = db.get_bind()
    listener = lambda conn, cursor, statement, *args: statements.append(statement)  # noqa: E731
    event.listen(bind, "before_cursor_execute", listener)
    try:
        get_overview(db, head, include_reports=False)
    finally:
        event.remove(bind, "before_cursor_execute", listener)
    report_reads = [s for s in statements if "FROM washing_daily_reports" in s and "report_date >=" in s]
    assert report_reads, "the windowed report read must have run"
    for statement in report_reads:
        assert "evidence" not in statement and "cleaned_table_codes" not in statement


def test_single_plant_filter_returns_exactly_that_plants_row(client, db):
    head = login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    plants = _washing_portfolio(db)
    full = {row["plant_id"]: row for row in get_overview(db, head)["plants"]}
    one = get_overview(db, head, include_reports=False, plant_ids={plants[1].id})
    assert [row["plant_id"] for row in one["plants"]] == [str(plants[1].id)]
    assert one["plants"][0] == full[str(plants[1].id)]
    # The HTTP parameters reach the same code path.
    response = client.get(f"/api/scheduled/washing/overview?plant_id={plants[1].id}&include_reports=false")
    assert response.status_code == 200, response.text
    assert [row["plant_id"] for row in response.json()["plants"]] == [str(plants[1].id)]
    assert response.json()["reports"] == []


def test_single_plant_filter_cannot_widen_a_site_engineers_scope(client, db):
    plants = _washing_portfolio(db, plants=2, days=3)
    from app.core.models import UserPlantAssignment
    engineer = login_user(client, db, role="Site Engineer", name="Perf SE", email="perf-se@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plants[0].id, assignment_role="Site Engineer"))
    db.commit()
    other = client.get(f"/api/scheduled/washing/overview?plant_id={plants[1].id}&include_reports=false")
    assert other.status_code == 200 and other.json()["plants"] == [], "another plant's figures must not leak"
    own = client.get(f"/api/scheduled/washing/overview?plant_id={plants[0].id}&include_reports=false")
    assert [row["plant_id"] for row in own.json()["plants"]] == [str(plants[0].id)]


def test_plant_details_washing_matches_the_overview(client, db):
    login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    plants = _washing_portfolio(db)
    overview = client.get("/api/portal/overview").json()
    row = next(r for r in overview["rows"] if r["plant"]["site_code"] == plants[2].site_code)
    details = client.get(f"/api/portal/plants/{plants[2].site_code}").json()
    assert details["profile"]["washing"] == row["profile"]["washing"]
    assert overview["warnings"] == [] and details["warnings"] == []


def test_washing_failure_is_reported_not_shown_as_zero(client, db, monkeypatch):
    login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    plants = _washing_portfolio(db, plants=1, days=3)
    db.add(Issue(ticket_no="PERF-1", plant_id=plants[0].id, description="x", severity="Critical", status="Open"))
    db.commit()

    def broken(*args, **kwargs):
        raise RuntimeError("washing read failed")

    monkeypatch.setattr(washing_cycles, "get_overview", broken)
    response = client.get("/api/portal/overview")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["warnings"] == ["washing_unavailable"]
    profile = body["rows"][0]["profile"]
    assert profile["openIssues"] == 1, "the rest of the Overview still loads"
    assert profile["washing"]["compliancePercent"] is None, "no washing figure is invented"


def test_calendar_page_flags_a_truncated_month(client, db):
    head = login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    plant = Plant(site_code="CAL01", plant_name="Calendar Plant")
    db.add(plant)
    db.flush()
    today = business_today()
    for n in range(5):
        db.add(OMTask(work_order_no=f"WO-{n}", plant_id=plant.id, task_name="Inspect", task_type="Inverter",
                      status="Scheduled", due_on=today.replace(day=1) + timedelta(days=n)))
    db.commit()
    month = today.strftime("%Y-%m")
    capped = service.calendar_page(db, head, "pm", month, [plant.id], limit=3)
    assert len(capped["entries"]) == 3 and capped["truncated"] is True and capped["limit"] == 3
    whole = service.calendar_page(db, head, "pm", month, [plant.id], limit=5)
    assert len(whole["entries"]) == 5 and whole["truncated"] is False
    api = client.get(f"/api/portal/calendar?kind=pm&month={month}&site_code=CAL01").json()
    assert api["truncated"] is False and len(api["entries"]) == 5


def test_issue_paging_is_stable_when_created_at_ties(client, db):
    login_user(client, db, role="O&M Head", name="Perf Head", email="perf-head@example.com")
    plant = Plant(site_code="PAGE01", plant_name="Paging Plant")
    db.add(plant)
    db.flush()
    same = business_today()
    from datetime import datetime, timezone
    stamp = datetime(same.year, same.month, same.day, 6, 0, tzinfo=timezone.utc)
    for n in range(7):
        db.add(Issue(ticket_no=f"TIE-{n}", plant_id=plant.id, description="tie", severity="Medium",
                     status="Open", created_at=stamp))
    db.commit()
    seen = []
    for offset in (0, 3, 6):
        page = client.get(f"/api/issues?limit=3&offset={offset}&site_code=PAGE01")
        assert page.status_code == 200, page.text
        seen += [issue["ticket_no"] for issue in page.json()]
    assert sorted(seen) == sorted(f"TIE-{n}" for n in range(7)), "every issue exactly once across pages"


def test_timed_pool_records_waiting_for_a_busy_pool(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'pool.sqlite3').as_posix()}", poolclass=TimedQueuePool,
                           pool_size=1, max_overflow=0, pool_timeout=5, connect_args={"check_same_thread": False})
    try:
        held = engine.connect()
        held.execute(text("SELECT 1"))
        threading.Timer(0.3, held.close).start()   # frees the only connection after 300 ms
        stats = {"connect_ms": 0.0}
        token = _stats.set(stats)
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        finally:
            _stats.reset(token)
        assert stats["pool_wait_ms"] >= 200, stats
        assert stats["pool_capacity"] == 1 and stats["pool_in_use_max"] == 1 and stats["pool_checkouts"] == 1
    finally:
        engine.dispose()


def test_timed_pool_is_free_outside_a_request(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'idle.sqlite3').as_posix()}", poolclass=TimedQueuePool)
    try:
        started = time.perf_counter()
        with engine.connect() as conn:
            assert conn.execute(text("SELECT 1")).scalar() == 1
        assert time.perf_counter() - started < 2
    finally:
        engine.dispose()
