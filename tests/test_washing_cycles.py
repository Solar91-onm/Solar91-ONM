from __future__ import annotations

from datetime import date

from app.core.timeutil import business_today
from app.core.models import (
    Notification,
    Plant,
    User,
    UserPlantAssignment,
    WashingConfig,
    WashingDailyReport,
    WashingTable,
)
from app.scheduled.washing_cycles import (
    _cycle_grade,
    _cycle_grade_summary,
    _cycle_work_scores,
    cleaning_activity_metrics,
    check_cycle_compliance_alerts,
    check_missed_monthly_targets,
    _code_number,
    format_table_codes,
)
from tests.conftest import grant_assignee_plants, login_user, tiny_png_bytes
from tests import conftest


BASE = "/api/scheduled/washing"

def _act_as(user):
    conftest._CURRENT_USER = user


def _plant(db):
    plant = Plant(site_code="CYCLE01", plant_name="Cycle Test Plant")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def _setup_cycle_users(client, db, plant):
    head = login_user(client, db, role="O&M Head", name="Cycle Head", email="cycle-head@example.com")
    assignee = login_user(client, db, role="Assignee", name="Cycle Assignee", email="cycle-assignee@example.com")
    grant_assignee_plants(db, assignee.id)
    db.commit()
    login_user(client, db, role="O&M Head", name="Cycle Head", email="cycle-head-setup@example.com")
    setup = client.post(f"{BASE}/setup", json={
        "plant_id": str(plant.id),
        "table_count": 4,
        "assignee_user_id": str(assignee.id),
    })
    assert setup.status_code == 200, setup.text
    return head, assignee


def test_table_code_helpers_compress_contiguous_and_gapped_ranges():
    assert _code_number("Table 040") == 40
    assert _code_number("Legacy T-7") == 7
    assert _code_number("Table A") is None
    assert format_table_codes(["Table 001", "Table 002", "Table 003", "Table 007"]) == "1–3, 7"
    assert format_table_codes(["Table 001", "Table 003", "Table 004", "Table 007"]) == "1, 3–4, 7"
    assert format_table_codes([]) == ""


def test_summary_overview_includes_table_range_only_for_registered_codes(client, db):
    configured = _plant(db)
    unrecorded = Plant(site_code="CYCLE02", plant_name="Unrecorded Tables")
    db.add(unrecorded)
    head = login_user(client, db, role="O&M Head", name="Range Head", email="range-head@example.com")
    db.add_all([
        WashingConfig(plant_id=configured.id, tables_per_cycle=4),
        WashingConfig(plant_id=unrecorded.id, tables_per_cycle=4),
        WashingTable(legacy_id="RANGE-001", plant_id=configured.id, table_code="Table 001"),
        WashingTable(legacy_id="RANGE-002", plant_id=configured.id, table_code="Table 002"),
        WashingTable(legacy_id="RANGE-004", plant_id=configured.id, table_code="Table 004"),
    ])
    db.commit()
    _act_as(head)

    response = client.get(f"{BASE}/overview?include_reports=false&summary=true")
    assert response.status_code == 200, response.text
    rows = {row["site_code"]: row for row in response.json()["plants"]}
    assert rows["CYCLE01"]["table_range"] == "1–2, 4"
    assert rows["CYCLE02"]["table_range"] is None


def test_cycle_requires_daily_reports_and_reviewer_confirmation(client, db, monkeypatch):
    _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Cycle Engineer", email="cycle-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    submitted = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2,
        "cleaned_table_codes": ["Table 001", "Table 002"], "remarks": "First half cleaned",
    })
    assert submitted.status_code == 200, submitted.text
    first_report_id = submitted.json()["id"]
    assert submitted.json()["review_status"] == "Pending"
    assert submitted.json()["remarks"] == "First half cleaned"

    other_assignee = login_user(client, db, role="Assignee", name="Unassigned Reviewer", email="cycle-assignee-other@example.com")
    grant_assignee_plants(db, other_assignee.id)
    db.commit()
    # A different account with the Assignee role is not the configured Assignee.
    response = client.post(f"{BASE}/daily-reports/{first_report_id}/review", json={"decision": "Confirm"})
    assert response.status_code == 403

    # The configured Assignee confirms the first daily report.
    _act_as(assignee)
    confirmed = client.post(f"{BASE}/daily-reports/{first_report_id}/review", json={"decision": "Confirm"})
    assert confirmed.status_code == 409 and "before and after" in confirmed.json()["detail"]
    _act_as(engineer)
    _upload_washing_photos(client, first_report_id)
    _act_as(assignee)
    confirmed = client.post(f"{BASE}/daily-reports/{first_report_id}/review", json={"decision": "Confirm"})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["review_status"] == "Confirmed"

    second = login_user(client, db, role="Site Engineer", name="Cycle Engineer 2", email="cycle-engineer-2@example.com")
    db.add(UserPlantAssignment(user_id=second.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    last_report = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2,
        "cleaned_table_codes": ["Table 003", "Table 004"], "remarks": "Remaining tables cleaned",
    })
    assert last_report.status_code == 200, last_report.text
    _act_as(second)
    _upload_washing_photos(client, last_report.json()["id"])

    head = db.query(User).filter_by(email="cycle-head-setup@example.com").one()
    _act_as(head)
    completion = client.post(f"{BASE}/daily-reports/{last_report.json()['id']}/review", json={"decision": "Confirm"})
    assert completion.status_code == 200, completion.text
    assert completion.json()["cycle_completed"] is True

    overview = client.get(f"{BASE}/overview").json()
    plant_row = next(row for row in overview["plants"] if row["plant_id"] == str(plant.id))
    assert plant_row["cycles_this_month"] == 1
    assert plant_row["confirmed_tables_cleaned"] == 0
    assert db.query(WashingDailyReport).filter_by(plant_id=plant.id, review_status="Confirmed").count() == 2


