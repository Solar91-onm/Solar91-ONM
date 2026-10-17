"""Regression tests for the October 2026 repair: business date, shared ops date,
notification read sync, and storage error mapping."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import subprocess

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core.models import AppSetting, Notification, Plant, UserEquipmentTypeAssignment, UserPlantAssignment
from app.core.timeutil import BUSINESS_TZ, business_now, business_today, log_stamp
from tests import conftest
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]
WASH = "/api/scheduled/washing"


# ---------------------------------------------------------------- business date

def test_business_timezone_is_india_standard_time():
    assert business_now().utcoffset() == timedelta(hours=5, minutes=30)
    # 20:00 UTC is 01:30 IST on the next calendar day; UTC date.today() would file it a day early.
    instant = datetime(2026, 10, 16, 20, 0, tzinfo=timezone.utc)
    assert instant.astimezone(BUSINESS_TZ).date() == date(2026, 10, 17)
    assert log_stamp().endswith("+05:30")


def test_application_code_has_no_server_local_date_calls():
    offenders = []
    for path in (ROOT / "app").rglob("*.py"):
        if path.name == "timeutil.py":
            continue
        text = path.read_text(encoding="utf-8")
        for needle in ("date.today()", "datetime.now()", "datetime.utcnow()"):
            if needle in text:
                offenders.append(f"{path.relative_to(ROOT)}: {needle}")
    assert offenders == []


def _washing_plant_for_engineer(client, db):
    plant = Plant(site_code="IST01", plant_name="IST Plant")
    db.add(plant)
    db.commit()
    washer = login_user(client, db, role="Assignee", name="IST Washer", email="ist-washer@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=washer.id, equipment_type="Modules cleaning"))
    db.commit()
    login_user(client, db, role="O&M Head", name="IST Head", email="ist-head@example.com")
    setup = client.post(f"{WASH}/setup", json={"plant_id": str(plant.id), "table_count": 4,
                                               "assignee_user_id": str(washer.id)})
    assert setup.status_code == 200, setup.text
    engineer = login_user(client, db, role="Site Engineer", name="IST Engineer", email="ist-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return plant


def test_washing_report_uses_business_date_for_default_and_future_check(client, db, monkeypatch):
    import app.scheduled.washing_cycles as washing_cycles

    plant = _washing_plant_for_engineer(client, db)
    business_day = business_today()
    # Simulate the early-morning IST window: the business date is already "tomorrow" in UTC terms.
    monkeypatch.setattr(washing_cycles, "business_today", lambda: business_day + timedelta(days=1))
    ist_today = business_day + timedelta(days=1)

    defaulted = client.post(f"{WASH}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
    })
    assert defaulted.status_code == 200, defaulted.text
    assert defaulted.json()["report_date"] == ist_today.isoformat()

    explicit = client.post(f"{WASH}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
        "report_date": ist_today.isoformat(),
    })
    assert explicit.status_code == 200, explicit.text

    future = client.post(f"{WASH}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
        "report_date": (ist_today + timedelta(days=1)).isoformat(),
    })
    assert future.status_code == 422
    assert "future" in future.json()["detail"]


def test_washing_overview_reports_business_today(client, db):
    _washing_plant_for_engineer(client, db)
    overview = client.get(f"{WASH}/overview")
    assert overview.status_code == 200, overview.text
    assert overview.json()["today"] == business_today().isoformat()


# ---------------------------------------------------------------- shared operations date

def test_operations_date_is_live_and_never_persisted(client, db):
    login_user(client, db)
    # A value saved by an older release must not freeze "today" for everyone.
    db.add(AppSetting(setting_key="opsDate", setting_value="2020-01-01"))
    db.commit()
    boot = client.get("/api/bootstrap").json()
    assert boot["state"]["opsDate"] == business_today().isoformat()

    synced = client.put("/api/state/sync", json={
        "collection_revisions": {"opsDate": boot["collection_revisions"].get("opsDate", 0)},
        "state": {"opsDate": "2021-02-02"},
    })
    assert synced.status_code == 200, synced.text
    db.expire_all()
    assert db.get(AppSetting, "opsDate").setting_value == "2020-01-01"  # untouched, not overwritten
    assert client.get("/api/bootstrap").json()["state"]["opsDate"] == business_today().isoformat()


# ---------------------------------------------------------------- notification read sync

def _sync_events(client, boot, events):
    return client.put("/api/state/sync", json={
        "revision": None,
        "collection_revisions": {"events": boot["collection_revisions"].get("events", 0)},
        "state": {"events": events},
    })


def test_marking_server_notification_read_does_not_duplicate_it(client, db):
    head = login_user(client, db, role="O&M Head", name="Bell Head", email="bell@example.com")
    db.add_all([
        Notification(user_id=head.id, title="Assigned", message="m1"),
        Notification(user_id=None, title="Broadcast", message="m2"),
    ])
    db.commit()
    boot = client.get("/api/bootstrap").json()
    events = boot["state"]["events"]
    assert len(events) == 2

    response = _sync_events(client, boot, [{**e, "read": True} for e in events])
    assert response.status_code == 200, response.text
    db.expire_all()
    rows = db.scalars(select(Notification)).all()
    assert len(rows) == 2
    assert all(row.read_at is not None for row in rows)
    assert all(row.legacy_id is None for row in rows)

    after = client.get("/api/bootstrap").json()["state"]["events"]
    assert len(after) == 2 and all(e["read"] for e in after)


def test_event_sync_cannot_change_another_users_notification(client, db):
    other = login_user(client, db, role="Assignee", name="Other", email="other@example.com")
    foreign = Notification(user_id=other.id, title="Private", message="only for other")
    db.add(foreign)
    db.commit()
    login_user(client, db, role="O&M Head", name="Head", email="head2@example.com")
    boot = client.get("/api/bootstrap").json()
    forged = {"id": str(foreign.id), "dbId": str(foreign.id), "title": "Hijacked", "read": True}
    assert _sync_events(client, boot, [forged]).status_code == 200
    db.expire_all()
    row = db.get(Notification, foreign.id)
    assert row.read_at is None and row.title == "Private"
    assert db.scalar(select(Notification).where(Notification.legacy_id == str(foreign.id))) is None


def test_client_created_events_still_persist_and_update(client, db):
    login_user(client, db, role="O&M Head", name="Head", email="head3@example.com")
    boot = client.get("/api/bootstrap").json()
    event = {"id": "EVT-1001", "key": "task_assigned:WO-1", "type": "task_assigned", "title": "Task assigned", "meta": "x", "read": False}
    assert _sync_events(client, boot, [event]).status_code == 200
    boot = client.get("/api/bootstrap").json()
    assert [e["id"] for e in boot["state"]["events"]] == ["EVT-1001"]
    stored = boot["state"]["events"][0]
    assert _sync_events(client, boot, [{**stored, "read": True}]).status_code == 200
    db.expire_all()
    rows = db.scalars(select(Notification)).all()
    assert len(rows) == 1 and rows[0].read_at is not None


def test_bootstrap_folds_duplicates_created_by_the_old_sync(client, db):
    head = login_user(client, db, role="O&M Head", name="Head", email="head4@example.com")
    original = Notification(user_id=head.id, title="Original")
    db.add(original)
    db.commit()
    duplicate = Notification(user_id=head.id, title="Original", legacy_id=str(original.id),
                             read_at=datetime.now(timezone.utc))
    db.add(duplicate)
    db.commit()
    events = client.get("/api/bootstrap").json()["state"]["events"]
    assert len(events) == 1
    assert events[0]["dbId"] == str(original.id) and events[0]["read"] is True
    assert db.scalar(select(Notification).where(Notification.id == duplicate.id)) is not None  # nothing deleted


# ---------------------------------------------------------------- storage errors

class _Resp:
    def __init__(self, status, body=b"img"):
        self.status_code = status
        self.content = body
        self.headers = {"content-type": "image/png"}


class _Client:
    def __init__(self, outcome):
        self.outcome = outcome

    def get(self, *args, **kwargs):
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@pytest.mark.parametrize("outcome,status", [
    (_Resp(200), None),
    (_Resp(404), 404),
    (_Resp(400), 404),
    (_Resp(503), 502),
    (httpx.ConnectTimeout("timed out"), 502),
])
def test_storage_download_distinguishes_missing_from_outage(monkeypatch, outcome, status):
    from app.core.config import Settings
    import app.storage.service as storage_service

    monkeypatch.setattr(storage_service, "get_storage_http_client", lambda: _Client(outcome))
    storage = storage_service.SupabaseStorage(Settings(
        supabase_url="https://example.supabase.co", supabase_service_role_key="test-key",
        supabase_storage_bucket="bucket", database_url="sqlite://",
    ))
    if status is None:
        assert storage.download("a/b.png") == (b"img", "image/png")
        return
    with pytest.raises(HTTPException) as caught:
        storage.download("a/b.png")
    assert caught.value.status_code == status


# ---------------------------------------------------------------- browser date helpers

@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for frontend helper tests")
@pytest.mark.parametrize("tz", ["Asia/Kolkata", "UTC", "America/New_York"])
def test_frontend_calendar_helpers_are_timezone_independent(tz):
    script = r"""
