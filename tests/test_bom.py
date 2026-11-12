"""BOM: per-plant BOQ / parts inventory (Views > Details > BOM and each plant's Details > BOM)."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import Integer, Numeric, String, Text

from app.core.models import AuditLog, BomItem
from tests.conftest import login_user

MIGRATIONS = Path(__file__).resolve().parents[1] / "database" / "migrations"


def _plants(client, codes=("BM01", "BM02")):
    for code in codes:
        created = client.post("/api/plants", json={"site_code": code, "plant_name": "Bom " + code})
        assert created.status_code == 201, created.text


def _head(client, db):
    login_user(client, db, role="O&M Head", name="BOM Head", email="bom-head@example.com")


def _line(site="BM01", **over):
    body = {"site_code": site, "item_name": "Inverter 100 kW", "maker": "Sungrow", "quantity": 2,
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
    assert (item["itemName"], item["maker"], item["quantity"], item["version"]) == ("Inverter 100 kW", "Sungrow", 2, 1)
    got = client.get("/api/bom?site_code=BM01").json()
    assert got["total"] == 1 and got["items"][0]["specs"].startswith("String inverter")
    assert got["items"][0]["testReport"] == "TR-11" and got["items"][0]["invoice"] == "INV-9"
    assert db.query(AuditLog).filter(AuditLog.module == "BOM").count() == 1


def test_item_name_is_required_and_bad_values_are_rejected(client, db):
    _head(client, db)
    _plants(client)
    assert client.post("/api/bom", json=_line(item_name="  ")).status_code == 422
    assert client.post("/api/bom", json=_line(quantity=-1)).status_code == 422
    assert client.post("/api/bom", json=_line(maker="x" * 161)).status_code == 422
    assert client.post("/api/bom", json=_line(supplier="x" * 161)).status_code == 422
    assert client.post("/api/bom", json=_line(site="NOPE")).status_code in (403, 404)
    assert db.query(BomItem).count() == 0


def test_portfolio_filters_by_plant_maker_and_search(client, db):
    _head(client, db)
    _plants(client)
    client.post("/api/bom", json=_line("BM01"))
    client.post("/api/bom", json=_line("BM01", item_name="Cable 4 sqmm", maker="Polycab", serial_no="C-7"))
    client.post("/api/bom", json=_line("BM02", item_name="Module 550 Wp", maker="Adani"))
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


# --- BOQ fields (migration 040): decimal quantity, unit, section, line order ----------------

def test_boq_line_round_trips_decimal_quantity_unit_section_and_sort_order(client, db):
    _head(client, db)
    _plants(client)
    created = client.post("/api/bom", json=_line(
        item_name="Solar PV Modules", quantity="5368.23", unit="kWp", section="PV Section", sort_order=1))
    assert created.status_code == 201, created.text
    item = created.json()
    # A JSON number, not a string, and not truncated to an integer.
    assert item["quantity"] == 5368.23 and isinstance(item["quantity"], float)
    assert (item["unit"], item["section"], item["sortOrder"]) == ("kWp", "PV Section", 1)
    read = client.get("/api/bom?site_code=BM01").json()["items"][0]
    assert read["quantity"] == 5368.23 and read["unit"] == "kWp"
    assert '"quantity":5368.23' in client.get("/api/bom?site_code=BM01").text
    # A whole quantity stays whole: 12, never 12.000.
    whole = client.post("/api/bom", json=_line(item_name="Inverter", quantity=12, unit="Nos.")).json()
    assert whole["quantity"] == 12 and str(whole["quantity"]) in ("12", "12.0")
    # Three decimals are kept, a fourth is refused.
    assert client.post("/api/bom", json=_line(quantity="7180.800")).json()["quantity"] == 7180.8
    assert client.post("/api/bom", json=_line(quantity="1.2345")).status_code == 422
    assert client.post("/api/bom", json=_line(sort_order=-1)).status_code == 422
    assert client.post("/api/bom", json=_line(unit="u" * 25)).status_code == 422
    assert client.post("/api/bom", json=_line(section="s" * 161)).status_code == 422


def test_boq_lines_come_back_in_section_and_line_order_with_a_section_filter(client, db):
    _head(client, db)
    _plants(client)
    for name, section, order in [
        ("Earthing Strip", "PROTECTION", 2), ("LA", "PROTECTION", 1),
        ("Module", "PV Section", 2), ("Structure", "PV Section", 1),
        ("Spare bolt", None, None),
    ]:
        assert client.post("/api/bom", json=_line(item_name=name, section=section, sort_order=order)).status_code == 201
    got = client.get("/api/bom?site_code=BM01").json()
    # Section, then the sheet's line order; lines with neither sort last.
    assert [i["itemName"] for i in got["items"]] == ["LA", "Earthing Strip", "Structure", "Module", "Spare bolt"]
    assert got["sections"] == ["PROTECTION", "PV Section"]
    only = client.get("/api/bom?site_code=BM01&section=pv%20section").json()
    assert only["total"] == 2 and [i["itemName"] for i in only["items"]] == ["Structure", "Module"]
    # The section list is built before the filters, so choosing one never empties the other list.
    assert only["sections"] == ["PROTECTION", "PV Section"]
    assert client.get("/api/bom?site_code=BM01&section=nothing").json()["total"] == 0


def test_sub_variant_lines_sharing_an_item_name_are_never_collapsed(client, db):
    _head(client, db)
    _plants(client)
    for order, spec in [(10, "11 kV, 3C x 95 sqmm"), (11, "11 kV, 3C x 185 sqmm"), (12, "11 kV, 3C x 300 sqmm")]:
        client.post("/api/bom", json=_line(item_name="JOINTING KIT", section="HT Section", sort_order=order,
                                           specs=spec, maker=None, quantity=None))
    got = client.get("/api/bom?site_code=BM01").json()
    assert got["total"] == 3
    assert [i["specs"] for i in got["items"]] == ["11 kV, 3C x 95 sqmm", "11 kV, 3C x 185 sqmm", "11 kV, 3C x 300 sqmm"]
    assert [i["sortOrder"] for i in got["items"]] == [10, 11, 12]
    # No maker, no unit and no quantity is a legitimate BOQ line, not an error.
    assert {i["maker"] for i in got["items"]} == {None}
    assert {i["unit"] for i in got["items"]} == {None}
    assert {i["quantity"] for i in got["items"]} == {None}
    assert got["makers"] == []


def test_editing_a_decimal_quantity_bumps_the_version_and_is_audited(client, db):
    _head(client, db)
    _plants(client)
    item = client.post("/api/bom", json=_line(quantity="100.5", unit="Mtrs", section="AC side", sort_order=4)).json()
    edit = {k: v for k, v in _line().items() if k != "site_code"}
    edit.update(quantity="7180.8", unit="Meter", section="AC side - Cables", sort_order=5, version=item["version"])
    saved = client.put("/api/bom/" + item["id"], json=edit)
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert (body["quantity"], body["unit"], body["section"], body["sortOrder"], body["version"]) == \
        (7180.8, "Meter", "AC side - Cables", 5, 2)
    # The audit entry stores the change as JSON: a Decimal quantity would not serialise.
    entry = db.query(AuditLog).filter(AuditLog.action == "Updated BOM item").one()
    assert entry.metadata_json["changes"]["quantity"] == {"from": 100.5, "to": 7180.8}
    assert entry.metadata_json["changes"]["unit"] == {"from": "Mtrs", "to": "Meter"}


def test_a_long_boq_item_name_is_accepted(client, db):
    _head(client, db)
    _plants(client)
    long_name = "DC Cable 1C x 4 sqmm, XLPE insulated, UV resistant, electron beam cross linked, " + "x" * 220
    assert len(long_name) > 200
    created = client.post("/api/bom", json=_line(item_name=long_name))
    assert created.status_code == 201, created.text
    assert created.json()["itemName"] == long_name
    assert client.post("/api/bom", json=_line(item_name="y" * 401)).status_code == 422


# --- Migration 040 (applied by hand in Supabase; checked here for shape) --------------------

def test_migration_040_is_additive_rerunnable_and_matches_the_model():
    text = (MIGRATIONS / "040_bom_boq_fields.sql").read_text(encoding="utf-8").lower()
    # Statements only: the explanatory header comment is not what is being checked.
    sql = " ".join(line.strip() for line in text.splitlines() if not line.lstrip().startswith("--"))
    # Nothing is dropped, emptied or rewritten away: existing bom_items rows survive it.
    for destructive in ("drop table", "drop column", "drop constraint", "delete from", "truncate", "drop index"):
        assert destructive not in sql, destructive
    assert sql.count("begin;") == 1 and sql.count("commit;") == 1
    # Widening keeps the stored values (integer -> numeric, varchar -> text) and is guarded, so re-running is safe.
    assert "alter column quantity type numeric(14,3) using quantity::numeric(14,3)" in sql
    assert "alter column item_name type text" in sql
    assert sql.count("and data_type <> 'numeric'") == 1 and sql.count("and data_type <> 'text'") == 1
    for column in ("unit       varchar(24)", "section    varchar(160)", "sort_order integer"):
        assert f"add column if not exists {column}" in sql
    assert "create index if not exists ix_bom_items_plant_section_order" in sql
    assert "on bom_items (plant_id, section, sort_order)" in sql
    assert "enable row level security" in sql and "from anon" in sql and "from authenticated" in sql
    # Nothing else claims the number 040.
    assert len([p for p in MIGRATIONS.glob("040*.sql")]) == 1

    columns = BomItem.__table__.c
    assert isinstance(columns.quantity.type, Numeric) and (columns.quantity.type.precision, columns.quantity.type.scale) == (14, 3)
    assert isinstance(columns.item_name.type, Text)
    assert isinstance(columns.unit.type, String) and columns.unit.type.length == 24
    assert isinstance(columns.section.type, String) and columns.section.type.length == 160
    assert isinstance(columns.sort_order.type, Integer)


# --- Maker/Supplier split and section order (migration 041) --------------------------------

def _boq(client, site="BM01"):
    """ABH01's shape in miniature: three sections whose BOQ order is NOT their alphabetical order."""
    for section, order, name in [
        ("PV Section", 1, "Solar PV Modules"),
        ("PV Section", 2, "DC Cable"),
        ("WMS", 3, "Weather Station"),
        ("14x2 MMS Hardware Quantity", 4, "HT Bolt M12"),
    ]:
        created = client.post("/api/bom", json=_line(site, item_name=name, section=section, sort_order=order))
        assert created.status_code == 201, created.text


