"""Equipment responsibility: configuration, automatic ticket assignment and PM routing.

What is checked:

* the catalogue is one list: a module's own name for an equipment ("VCB Panel", "Transformer",
  "4 Pole + ACDB + Aux. TX") resolves to the canonical category rather than creating a second one;
* an O&M Head configures responsibility from either the person's dialog or the category matrix,
  and both write the same rows, with an audit trail;
* a new site issue goes to the equipment's primary Assignee whatever plant it is on, and a
  category with nobody configured leaves the ticket unassigned, notified, and never discarded;
* an existing ticket's assignee is untouched, and configuration grants no approval authority.
"""
from __future__ import annotations

from sqlalchemy import select

from app.core.models import EquipmentResponsibility, Issue, Notification, Plant, User, UserPlantAssignment
from app.core.security import user_scoped_plant_ids
from app.equipment.service import canonical_key, invalidate_responsibility_cache, pm_keys, primary_assignee
from tests import conftest
from tests.conftest import login_user, seed_work_categories

BASE = "/api/equipment-responsibilities"


def _act_as(db, user):
    conftest._CURRENT_USER = db.get(User, user.id)
    return conftest._CURRENT_USER


def _plants(db, *codes):
    rows = [Plant(site_code=code, plant_name=f"Plant {code}", status="active") for code in codes]
    db.add_all(rows)
    db.commit()
    return rows


def _assignee(db, name, email, *plant_ids):
    user = User(auth_provider="supabase", external_subject=f"test:eqr:{email}", email=email,
                display_name=name, role="Assignee", is_active=True)
    db.add(user)
    db.flush()
    for plant_id in plant_ids:
        db.add(UserPlantAssignment(user_id=user.id, plant_id=plant_id, assignment_role="Assignee"))
    db.commit()
    db.refresh(user)
    return user


def _engineer(db, client, plant, email="eqr-engineer@example.com"):
    user = login_user(client, db, role="Site Engineer", name="Field Person", email=email)
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return user


def _history(client, issue_id):
    """The ticket's activity, whichever shape the endpoint returns."""
    body = client.get(f"/api/issues/{issue_id}/activity").json()
    if isinstance(body, list):
        return body
    return body.get("history") or body.get("entries") or []


def _raise_issue(client, plant, vertical="Inverter", description="Fan not running"):
    return client.post("/api/issues", json={
        "plant_id": str(plant.id), "vertical": vertical, "subcategory": "Fan failure",
        "description": description, "severity": "Medium"})


# ── one canonical list, with the other modules' names mapped onto it ────────


def test_module_specific_names_resolve_to_one_canonical_category():
    assert canonical_key("VCB Panel") == canonical_key("VCB") == "vcb"
    assert canonical_key("Transformer") == canonical_key("IDT Transformer") == "idt_transformer"
    assert canonical_key("Earth pit") == canonical_key("Earthing") == "earthing"
    assert canonical_key("GSS visit") == canonical_key("Switchyard") == "gss"
    assert canonical_key("washing") == canonical_key("Module Cleaning") == "washing"
    # A combined PM activity belongs to each of its sections' equipment.
    assert pm_keys("4 Pole + ACDB + Aux. TX") == ["four_pole", "acdb", "aux_transformer"]
    assert pm_keys("GSS visit") == ["gss"], "GSS side stays its own responsibility"
    # Something the portal does not know yet still gets a stable key, not a crash.
    assert canonical_key("Battery bank") == "cat_battery_bank"


def test_the_catalogue_includes_configured_work_categories_without_duplicating_them(client, db):
    login_user(client, db, role="O&M Head", email="cat-head@example.com")
    seed_work_categories(db, "Inverter", "VCB Panel", "Battery bank")

    body = client.get(BASE).json()
    keys = [item["key"] for item in body["categories"]]
    assert keys.count("inverter") == 1, "the master list does not create a second Inverter"
    assert keys.count("vcb") == 1, "VCB Panel is the VCB category"
    assert "cat_battery_bank" in keys, "a category only in work_categories is still offered"
    assert len(set(keys)) == len(keys)


