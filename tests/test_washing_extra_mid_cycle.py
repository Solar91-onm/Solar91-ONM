"""Extra cleaning remains in the calendar, but only post-cycle-three work affects compliance.

Re-cleaning during an incomplete cycle cannot stand in for work owed or raise the plant's score.
`is_extra` (migration 048) stores the distinction; entries after all three cycles are confirmed
still count toward the monthly score without advancing cycle progress.
"""
from __future__ import annotations

from datetime import date
from uuid import UUID

from app.core.models import WashingDailyReport
from app.scheduled.washing_cycles import _cycle_ledger, _cycle_work_scores, _month_wash_summary
from tests import conftest
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users
from tests.test_washing_sheet import _days, _engineer, _sheet

TOTAL = 4  # _plant(db) configures 4 tables per cycle


def _picked(day, numbers, *, extra=False):
    entry = {"report_date": day.isoformat(), "job_status": "Done",
             "tables_cleaned": len(numbers), "table_numbers": list(numbers)}
    if extra:
        entry["is_extra"] = True
    return entry


def _team(client, db, who="head"):
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head if who == "head" else assignee
    return plant, head, assignee


def _rows(db, plant):
    db.expire_all()
    return db.query(WashingDailyReport).filter_by(plant_id=plant.id).order_by(
        WashingDailyReport.report_date, WashingDailyReport.created_at).all()


# ---------------------------------------------------------------- the rules, in isolation


class _R:
    """The handful of fields the scoring helpers read off a report."""

    def __init__(self, day, tables, cycle_no, *, extra=False, completed=False, numbers=()):
        self.report_date, self.tables_cleaned, self.cycle_no = day, tables, cycle_no
        self.is_extra, self.cycle_completed = extra, completed
        self.review_status, self.job_status = "Confirmed", "Done"
        self.cleaned_table_codes = ["Table %03d" % n for n in numbers]
        self.cycle_month = day.strftime("%Y-%m")
        self.exception_reason = None
        self.created_at = None


def test_extra_cleaning_never_counts_as_cycle_progress():
    """Even an extra entry naming a table this cycle has not reached adds nothing to it."""
    work = [_R(date(2026, 11, 5), 2, 1, numbers=(1, 2))]
    repeat = work + [_R(date(2026, 11, 8), 2, 1, extra=True, numbers=(1, 2))]
    fresh = work + [_R(date(2026, 11, 8), 1, 1, extra=True, numbers=(4,))]

    assert _cycle_ledger(work, TOTAL)[1]["confirmed"] == 2
    assert _cycle_ledger(repeat, TOTAL)[1]["confirmed"] == 2, "a repeat is not progress"
    assert _cycle_ledger(fresh, TOTAL)[1]["confirmed"] == 2, "rework cannot stand in for work owed"


def test_mid_cycle_extra_cleaning_is_calendar_only_until_all_three_cycles_are_complete():
    today = date(2026, 11, 28)
    one_cycle = [_R(date(2026, 11, 5), 4, 1, completed=True, numbers=range(1, 5))]
    mid = one_cycle + [_R(date(2026, 11, 8), 2, 1, extra=True, numbers=(1, 2))]

    before = _cycle_work_scores(one_cycle, TOTAL, today, None, set())["month"]["tables_done"]
    after = _cycle_work_scores(mid, TOTAL, today, None, set())["month"]["tables_done"]
    assert after == before, "mid-cycle re-cleaning is not compliance work"
    assert _month_wash_summary(mid, TOTAL)["extra_tables"] == 2

    all_three = [
        _R(date(2026, 11, 5), 4, 1, completed=True, numbers=range(1, 5)),
        _R(date(2026, 11, 14), 4, 2, completed=True, numbers=range(1, 5)),
        _R(date(2026, 11, 24), 4, 3, completed=True, numbers=range(1, 5)),
    ]
    mid_and_done = all_three + [
        _R(date(2026, 11, 8), 2, 1, extra=True, numbers=(1, 2)),
        _R(date(2026, 11, 25), 2, 3, extra=True, numbers=(1, 2)),
    ]

    before = _cycle_work_scores(all_three, TOTAL, today, None, set())["month"]["tables_done"]
    after = _cycle_work_scores(mid_and_done, TOTAL, today, None, set())["month"]["tables_done"]
    assert after == before + 2, "only extra cleaning after Cycle 3 contributes to compliance"
    summary = _month_wash_summary(mid_and_done, TOTAL)
    assert (summary["extra_tables"], summary["extra_times"]) == (4, 1.0)
    assert summary["times_washed"] == 3.0, "extra washing is reported apart from the cycles"
    # and it still never passes for cycle work
    assert all(cycle["tables_done"] == TOTAL for cycle in
               _cycle_work_scores(mid_and_done, TOTAL, today, None, set())["cycles"].values())