def test_maker_and_supplier_are_separate_stored_filterable_fields(client, db):
    _head(client, db)
    _plants(client)
    created = client.post("/api/bom", json=_line(maker="Sungrow", supplier="Shakti Traders"))
    assert created.status_code == 201, created.text
    assert (created.json()["maker"], created.json()["supplier"]) == ("Sungrow", "Shakti Traders")
    client.post("/api/bom", json=_line(item_name="DC Cable", maker="Polycab", supplier="Shakti Traders"))
    client.post("/api/bom", json=_line(item_name="Module", maker="Adani", supplier="Adani Solar Ltd"))
    everything = client.get("/api/bom").json()
    assert everything["makers"] == ["Adani", "Polycab", "Sungrow"]
    assert everything["suppliers"] == ["Adani Solar Ltd", "Shakti Traders"]
    # Each filter stands on its own and does not read the other column.
    assert client.get("/api/bom?maker=sungrow").json()["total"] == 1
    assert client.get("/api/bom?supplier=shakti%20traders").json()["total"] == 2
    assert client.get("/api/bom?maker=shakti%20traders").json()["total"] == 0
    assert client.get("/api/bom?supplier=sungrow").json()["total"] == 0
    assert client.get("/api/bom?maker=polycab&supplier=shakti%20traders").json()["total"] == 1
    # Search reaches both columns.
    assert client.get("/api/bom?q=shakti").json()["total"] == 2
    # The old field name is gone: a body still sending it leaves maker empty.
    kept = client.put("/api/bom/" + created.json()["id"],
                      json={"item_name": "Inverter 100 kW", "maker_supplier": "Sungrow", "version": 1})
    assert kept.status_code == 200 and kept.json()["maker"] is None
    assert not hasattr(db.query(BomItem).first(), "maker_supplier")


