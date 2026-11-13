"""Editing a saved Module Cleaning day, and recording days as a range from the start, from the end, or scattered tables."""
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


def _picked(day, numbers):
    return {"report_date": day.isoformat(), "job_status": "Done", "tables_cleaned": len(numbers), "table_numbers": numbers}


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


def _row(db, report_id):
    db.expire_all()
    return db.get(WashingDailyReport, uuid.UUID(report_id))


def test_head_edits_a_confirmed_day_which_stays_confirmed_and_is_audited(client, db):
    _plant_row, head, _assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)
    original_date = _row(db, d1).report_date

    edited = client.patch(f"{BASE}/daily-reports/{d1}", json={"table_numbers": [4], "remarks": "Recount"})

    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert body["review_status"] == "Confirmed"  # an O&M edit does not send a confirmed day back for review
    assert body["tables_cleaned"] == 1 and body["cleaned_table_codes"] == ["Table 004"] and body["remarks"] == "Recount"
    audit = db.query(AuditLog).filter_by(action="Edited daily washing report", entity_id=d1).one()
    assert audit.actor_name == head.display_name
    assert audit.metadata_json["before"]["report_date"] == original_date.isoformat()
    assert audit.metadata_json["before"]["table_codes"] == ["Table 001"]


def test_edit_can_make_a_day_scattered_and_completes_the_cycle(client, db):
    _plant_row, _head, _assignee, (_d1, _d2, d3) = _confirmed_three_days(client, db)

    edited = client.patch(f"{BASE}/daily-reports/{d3}", json={"table_numbers": [4, 3]})

    assert edited.status_code == 200, edited.text
    assert edited.json()["tables_cleaned"] == 2 and edited.json()["cleaned_table_codes"] == ["Table 003", "Table 004"]
    assert _row(db, d3).cycle_completed is True  # 1 + 1 + 2 fills the plant's 4 tables


def test_engineer_edit_that_repeats_a_table_of_the_same_cycle_is_refused_and_changes_nothing(client, db):
    # A Site Engineer's repeat is refused. (An O&M Head / Assignee repeat starts the next cycle instead:
    # tests/test_washing_reclean_next_cycle.py.)
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    d1, d2, d3 = _days(3)
    saved = _sheet(client, plant, [_ranged(d1, 1, 1), _ranged(d2, 2, 2), _ranged(d3, 3, 3)])
    assert saved.status_code == 200, saved.text
    first = saved.json()["reports"][0]["id"]

    refused = client.patch(f"{BASE}/daily-reports/{first}", json={"table_numbers": [1, 2]})  # table 2 belongs to the next day

    assert refused.status_code == 409 and "Table 2 is already recorded in cycle 1" in refused.json()["detail"]
    assert _row(db, first).cleaned_table_codes == ["Table 001"] and _row(db, first).tables_cleaned == 1


def test_switching_a_day_to_not_done_requires_a_reason(client, db):
    _plant_row, _head, _assignee, (d1, d2, _d3) = _confirmed_three_days(client, db)

    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"job_status": "Not done"}).status_code == 422
    done = client.patch(f"{BASE}/daily-reports/{d1}", json={"job_status": "Not done", "exception_reason": "Rain"})

    assert done.status_code == 200, done.text
    assert done.json()["tables_cleaned"] == 0 and done.json()["review_status"] == "Confirmed"
    assert _row(db, d2).cleaned_table_codes == ["Table 002"]  # other days keep their own tables


def test_assignee_can_edit_but_a_site_engineer_cannot_change_a_confirmed_day(client, db):
    plant, _head, assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)

    conftest._CURRENT_USER = assignee
    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"remarks": "Assignee fix"}).status_code == 200

    _engineer(client, db, plant)
    refused = client.patch(f"{BASE}/daily-reports/{d1}", json={"remarks": "Engineer change"})
    assert refused.status_code == 403
    assert _row(db, d1).remarks == "Assignee fix"


