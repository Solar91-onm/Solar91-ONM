from __future__ import annotations

import uuid

from sqlalchemy import event

from app.core.timeutil import business_today
from app.core.database import engine
from app.core.models import Equipment, Plant, User, UserEquipmentTypeAssignment
from app.plants.router import (
    _document_content_disposition,
    _safe_document_filename,
)
from tests.conftest import login_user


def test_equipment_document_filename_is_safe_for_storage_and_response_headers():
    filename = _safe_document_filename(
        "..\\private\\bad\r\nSet-Cookie: x.pdf"
    )
    disposition = _document_content_disposition(filename)

    assert filename == "badSet-Cookie: x.pdf"
    assert "\r" not in disposition and "\n" not in disposition
    assert 'filename="badSet-Cookie_ x.pdf"' in disposition
    assert "filename*=UTF-8''badSet-Cookie%3A%20x.pdf" in disposition


def test_equipment_can_be_added_edited_moved_between_plants_and_removed(client, db):
    login_user(
        client,
        db,
        role="O&M Head",
        name="Head",
        email="head@example.com",
    )

    a = client.post(
        "/api/plants",
        json={"site_code": "RA01", "plant_name": "Register A"},
    ).json()

    b = client.post(
        "/api/plants",
        json={"site_code": "RB01", "plant_name": "Register B"},
    ).json()

    created = client.post(
        "/api/equipment",
        json={
            "plant_id": a["id"],
            "equipment_code": "INV-01",
            "equipment_name": "Inverter 1",
            "equipment_type": "Inverter",
            "maker": "Sungrow",
            "model": "SG110CX",
            "serial_number": "S-1",
        },
    )

    assert created.status_code == 201, created.text

    eid = created.json()["id"]

    assert created.json()["maker"] == "Sungrow"

    edited = client.patch(
        f"/api/equipment/{eid}",
        json={"maker": "Huawei", "status": "maintenance"},
    )

    assert (
        edited.status_code == 200
        and edited.json()["maker"] == "Huawei"
        and edited.json()["status"] == "maintenance"
    )

    moved = client.patch(
        f"/api/equipment/{eid}",
        json={"plant_id": b["id"]},
    )

    assert moved.status_code == 200
    assert moved.json()["plant_id"] == b["id"]

    db.expire_all()

    assert str(db.get(Equipment, uuid.UUID(eid)).plant_id) == b["id"]

    assert (
        client.patch(
            f"/api/equipment/{eid}",
            json={"plant_id": str(uuid.uuid4())},
        ).status_code
        == 404
    )

    client.post(
        "/api/equipment",
        json={
            "plant_id": a["id"],
            "equipment_code": "INV-01",
            "equipment_name": "Another",
            "equipment_type": "Inverter",
            "maker": "ABB",
        },
    )

    clash = client.patch(
        f"/api/equipment/{eid}",
        json={"plant_id": a["id"]},
    )

    assert clash.status_code == 409

    assert client.delete(f"/api/equipment/{eid}").status_code == 204

    assert client.get(
        f"/api/equipment?plant_id={b['id']}"
    ).json() == []


def test_equipment_v2_fields_default_discom_and_audit(client, db):
    from app.core.models import AuditLog

    login_user(
        client,
        db,
        role="O&M Head",
        name="Head V2",
        email="headv2@example.com",
    )

    plant = client.post(
        "/api/plants",
        json={
            "site_code": "V201",
            "plant_name": "V2 Plant",
            "discom": "JVVNL",
        },
    ).json()

    r = client.post(
        "/api/equipment",
        json={
            "plant_id": plant["id"],
            "equipment_code": "TR-01",
            "equipment_name": "Transformer 1",
            "equipment_type": "Transformer",
            "rating": "2.5 MVA",
            "capacity_kw": 2500,
            "quantity": 1,
            "criticality": "High",
            "warranty_end": "2027-03-01",
            "next_service_due": "2026-11-15",
        },
    )

    assert r.status_code == 201, r.text

    body = r.json()

    assert body["discom"] == "JVVNL"
    assert body["rating"] == "2.5 MVA"
    assert body["criticality"] == "High"

    assert db.query(AuditLog).filter(
        AuditLog.entity_id == body["id"],
        AuditLog.action == "Created equipment",
    ).one()