def test_lines_are_ordered_by_section_order_not_by_the_section_text(client, db):
    _head(client, db)
    _plants(client)
    _boq(client)
    # Every line of a section shares that section's order, assigned as the section first appeared.
    rows = client.get("/api/bom?site_code=BM01").json()
    assert [(i["section"], i["sectionOrder"]) for i in rows["items"]] == [
        ("PV Section", 1), ("PV Section", 1), ("WMS", 2), ("14x2 MMS Hardware Quantity", 3)]
    names = [i["section"] for i in rows["items"]]
    # The bug this replaces: ordering by the section TEXT is alphabetical, so "14x2 ..." led.
    assert names.index("PV Section") < names.index("14x2 MMS Hardware Quantity")
    assert names != sorted(names, key=str.lower)
    # The filter dropdown is fed in the same order as the table, not A-Z.
    assert rows["sections"] == ["PV Section", "WMS", "14x2 MMS Hardware Quantity"]
    # A new line joins the section it names, instead of falling to the bottom of the table.
    added = client.post("/api/bom", json=_line(item_name="DC SPD", section="PV Section", sort_order=99)).json()
    assert added["sectionOrder"] == 1
    assert [i["itemName"] for i in client.get("/api/bom?site_code=BM01").json()["items"]][:3] == \
        ["Solar PV Modules", "DC Cable", "DC SPD"]
    # A brand-new section goes after the ordered ones, never into the middle.
    assert client.post("/api/bom", json=_line(item_name="Fence", section="Civil")).json()["sectionOrder"] == 4


