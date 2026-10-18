from __future__ import annotations

from io import BytesIO
from uuid import UUID

import pytest
from openpyxl import Workbook

from app.core.models import Plant
from app.plants.codes import normalize_site_code
from tests.conftest import login_user


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("abh_01", "ABH01"),
        ("KRN_01", "KRN01"),
        ("KH0_01", "KH001"),
        ("KHO01", "KH001"),
        ("KHO02", "KHO02"),
        ("KH002", "KH002"),
        ("ABO01", "ABO01"),
        ("AB001", "AB001"),
    ],
)
def test_normalize_site_code(value, expected):
    assert normalize_site_code(value) == expected


def test_plant_model_stores_canonical_code():
    assert Plant(site_code="  abH-01  ", plant_name="ABH").site_code == "ABH01"


@pytest.mark.parametrize(("first", "second", "canonical"), [
    ("ABH_01", "ABH01", "ABH01"),
    ("KRN_01", "KRN01", "KRN01"),
    ("KH0_01", "KHO01", "KH001"),
])
def test_api_rejects_formatted_duplicate_and_preserves_existing_plant(
    client, db, first, second, canonical
):
    login_user(client, db)
    created = client.post(
        "/api/plants",
        json={"site_code": first, "plant_name": "Canonical Plant"},
    )
    assert created.status_code == 201, created.text
    plant_id = UUID(created.json()["id"])

    duplicate = client.post(
        "/api/plants",
        json={"site_code": second, "plant_name": "Duplicate Plant"},
    )
    assert duplicate.status_code == 409

    db.expire_all()
    plants = db.query(Plant).all()
    assert len(plants) == 1
    assert plants[0].id == plant_id
    assert plants[0].site_code == canonical


def test_excel_import_matches_existing_and_detects_formatted_duplicates(client, db):
    login_user(client, db)
    existing = Plant(site_code="ABH01", plant_name="ABH Plant")
    db.add(existing)
    db.commit()
    existing_id = existing.id

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Site Code", "Plant Name"])
    sheet.append(["ABH_01", "Updated ABH Plant"])
    sheet.append(["KRN_01", "Kerli Nadi"])
    sheet.append(["KRN01", "Duplicate Kerli Nadi"])
    stream = BytesIO()
    workbook.save(stream)

    response = client.post(
        "/api/imports/plants",
        files={
            "file": (
                "plants.xlsx",
                stream.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["created"] == 1
    assert result["updated"] == 1
    assert result["invalid_rows"] == [
        {"row": 4, "site_code": "KRN01", "error": "Duplicate Site Code in workbook"}
    ]

    db.expire_all()
    assert db.query(Plant).count() == 2
    updated = db.query(Plant).filter(Plant.site_code == "ABH01").one()
    assert updated.id == existing_id
    assert updated.plant_name == "Updated ABH Plant"
    assert db.query(Plant).filter(Plant.site_code == "KRN01").one()