def test_equipment_bulk_is_atomic_on_duplicate(client, db):
    login_user(
        client,
        db,
        role="O&M Head",
        name="Bulk Head",
        email="bulk@example.com",
    )

    plant = client.post(
        "/api/plants",
        json={
            "site_code": "BLK1",
            "plant_name": "Bulk Plant",
        },
    ).json()

    client.post(
        "/api/equipment",
        json={
            "plant_id": plant["id"],
            "equipment_code": "INV-01",
            "equipment_name": "Existing",
        },
    )

    r = client.post(
        "/api/equipment/bulk",
        json={
            "items": [
                {
                    "plant_id": plant["id"],
                    "equipment_code": "INV-02",
                    "equipment_name": "New 2",
                },
                {
                    "plant_id": plant["id"],
                    "equipment_code": "INV-01",
                    "equipment_name": "Clash",
                },
            ]
        },
    )

    assert r.status_code == 409

    rows = client.get(
        f'/api/equipment?plant_id={plant["id"]}&limit=100'
    ).json()

    assert [x["equipment_code"] for x in rows] == ["INV-01"]


def test_equipment_register_scope_for_read_only_roles(client, db):
    from app.core.models import (
        Equipment,
        Plant,
        UserEquipmentTypeAssignment,
        UserPlantAssignment,
    )

    p1 = Plant(
        site_code="SC01",
        plant_name="Scope One",
    )

    p2 = Plant(
        site_code="SC02",
        plant_name="Scope Two",
    )

    db.add_all([p1, p2])
    db.commit()

    db.refresh(p1)
    db.refresh(p2)

    db.add_all(
        [
            Equipment(
                plant_id=p1.id,
                equipment_code="INV-A",
                equipment_name="Inv A",
                equipment_type="Inverter",
            ),
            Equipment(
                plant_id=p1.id,
                equipment_code="TR-A",
                equipment_name="Tr A",
                equipment_type="Transformer",
            ),
            Equipment(
                plant_id=p2.id,
                equipment_code="INV-B",
                equipment_name="Inv B",
                equipment_type="Inverter",
            ),
        ]
    )

    db.commit()

    login_user(
        client,
        db,
        role="Administration",
        name="Admin Read",
        email="adminread@example.com",
    )

    assert len(
        client.get("/api/equipment?limit=100").json()
    ) == 3

    assert (
        client.post(
            "/api/equipment",
            json={
                "plant_id": str(p1.id),
                "equipment_name": "No",
            },
        ).status_code
        == 403
    )

    assignee = login_user(
        client,
        db,
        role="Assignee",
        name="Inv Owner",
        email="invowner@example.com",
    )

    db.add(
        UserEquipmentTypeAssignment(
            user_id=assignee.id,
            equipment_type="Inverter",
        )
    )

    db.commit()

    rows = client.get("/api/equipment?limit=100").json()

    assert {x["equipment_code"] for x in rows} == {
        "INV-A",
        "INV-B",
    }

    engineer = login_user(
        client,
        db,
        role="Site Engineer",
        name="Site Eng",
        email="siteeng@example.com",
    )

    db.add(
        UserPlantAssignment(
            user_id=engineer.id,
            plant_id=p1.id,
            assignment_role="Site Engineer",
        )
    )

    db.commit()

    rows = client.get("/api/equipment?limit=100").json()

    assert {x["equipment_code"] for x in rows} == {
        "INV-A",
        "TR-A",
    }

    assert (
        client.patch(
            f'/api/equipment/{rows[0]["id"]}',
            json={"maker": "Nope"},
        ).status_code
        == 403
    )