def test_reordering_sections_persists_and_an_unknown_section_is_refused(client, db):
    _head(client, db)
    _plants(client)
    _boq(client)
    plant_id = str(db.query(BomItem).first().plant_id)
    wanted = ["WMS", "14x2 MMS Hardware Quantity", "PV Section"]
    saved = client.patch("/api/bom/sections/order", json={"plantId": plant_id, "sections": wanted})
    assert saved.status_code == 200, saved.text
    assert saved.json()["sections"] == wanted and saved.json()["siteCode"] == "BM01"
    rows = client.get("/api/bom?site_code=BM01").json()
    assert [i["section"] for i in rows["items"]] == [
        "WMS", "14x2 MMS Hardware Quantity", "PV Section", "PV Section"]
    assert [i["sectionOrder"] for i in rows["items"]] == [1, 2, 3, 3]
    assert rows["sections"] == wanted
    # It is persisted, not just re-sorted in the response.
    assert {r.section_order for r in db.query(BomItem).filter(BomItem.section == "WMS")} == {1}
    assert db.query(AuditLog).filter(AuditLog.action == "Reordered BOM sections").count() == 1
    # A name this plant does not use is refused, and nothing is rewritten.
    bad = client.patch("/api/bom/sections/order",
                       json={"plantId": plant_id, "sections": ["WMS", "PROTECTION"]})
    assert bad.status_code == 400 and "PROTECTION" in bad.text
    assert [i["section"] for i in client.get("/api/bom?site_code=BM01").json()["items"]][0] == "WMS"
    assert client.patch("/api/bom/sections/order",
                        json={"plantId": plant_id, "sections": ["WMS", "wms"]}).status_code == 400
    assert client.patch("/api/bom/sections/order", json={"plantId": plant_id, "sections": []}).status_code == 422
    assert client.patch("/api/bom/sections/order",
                        json={"plantId": "not-a-uuid", "sections": ["WMS"]}).status_code == 404
    # A partial list still leaves one complete order: the sections left out follow the listed ones.
    partial = client.patch("/api/bom/sections/order", json={"plantId": plant_id, "sections": ["PV Section"]})
    assert partial.status_code == 200
    assert partial.json()["sections"][0] == "PV Section"
    orders = [i["sectionOrder"] for i in client.get("/api/bom?site_code=BM01").json()["items"]]
    assert orders == sorted(orders) and len(set(orders)) == 3


def test_only_an_editor_in_scope_may_reorder_sections(client, db):
    _head(client, db)
    _plants(client)
    _boq(client)
    plant_id = str(db.query(BomItem).first().plant_id)
    login_user(client, db, role="Viewer", name="BOM Viewer 2", email="bom-viewer-2@example.com")
    refused = client.patch("/api/bom/sections/order", json={"plantId": plant_id, "sections": ["WMS"]})
    assert refused.status_code == 403
    assert {r.section_order for r in db.query(BomItem).filter(BomItem.section == "WMS")} == {2}


def test_moving_a_line_to_another_section_takes_the_new_sections_place(client, db):
    _head(client, db)
    _plants(client)
    _boq(client)
    line = client.get("/api/bom?site_code=BM01").json()["items"][0]      # PV Section, order 1
    edit = {k: v for k, v in _line().items() if k != "site_code"}
    edit.update(item_name=line["itemName"], section="WMS", sort_order=1, version=line["version"])
    moved = client.put("/api/bom/" + line["id"], json=edit)
    assert moved.status_code == 200, moved.text
    assert (moved.json()["section"], moved.json()["sectionOrder"]) == ("WMS", 2)
    assert [i["section"] for i in client.get("/api/bom?site_code=BM01").json()["items"]] == [
        "PV Section", "WMS", "WMS", "14x2 MMS Hardware Quantity"]


def test_across_plants_each_plants_boq_stays_together(client, db):
    _head(client, db)
    _plants(client)
    _boq(client, "BM01")
    _boq(client, "BM02")
    codes = [i["siteCode"] for i in client.get("/api/bom").json()["items"]]
    assert codes == ["BM01"] * 4 + ["BM02"] * 4, "one plant's BOQ must not interleave with another's"


# --- Migration 041 (applied by hand in Supabase; checked here for shape) --------------------

