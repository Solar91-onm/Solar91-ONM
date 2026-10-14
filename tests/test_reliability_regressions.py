from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import OperationalError

from app.core.database import engine
from app.core.models import Equipment, Issue, Plant
from app.issues.repository import IssueRepository
from tests.conftest import TEST_DB, login_user


def test_test_suite_uses_an_isolated_sqlite_database():
    assert engine.dialect.name == "sqlite"
    assert engine.url.database == TEST_DB.as_posix()


def test_issue_for_update_query_compiles_to_postgresql_row_lock():
    class CapturingSession:
        statement = None

        def flush(self):
            pass

        def scalar(self, statement):
            self.statement = statement
            return None

    session = CapturingSession()
    IssueRepository(session).by_id(UUID("00000000-0000-0000-0000-000000000001"), for_update=True)

    assert "FOR UPDATE" in str(session.statement.compile(dialect=postgresql.dialect()))
    assert session.statement.get_execution_options()["populate_existing"] is True


def test_issue_pagination_uses_newest_first_and_rejects_oversized_page(client, db):
    login_user(client, db)
    plant = client.post(
        "/api/plants",
        json={"site_code": "PAGE01", "plant_name": "Pagination Plant"},
    ).json()
    issues = []
    for ticket_no in ("PAGE-1", "PAGE-2", "PAGE-3"):
        response = client.post(
            "/api/issues",
            json={
                "ticket_no": ticket_no,
                "plant_id": plant["id"],
                "description": ticket_no,
                "severity": "Low",
            },
        )
        assert response.status_code == 201, response.text
        issues.append(response.json())

    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for index, payload in enumerate(issues):
        row = db.get(Issue, UUID(payload["id"]))
        row.created_at = base + timedelta(days=index)
    db.commit()

    first = client.get("/api/issues?limit=1&offset=0")
    second = client.get("/api/issues?limit=1&offset=1")
    assert first.status_code == second.status_code == 200
    assert first.json()[0]["ticket_no"] == "PAGE-3"
    assert second.json()[0]["ticket_no"] == "PAGE-2"
    assert client.get("/api/issues?limit=201").status_code == 422


def test_plant_and_equipment_filters_and_pagination(client, db):
    login_user(client, db)
    plants = [
        Plant(site_code=f"REG-{letter}", plant_name=f"Register {letter}")
        for letter in ("A", "B", "C")
    ]
    db.add_all(plants)
    db.flush()
    for index, plant in enumerate(plants):
        db.add(
            Equipment(
                plant_id=plant.id,
                equipment_code=f"INV-{index}",
                equipment_name=f"Inverter {index}",
                equipment_type="Inverter" if index < 2 else "Transformer",
                maker="Maker A" if index != 1 else "Maker B",
            )
        )
    db.commit()

    plant_page = client.get("/api/plants?q=Register&limit=1&offset=1")
    assert plant_page.status_code == 200
    assert [row["site_code"] for row in plant_page.json()] == ["REG-B"]
    assert client.get("/api/plants?limit=201").status_code == 422

    equipment_page = client.get(
        "/api/equipment/page?equipment_type=Inverter&limit=10&offset=1"
    )
    assert equipment_page.status_code == 200
    assert equipment_page.json()["total"] == 2
    assert equipment_page.json()["offset"] == 1
    assert [row["equipment_code"] for row in equipment_page.json()["items"]] == [
        "INV-1"
    ]


def test_duplicate_issue_submission_returns_conflict_without_second_row(client, db):
    login_user(client, db)
    plant = client.post(
        "/api/plants",
        json={"site_code": "DUPISS", "plant_name": "Duplicate Issue Plant"},
    ).json()
    payload = {
        "ticket_no": "DUP-ISSUE-1",
        "plant_id": plant["id"],
        "description": "Submitted twice",
        "severity": "Low",
    }

    first = client.post("/api/issues", json=payload)
    duplicate = client.post("/api/issues", json=payload)

    assert first.status_code == 201, first.text
    assert duplicate.status_code == 409
    assert db.query(Issue).filter_by(ticket_no="DUP-ISSUE-1").count() == 1