def test_equipment_warranty_filter_and_move_audit(client, db):
    from datetime import date, timedelta

    from app.core.models import AuditLog

    login_user(
        client,
        db,
        role="O&M Head",
        name="Mover",
        email="mover@example.com",
    )

    a = client.post(
        "/api/plants",
        json={
            "site_code": "MV1",
            "plant_name": "Move A",
        },
    ).json()

    b = client.post(
        "/api/plants",
        json={
            "site_code": "MV2",
            "plant_name": "Move B",
        },
    ).json()

    exp = (
        business_today() + timedelta(days=30)
    ).isoformat()

    eq = client.post(
        "/api/equipment",
        json={
            "plant_id": a["id"],
            "equipment_code": "CB-1",
            "equipment_name": "Combiner",
            "warranty_end": exp,
        },
    ).json()

    page = client.get(
        "/api/equipment/page?warranty=expiring&limit=10"
    ).json()

    assert page["total"] == 1
    assert page["items"][0]["id"] == eq["id"]

    moved = client.post(
        f'/api/equipment/{eq["id"]}/move',
        json={"plant_id": b["id"]},
    )

    assert moved.status_code == 200
    assert moved.json()["plant_id"] == b["id"]

    assert db.query(AuditLog).filter(
        AuditLog.entity_id == eq["id"],
        AuditLog.action == "Moved equipment to another plant",
    ).one()


def test_equipment_page_batches_owner_lookups(client, db):
    login_user(
        client,
        db,
        role="O&M Head",
        name="Equipment Page Head",
        email="equipment-page-head@example.com",
    )
    plant = Plant(site_code="BATCH1", plant_name="Batch Plant")
    owner = User(
        auth_provider="supabase",
        external_subject="equipment-page-owner",
        email="equipment-page-owner@example.com",
        display_name="Inverter Owner",
        role="Assignee",
        is_active=True,
    )
    db.add_all([plant, owner])
    db.flush()
    db.add(UserEquipmentTypeAssignment(user_id=owner.id, equipment_type="Inverter"))
    db.add_all(
        [
            Equipment(
                plant_id=plant.id,
                equipment_code=f"INV-{number}",
                equipment_name=f"Inverter {number}",
                equipment_type="Inverter",
                in_charge_user_id=owner.id if number == 1 else None,
            )
            for number in range(1, 4)
        ]
    )
    db.commit()

    statements = []

    def count_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().lower().startswith("select"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", count_statement)
    try:
        response = client.get("/api/equipment/page?plant_id={}&limit=10".format(plant.id))
    finally:
        event.remove(engine, "before_cursor_execute", count_statement)

    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 3
    first = next(item for item in page["items"] if item["equipment_code"] == "INV-1")
    assert first["in_charge_name"] == "Inverter Owner"
    assert first["type_owners"] == ["Inverter Owner"]
    assert len(statements) == 4


def test_equipment_import_dry_run(client, db):
    import io

    from openpyxl import Workbook

    login_user(
        client,
        db,
        role="O&M Head",
        name="Importer",
        email="importer@example.com",
    )

    client.post(
        "/api/plants",
        json={
            "site_code": "IMP1",
            "plant_name": "Import Plant",
            "discom": "AVVNL",
        },
    )

    wb = Workbook()
    ws = wb.active

    ws.append(
        [
            "plant",
            "equipment_code",
            "equipment_name",
            "equipment_type",
            "maker",
            "warranty_end",
        ]
    )

    ws.append(
        [
            "IMP1",
            "INV-77",
            "Inverter 77",
            "Inverter",
            "Huawei",
            "2028-01-01",
        ]
    )

    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)

    r = client.post(
        "/api/equipment/import",
        data={"dry_run": "true"},
        files={
            "file": (
                "equipment.xlsx",
                bio.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )

    assert r.status_code == 200, r.text

    assert r.json()["dry_run"] is True
    assert r.json()["valid"] == 1

    assert client.get(
        "/api/equipment?limit=100"
    ).json() == []