def test_migration_041_renames_maker_adds_supplier_and_backfills_section_order():
    text = (MIGRATIONS / "041_bom_maker_supplier_sections.sql").read_text(encoding="utf-8").lower()
    sql = " ".join(line.strip() for line in text.splitlines() if not line.lstrip().startswith("--"))
    # No row is removed and no column is dropped: the rename keeps every stored maker value.
    for destructive in ("drop table", "drop column", "drop constraint", "delete from", "truncate"):
        assert destructive not in sql, destructive
    assert sql.count("begin;") == 1 and sql.count("commit;") == 1
    # a) the rename, guarded both ways so a second run is a no-op
    assert "alter table bom_items rename column maker_supplier to maker" in sql
    assert "and column_name = 'maker_supplier'" in sql and "and column_name = 'maker'" in sql
    assert "and not exists (select 1 from information_schema.columns" in sql
    # b) + c) the new columns
    assert "add column if not exists supplier varchar(160)" in sql
    assert "add column if not exists section_order integer" in sql
    # c) the backfill: BOQ line order decides the section order, and it never undoes a saved reorder
    assert "row_number() over (partition by plant_id order by first_line" in sql
    assert "min(sort_order) as first_line" in sql
    assert "update bom_items b set section_order = r.pos" in sql
    assert "b.section_order is null" in sql
    # d) the read index moves off the section TEXT and onto the section order
    assert "drop index if exists ix_bom_items_plant_section_order" in sql
    assert "on bom_items (plant_id, section_order, sort_order)" in sql
    assert "(plant_id, section, sort_order)" not in sql
    assert "enable row level security" in sql and "from anon" in sql and "from authenticated" in sql
    # 041 is the latest migration; nothing else claims that number.
    assert len([p for p in MIGRATIONS.glob("041*.sql")]) == 1
    assert max(p.name for p in MIGRATIONS.glob("0*.sql")).startswith("041")

    columns = BomItem.__table__.c
    assert "maker_supplier" not in columns
    assert isinstance(columns.maker.type, String) and columns.maker.type.length == 160
    assert isinstance(columns.supplier.type, String) and columns.supplier.type.length == 160
    assert isinstance(columns.section_order.type, Integer)
    index = [i for i in BomItem.__table__.indexes if i.name == "ix_bom_items_plant_section_order"]
    assert index and [c.name for c in index[0].columns] == ["plant_id", "section_order", "sort_order"]


def test_migration_041_backfill_puts_sections_in_boq_order_not_alphabetical():
    """The backfill, run on SQLite against the ABH01 shape: PV Section < WMS < Structures."""
    import sqlite3

    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE bom_items (plant_id text, section text, sort_order integer, section_order integer)")
    db.executemany("INSERT INTO bom_items VALUES (?, ?, ?, NULL)", [
        ("ABH01", "PV Section", 1), ("ABH01", "PV Section", 2),
        ("ABH01", "WMS", 3),
        ("ABH01", "Structures", 4), ("ABH01", "Structures", 5),
        ("ABH01", None, None),                                     # a line with no section keeps no order
        ("BGR02", "Structures", 1), ("BGR02", "PV Section", 2),    # another plant orders them its own way
    ])
    db.execute("""
        WITH s AS (SELECT plant_id, section, MIN(sort_order) AS first_line
                   FROM bom_items WHERE section IS NOT NULL
                   GROUP BY plant_id, section),
             r AS (SELECT plant_id, section,
                          row_number() OVER (PARTITION BY plant_id ORDER BY first_line, section) AS pos
                   FROM s)
        UPDATE bom_items SET section_order = (
            SELECT r.pos FROM r WHERE r.plant_id = bom_items.plant_id AND r.section = bom_items.section)
        WHERE section_order IS NULL AND section IS NOT NULL
    """)
    got = dict(db.execute("SELECT section, MIN(section_order) FROM bom_items WHERE plant_id = 'ABH01' "
                          "AND section IS NOT NULL GROUP BY section").fetchall())
    assert got == {"PV Section": 1, "WMS": 2, "Structures": 3}, got
    assert sorted(got, key=got.get) != sorted(got, key=str.lower), "BOQ order, not alphabetical"
    # Every row of a section carries the same number; a line with no section keeps none.
    assert db.execute("SELECT COUNT(DISTINCT section_order) FROM bom_items WHERE plant_id = 'ABH01' "
                      "AND section = 'Structures'").fetchone()[0] == 1
    assert db.execute("SELECT section_order FROM bom_items WHERE section IS NULL").fetchone()[0] is None
    # Each plant is numbered on its own BOQ.
    assert dict(db.execute("SELECT section, section_order FROM bom_items WHERE plant_id = 'BGR02'").fetchall()) == \
        {"Structures": 1, "PV Section": 2}
    db.close()