def test_not_done_exception_is_distinct_and_does_not_consume_cycle_tables(client, db):
    plant = _plant(db)
    _head, _assignee = _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Exception Engineer", email="exception-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    exception = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Not done", "tables_cleaned": 0,
        "cleaned_table_codes": [], "exception_reason": "Rain", "remarks": "Heavy rain",
    })
    assert exception.status_code == 200, exception.text
    assert exception.json()["exception_reason"] == "Rain"

    done = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 4,
        "cleaned_table_codes": ["Table 001", "Table 002", "Table 003", "Table 004"],
    })
    assert done.status_code == 200, done.text
    assert done.json()["cycle_no"] == exception.json()["cycle_no"] == 1


def test_done_report_is_never_rejected_for_count_or_codes(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Invalid Table Engineer", email="invalid-table-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    # The plant number is only a compliance target: any reported count is accepted.
    response = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
        "cleaned_table_codes": ["Table 999"],
    })
    assert response.status_code == 200, response.text


def test_setup_can_change_tables_per_cycle_after_reports(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=business_today().strftime("%Y-%m"), cycle_no=1,
        report_date=business_today(), job_status="Not done", tables_cleaned=0, reported_by="Field",
    ))
    db.commit()
    head = db.query(User).filter_by(email="cycle-head-setup@example.com").one()
    _act_as(head)
    response = client.post(f"{BASE}/setup", json={
        "plant_id": str(plant.id), "table_count": 2, "assignee_user_id": str(assignee.id),
    })
    assert response.status_code == 200, response.text
    db.expire_all()
    assert db.get(WashingConfig, plant.id).tables_per_cycle == 2
    assert db.query(WashingTable).filter_by(plant_id=plant.id).count() == 0


def test_missed_monthly_target_notification_is_deduplicated(client, db):
    login_user(client, db, role="O&M Head", name="Target Head", email="target-head@example.com")
    plant = _plant(db)
    db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14))
    db.add_all(WashingTable(legacy_id=f"CYCLE-T-{number}", plant_id=plant.id, table_code=f"Table {number}")
               for number in range(1, 3))
    db.commit()

    first_day = date(2026, 11, 1)
    assert check_missed_monthly_targets(db, first_day) == 1
    assert check_missed_monthly_targets(db, first_day) == 0
    alert = db.query(Notification).filter_by(event_type="washing_monthly_target_missed").one()
    assert "0 of 3 required cycles" in alert.message


def test_cycle_compliance_alert_uses_threshold_and_is_deduplicated(client, db):
    login_user(client, db, role="O&M Head", name="Compliance Head", email="compliance-head@example.com")
    plant = _plant(db)
    db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14, compliance_threshold_percent=85))
    db.add_all(WashingTable(legacy_id=f"COMPLIANCE-T-{number}", plant_id=plant.id, table_code=f"Table {number}")
               for number in range(1, 11))
    db.commit()

    assert check_cycle_compliance_alerts(db, date(2026, 11, 8)) == 0      # cycle 1 (1-10 Nov) has not ended yet
    assert check_cycle_compliance_alerts(db, date(2026, 11, 11)) == 1     # the day after it ends
    assert check_cycle_compliance_alerts(db, date(2026, 11, 12)) == 0     # once per cycle
    notification = db.query(Notification).filter_by(event_type="washing_cycle_compliance_low").one()
    assert "Cycle 1 ended with 0 of 10 tables done (0.0%)" in notification.message
    assert notification.user_id is not None


