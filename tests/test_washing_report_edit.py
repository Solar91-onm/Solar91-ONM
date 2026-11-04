"""Editing a saved Module Cleaning day from the Record sheet (O&M Head and Assignee, even after confirmation)."""
from __future__ import annotations

import uuid

from app.core.models import AuditLog, WashingDailyReport
from tests import conftest
from tests.conftest import login_user
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users
from tests.test_washing_sheet import _days, _engineer, _sheet


def _ranged(day, start, end):
    return {"report_date": day.isoformat(), "job_status": "Done", "tables_cleaned": end - start + 1,
            "table_start": start, "table_end": end}


def _confirmed_three_days(client, db):
    """Three single-table days on a 4-table plant, saved by the O&M Head (so already Confirmed)."""
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3 = _days(3, back=90)
    response = _sheet(client, plant, [_ranged(d1, 1, 1), _ranged(d2, 2, 2), _ranged(d3, 3, 3)])
    assert response.status_code == 200, response.text
    ids = [r["id"] for r in response.json()["reports"]]
    return plant, head, assignee, ids


def _codes(db, report_id):
    db.expire_all()
    return db.get(WashingDailyReport, uuid.UUID(report_id)).cleaned_table_codes


def test_head_edits_a_confirmed_day_and_the_following_days_move_with_it(client, db):
    plant, head, _assignee, (d1, d2, d3) = _confirmed_three_days(client, db)
    d1_date = db.get(WashingDailyReport, uuid.UUID(d1)).report_date

    edited = client.patch(f"{BASE}/daily-reports/{d1}", json={"table_start": 1, "table_end": 2, "remarks": "Recount"})

    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert body["review_status"] == "Confirmed"  # an O&M edit does not send a confirmed day back for review
    assert body["tables_cleaned"] == 2 and body["cleaned_table_codes"] == ["Table 001", "Table 002"]
    assert body["remarks"] == "Recount"
    assert _codes(db, d2) == ["Table 003"] and _codes(db, d3) == ["Table 004"]
    db.expire_all()
    assert db.get(WashingDailyReport, uuid.UUID(d3)).cycle_completed is True  # 2 + 1 + 1 now fills the 4 tables
    audit = db.query(AuditLog).filter_by(action="Edited daily washing report", entity_id=d1).one()
    assert audit.actor_name == head.display_name and audit.metadata_json["before"]["report_date"] == d1_date.isoformat()


def test_shifted_range_that_no_longer_fits_keeps_its_count_but_drops_the_numbers(client, db):
    _plant_row, _head, _assignee, (d1, d2, _d3) = _confirmed_three_days(client, db)

    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"table_start": 1, "table_end": 4}).status_code == 200

    db.expire_all()
    later = db.get(WashingDailyReport, uuid.UUID(d2))
    assert later.tables_cleaned == 1 and later.cleaned_table_codes == []


def test_switching_a_day_to_not_done_requires_a_reason_and_pulls_later_days_back(client, db):
    _plant_row, _head, _assignee, (d1, d2, d3) = _confirmed_three_days(client, db)

    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"job_status": "Not done"}).status_code == 422
    done = client.patch(f"{BASE}/daily-reports/{d1}", json={"job_status": "Not done", "exception_reason": "Rain"})

    assert done.status_code == 200, done.text
    assert done.json()["tables_cleaned"] == 0 and done.json()["review_status"] == "Confirmed"
    assert _codes(db, d2) == ["Table 001"] and _codes(db, d3) == ["Table 002"]


def test_assignee_can_edit_but_a_site_engineer_cannot_change_a_confirmed_day(client, db):
    plant, _head, assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)

    conftest._CURRENT_USER = assignee
    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"remarks": "Assignee fix"}).status_code == 200

    _engineer(client, db, plant)
    refused = client.patch(f"{BASE}/daily-reports/{d1}", json={"remarks": "Engineer change"})
    assert refused.status_code == 403
    db.expire_all()
    assert db.get(WashingDailyReport, uuid.UUID(d1)).remarks == "Assignee fix"


def test_edit_rejects_out_of_range_or_inconsistent_table_numbers(client, db):
    _plant_row, _head, _assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)
    url = f"{BASE}/daily-reports/{d1}"

    assert client.patch(url, json={"table_start": 1, "table_end": 5}).status_code == 422  # plant has 4 tables
    assert client.patch(url, json={"table_start": 3, "table_end": 2}).status_code == 422
    assert client.patch(url, json={"table_end": 2}).status_code == 422
    assert client.patch(url, json={"table_start": 1, "table_end": 2, "tables_cleaned": 3}).status_code == 422
    assert _codes(db, d1) == ["Table 001"]  # nothing was changed by the refused edits


def test_viewer_cannot_edit(client, db):
    _plant_row, _head, _assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)
    login_user(client, db, role="Viewer", name="Edit Viewer", email="edit-viewer@example.com")

    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"remarks": "x"}).status_code == 403