const src = require('fs').readFileSync(process.argv[1], 'utf8');
const pick = n => { const m = src.match(new RegExp('function ' + n + '\\([^)]*\\)\\{.*?\\}\\n', 's')); if (!m) throw new Error('missing ' + n); return m[0]; };
eval(pick('s91BusinessDate') + pick('s91DayOf') + pick('addDays') + 'globalThis.h={s91BusinessDate,s91DayOf,addDays};');
const r = {
  plus1: h.addDays('2026-10-17', 1), zero: h.addDays('2026-10-17', 0), monthEnd: h.addDays('2026-10-31', 1),
  back: h.addDays('2026-03-01', -1), leap: h.addDays('2028-02-28', 1),
  earlyIst: h.s91BusinessDate(new Date('2026-10-16T20:00:00Z')), lateIst: h.s91BusinessDate(new Date('2026-10-16T18:29:00Z')),
  serverTs: h.s91DayOf('2026-10-16T20:00:00+00:00'), plain: h.s91DayOf('2026-10-16'),
};
console.log(JSON.stringify(r));
"""
    run = subprocess.run(["node", "-e", script, str(ROOT / "frontend/static/js/00-auth-data-and-imports.js")],
                         capture_output=True, text=True, encoding="utf-8", timeout=20,
                         env={**__import__("os").environ, "TZ": tz})
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout) == {
        "plus1": "2026-10-18", "zero": "2026-10-17", "monthEnd": "2026-11-01", "back": "2026-02-28",
        "leap": "2028-02-29", "earlyIst": "2026-10-17", "lateIst": "2026-10-16",
        "serverTs": "2026-10-17", "plain": "2026-10-16",
    }


def test_frontend_never_syncs_operations_date():
    source = (ROOT / "frontend/static/js/00-auth-data-and-imports.js").read_text(encoding="utf-8")
    server_keys = source.split("const SERVER_STATE_KEYS=[", 1)[1].split("]", 1)[0]
    assert '"opsDate"' not in server_keys
    actions = (ROOT / "frontend/static/js/08-actions-exports-and-submission.js").read_text(encoding="utf-8")
    set_ops = actions.split("function setOpsDate(", 1)[1].split("\n", 1)[0]
    assert "persist()" not in set_ops