def test_setup_lists_every_assignee_and_grants_the_washing_scope(client, db):
    plant = _plant(db)
    assignee = login_user(client, db, role="Assignee", name="Fresh Assignee", email="fresh-assignee@example.com")
    login_user(client, db, role="O&M Head", name="Setup Head", email="setup-head@example.com")
    listed = client.get(f"{BASE}/assignees").json()
    row = next(a for a in listed if a["id"] == str(assignee.id))
    assert row["has_washing_scope"] is False                 # listed even though they have no washing scope yet
    setup = client.post(f"{BASE}/setup", json={"plant_id": str(plant.id), "table_count": 6, "assignee_user_id": str(assignee.id)})
    assert setup.status_code == 200, setup.text
    assert db.query(UserPlantAssignment).filter_by(user_id=assignee.id, plant_id=plant.id).count() == 1
    again = client.get(f"{BASE}/assignees").json()
    assert next(a for a in again if a["id"] == str(assignee.id))["has_washing_scope"] is True


def test_setup_rejects_a_user_who_is_not_an_assignee(client, db):
    plant = _plant(db)
    engineer = login_user(client, db, role="Site Engineer", name="Not Assignee", email="not-assignee-wash@example.com")
    login_user(client, db, role="O&M Head", name="Setup Head 2", email="setup-head2@example.com")
    resp = client.post(f"{BASE}/setup", json={"plant_id": str(plant.id), "table_count": 6, "assignee_user_id": str(engineer.id)})
    assert resp.status_code in (404, 422)


def _engineer(client, db, plant, email="wash-eng@example.com"):
    engineer = login_user(client, db, role="Site Engineer", name="Wash Engineer", email=email)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return engineer


def test_site_engineer_reports_a_daily_count_with_no_upper_limit(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)        # 4 tables in the plant
    _engineer(client, db, plant)
    first = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 3})
    assert first.status_code == 200, first.text
    assert first.json()["cleaned_table_codes"] == []                    # no individual tables are tracked
    second = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1})
    assert second.status_code == 200, second.text
    too_many = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1})
    assert too_many.status_code == 200                                   # above the target is still accepted
    zero = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 0})
    assert zero.status_code == 422


def test_completing_a_cycle_starts_the_next_one_and_is_listed_in_the_register(client, db):
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    report = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 4}).json()
    _act_as(head)
    done = client.post(f"{BASE}/daily-reports/{report['id']}/review", json={"decision": "Confirm"})
    assert done.status_code == 200 and done.json()["cycle_completed"] is True
    note = db.query(Notification).filter(Notification.event_type == "washing_cycle_completed").first()
    assert note is not None and "Cycle 2 starts now" in note.message
    overview = client.get(f"{BASE}/overview").json()
    row = next(p for p in overview["plants"] if p["plant_id"] == str(plant.id))
    assert row["current_cycle"] == 2 and row["cycles_this_month"] == 1
    assert [c["state"] for c in row["cycles"]] == ["Completed", "In progress", "Upcoming"]
    event = overview["cycle_events"][0]
    assert event["cycle_no"] == 1 and event["next_cycle"] == 2 and event["site_code"] == "CYCLE01"
    assert overview["portfolio"]["cycles_completed_month"] == 1


def test_overdue_matrix_buckets_and_deadlines():
    from app.scheduled.washing_cycles import _cycle_due_dates, _overdue_info
    assert [d.day for d in _cycle_due_dates(date(2026, 10, 5))] == [10, 20, 31]
    assert _overdue_info(0, date(2026, 10, 9))["overdue_bucket"] == "on_track"
    assert _overdue_info(0, date(2026, 10, 11))["overdue_bucket"] == "1d"
    assert _overdue_info(0, date(2026, 10, 14)) ["overdue_bucket"] == "3d" and _overdue_info(0, date(2026, 10, 14))["overdue_days"] == 4
    assert _overdue_info(1, date(2026, 10, 14))["overdue_bucket"] == "on_track"      # cycle 1 done; cycle 2 due on the 20th
    late = _overdue_info(1, date(2026, 10, 27))
    assert late["overdue_bucket"] == "7d" and late["overdue_cycle"] == 2 and late["overdue_days"] == 7


def test_overdue_alerts_fire_once_per_level(client, db):
    from app.scheduled.washing_cycles import check_washing_overdue
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    assert check_washing_overdue(db, date(2026, 10, 9)) == 0                  # nothing due yet
    assert check_washing_overdue(db, date(2026, 10, 11)) == 1                 # 1 day late
    assert check_washing_overdue(db, date(2026, 10, 11)) == 0                 # not repeated
    assert check_washing_overdue(db, date(2026, 10, 14)) == 1                 # now 3+ days late
    assert check_washing_overdue(db, date(2026, 10, 18)) == 1                 # 7+ days late
    titles = [n.title for n in db.query(Notification).filter(Notification.event_type == "washing_overdue")]
    assert any("overdue 8 days" in t for t in titles)