# ── configuration ──────────────────────────────────────────────────────────


def test_a_head_configures_from_the_matrix_and_the_person_sees_the_same_rows(client, db):
    plants = _plants(db, "EQR01", "EQR02")
    head = login_user(client, db, role="O&M Head", email="matrix-head@example.com")
    primary = _assignee(db, "Inverter Owner", "inv-owner@example.com", plants[0].id)
    backup = _assignee(db, "Standby", "standby@example.com", plants[1].id)
    _act_as(db, head)

    saved = client.put(f"{BASE}/category/inverter", json={
        "primary_user_id": str(primary.id), "backup_user_id": str(backup.id), "active": True})
    assert saved.status_code == 200, saved.text

    matrix = {item["key"]: item for item in client.get(BASE).json()["categories"]}
    assert matrix["inverter"]["primary"]["user_id"] == str(primary.id)
    assert matrix["inverter"]["backup"]["user_id"] == str(backup.id)
    assert matrix["inverter"]["status"] == "Active"
    assert matrix["accb"]["primary"] is None and matrix["accb"]["status"] == "Not configured"

    # The same rows, read from the person's own side.
    _act_as(db, primary)
    mine = client.get(f"{BASE}/mine").json()
    assert mine["keys"] == ["inverter"]
    assert mine["labels"] == ["Inverter"]

    # And the audit trail says who changed what.
    _act_as(db, head)
    history = client.get(f"{BASE}/history").json()["entries"]
    assert history and history[0]["actor"] == head.display_name
    assert any(entry["equipment_key"] == "inverter" for entry in history)


def test_a_person_can_hold_several_categories_and_losing_one_removes_only_that(client, db):
    plants = _plants(db, "EQR03")
    head = login_user(client, db, role="O&M Head", email="multi-head@example.com")
    person = _assignee(db, "Electrical", "electrical@example.com", plants[0].id)
    _act_as(db, head)

    first = client.put(f"{BASE}/user/{person.id}", json={"items": [
        {"equipment_key": "vcb", "position": "primary"},
        {"equipment_key": "idt_transformer", "position": "primary"},
        {"equipment_key": "gss", "position": "backup"}]})
    assert first.status_code == 200, first.text
    assert set(first.json()["keys"]) == {"vcb", "idt_transformer", "gss"}

    second = client.put(f"{BASE}/user/{person.id}", json={"items": [
        {"equipment_key": "vcb", "position": "primary"}]})
    assert second.status_code == 200
    assert second.json()["keys"] == ["vcb"]
    rows = list(db.scalars(select(EquipmentResponsibility).where(
        EquipmentResponsibility.user_id == person.id)))
    assert [row.equipment_key for row in rows] == ["vcb"]
    assert any(entry["action"] == "Equipment responsibility removed"
               for entry in client.get(f"{BASE}/history").json()["entries"])


def test_only_one_active_primary_per_category_and_the_previous_one_becomes_backup(client, db):
    plants = _plants(db, "EQR04")
    head = login_user(client, db, role="O&M Head", email="primary-head@example.com")
    first = _assignee(db, "First Owner", "first-owner@example.com", plants[0].id)
    second = _assignee(db, "Second Owner", "second-owner@example.com", plants[0].id)
    _act_as(db, head)

    client.put(f"{BASE}/user/{first.id}", json={"items": [{"equipment_key": "accb", "position": "primary"}]})
    client.put(f"{BASE}/user/{second.id}", json={"items": [{"equipment_key": "accb", "position": "primary"}]})

    rows = {row.user_id: row for row in db.scalars(select(EquipmentResponsibility).where(
        EquipmentResponsibility.equipment_key == "accb"))}
    assert rows[second.id].position == "primary"
    assert rows[first.id].position == "backup", "the previous primary is kept as backup, not deleted"
    invalidate_responsibility_cache()
    assert primary_assignee(db, "ACCB").id == second.id


