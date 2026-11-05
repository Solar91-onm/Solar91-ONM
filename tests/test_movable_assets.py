"""Movable Assets: units of each named part per plant (Views tab and each plant's tab)."""
from __future__ import annotations

from pathlib import Path

from app.core.models import MovableAsset
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]


def _plants(client, codes=("MA01", "MA02")):
    for code in codes:
        created = client.post("/api/plants", json={"site_code": code, "plant_name": "Movable " + code})
        assert created.status_code == 201, created.text


def _head(client, db):
    login_user(client, db, role="O&M Head", name="MA Head", email="ma-head@example.com")


def test_add_part_creates_a_zero_row_for_every_plant(client, db):
    _head(client, db)
    _plants(client)
    response = client.post("/api/movable-assets/parts", json={"part": "  Ladder "})
    assert response.status_code == 201, response.text
    assert response.json() == {"part": "Ladder", "plantsAdded": 2}
    body = client.get("/api/movable-assets").json()
    assert body["parts"] == ["Ladder"]
    assert sorted((r["siteCode"], r["units"]) for r in body["records"]) == [("MA01", 0), ("MA02", 0)]


def test_setting_units_updates_one_cell_and_reuses_the_existing_spelling(client, db):
    _head(client, db)
    _plants(client)
    client.post("/api/movable-assets/parts", json={"part": "Ladder"})
    saved = client.put("/api/movable-assets", json={"site_code": "MA01", "part": "ladder", "units": 4})
    assert saved.status_code == 200, saved.text
    assert saved.json()["part"] == "Ladder", "a different case must not create a second column"
    assert db.query(MovableAsset).count() == 2
    one = client.get("/api/movable-assets?site_code=MA01").json()
    assert one["records"] == [{"siteCode": "MA01", "part": "Ladder", "units": 4}]


def test_units_must_be_a_non_negative_whole_number(client, db):
    _head(client, db)
    _plants(client)
    assert client.put("/api/movable-assets", json={"site_code": "MA01", "part": "Ladder", "units": -1}).status_code == 422
    assert client.put("/api/movable-assets", json={"site_code": "MA01", "part": "  ", "units": 1}).status_code == 422


def test_removing_a_part_deletes_its_rows(client, db):
    _head(client, db)
    _plants(client)
    client.post("/api/movable-assets/parts", json={"part": "Ladder"})
    removed = client.delete("/api/movable-assets/parts?part=Ladder")
    assert removed.status_code == 200 and removed.json()["removed"] == 2
    assert client.get("/api/movable-assets").json() == {"parts": [], "records": []}


def test_a_role_without_plants_manage_can_read_but_not_write(client, db):
    _head(client, db)
    _plants(client)
    client.post("/api/movable-assets/parts", json={"part": "Ladder"})
    login_user(client, db, role="Viewer", name="MA Viewer", email="ma-viewer@example.com")
    assert client.put("/api/movable-assets", json={"site_code": "MA01", "part": "Ladder", "units": 9}).status_code == 403
    assert client.post("/api/movable-assets/parts", json={"part": "Drill"}).status_code == 403
    assert client.delete("/api/movable-assets/parts?part=Ladder").status_code == 403


def test_the_page_is_wired_into_views_and_every_plant():
    page = (ROOT / "frontend" / "templates" / "index.html").read_text(encoding="utf-8")
    nav = (ROOT / "assets" / "js" / "navigation.js").read_text(encoding="utf-8")
    assert 'data-nav="view:movable-assets"' in page
    assert "data-movable-assets-host" in page
    assert "/assets/js/movable-assets.js" in page
    assert "Solar91PortalMovableAssets.show" in nav and "siteCode: plantCode" in nav