def test_overview_lists_unconfigured_plants_and_daily_status(client, db):
    configured = _plant(db)
    spare = Plant(site_code="SPARE01", plant_name="Spare Plant")
    db.add(spare); db.commit()
    head, _assignee = _setup_cycle_users(client, db, configured)
    _act_as(head)
    overview = client.get(f"{BASE}/overview").json()
    assert [p["site_code"] for p in overview["unconfigured"]] == ["SPARE01"]
    assert set(overview["overdue_matrix"]) == {"on_track", "1d", "3d", "7d"}
    row = overview["plants"][0]
    assert len(row["daily_status"]) == business_today().day and row["daily_status"][-1]["status"] in {"Not reported yet", "Awaiting review", "Confirmed", "Exception"}


def test_summary_overview_includes_cycle_grades_from_distinct_non_rejected_codes(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    today = business_today()
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=today.strftime("%Y-%m"), cycle_no=1, report_date=today,
        job_status="Done", tables_cleaned=2, cleaned_table_codes=["Table 001", "Table 002"],
        reported_by="Field", review_status="Confirmed",
    ))
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=today.strftime("%Y-%m"), cycle_no=1, report_date=today,
        job_status="Done", tables_cleaned=2, cleaned_table_codes=["Table 003"],
        reported_by="Field", review_status="Rejected",
    ))
    db.commit()
    _act_as(head)

    response = client.get(f"{BASE}/overview?include_reports=false&summary=true")
    assert response.status_code == 200, response.text
    row = next(item for item in response.json()["plants"] if item["plant_id"] == str(plant.id))
    grade = next(item for item in row["cycle_grades"] if item["cycle_no"] == 1)
    assert grade["coverage_count"] == 2
    assert grade["required_tables"] == 4
    assert len(row["cycle_grades"]) == 3
    assert row["cycle_grade_summary"]["running"] + row["cycle_grade_summary"]["due"] <= 3


def test_cycle_grades_use_threshold_timing_and_exclude_running_cycles():
    from types import SimpleNamespace

    start = date(2026, 11, 1)

    def report(day, codes, status="Confirmed"):
        return SimpleNamespace(
            cycle_no=1, report_date=date(2026, 11, day), review_status=status,
            cleaned_table_codes=codes,
        )

    on_target = _cycle_grade(
        1, [report(7, [f"T{i}" for i in range(1, 10)]), report(7, ["T1"])],
        10, 85, 7, start, date(2026, 11, 10), date(2026, 11, 10),
    )
    on_time = _cycle_grade(
        1, [report(10, [f"T{i}" for i in range(1, 10)])],
        10, 85, 7, start, date(2026, 11, 10), date(2026, 11, 10),
    )
    overdue = _cycle_grade(
        1, [report(13, [f"T{i}" for i in range(1, 10)])],
        10, 85, 7, start, date(2026, 11, 10), date(2026, 11, 13),
    )
    running = _cycle_grade(
        1, [report(9, [f"T{i}" for i in range(1, 10)], "Rejected")],
        10, 85, 7, start, date(2026, 11, 10), date(2026, 11, 9),
    )
    assert on_target["grade"] == "on_target" and on_target["coverage_count"] == 9
    assert on_time["grade"] == "on_time" and on_time["days_to_target"] == 9
    assert overdue["grade"] == "overdue" and overdue["coverage_percent"] == 90
    assert running["grade"] == "running" and running["coverage_count"] == 0
    upcoming = _cycle_grade(
        3, [], 10, 85, 7, date(2026, 11, 21), date(2026, 11, 30), date(2026, 11, 17),
    )
    assert upcoming["grade"] == "upcoming" and upcoming["compliance_percent"] is None

    summary = _cycle_grade_summary([on_target, on_time, overdue, running, upcoming])
    assert summary["due"] == 3 and summary["running"] == 1 and summary["upcoming"] == 1
    # Compliance is counted in tables, not in how many cycles earned a good grade, so grades
    # carrying no table counts contribute nothing.
    assert summary["compliance_percent"] == 0.0
    scored = _cycle_grade_summary([
        dict(on_target, tables_done=10, tables_due=10),
        dict(overdue, tables_done=5, tables_due=10),
        dict(upcoming, tables_done=0, tables_due=0),   # upcoming is left out entirely
    ])
    assert scored["compliance_percent"] == 75.0


def _work(day, tables, status="Confirmed", month=11, cycle=1, completed=False):
    from types import SimpleNamespace
    return SimpleNamespace(
        report_date=date(2026, month, day), cycle_month=f"2026-{month:02d}", cycle_no=cycle,
        tables_cleaned=tables, review_status=status, cycle_completed=completed, cleaned_table_codes=[],
    )