def test_configuration_is_refused_to_everyone_but_the_head(client, db):
    plants = _plants(db, "EQR05")
    person = _assignee(db, "Assignee", "plain-assignee@example.com", plants[0].id)
    _act_as(db, person)

    assert client.get(BASE).status_code == 403
    assert client.put(f"{BASE}/category/inverter",
                      json={"primary_user_id": str(person.id)}).status_code == 403
    # Their own responsibilities are readable: it tells them nothing about anyone else.
    assert client.get(f"{BASE}/mine").status_code == 200

    engineer = login_user(client, db, role="Site Engineer", email="eqr-se@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plants[0].id))
    db.commit()
    assert client.get(BASE).status_code == 403
    assert client.put(f"{BASE}/user/{person.id}", json={"items": []}).status_code == 403


def test_a_site_engineer_cannot_be_given_equipment_responsibility(client, db):
    plants = _plants(db, "EQR06")
    head = login_user(client, db, role="O&M Head", email="holder-head@example.com")
    engineer = User(auth_provider="supabase", external_subject="test:eqr:se2", email="se2@example.com",
                    display_name="Engineer", role="Site Engineer", is_active=True)
    db.add(engineer)
    db.commit()
    db.refresh(engineer)
    _act_as(db, head)

    refused = client.put(f"{BASE}/category/inverter", json={"primary_user_id": str(engineer.id)})
    assert refused.status_code == 422
    assert "Assignee" in refused.text


# ── automatic assignment of site issues ────────────────────────────────────


def test_a_new_ticket_goes_to_the_equipment_owner_whatever_the_plant(client, db):
    north, south = _plants(db, "EQR10", "EQR11")
    head = login_user(client, db, role="O&M Head", email="auto-head@example.com")
    seed_work_categories(db, "Inverter", "VCB Panel")
    owner = _assignee(db, "Inverter Owner", "auto-owner@example.com", north.id)
    _act_as(db, head)
    client.put(f"{BASE}/category/inverter", json={"primary_user_id": str(owner.id), "active": True})

    _engineer(db, client, south, email="auto-engineer@example.com")
    created = _raise_issue(client, south, "Inverter")
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["assigned_to"] == str(owner.id), "routed by equipment, not by plant"
    assert body["assignee_text"] == owner.display_name, "the ticket shows who holds it"
    assert body["status"] == "Assigned"

    # The owner can work that plant without a per-plant grant: Assignees now have portfolio-wide
    # scope, so equipment routing no longer writes a UserPlantAssignment or a scope-grant audit row.
    assert user_scoped_plant_ids(db, db.get(User, owner.id)) is None
    assert db.scalar(select(UserPlantAssignment).where(
        UserPlantAssignment.user_id == owner.id, UserPlantAssignment.plant_id == south.id)) is None

    # The ticket's own history says why, and the owner is told.
    entries = _history(client, body["id"])
    actions = [entry.get("action") for entry in entries]
    assert "issue.auto_assigned" in actions, entries
    told = [n for n in db.scalars(select(Notification).where(Notification.user_id == owner.id))]
    assert any(n.event_type == "ticket_assigned" for n in told)


def test_an_unconfigured_category_keeps_the_ticket_and_tells_the_head(client, db):
    plant, = _plants(db, "EQR12")
    head = login_user(client, db, role="O&M Head", email="unassigned-head@example.com")
    seed_work_categories(db, "Transmission Line")
    _engineer(db, client, plant, email="unassigned-engineer@example.com")

    created = _raise_issue(client, plant, "Transmission Line", "Insulator damaged")
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["assigned_to"] is None
    assert body["status"] == "Open", "the ticket exists and is workable, not discarded"

    entries = _history(client, body["id"])
    skipped = [e for e in entries if e.get("action") == "issue.assignment_skipped"]
    assert skipped, entries
    assert "responsibility not configured" in (skipped[0].get("note") or "").lower()

    told = [n for n in db.scalars(select(Notification).where(Notification.user_id == head.id))]
    unassigned = [n for n in told if n.event_type == "issue_unassigned"]
    assert len(unassigned) == 1
    assert "not configured" in unassigned[0].title.lower()
    assert unassigned[0].target_id == body["ticket_no"]

    # And the head can still assign it by hand.
    _act_as(db, head)
    owner = _assignee(db, "Line Owner", "line-owner@example.com", plant.id)
    _act_as(db, head)
    assigned = client.post(f"/api/issues/{body['id']}/assign",
                           json={"assigned_to": str(owner.id), "note": "Manual"})
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["assigned_to"] == str(owner.id)


def test_configuring_responsibility_later_does_not_touch_existing_tickets(client, db):
    plant, = _plants(db, "EQR13")
    head = login_user(client, db, role="O&M Head", email="keep-head@example.com")
    seed_work_categories(db, "ACCB")
    first_owner = _assignee(db, "Original", "original@example.com", plant.id)
    _act_as(db, head)
    client.put(f"{BASE}/category/accb", json={"primary_user_id": str(first_owner.id), "active": True})
    _engineer(db, client, plant, email="keep-engineer@example.com")
    ticket = _raise_issue(client, plant, "ACCB").json()
    assert ticket["assigned_to"] == str(first_owner.id)

    _act_as(db, head)
    new_owner = _assignee(db, "Replacement", "replacement@example.com", plant.id)
    _act_as(db, head)
    client.put(f"{BASE}/category/accb", json={"primary_user_id": str(new_owner.id), "active": True})

    existing = db.scalar(select(Issue).where(Issue.ticket_no == ticket["ticket_no"]))
    assert str(existing.assigned_to) == str(first_owner.id), "existing tickets keep their assignee"

    _engineer(db, client, plant, email="keep-engineer-2@example.com")
    later = _raise_issue(client, plant, "ACCB", "Second fault").json()
    assert later["assigned_to"] == str(new_owner.id), "only new tickets follow the new configuration"


def test_an_assignee_raising_a_ticket_defaults_to_equipment_owner(client, db):
    plant, = _plants(db, "EQR14")
    head = login_user(client, db, role="O&M Head", email="self-head@example.com")
    seed_work_categories(db, "Inverter")
    owner = _assignee(db, "Equipment Owner", "self-owner@example.com", plant.id)
    reporter = _assignee(db, "Reporter", "self-reporter@example.com", plant.id)
    _act_as(db, head)
    client.put(f"{BASE}/category/inverter", json={"primary_user_id": str(owner.id), "active": True})

    _act_as(db, reporter)
    created = _raise_issue(client, plant, "Inverter", "Found while on site")
    assert created.status_code == 201, created.text
    assert created.json()["assigned_to"] == str(owner.id)


def test_an_assignee_raising_a_ticket_defaults_to_self_without_equipment_owner(client, db):
    plant, = _plants(db, "EQR15")
    seed_work_categories(db, "Inverter")
    reporter = _assignee(db, "Reporter", "fallback-reporter@example.com", plant.id)

    _act_as(db, reporter)
    created = _raise_issue(client, plant, "Inverter", "Found without configured owner")
    assert created.status_code == 201, created.text
    assert created.json()["assigned_to"] == str(reporter.id)
    assert created.json()["status"] == "Assigned"


# ── Preventive Maintenance routing, without changing authority ─────────────


def test_pm_notifications_reach_the_equipment_owner_across_plants(client, db, monkeypatch):
    from datetime import date

    from app.pmplan.tracking import CHECKLISTS, PMTrackingActivity

    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 11, 25))
    north, south = _plants(db, "EQR20", "EQR21")
    head = login_user(client, db, role="O&M Head", email="pm-eqr-head@example.com")
    owner = _assignee(db, "Transformer Owner", "trf-owner@example.com", north.id)
    _act_as(db, head)
    client.put(f"{BASE}/category/idt_transformer",
               json={"primary_user_id": str(owner.id), "active": True})

    row = PMTrackingActivity(plant_id=south.id, equipment="IDT Transformer",
                             equipment_id="IDT-01", scheduled_on=date(2026, 11, 2))
    db.add(row)
    db.commit()
    db.refresh(row)
    _engineer(db, client, south, email="pm-eqr-engineer@example.com")
    submitted = client.post(f"/api/pm-plan/tracking/{row.id}/action", json={
        "action": "submit", "inspected_on": "2026-11-25",
        "checks": [{"result": "OK"} for _ in CHECKLISTS["IDT Transformer"]]})
    assert submitted.status_code == 200, submitted.text

    told = [n for n in db.scalars(select(Notification).where(Notification.user_id == owner.id))
            if (n.event_type or "").startswith("pm_")]
    assert [n.event_type for n in told] == ["pm_submitted"], \
        "the transformer owner hears about transformer PM on a plant they were not assigned"
    assert told[0].payload["site_code"] == "EQR21"

    # Responsibility is not approval authority: the Assignee still cannot approve.
    _act_as(db, owner)
    refused = client.post(f"/api/pm-plan/tracking/{row.id}/action", json={"action": "approve"})
    assert refused.status_code in (403, 404, 409), refused.text
    db.refresh(row)
    assert row.status == "Pending approval"


