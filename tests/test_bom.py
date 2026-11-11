"""BOM: per-plant parts inventory (Views > Details > BOM and each plant's Details > BOM)."""
from __future__ import annotations

from app.core.models import AuditLog, BomItem
from tests.conftest import login_user


def _plants(client, codes=("BM01", "BM02")):
    for code in codes:
        created = client.post("/api/plants", json={"site_code": code, "plant_name": "Bom " + code})
        assert created.status_code == 201, created.text


def _head(client, db):
    login_user(client, db, role="O&M Head", name="BOM Head", email="bom-head@example.com")


def _line(site="BM01", **over):
    body = {"site_code": site, "item_name": "Inverter 100 kW", "maker_supplier": "Sungrow", "quantity": 2,
            "specs": "String inverter, 3-phase, 1100 V DC max", "test_report": "TR-11",
            "warranty_cert": "WC-5", "serial_no": "SN-001", "invoice": "INV-9"}
    body.update(over)
    return body


def test_add_line_persists_every_column_and_is_audited(client, db):
    _head(client, db)
    _plants(client)
    created = client.post("/api/bom", json=_line())
    assert created.status_code == 201, created.text
    item = created.json()
    assert (item["itemName"], item["makerSupplier"], item["quantity"], item["version"]) == ("Inverter 100 kW", "Sungrow", 2, 1)
    got = client.get("/api/bom?site_code=BM01").json()
    assert got["total"] == 1 and got["items"][0]["specs"].startswith("String inverter")
    assert got["items"][0]["testReport"] == "TR-11" and got["items"][0]["invoice"] == "INV-9"
    assert db.query(AuditLog).filter(AuditLog.module == "BOM").count() == 1


def test_item_name_is_required_and_bad_values_are_rejected(client, db):
    _head(client, db)
    _plants(client)
    assert client.post("/api/bom", json=_line(item_name="  ")).status_code == 422
    assert client.post("/api/bom", json=_line(quantity=-1)).status_code == 422
    assert client.post("/api/bom", json=_line(maker_supplier="x" * 161)).status_code == 422
    assert client.post("/api/bom", json=_line(site="NOPE")).status_code in (403, 404)
    assert db.query(BomItem).count() == 0


def test_portfolio_filters_by_plant_maker_and_search(client, db):
    _head(client, db)
    _plants(client)
    client.post("/api/bom", json=_line("BM01"))
    client.post("/api/bom", json=_line("BM01", item_name="Cable 4 sqmm", maker_supplier="Polycab", serial_no="C-7"))
    client.post("/api/bom", json=_line("BM02", item_name="Module 550 Wp", maker_supplier="Adani"))
    everything = client.get("/api/bom").json()
    assert everything["total"] == 3
    assert everything["makers"] == ["Adani", "Polycab", "Sungrow"]
    assert client.get("/api/bom?site_code=BM02").json()["total"] == 1
    assert client.get("/api/bom?maker=polycab").json()["total"] == 1
    assert client.get("/api/bom?q=c-7").json()["items"][0]["itemName"] == "Cable 4 sqmm"
    assert client.get("/api/bom?q=100%25").json()["total"] == 0, "% is literal, not a wildcard"
    page = client.get("/api/bom?limit=2").json()
    assert len(page["items"]) == 2 and page["total"] == 3
    assert len(client.get("/api/bom?limit=2&offset=2").json()["items"]) == 1


def test_update_bumps_version_and_a_stale_save_is_refused(client, db):
    _head(client, db)
    _plants(client)
    item = client.post("/api/bom", json=_line()).json()
    edit = {k: v for k, v in _line().items() if k != "site_code"}
    edit.update(quantity=5, version=item["version"])
    saved = client.put("/api/bom/" + item["id"], json=edit)
    assert saved.status_code == 200 and saved.json()["quantity"] == 5 and saved.json()["version"] == 2
    stale = client.put("/api/bom/" + item["id"], json=dict(edit, quantity=9))
    assert stale.status_code == 409
    assert client.get("/api/bom?site_code=BM01").json()["items"][0]["quantity"] == 5


def test_delete_needs_the_current_version(client, db):
    _head(client, db)
    _plants(client)
    item = client.post("/api/bom", json=_line()).json()
    assert client.delete(f"/api/bom/{item['id']}?version=7").status_code == 409
    assert client.delete(f"/api/bom/{item['id']}?version=1").status_code == 200
    assert client.delete(f"/api/bom/{item['id']}?version=1").status_code == 404
    assert client.delete("/api/bom/not-a-uuid?version=1").status_code == 404
    assert db.query(BomItem).count() == 0


def test_viewer_can_read_but_not_write(client, db):
    _head(client, db)
    _plants(client)
    item = client.post("/api/bom", json=_line()).json()
    login_user(client, db, role="Viewer", name="BOM Viewer", email="bom-viewer@example.com")
    assert client.get("/api/bom").status_code == 200
    assert client.post("/api/bom", json=_line()).status_code == 403
    assert client.put("/api/bom/" + item["id"], json={"item_name": "x", "version": 1}).status_code == 403
    assert client.delete(f"/api/bom/{item['id']}?version=1").status_code == 403


def test_invoice_link_is_stored_and_only_web_addresses_are_accepted(client, db):
    _head(client, db)
    _plants(client)
    ok = client.post("/api/bom", json=_line(invoice_url="  https://files.example.com/inv/9.pdf?x=1 "))
    assert ok.status_code == 201, ok.text
    assert ok.json()["invoiceUrl"] == "https://files.example.com/inv/9.pdf?x=1"
    assert client.get("/api/bom?site_code=BM01").json()["items"][0]["invoiceUrl"] == "https://files.example.com/inv/9.pdf?x=1"
    for bad in ("javascript:alert(1)", "data:text/html,x", "ftp://host/file", "example.com/inv", "https://", "https://a b.com"):
        assert client.post("/api/bom", json=_line(invoice_url=bad)).status_code == 422, bad
    assert db.query(BomItem).count() == 1
    # clearing the link on edit
    item = ok.json()
    edit = {k: v for k, v in _line().items() if k != "site_code"}
    edit.update(version=item["version"], invoice_url="")
    cleared = client.put("/api/bom/" + item["id"], json=edit)
    assert cleared.status_code == 200 and cleared.json()["invoiceUrl"] is None