def test_cycle_work_scores_follow_the_owners_worked_example():
    """A 100-table plant: Cycle 1 and 2 fully cleaned on time, Cycle 3 only half.
    Month = (100 + 100 + 50) / 300 = 83%; each cycle scores its own work."""
    reports = [_work(5, 100, cycle=1), _work(15, 100, cycle=2), _work(25, 50, cycle=3)]
    result = _cycle_work_scores(reports, 100, date(2026, 11, 30), None, set())

    assert [result["cycles"][n]["score"] for n in (1, 2, 3)] == [100, 100, 50]
    assert result["month"] == {"tables_done": 250, "tables_due": 300, "percent": 83.3}


def test_catch_up_work_counts_in_the_cycle_it_is_done():
    """The rate uses dates, while a cycle's score uses its assigned cycle number. A cycle is a
    fixed amount of work, so its own score stops at 100% however much is done inside it."""
    reports = [_work(3, 50, month=12), _work(8, 100, month=12)]
    result = _cycle_work_scores(reports, 100, date(2026, 12, 10), None, set())

    assert result["cycles"][1]["score"] == 100
    assert result["month"]["tables_done"] == 150
    assert result["month"]["percent"] == 100      # the rate itself is capped


def test_extra_washing_after_all_three_cycles_raises_compliance_above_100():
    """Washing every table again after the three cycles are complete is more than the month
    asked for, so the plant's cleaning compliance goes past 100% instead of stopping there."""
    assert cleaning_activity_metrics(3, 3, allow_extra=True)["compliance_percent"] == 100.0
    # Three cycles done plus a further full wash of the plant = four of three planned.
    extra = cleaning_activity_metrics(4, 3, allow_extra=True)
    assert extra["compliance_percent"] == 133.3
    assert extra["completed"] == 4 and extra["pending"] == 0
    # Half an extra wash counts as half, so the score moves with the work.
    assert cleaning_activity_metrics(3.5, 3, allow_extra=True)["compliance_percent"] == 116.7
    # Only one plant may exceed 100%: across plants the same work is capped.
    assert cleaning_activity_metrics(4, 3)["compliance_percent"] == 100.0


def test_next_cycle_does_not_start_when_its_calendar_window_begins():
    """17 Nov: Cycle 1 is still active; the date alone must not start Cycle 2."""
    reports = [_work(4, 45, cycle=1), _work(14, 35, cycle=1), _work(16, 0, cycle=1)]
    result = _cycle_work_scores(reports, 100, date(2026, 11, 17), None, set())

    assert result["cycles"][1]["tables_done"] == 80
    assert result["cycles"][1]["tables_due"] == 100
    assert result["cycles"][1]["score"] == 80
    assert result["cycles"][1]["started"] is True
    assert result["cycles"][2]["score"] is None
    assert result["cycles"][2]["started"] is False
    assert result["cycles"][3]["score"] is None
    assert result["month"] == {"tables_done": 80, "tables_due": 170, "percent": 47.1}


def test_next_cycle_starts_only_after_all_tables_in_previous_cycle_are_cleaned():
    reports = [
        _work(16, 100, cycle=1, completed=True),
        _work(17, 35, cycle=2),
    ]
    result = _cycle_work_scores(reports, 100, date(2026, 11, 17), None, set())

    assert result["cycles"][1]["score"] == 100
    assert result["cycles"][2]["tables_done"] == 35
    assert result["cycles"][2]["tables_due"] == 100
    assert result["cycles"][2]["score"] == 35
    assert result["cycles"][2]["started"] is True
    assert result["cycles"][3]["started"] is False


def test_unconfirmed_and_future_work_is_not_counted():
    reports = [_work(5, 100, status="Pending"), _work(6, 100, status="Rejected"), _work(9, 30), _work(20, 99)]
    result = _cycle_work_scores(reports, 100, date(2026, 11, 10), None, set())

    assert result["cycles"][1]["tables_done"] == 30   # only confirmed, and nothing after today
    assert result["cycles"][2]["score"] is None


def test_cleaning_activity_metrics_counts_verified_completions_and_pending():
    assert cleaning_activity_metrics(85, 100, 5) == {
        "planned": 100, "completed": 85, "pending": 15, "overdue": 5,
        "compliance_percent": 85.0,
    }
    assert cleaning_activity_metrics(100, 100)["compliance_percent"] == 100.0
    # Capped by default, so a portfolio figure can never exceed 100%.
    assert cleaning_activity_metrics(150, 100)["compliance_percent"] == 100.0
    # A single plant's own row credits extra cleaning beyond its planned cycles.
    assert cleaning_activity_metrics(150, 100, allow_extra=True)["compliance_percent"] == 150.0
    assert cleaning_activity_metrics(150, 100, allow_extra=True)["pending"] == 0
    assert cleaning_activity_metrics(0, 0) == {
        "planned": 0, "completed": 0, "pending": 0, "overdue": 0,
        "compliance_percent": 0.0,
    }
    # Overdue is a subset of pending, never a second denominator item.
    assert cleaning_activity_metrics(7, 10, 5)["overdue"] == 3


