from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from app.core.timeutil import business_today
from app.core.models import (
    Plant,
    UserEquipmentTypeAssignment,
    UserPlantAssignment,
    WashingHistory,
    WashingTable,
)
from tests import conftest
from tests.conftest import login_user
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users, _stub_washing_storage

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
ROOT = Path(__file__).resolve().parents[1]


def _engineer(client, db, plant):
    user = login_user(client, db, role="Site Engineer", name="Day Engineer", email="day-engineer@example.com")
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return user


def _photo(client, report_id, kind):
    return client.post(
        f"{BASE}/daily-reports/{report_id}/evidence",
        files=[("files", (f"{kind}.png", PNG, "image/png"))],
        data={"kind": kind},
    )


def test_engineer_reports_a_past_day_with_photos_and_head_or_assignee_confirm(client, db, monkeypatch):
    _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant)
    day = (business_today() - timedelta(days=3)).isoformat()

    report = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2, "report_date": day,
    })
    assert report.status_code == 200, report.text
    report = report.json()
    assert report["report_date"] == day and report["review_status"] == "Pending"
    assert report["can_add_evidence"] is True and report["can_review"] is False
    assert _photo(client, report["id"], "before").status_code == 200
    assert _photo(client, report["id"], "after").status_code == 200

    # the engineer corrects their own count before review
    edited = client.patch(f"{BASE}/daily-reports/{report['id']}", json={"tables_cleaned": 3})
    assert edited.status_code == 200 and edited.json()["tables_cleaned"] == 3

    # the engineer can never confirm their own submission
    assert client.post(f"{BASE}/daily-reports/{report['id']}/review", json={"decision": "Confirm"}).status_code == 403

    # the plant's configured Assignee sees the report as reviewable and may add evidence too
    conftest._CURRENT_USER = assignee
    row = next(r for r in client.get(f"{BASE}/overview").json()["reports"] if r["id"] == report["id"])
    assert row["can_review"] is True and row["can_add_evidence"] is True
    assert _photo(client, report["id"], "other").status_code == 200
    confirmed = client.post(f"{BASE}/daily-reports/{report['id']}/review", json={"decision": "Confirm"})
    assert confirmed.status_code == 200 and confirmed.json()["review_status"] == "Confirmed"
    assert confirmed.json()["can_add_evidence"] is False
    assert _photo(client, report["id"], "after").status_code == 403


def test_head_can_add_evidence_and_confirm_but_unassigned_assignee_cannot(client, db, monkeypatch):
    _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    other = login_user(client, db, role="Assignee", name="Other Assignee", email="other-assignee@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=other.id, equipment_type="Modules cleaning"))
    db.commit()
    _engineer(client, db, plant)
    report = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1}).json()

    conftest._CURRENT_USER = other  # washing scope, but not this plant's configured Assignee
    assert _photo(client, report["id"], "before").status_code == 403
    assert client.post(f"{BASE}/daily-reports/{report['id']}/review", json={"decision": "Confirm"}).status_code == 403

    conftest._CURRENT_USER = head
    assert _photo(client, report["id"], "before").status_code == 200
    assert _photo(client, report["id"], "after").status_code == 200
    assert client.post(f"{BASE}/daily-reports/{report['id']}/review", json={"decision": "Confirm"}).status_code == 200


def test_engineer_cannot_report_older_than_45_days_or_other_plants(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    old = (business_today() - timedelta(days=46)).isoformat()
    assert client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1, "report_date": old}).status_code == 422
    other = Plant(site_code="OTHER01", plant_name="Other Plant")
    db.add(other)
    db.commit()
    assert client.post(f"{BASE}/daily-reports", json={"plant_id": str(other.id), "job_status": "Done", "tables_cleaned": 1}).status_code in (403, 409)