def test_edit_rejects_out_of_range_or_inconsistent_table_numbers(client, db):
    _plant_row, _head, _assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)
    url = f"{BASE}/daily-reports/{d1}"

    assert client.patch(url, json={"table_start": 1, "table_end": 5}).status_code == 422  # plant has 4 tables
    assert client.patch(url, json={"table_start": 3, "table_end": 2}).status_code == 422
    assert client.patch(url, json={"table_end": 2}).status_code == 422
    assert client.patch(url, json={"table_start": 1, "table_end": 2, "tables_cleaned": 3}).status_code == 422
    assert client.patch(url, json={"table_numbers": [4, 5]}).status_code == 422  # table 5 does not exist
    assert client.patch(url, json={"table_numbers": [4, 4]}).status_code == 422  # listed twice
    assert client.patch(url, json={"table_numbers": [4], "tables_cleaned": 2}).status_code == 422
    assert client.patch(url, json={"table_numbers": [4], "table_start": 4, "table_end": 4}).status_code == 422
    assert _row(db, d1).cleaned_table_codes == ["Table 001"]  # nothing was changed by the refused edits


def test_viewer_cannot_edit(client, db):
    _plant_row, _head, _assignee, (d1, _d2, _d3) = _confirmed_three_days(client, db)
    login_user(client, db, role="Viewer", name="Edit Viewer", email="edit-viewer@example.com")

    assert client.patch(f"{BASE}/daily-reports/{d1}", json={"remarks": "x"}).status_code == 403


def test_sheet_records_days_from_the_end_and_as_scattered_tables(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)  # 4 tables per cycle
    conftest._CURRENT_USER = head
    d1, d2 = _days(2, back=60)

    saved = _sheet(client, plant, [_picked(d1, [4, 3]), _picked(d2, [1])])  # from the end, then from the start

    assert saved.status_code == 200, saved.text
    first, second = saved.json()["reports"]
    assert first["cleaned_table_codes"] == ["Table 003", "Table 004"] and first["tables_cleaned"] == 2
    assert second["cleaned_table_codes"] == ["Table 001"]


def test_engineer_sheet_refuses_a_table_cleaned_twice_in_one_cycle_and_saves_nothing(client, db):
    # A Site Engineer's repeat is refused; an O&M repeat starts the next cycle (test_washing_reclean_next_cycle.py).
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    d1, d2, d3 = _days(3)
    assert _sheet(client, plant, [_picked(d1, [1, 3])]).status_code == 200

    clash = _sheet(client, plant, [_picked(d2, [2]), _picked(d3, [3])])  # table 3 was already cleaned on d1

    assert clash.status_code == 409 and "Table 3 is already recorded in cycle 1" in clash.json()["detail"]
    db.expire_all()
    assert db.query(WashingDailyReport).filter_by(plant_id=plant.id).count() == 1  # all or nothing

    assert _sheet(client, plant, [_picked(d2, [2, 2])]).status_code == 422
    assert _sheet(client, plant, [_picked(d2, [9])]).status_code == 422


def test_zero_tables_day_is_saved_by_the_team_and_uses_no_table_numbers(client, db):
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    d1, d2 = _days(2, back=60)
    zero = {"report_date": d1.isoformat(), "job_status": "Not done", "exception_reason": "Other",
            "tables_cleaned": 0, "remarks": "No water"}

    for who in (head, assignee):
        conftest._CURRENT_USER = who
        saved = _sheet(client, plant, [zero, _ranged(d2, 1, 2)])
        assert saved.status_code == 200, saved.text
        first, second = saved.json()["reports"]
        assert first["tables_cleaned"] == 0 and first["job_status"] == "Not done"
        assert first["review_status"] == "Confirmed" and first["remarks"] == "No water"
        assert second["cleaned_table_codes"] == ["Table 001", "Table 002"]
        for report in (first, second):
            assert client.delete(f"{BASE}/daily-reports/{report['id']}").status_code == 200  # reset for the next user


def test_calendar_and_day_detail_show_which_tables_were_cleaned(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2 = _days(2, back=60)
    saved = _sheet(client, plant, [_picked(d1, [1, 2, 4]), _picked(d2, [3])])
    assert saved.status_code == 200, saved.text
    first_id = saved.json()["reports"][0]["id"]

    month = client.get("/api/portal/calendar", params={"kind": "washing", "month": d1.strftime("%Y-%m")})
    assert month.status_code == 200, month.text
    by_id = {entry["id"]: entry for entry in month.json()["entries"]}
    assert by_id[first_id]["tablesList"] == "1–2, 4" and by_id[first_id]["tablesCleaned"] == 3

    detail = client.get(f"/api/operations-calendar/washing/{first_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["tables_list"] == "1–2, 4" and detail.json()["tables_cleaned"] == 3