def test_cleaning_compliance_follows_the_agreed_rules():
    """Compliance = completed / planned x 100, one decimal, overdue inside pending, and above
    100% only for a single plant that cleaned beyond its plan."""
    assert cleaning_activity_metrics(85, 100)["compliance_percent"] == 85.0
    assert cleaning_activity_metrics(100, 100)["compliance_percent"] == 100.0
    assert cleaning_activity_metrics(0, 0)["compliance_percent"] == 0.0        # never divides by zero
    assert cleaning_activity_metrics(0, 4)["compliance_percent"] == 0.0

    # Overdue is a subset of pending, so it is never a second item in the denominator.
    counted = cleaning_activity_metrics(85, 100, 5)
    assert counted["pending"] == 15 and counted["overdue"] == 5
    assert counted["completed"] + counted["pending"] == counted["planned"]

    # A part-finished activity is not a completed one: half a wash counts as half.
    assert cleaning_activity_metrics(2.5, 3, allow_extra=True)["compliance_percent"] == 83.3

    # Only one plant may pass 100%.
    assert cleaning_activity_metrics(4, 3, allow_extra=True)["compliance_percent"] == 133.3
    assert cleaning_activity_metrics(4, 3)["compliance_percent"] == 100.0


def test_a_part_finished_cycle_counts_towards_compliance():
    """Half of cycle 1 cleaned is half a cycle achieved, not nothing. A plant cleaning every day
    used to read 0% until the moment a cycle closed, which hid all the work in flight."""
    # 178 of 352 tables = 0.506 of one cycle, against the month's three planned cycles.
    assert cleaning_activity_metrics(0.506, 3, 1, allow_extra=True)["compliance_percent"] == 16.9
    # The displayed count stays whole: no cycle is finished yet.
    assert cleaning_activity_metrics(0.506, 3, 1, allow_extra=True)["completed"] == 0.5
    # Precision is kept for the percentage, so the browser's own aggregate agrees to the decimal.
    assert cleaning_activity_metrics(1.0 / 3, 1)["compliance_percent"] == 33.3


def test_one_plants_extra_cleaning_cannot_hide_another_plants_shortfall():
    from app.portal.service import aggregate

    def row(completed, planned):
        activities = cleaning_activity_metrics(completed, planned, allow_extra=True)
        return {
            "plant": {"dc_capacity_kw": None, "ac_capacity_kw": None, "commissioned_on": None},
            "profile": {"derivedCondition": "unknown", "washing": {
                "completed": activities["completed"], "pending": activities["pending"],
                "overdue": activities["overdue"], "compliancePercent": activities["compliance_percent"],
                "monthlyActivities": activities, "cycleGrades": []}},
        }

    # Alone, the plant that did a fourth wash reads above 100%.
    assert aggregate([row(4, 3)])["washingCompliancePercent"] == 133.3
    # Beside a plant that did nothing, its surplus is not lent out: 3 of 6, not 4 of 6.
    together = aggregate([row(4, 3), row(0, 3)])
    assert together["washingCompliancePercent"] == 50.0
    assert together["washingWork"]["done"] == 3 and together["washingWork"]["due"] == 6


def test_portfolio_cleaning_compliance_aggregates_activity_counts():
    from app.portal.service import aggregate

    def row(done, pending, overdue=0, cycles=()):
        activities = cleaning_activity_metrics(done, done + pending, overdue)
        return {
            "plant": {"dc_capacity_kw": None, "ac_capacity_kw": None, "commissioned_on": None},
            "profile": {
                "derivedCondition": "unknown",
                "washing": {
                    "completed": activities["completed"], "pending": activities["pending"],
                    "overdue": activities["overdue"], "compliancePercent": activities["compliance_percent"],
                    "monthlyActivities": activities,
                    "cycleGrades": [
                        {"cycleNo": n, "compliancePercent": None if d is None else 0,
                         "tablesDone": c, "tablesDue": d}
                        for n, (c, d) in enumerate(cycles, 1)
                    ],
                },
            },
        }

    one = aggregate([row(85, 15, 5)])
    assert one["washingCompliancePercent"] == 85.0
    assert one["washingCompleted"] == 85
    assert one["washingPending"] == 15
    assert one["washingOverdue"] == 5
    assert one["washingWork"] == {"done": 85, "completed": 85, "due": 100, "pending": 15, "overdue": 5, "plants": 1}

    both = aggregate([row(10, 0), row(10, 80)])
    assert both["washingCompliancePercent"] == 20.0         # (10 + 10) / (10 + 90), not a mean
    assert both["washingWork"] == {"done": 20, "completed": 20, "due": 100, "pending": 80, "overdue": 0, "plants": 2}

    by_cycle = aggregate([row(0, 0, cycles=[(45, 100), (35, 70), (0, None)])])
    assert by_cycle["washingCycleCompliancePercentByCycle"] == {"1": 45, "2": 50, "3": None}
    assert aggregate([{"plant": row(0, 0)["plant"], "profile": {"derivedCondition": "unknown"}}])[
        "washingCompliancePercent"] == 0.0