def test_bootstrap_lite_keeps_scope_and_full_bootstrap_keeps_washing(client, db):
    plant = _plant(db)
    table = WashingTable(legacy_id="WT-LITE-1", plant_id=plant.id, inverter_no=1, table_code="INV-01-T-01", legacy_payload={})
    db.add(table)
    db.flush()
    db.add(WashingHistory(washing_table_id=table.id, event_type="wash", event_date=business_today(), actor="Tech", notes="n"))
    db.commit()
    login_user(client, db, role="O&M Head", name="Boot Head", email="boot-head@example.com")
    full = client.get("/api/bootstrap").json()
    lite = client.get("/api/bootstrap?lite=1").json()
    assert len(full["state"]["washing"]) == 1 and lite["state"]["washing"] == []
    for key in ("user", "scope", "permissions", "modules", "pending_access", "revision", "collection_revisions"):
        assert lite[key] == full[key]
    # a screen that needs washing can still fetch exactly that collection on demand
    on_demand = client.get("/api/state/collections?keys=washing").json()
    assert len(on_demand["state"]["washing"]) == 1


def test_frontend_wiring_for_day_reports_and_lite_pm_refresh():
    washing = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    assert "window.washReportForDay=" in washing and "washReportForDay(" in washing
    assert "canDayReport=isField()" in washing
    actions = (ROOT / "frontend/static/js/08-actions-exports-and-submission.js").read_text(encoding="utf-8")
    start = actions.index("async function completeTask()")
    body = actions[start:actions.index("function reassignTask()", start)]
    assert "/api/bootstrap?lite=1" in body and "washing:S.washing" in body
    live = (ROOT / "frontend/static/js/34-live-refresh.js").read_text(encoding="utf-8")
    assert "/api/bootstrap?lite=1" in live


def test_overview_sends_recent_reports_by_default_and_full_window_on_request(client, db):
    from app.core.models import WashingDailyReport

    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    login_user(client, db, role="O&M Head", name="Window Head", email="window-head@example.com")
    for age in (1, 10, 60):
        day = business_today() - timedelta(days=age)
        db.add(WashingDailyReport(
            plant_id=plant.id, cycle_month=day.strftime("%Y-%m"), cycle_no=1, report_date=day, job_status="Done",
            tables_cleaned=1, cleaned_table_codes=[], reported_by="E", review_status="Confirmed",
        ))
    db.commit()
    default_response = client.get(f"{BASE}/overview")
    assert default_response.status_code == 200, default_response.text
    default = default_response.json()
    query_count = int(default_response.headers["server-timing"].split('desc="')[1].split()[0])
    # the overview's 3 queries plus one read of the compliance excused-reasons setting (once per request, not per plant)
    assert query_count <= 4, f"Washing overview used {query_count} database queries for one configured plant"
    assert sorted(r["report_date"] for r in default["reports"]) == sorted(
        (business_today() - timedelta(days=a)).isoformat() for a in (1, 10))
    full = client.get(f"{BASE}/overview?report_days=90").json()
    assert len(full["reports"]) == 3
    # figures are computed from the whole window either way
    assert default["plants"][0]["table_count"] == full["plants"][0]["table_count"]


def test_pending_reports_are_always_sent_even_when_old(client, db):
    from app.core.models import WashingDailyReport

    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    login_user(client, db, role="O&M Head", name="Pending Head", email="pending-head@example.com")
    old = business_today() - timedelta(days=60)
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=old.strftime("%Y-%m"), cycle_no=1, report_date=old, job_status="Done",
        tables_cleaned=1, cleaned_table_codes=[], reported_by="E", review_status="Pending",
    ))
    db.commit()
    reports = client.get(f"{BASE}/overview").json()["reports"]
    assert len(reports) == 1 and reports[0]["review_status"] == "Pending"


def test_bootstrap_washing_is_scoped_to_the_engineers_plant_and_empty_for_viewers(client, db):
    plant = _plant(db)
    other = Plant(site_code="OTHER02", plant_name="Other Scoped Plant")
    db.add(other)
    db.commit()
    for p, code in ((plant, "A"), (other, "B")):
        db.add(WashingTable(legacy_id=f"WT-{code}", plant_id=p.id, inverter_no=1, table_code=f"INV-01-T-{code}", legacy_payload={}))
    db.commit()
    _engineer(client, db, plant)
    rows = client.get("/api/bootstrap").json()["state"]["washing"]
    assert [r["id"] for r in rows] == ["WT-A"]
    login_user(client, db, role="Viewer", name="Viewer", email="viewer-washing@example.com")
    assert client.get("/api/bootstrap").json()["state"]["washing"] == []