def test_issue_list_database_failure_is_generic_and_does_not_leak_driver_detail(
    client, db, monkeypatch
):
    from app.issues.repository import IssueRepository

    login_user(client, db)
    monkeypatch.setattr(
        IssueRepository,
        "list",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OperationalError(
                "SELECT issues",
                {},
                RuntimeError("simulated connection failure"),
            )
        ),
    )

    response = client.get("/api/issues")

    assert response.status_code == 503
    assert response.json() == {
        "error": "database_error",
        "detail": "The database operation could not be completed.",
    }
    assert "simulated connection failure" not in response.text


def test_issue_evidence_upload_failure_rolls_back_metadata_and_cleans_uploaded_objects(
    client, db, monkeypatch
):
    import app.issues.router as issue_router

    login_user(client, db)
    plant = client.post(
        "/api/plants",
        json={"site_code": "EVID01", "plant_name": "Evidence Plant"},
    ).json()
    created = client.post(
        "/api/issues",
        json={
            "plant_id": plant["id"],
            "description": "Evidence upload rollback",
            "severity": "Low",
        },
    )
    assert created.status_code == 201, created.text

    class FailingStorage:
        def __init__(self):
            self.uploads: list[str] = []
            self.removed: list[str] = []
            self.upload_number = 0

        def upload(self, path, _data, _content_type):
            self.upload_number += 1
            if self.upload_number == 2:
                raise HTTPException(502, "Simulated storage outage")
            self.uploads.append(path)

        def remove(self, paths):
            self.removed.extend(paths)

    storage = FailingStorage()
    monkeypatch.setattr(issue_router, "SupabaseStorage", lambda: storage)
    image = bytes(range(32, 80))
    response = client.post(
        f"/api/issues/{created.json()['id']}/evidence",
        files=[
            ("files", ("first.jpg", image, "image/jpeg")),
            ("files", ("second.jpg", image, "image/jpeg")),
        ],
    )

    assert response.status_code == 502
    assert len(storage.uploads) == 1
    assert storage.removed == storage.uploads
    db.expire_all()
    issue = db.get(Issue, UUID(created.json()["id"]))
    assert issue.photo_count == 0
    assert not (issue.legacy_payload or {}).get("evidence")


def test_issue_evidence_download_remains_private_and_scope_checked(
    client, db, monkeypatch
):
    import app.issues.router as issue_router

    login_user(client, db)
    plant = Plant(site_code="PRIV01", plant_name="Private Evidence Plant")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    issue = Issue(
        ticket_no="PRIVATE-EVIDENCE-1",
        plant_id=plant.id,
        description="Private evidence test",
        severity="Low",
        legacy_payload={
            "evidence": [
                {
                    "id": "PRIVATE-PHOTO-1",
                    "storage_path": "issues/private/photo.jpg",
                }
            ]
        },
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)

    class ReadOnlyStorage:
        def __init__(self):
            self.downloads: list[str] = []

        def download(self, path):
            self.downloads.append(path)
            return b"private image bytes", "image/jpeg"

    storage = ReadOnlyStorage()
    monkeypatch.setattr(issue_router, "SupabaseStorage", lambda: storage)
    issue_url = f"/api/issues/{issue.id}/evidence/PRIVATE-PHOTO-1"

    allowed = client.get(issue_url)
    assert allowed.status_code == 200
    assert allowed.content == b"private image bytes"
    assert allowed.headers["cache-control"] == "private, max-age=60"
    assert storage.downloads == ["issues/private/photo.jpg"]

    login_user(
        client,
        db,
        role="Site Engineer",
        name="Unassigned Engineer",
        email="unassigned-engineer@example.com",
    )
    denied = client.get(issue_url)
    assert denied.status_code == 403
    assert len(storage.downloads) == 1