def test_new_responsibility_routes_existing_open_tickets_from_both_access_editors(client, db):
    north, south = _plants(db, "EQR30", "EQR31")
    head = login_user(client, db, role="O&M Head", email="backfill-head@example.com")
    owner = _assignee(db, "Owner", "backfill-owner@example.com", north.id)
    other = _assignee(db, "Other", "backfill-other@example.com", north.id)
    rows = [Issue(ticket_no=f"ISS-{100+i}", plant_id=plant.id, vertical=vertical,
                  description="Test fault", severity="Medium", status=status,
                  assigned_to=assigned, assignee_text=text)
            for i, (plant, vertical, status, assigned, text) in enumerate([
                (north, "VCB Panel", "Open", None, None),
                (south, "VCB", "Open", None, None),
                (south, "Inverter", "Open", None, None),
                (north, "VCB", "Assigned", other.id, other.display_name),
                (south, "VCB", "Closed", None, None),
                (south, "VCB", "Open", None, "Legacy owner")])]
    db.add_all(rows); db.commit()
    ids = [r.id for r in rows]
    _act_as(db, head)
    response = client.put(f"{BASE}/category/vcb", json={"primary_user_id": str(owner.id)})
    assert response.status_code == 200, response.text
    assert response.json()["issues_auto_assigned"] == 2
    response = client.put(f"{BASE}/user/{owner.id}", json={"items": [
        {"equipment_key": "vcb", "position": "primary"}, {"equipment_key": "inverter", "position": "primary"}]})
    assert response.status_code == 200, response.text
    assert response.json()["issues_auto_assigned"] == 1
    db.expire_all()
    routed = [db.get(Issue, i) for i in ids]
    assert all(r.assigned_to == owner.id and r.status == "Assigned" for r in routed[:3])
    assert routed[3].assigned_to == other.id
    assert routed[4].status == "Closed" and routed[4].assigned_to is None
    assert routed[5].assignee_text == "Legacy owner"
    assert any(e["action"] == "issue.auto_assigned" for e in _history(client, str(ids[0])))
    assert client.put(f"{BASE}/category/vcb", json={"primary_user_id": str(owner.id)}).json()["issues_auto_assigned"] == 0