def test_portal_overview_uses_table_progress_before_any_cycle_is_completed(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    today = business_today()
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=today.strftime("%Y-%m"), cycle_no=1, report_date=today,
        job_status="Done", tables_cleaned=2, cleaned_table_codes=["Table 001", "Table 002"],
        reported_by="Field", review_status="Confirmed", cycle_completed=False,
    ))
    db.commit()
    _act_as(head)

    dashboard = client.get("/api/portal/overview/range?period=month")
    module = client.get(f"{BASE}/overview?include_reports=false&summary=true")
    assert dashboard.status_code == module.status_code == 200
    profile = next(row["profile"] for row in dashboard.json()["rows"] if row["plant"]["id"] == str(plant.id))
    module_row = next(row for row in module.json()["plants"] if row["plant_id"] == str(plant.id))
    # No cycle is finished, so the activity count is still 0 ...
    assert profile["washing"]["completed"] == 0
    # ... but the tables already cleaned count towards the score: work in flight is not invisible.
    assert profile["washing"]["compliancePercent"] > 0
    assert module_row["monthly_cycle_progress"] > 0
    # How many cycles are planned depends on where in the month today falls, so compare the two
    # views against each other rather than hard-coding a number that only holds on some days.
    assert profile["washing"]["pending"] == module_row["monthly_activities_pending"]
    assert profile["washing"]["compliancePercent"] == module_row["monthly_compliance_percent"]
    assert dashboard.json()["totals"]["washingCompliancePercent"] == profile["washing"]["compliancePercent"]


def test_overview_version_check_returns_only_a_scoped_token(client, db):
    head, _assignee = _setup_cycle_users(client, db, _plant(db))
    _act_as(head)

    response = client.get("/api/portal/overview?version_only=true")

    assert response.status_code == 200
    assert set(response.json()) == {"dataVersion"}
    assert isinstance(response.json()["dataVersion"], str)


def test_photo_kind_is_stored_for_before_and_after(client, db, monkeypatch):
    storage = _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    report = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2}).json()
    png = tiny_png_bytes()
    before = client.post(f"{BASE}/daily-reports/{report['id']}/evidence", files=[("files", ("b.png", png, "image/png"))], data={"kind": "before"})
    after = client.post(f"{BASE}/daily-reports/{report['id']}/evidence", files=[("files", ("a.png", png, "image/png"))], data={"kind": "after"})
    assert before.status_code == 200 and before.json()[0]["kind"] == "before"
    assert after.status_code == 200 and after.json()[0]["kind"] == "after"
    saved_photo = client.get(f"{BASE}/daily-reports/{report['id']}/evidence/{before.json()[0]['id']}")
    assert saved_photo.status_code == 200 and saved_photo.content[:4] == b"RIFF" and saved_photo.content[8:12] == b"WEBP"
    assert len(storage.objects) == 4  # original + thumbnail for each of the two photos
    bad = client.post(f"{BASE}/daily-reports/{report['id']}/evidence", files=[("files", ("x.png", png, "image/png"))], data={"kind": "selfie"})
    assert bad.status_code == 422
    overview = client.get(f"{BASE}/overview").json()
    rep = next(r for r in overview["reports"] if r["id"] == report["id"])
    assert rep["has_before"] and rep["has_after"]


def _stub_washing_storage(monkeypatch):
    import app.scheduled.router as scheduled_router
    import app.photos.router as photos_router

    class FakeStorage:
        objects = {}
        base = "https://storage.test"
        bucket = "photos"

        def upload(self, path, data, content_type):
            self.objects[path] = (data, content_type)

        def download(self, path):
            return self.objects[path]

        def usage_bytes(self):
            return sum(len(data) for data, _content_type in self.objects.values())

        def remove(self, paths):
            for path in paths:
                self.objects.pop(path, None)

        def remove_strict(self, paths):
            self.remove(paths)

    monkeypatch.setattr(scheduled_router, "SupabaseStorage", FakeStorage)
    monkeypatch.setattr(photos_router, "SupabaseStorage", FakeStorage)
    from app.storage.usage import clear_bucket_usage_cache
    clear_bucket_usage_cache()
    return FakeStorage()