def test_assignee_can_edit_and_remove_extra_cleaning(client, db):
    plant, _head, _assignee = _team(client, db, who="assignee")
    d1, d2 = _days(2, back=30)
    saved = _sheet(client, plant, [_picked(d1, [1, 2], extra=True)])
    assert saved.status_code == 200, saved.text
    report_id = saved.json()["reports"][0]["id"]

    updated = client.patch(f"{BASE}/daily-reports/{report_id}", json={
        "report_date": d2.isoformat(), "table_numbers": [3, 4], "remarks": "Corrected entry",
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()["is_extra"] is True
    assert updated.json()["report_date"] == d2.isoformat()
    assert updated.json()["tables_cleaned"] == 2

    removed = client.delete(f"{BASE}/daily-reports/{report_id}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["deleted"] is True
    assert not _rows(db, plant)


def test_site_engineer_cannot_edit_or_remove_extra_cleaning(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2)
    _engineer(client, db, plant)
    saved = _sheet(client, plant, [_picked(d1, [1, 2], extra=True)])
    assert saved.status_code == 200, saved.text
    report = saved.json()["reports"][0]
    assert report["can_edit"] is False
    assert report["can_delete"] is False

    updated = client.patch(f"{BASE}/daily-reports/{report['id']}", json={
        "report_date": d2.isoformat(), "table_numbers": [3, 4],
    })
    assert updated.status_code == 403
    removed = client.delete(f"{BASE}/daily-reports/{report['id']}")
    assert removed.status_code == 403
    assert len(_rows(db, plant)) == 1


# ---------------------------------------------------------------- through the API


def test_the_om_team_records_extra_cleaning_during_a_running_cycle(client, db):
    """The portal sends it as one sheet entry flagged extra. Repeated tables are accepted, the cycle
    does not move, and the entry is tagged to the cycle it happened during."""
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    extra = _sheet(client, plant, [_picked(d2, [1, 2], extra=True)])

    assert extra.status_code == 200, extra.text
    row = extra.json()["reports"][0]
    assert row["is_extra"] is True and row["cycle_no"] == 1
    assert row["cycle_completed"] is False
    assert row["photos_required"] is False, "extra cleaning must not be blocked from confirmation"
    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")}).json()
    assert month["cycles"][0]["confirmed"] == 2, "the cycle still needs its other 2 tables"
    assert month["cycles"][0]["state"] == "In progress"
    assert month["summary"]["extra_tables"] == 2, "the monthly record still lists mid-cycle extra work"
    overview = client.get(f"{BASE}/overview", params={
        "month": d1.strftime("%Y-%m"), "include_reports": "false", "summary": "true",
    })
    assert overview.status_code == 200, overview.text
    plant_score = next(row for row in overview.json()["plants"] if row["plant_id"] == str(plant.id))
    assert plant_score["monthly_tables_confirmed"] == 2
    assert plant_score["monthly_compliance_percent"] == 16.7


def test_extra_cleaning_does_not_consume_a_table_the_cycle_still_needs(client, db):
    """Table 3 re-cleaned as extra leaves table 3 still owed as cycle work, and recordable."""
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3 = _days(3, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200
    assert _sheet(client, plant, [_picked(d2, [3], extra=True)]).status_code == 200

    finish = _sheet(client, plant, [_picked(d3, [3, 4])])

    assert finish.status_code == 200, finish.text
    assert finish.json()["reports"][0]["cycle_completed"] is True
    assert [(r.cycle_no, r.is_extra, r.cycle_completed) for r in _rows(db, plant)] == [
        (1, False, False), (1, True, False), (1, False, True),
    ]


def test_a_site_engineers_extra_cleaning_waits_for_confirmation(client, db):
    plant, head, _assignee = _team(client, db)
    d1, d2 = _days(2)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200
    _engineer(client, db, plant)

    saved = _sheet(client, plant, [_picked(d2, [1, 2], extra=True)])

    assert saved.status_code == 200, saved.text
    pending = saved.json()["reports"][0]
    assert pending["review_status"] == "Pending" and pending["is_extra"] is True

    conftest._CURRENT_USER = head
    confirmed = client.post(f"{BASE}/daily-reports/confirm",
                            json={"plant_id": str(plant.id), "report_ids": [pending["id"]]})
    assert confirmed.status_code == 200, confirmed.text
    db.expire_all()
    row = db.query(WashingDailyReport).filter_by(id=UUID(pending["id"])).one()
    assert row.review_status == "Confirmed" and row.is_extra is True and row.cycle_no == 1


def test_extra_cleaning_counts_before_and_after_all_three_cycles_are_confirmed(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2, 3, 4])]).status_code == 200
    assert _sheet(client, plant, [_picked(d2, [1, 2], extra=True)]).status_code == 200
    month = d1.strftime("%Y-%m")
    assert client.get(f"{BASE}/plants/{plant.id}/cycles",
                      params={"month": month}).json()["summary"]["extra_tables"] == 2

    assert _sheet(client, plant, [_picked(d3, [1, 2, 3, 4]), _picked(d4, [1, 2, 3, 4])]).status_code == 200

    body = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": month}).json()
    assert body["summary"]["cycles_completed"] == 3
    assert body["summary"]["extra_tables"] == 2
    assert body["summary"]["extra_times"] == 0.5
    assert [cycle["confirmed"] for cycle in body["cycles"]] == [4, 4, 4], \
        "the three cycles are exactly their table count; the rework is counted apart"


def test_an_extra_entry_must_record_work_that_was_done(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, = _days(1, back=30)

    refused = _sheet(client, plant, [{
        "report_date": d1.isoformat(), "job_status": "Not done",
        "tables_cleaned": 0, "exception_reason": "Rain", "is_extra": True,
    }])

    assert refused.status_code == 422
    assert not _rows(db, plant)
