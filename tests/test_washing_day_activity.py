from __future__ import annotations

from pathlib import Path

from app.core.models import Plant, UserPlantAssignment
from app.core.timeutil import business_today
from tests.conftest import login_user
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users
from tests.test_washing_sheet import _days, _done, _sheet

ROOT = Path(__file__).resolve().parents[1]


def _activity(client, day=None, plant=None):
    q = []
    if day:
        q.append(f"day={day.isoformat()}")
    if plant:
        q.append(f"plant_id={plant.id}")
    return client.get(f"{BASE}/day-activity" + ("?" + "&".join(q) if q else ""))


def test_day_summary_counts_cycles_by_washing_date_and_confirmations_by_confirmation_day(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)          # 4 tables; signed in as the O&M Head, whose entries are confirmed at once
    d1, d2 = _days(2)
    assert _sheet(client, plant, [_done(d1, 2), _done(d2, 2)]).status_code == 200

    washed = _activity(client, d2).json()
    assert washed["totals"]["cycles_completed"] == 1 and washed["totals"]["reported"] == 1
    assert washed["totals"]["confirmations"] == 0          # confirmed today, not on the washing day
    assert washed["plants"][0]["cycles_completed"] == [1]

    today = _activity(client).json()
    assert today["date"] == business_today().isoformat()
    assert today["totals"]["confirmations"] == 2 and today["totals"]["tables_confirmed"] == 4
    assert today["plants"][0]["confirmed_by"] == ["Cycle Head"]

    one = _activity(client, d1, plant).json()
    assert one["plant_id"] == str(plant.id) and len(one["plants"]) == 1 and one["totals"]["cycles_completed"] == 0


def test_day_summary_all_plants_lists_only_plants_with_activity(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    quiet = Plant(site_code="QUIET01", plant_name="Quiet Plant")
    db.add(quiet); db.commit()
    assert client.post(f"{BASE}/setup", json={"plant_id": str(quiet.id), "table_count": 3,
                                                 "assignee_user_id": str(assignee.id)}).status_code == 200
    d1, = _days(1)
    _sheet(client, plant, [_done(d1, 1)])
    body = _activity(client, d1).json()
    assert body["totals"]["plants"] == 2 and body["totals"]["plants_active"] == 1
    # every plant is listed: cleaned & confirmed first, then the plant with nothing recorded
    assert [(p["site_code"], p["status"]) for p in body["plants"]] == [("CYCLE01", "confirmed"), ("QUIET01", "not_reported")]
    assert body["totals"]["status"]["confirmed"] == 1 and body["totals"]["status"]["not_reported"] == 1
    cleaned = body["plants"][0]
    assert cleaned["cleaned_confirmed"] == 1 and cleaned["target"] is not None
    assert cleaned["difference"] == 1 - cleaned["target"]
    single = _activity(client, d1, quiet).json()
    assert [p["site_code"] for p in single["plants"]] == ["QUIET01"] and single["totals"]["reported"] == 0


def test_day_summary_marks_not_done_and_awaiting(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    d1, d2 = _days(2)
    assert _sheet(client, plant, [{"report_date": d1.isoformat(), "job_status": "Not done", "exception_reason": "Rain"}]).status_code == 200
    row = _activity(client, d1).json()["plants"][0]
    assert row["status"] == "not_done" and row["not_done_reason"] == "Rain" and row["difference"] is None
    engineer = login_user(client, db, role="Site Engineer", name="Wait Engineer", email="wait-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer")); db.commit()
    assert _sheet(client, plant, [_done(d2, 2)]).status_code == 200
    seen = _activity(client, d2).json()
    assert seen["plants"][0]["status"] == "awaiting" and seen["plants"][0]["cleaned_pending"] == 2
    assert seen["plants"][0]["target"] is None and seen["totals"]["target"] is None     # field users never get targets


def test_day_summary_scope(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Day Engineer", email="day-engineer@example.com")
    d1, = _days(1)
    assert _activity(client, d1, plant).status_code == 404       # not their plant
    assert _activity(client, d1).json()["totals"]["plants"] == 0
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer")); db.commit()
    assert _sheet(client, plant, [_done(d1, 1)]).status_code == 200
    mine = _activity(client, d1, plant).json()
    assert mine["totals"]["pending"] == 1 and mine["totals"]["confirmations"] == 0
    login_user(client, db, role="Viewer", name="Day Viewer", email="day-viewer@example.com")
    assert _activity(client, d1).status_code == 403


def test_day_summary_button_and_compact_sheet_are_wired():
    js = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    css = (ROOT / "frontend/static/css/40-washing-and-picker.css").read_text(encoding="utf-8")
    assert "openWashDaySummary()" in js and "/api/scheduled/washing/day-activity" in js
    assert 'S.modal==="washingDaySummary"' in js and "todayStrip()+feedHtml()" in js
    assert ".wx-sheet{max-height:max(500px,66vh)}" in css