def _upload_washing_photos(client, report_id):
    png = tiny_png_bytes()
    before = client.post(
        f"{BASE}/daily-reports/{report_id}/evidence",
        files=[("files", ("before.png", png, "image/png"))],
        data={"kind": "before"},
    )
    after = client.post(
        f"{BASE}/daily-reports/{report_id}/evidence",
        files=[("files", ("after.png", png, "image/png"))],
        data={"kind": "after"},
    )
    assert before.status_code == 200, before.text
    assert after.status_code == 200, after.text


def _engineer(client, db, plant, email="ov-engineer@example.com"):
    engineer = login_user(client, db, role="Site Engineer", name="Overlay Engineer", email=email)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return engineer


def test_engineer_can_backdate_edit_and_delete_own_pending_report(client, db):
    from datetime import timedelta
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant)
    _act_as(engineer)
    yesterday = business_today() - timedelta(days=1)
    made = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1, "report_date": yesterday.isoformat(),
    })
    assert made.status_code == 200, made.text
    body = made.json()
    assert body["report_date"] == yesterday.isoformat() and body["can_edit"] and body["can_delete"]
    future = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
        "report_date": (business_today() + timedelta(days=1)).isoformat(),
    })
    assert future.status_code == 422
    edited = client.patch(f"{BASE}/daily-reports/{body['id']}", json={"tables_cleaned": 3, "remarks": "fixed count"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["tables_cleaned"] == 3 and edited.json()["remarks"] == "fixed count"
    assert client.patch(f"{BASE}/daily-reports/{body['id']}", json={"tables_cleaned": 99}).status_code == 200
    assert client.delete(f"{BASE}/daily-reports/{body['id']}").status_code == 200


def test_head_changes_cycle_deadline_and_edits_reviewed_report(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    month = business_today().strftime("%Y-%m")
    target = business_today().replace(day=28)
    _act_as(head)
    changed = client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": target.isoformat()})
    assert changed.status_code == 200, changed.text
    assert changed.json()["due_dates"][0] == target.isoformat()
    overview = client.get(f"{BASE}/overview").json()
    row = next(p for p in overview["plants"] if p["plant_id"] == str(plant.id))
    assert row["cycles"][0]["due_date"] == target.isoformat() and row["cycles"][0]["due_overridden"] is True
    # outside the month is refused; reset restores the default
    other_month = (business_today().replace(day=1) - __import__("datetime").timedelta(days=1)).isoformat()
    assert client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": other_month}).status_code == 422
    reset = client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": None})
    assert reset.json()["due_dates"][0].endswith("-10")

    # O&M back-fills an older report (auto-confirmed), edits its date, then deletes it
    old = (business_today().replace(day=1))
    made = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 4, "report_date": old.isoformat()})
    assert made.status_code == 200, made.text
    assert made.json()["review_status"] == "Confirmed" and made.json()["cycle_completed"] is True
    moved = client.patch(f"{BASE}/daily-reports/{made.json()['id']}", json={"report_date": old.replace(day=min(5, business_today().day)).isoformat()})
    assert moved.status_code == 200 and moved.json()["cycle_completed"] is True
    assert client.delete(f"{BASE}/daily-reports/{made.json()['id']}").status_code == 200
    row = next(p for p in client.get(f"{BASE}/overview").json()["plants"] if p["plant_id"] == str(plant.id))
    assert row["cycles_this_month"] == 0


def test_site_engineer_report_counts_can_vary_by_day_without_daily_target(client, db):
    plant = _plant(db)
    _head, _assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant, "variable-count-engineer@example.com")
    _act_as(engineer)
    first = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 3,
    })
    assert first.status_code == 200, first.text
    second = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
    })
    assert second.status_code == 200, second.text
    overview = client.get(f"{BASE}/overview").json()
    plant_row = next(row for row in overview["plants"] if row["plant_id"] == str(plant.id))
    assert "cycle_compliance_percent" not in plant_row and "cycle_compliance" not in plant_row
    # The per-cycle work scores are compliance figures too: a Site Engineer keeps the grades only.
    assert plant_row.get("cycle_grades"), "the grades themselves stay visible"
    for grade in plant_row["cycle_grades"]:
        assert "grade" in grade
        assert not {"compliance_percent", "tables_done", "tables_due"} & set(grade)
    assert all("target" not in day for day in plant_row["daily_status"])
    assert "cycle_compliance" not in overview["portfolio"]


def test_engineer_cannot_change_cycle_dates_or_confirmed_reports(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant, "ov-engineer-2@example.com")
    _act_as(head)
    made = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1})
    _act_as(engineer)
    month = business_today().strftime("%Y-%m")
    assert client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": business_today().isoformat()}).status_code == 403
    assert client.patch(f"{BASE}/daily-reports/{made.json()['id']}", json={"tables_cleaned": 2}).status_code == 403
    assert client.delete(f"{BASE}/daily-reports/{made.json()['id']}").status_code == 403