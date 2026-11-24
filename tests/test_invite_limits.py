from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException

from app.core.database import SessionLocal
from app.core.models import InviteImportReceipt, Plant, User
from app.users import invite_limits
from tests.conftest import login_user


def _limits(**overrides):
    values = {
        "invite_direct_per_hour": 20,
        "invite_profile_per_hour": 5,
        "invite_bulk_per_hour": 500,
        "invite_bulk_max_per_import": 500,
        "invite_recipient_per_hour": 3,
        "invite_resend_cooldown_seconds": 600,
        "invite_import_idempotency_hours": 24,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_concurrent_reservations_cannot_exceed_actor_quota(monkeypatch):
    monkeypatch.setattr(invite_limits, "get_settings", lambda: _limits(invite_direct_per_hour=1))
    actor_id = uuid4()
    barrier = Barrier(2)

    def reserve(email):
        with SessionLocal() as session:
            barrier.wait()
            try:
                invite_limits.reserve_invite_quota(session, actor_id, [email], channel="direct")
                return "reserved"
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, ("first@example.com", "second@example.com")))

    assert sorted(results, key=str) == [429, "reserved"]


def test_duplicate_bulk_upload_returns_cached_result_without_resending(client, db, monkeypatch):
    from app.users import invites

    sent = []
    monkeypatch.setattr(invites, "send_invite_email", lambda **kw: (sent.append(kw) or (True, "sent")))
    login_user(client, db, email="head@example.com")
    plant = Plant(site_code="CACHED", plant_name="Cached Plant")
    db.add(plant)
    db.commit()
    csv_data = f"Name,Email,Role,Plants\nNew Person,new@example.com,Assignee,CACHED\n".encode()

    first = client.post("/api/users/import", files={"file": ("team.csv", csv_data, "text/csv")})
    plant.site_code = "RENAMED"
    plant.plant_name = "Renamed Plant"
    db.commit()
    second = client.post("/api/users/import", files={"file": ("team.csv", csv_data, "text/csv")})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    assert len(sent) == 1
    assert db.query(User).filter_by(email="new@example.com").count() == 1
    assert db.query(InviteImportReceipt).filter_by(status="completed").count() == 1


def test_recipient_quota_is_shared_across_actors(db, monkeypatch):
    monkeypatch.setattr(invite_limits, "get_settings", lambda: _limits(invite_recipient_per_hour=2))
    for _ in range(2):
        invite_limits.reserve_invite_quota(db, uuid4(), ["same@example.com"], channel="direct")

    try:
        invite_limits.reserve_invite_quota(db, uuid4(), ["same@example.com"], channel="direct")
    except HTTPException as exc:
        assert exc.status_code == 429
        assert exc.headers["Retry-After"]
    else:
        raise AssertionError("Recipient quota should reject the third invitation.")


def test_bulk_quota_rejects_entire_import_before_writes(client, db, monkeypatch):
    from app.users import invites

    monkeypatch.setattr(
        invite_limits, "get_settings",
        lambda: _limits(invite_bulk_per_hour=1, invite_bulk_max_per_import=500),
    )
    sent = []
    monkeypatch.setattr(invites, "send_invite_email", lambda **kw: (sent.append(kw) or (True, "sent")))
    login_user(client, db, email="head@example.com")
    csv_data = (
        b"Name,Email,Role\n"
        b"First,first@example.com,Viewer\n"
        b"Second,second@example.com,Viewer\n"
    )

    response = client.post("/api/users/import", files={"file": ("team.csv", csv_data, "text/csv")})

    assert response.status_code == 429
    assert response.headers["retry-after"]
    assert db.query(User).filter(User.email.in_(["first@example.com", "second@example.com"])).count() == 0
    assert sent == []
    assert db.query(InviteImportReceipt).count() == 0


def test_per_import_limit_rejects_batch_without_partial_writes(client, db, monkeypatch):
    monkeypatch.setattr(
        invite_limits, "get_settings",
        lambda: _limits(invite_bulk_per_hour=500, invite_bulk_max_per_import=1),
    )
    login_user(client, db, email="head@example.com")
    csv_data = (
        b"Name,Email,Role\n"
        b"First,first@example.com,Viewer\n"
        b"Second,second@example.com,Viewer\n"
    )

    response = client.post("/api/users/import", files={"file": ("team.csv", csv_data, "text/csv")})

    assert response.status_code == 422
    assert db.query(User).filter(User.email.in_(["first@example.com", "second@example.com"])).count() == 0
    assert db.query(InviteImportReceipt).count() == 0


def test_profile_email_quota_rejects_without_changing_second_invite(client, db, monkeypatch):
    from app.users import invites

    monkeypatch.setattr(
        invite_limits, "get_settings",
        lambda: _limits(invite_profile_per_hour=1),
    )
    monkeypatch.setattr(invites, "send_invite_email", lambda **kw: (True, "sent"))
    login_user(client, db, email="head@example.com")
    targets = [
        User(
            auth_provider="clerk",
            external_subject=f"invite:{email}",
            email=email,
            display_name=name,
            role="Viewer",
            is_active=True,
        )
        for email, name in (("first@example.com", "First"), ("second@example.com", "Second"))
    ]
    db.add_all(targets)
    db.commit()
    for target in targets:
        db.refresh(target)

    def change_email(target, email):
        return client.patch(f"/api/users/{target.id}/profile", json={
            "email": email,
            "expected_email": target.email,
            "expected_name": target.display_name,
        })

    first = change_email(targets[0], "first-new@example.com")
    second = change_email(targets[1], "second-new@example.com")

    assert first.status_code == 200, first.text
    assert second.status_code == 429
    db.refresh(targets[1])
    assert targets[1].email == "second@example.com"


def test_resend_cooldown_returns_retry_after(client, db, monkeypatch):
    from app.users import invites

    sent = []
    monkeypatch.setattr(invites, "send_invite_email", lambda **kw: (sent.append(kw) or (True, "sent")))
    login_user(client, db, email="head@example.com")
    created = client.post("/api/users/invite", json={
        "name": "Invitee", "email": "invitee@example.com", "role": "Viewer",
    })
    assert created.status_code == 201, created.text

    first = client.post(f"/api/users/{created.json()['id']}/resend-invite")
    second = client.post(f"/api/users/{created.json()['id']}/resend-invite")

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.headers["retry-after"]
    assert len(sent) == 2
