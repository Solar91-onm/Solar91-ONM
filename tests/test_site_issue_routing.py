"""Regression tests for site issue exceptions, backups and defaults."""
from uuid import uuid4

from sqlalchemy import select
from app.core.models import AppSetting, AuditLog, Issue, User
from app.equipment.issue_routing import SETTING_KEY
from app.equipment.service import canonical_key
from tests.conftest import login_user, seed_work_categories
from tests.test_equipment_responsibility import _act_as, _assignee, _engineer, _plants, _raise_issue

BASE = "/api/equipment-responsibilities"


def set_rule(client, plants, key, primary=None, backup=None, apply_existing=False):
    return client.put(BASE + "/issue-routing", json={
        "plant_ids": [str(p.id) for p in plants], "equipment_keys": [key] if isinstance(key, str) else key,
        "primary_user_id": str(primary.id) if primary else None,
        "backup_user_id": str(backup.id) if backup else None,
        "apply_existing": apply_existing,
    })


def test_nine_names_have_distinct_and_compatible_routing_keys(client, db):
    names = ["Solar PV modules", "LA", "Water pipe line", "Water Pump", "Vegetation",
             "Modules cleaning", "MMS", "MMS and Modules tightness", "Grid side tripping and voltage issue"]
    seed_work_categories(db, *names)
    login_user(client, db, role="O&M Head")
    keys = [canonical_key(name) for name in names]
    assert len(set(keys)) == 9
    assert canonical_key("Module") == keys[0]
    assert canonical_key("Module Cleaning") == keys[5]
    assert canonical_key("Module Mounting Structure (MMS)") == keys[6]
    body = client.get(BASE).json()
    assert set(keys) <= {c["key"] for c in body["categories"]}
    assert set(names) <= {c["name"] for c in client.get("/api/categories").json()["categories"]}


def test_specific_plant_and_equipment_override_global_and_default(client, db):
    north, south, east = _plants(db, "RT01", "RT02", "RT03")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter", "Water Pump", "LA")
    local = _assignee(db, "Local", "local@test.example")
    plant_owner = _assignee(db, "Plant", "plant@test.example")
    global_owner = _assignee(db, "Global", "global@test.example")
    fallback = _assignee(db, "Default", "default@test.example")
    _act_as(db, head)
    assert client.put(BASE + "/category/inverter", json={"primary_user_id": str(global_owner.id)}).status_code == 200
    assert set_rule(client, [north, east], "inverter", local).status_code == 200
    assert set_rule(client, [north], "*", plant_owner).status_code == 200
    assert set_rule(client, [], "*", fallback).status_code == 200
    for plant, equipment, expected, source in [
        (north, "Inverter", local, "plant_equipment_primary"),
        (east, "Inverter", local, "plant_equipment_primary"),
        (north, "Water Pump", plant_owner, "plant_all_primary"),
        (south, "Inverter", global_owner, "equipment_primary"),
        (south, "LA", fallback, "default_primary"),
    ]:
        _act_as(db, head)
        response = _raise_issue(client, plant, equipment, f"Fault: {plant.site_code} {equipment}")
        assert response.status_code == 201, response.text
        assert response.json()["assigned_to"] == str(expected.id)
        assert response.json()["status"] == "Assigned"
        entry = db.scalar(select(AuditLog).where(AuditLog.entity_id == response.json()["ticket_no"], AuditLog.action == "issue.auto_assigned"))
        assert entry.metadata_json["rule"] == source
    rules = client.get(BASE).json()["issue_routing"]
    assert len(rules) == 4
    assert db.scalar(select(AppSetting).where(AppSetting.setting_key == SETTING_KEY)) is not None


def test_site_engineer_auto_assignment_uses_backup_and_fresh_user_status(client, db):
    plant, = _plants(db, "RT04")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter")
    primary = _assignee(db, "Primary", "primary@test.example")
    backup = _assignee(db, "Backup", "backup@test.example")
    global_owner = _assignee(db, "Global", "global2@test.example")
    _act_as(db, head)
    assert set_rule(client, [plant], "inverter", primary, backup).status_code == 200
    assert client.put(BASE + "/category/inverter", json={"primary_user_id": str(global_owner.id)}).status_code == 200
    engineer = _engineer(db, client, plant, email="engineer-routing@test.example")
    primary.is_active = False
    db.commit()
    _act_as(db, engineer)
    response = _raise_issue(client, plant, "Inverter", "Primary inactive")
    assert response.status_code == 201, response.text
    assert response.json()["assigned_to"] == str(backup.id)
    backup.role = "Viewer"
    db.commit()
    _act_as(db, engineer)
    response = _raise_issue(client, plant, "Inverter", "Both unavailable")
    assert response.status_code == 201, response.text
    assert response.json()["assigned_to"] == str(global_owner.id)


def test_global_backup_and_default_backup(client, db):
    plant, = _plants(db, "RT05")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter", "LA")
    a = _assignee(db, "A", "a5@test.example")
    b = _assignee(db, "B", "b5@test.example")
    _act_as(db, head)
    assert client.put(BASE + "/category/inverter", json={"primary_user_id": str(a.id), "backup_user_id": str(b.id)}).status_code == 200
    assert set_rule(client, [], "*", a, b).status_code == 200
    a.is_active = False
    db.commit()
    for equipment in ["Inverter", "LA"]:
        r = _raise_issue(client, plant, equipment, "Fallback " + equipment)
        assert r.status_code == 201, r.text
        assert r.json()["assigned_to"] == str(b.id)


def test_backfill_scope_preserves_existing_owners_and_uses_new_resolver(client, db):
    north, south = _plants(db, "RT06", "RT07")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter", "LA")
    a = _assignee(db, "A", "a6@test.example")
    b = _assignee(db, "B", "b6@test.example")
    _act_as(db, head)
    assert set_rule(client, [north], "inverter", a).status_code == 200
    rows = [Issue(ticket_no=f"RT-0{i}", plant_id=p.id, vertical=e, description="old issue",
                  severity="Medium", status=status, assigned_to=owner, assignee_text="Existing" if owner else None)
            for i, (p,e,status,owner) in enumerate([(north,"Inverter","Open",None),(south,"Inverter","Open",None),
                (north,"LA","Open",None),(north,"Inverter","Assigned",b.id),(north,"Inverter","Closed",None)])]
    db.add_all(rows); db.commit()
    ids = [r.id for r in rows]
    # Global save backfills using the same priority as issue creation.
    response = client.put(BASE + "/category/inverter", json={"primary_user_id": str(b.id)})
    assert response.status_code == 200, response.text
    assert response.json()["issues_auto_assigned"] == 2
    db.expire_all()
    assert [db.get(Issue, i).assigned_to for i in ids] == [a.id,b.id,None,b.id,None]
    assert set_rule(client, [north], "*", a, apply_existing=False).json()["issues_auto_assigned"] == 0
    assert set_rule(client, [north], "*", a, apply_existing=True).json()["issues_auto_assigned"] == 1
    assert set_rule(client, [north], "inverter").status_code == 200
    assert set_rule(client, [north], "*" ).status_code == 200
    response = _raise_issue(client, north, "Inverter", "After removal")
    assert response.json()["assigned_to"] == str(b.id)
    db.expire_all()
    assert db.get(Issue,ids[0]).assigned_to == a.id


def test_write_validation_and_permission(client, db):
    plant, = _plants(db, "RT08")
    head = login_user(client, db, role="O&M Head")
    a = _assignee(db, "A", "a8@test.example")
    _act_as(db, head)
    assert set_rule(client, [plant], "inverter", a, a).status_code == 422
    assert set_rule(client, [plant], "not_a_category", a).status_code == 422
    assert set_rule(client, [plant], "inverter", head).status_code == 422
    assert set_rule(client, [], "inverter", a).status_code == 422
    assert client.put(BASE + "/issue-routing", json={"plant_ids":[str(uuid4())],"equipment_keys":["inverter"],"primary_user_id":str(a.id)}).status_code == 422
    assert set_rule(client, [plant], ["*", "inverter"], a).status_code == 422
    assert set_rule(client, [plant], [], a).status_code == 422
    _act_as(db, a)
    assert set_rule(client, [plant], "inverter", a).status_code == 403
    assert set_rule(client, [plant], ["inverter", "la"], a).status_code == 403
    assert client.get(BASE).status_code == 403
    assert db.get(AppSetting, SETTING_KEY) is None


def test_multiple_plants_and_equipment_save_and_remove_together(client, db):
    north, south, east = _plants(db, "MS01", "MS02", "MS03")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter", "LA", "Water Pump")
    owner = _assignee(db, "Multi", "multi@test.example")
    backup = _assignee(db, "Multi backup", "multi-backup@test.example")
    _act_as(db, head)
    keys = [canonical_key("Inverter"), canonical_key("LA")]
    saved = set_rule(client, [north, south], keys + [keys[0]], owner, backup)
    assert saved.status_code == 200, saved.text
    expected = {f"{p.id}:{k}" for p in (north, south) for k in keys}
    assert set(saved.json()["rules"]) == expected
    assert db.query(AuditLog).filter(AuditLog.entity_type == "site_issue_routing",
                                     AuditLog.action == "Site issue routing set").count() == 4
    for plant, equipment, expected_owner in [(north, "Inverter", owner), (south, "LA", owner),
                                             (east, "Inverter", None), (north, "Water Pump", None)]:
        _act_as(db, head)
        response = _raise_issue(client, plant, equipment, f"Multi {plant.site_code} {equipment}")
        assert response.status_code == 201, response.text
        assert response.json()["assigned_to"] == (str(expected_owner.id) if expected_owner else None)

    removed = set_rule(client, [north, south], keys)
    assert removed.status_code == 200, removed.text
    assert removed.json()["rules"] == {}
    assert db.query(AuditLog).filter(AuditLog.entity_type == "site_issue_routing",
                                     AuditLog.action == "Site issue routing removed").count() == 4


def test_apply_assigns_open_issues_from_one_persons_saved_rules_only(client, db):
    p1, p2, p3, p4 = _plants(db, "AP01", "AP02", "AP03", "AP04")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter", "LA")
    kush = _assignee(db, "Kush", "kush-apply@test.example")
    other = _assignee(db, "Other", "other-apply@test.example")
    primary = _assignee(db, "Primary elsewhere", "primary-apply@test.example")
    _act_as(db, head)
    inverter, la = canonical_key("Inverter"), canonical_key("LA")
    assert set_rule(client, [p1], inverter, kush).status_code == 200
    assert set_rule(client, [p2], "*", kush).status_code == 200
    assert set_rule(client, [p3], inverter, other).status_code == 200
    assert set_rule(client, [p4], inverter, primary, kush).status_code == 200
    rules_before = dict(db.get(AppSetting, SETTING_KEY).setting_value)
    cases = [(p1, "Inverter", "Open", None), (p1, "LA", "Open", None), (p2, "LA", "Open", None),
             (p3, "Inverter", "Open", None), (p4, "Inverter", "Open", None),
             (p1, "Inverter", "Assigned", other.id), (p1, "Inverter", "Closed", None)]
    rows = [Issue(ticket_no=f"AP-0{i}", plant_id=p.id, vertical=v, description="older issue", severity="Medium",
                  status=status, assigned_to=owner, assignee_text="Existing" if owner else None)
            for i, (p, v, status, owner) in enumerate(cases)]
    db.add_all(rows); db.commit()
    ids = [row.id for row in rows]

    response = client.post(BASE + "/issue-routing/apply", json={"user_ids": [str(kush.id)]})
    assert response.status_code == 200, response.text
    assert response.json() == {"issues_auto_assigned": 3, "rules_covered": 3}
    db.expire_all()
    assert [db.get(Issue, i).assigned_to for i in ids] == [
        kush.id,      # his plant + equipment rule
        None,         # LA at AP01 is not his
        kush.id,      # his plant-wide rule at AP02
        None,         # someone else's rule
        primary.id,   # he is only backup at AP04; the eligible primary receives it
        other.id,     # already assigned: never moved
        None,         # closed: never touched
    ]
    assert db.get(AppSetting, SETTING_KEY).setting_value == rules_before
    assert db.query(AuditLog).filter(AuditLog.action == "Site issue routing applied").count() == 1

    assert client.post(BASE + "/issue-routing/apply", json={"user_ids": []}).status_code == 422
    _act_as(db, kush)
    assert client.post(BASE + "/issue-routing/apply", json={"user_ids": [str(kush.id)]}).status_code == 403


def test_multi_equipment_backfill_routes_only_the_chosen_categories(client, db):
    plant, = _plants(db, "MS04")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Inverter", "LA", "Water Pump")
    owner = _assignee(db, "Backfill", "multi-backfill@test.example")
    _act_as(db, head)
    rows = [Issue(ticket_no=f"MS-0{i}", plant_id=plant.id, vertical=vertical, description="old issue",
                  severity="Medium", status="Open") for i, vertical in enumerate(["Inverter", "LA", "Water Pump"])]
    db.add_all(rows); db.commit()
    ids = [row.id for row in rows]
    response = set_rule(client, [plant], [canonical_key("Inverter"), canonical_key("LA")], owner, apply_existing=True)
    assert response.status_code == 200, response.text
    assert response.json()["issues_auto_assigned"] == 2
    db.expire_all()
    assert [db.get(Issue, i).assigned_to for i in ids] == [owner.id, owner.id, None]


def test_other_is_independently_assignable_without_changing_miscellaneous_pm(client, db):
    from app.equipment.service import pm_keys

    north, south = _plants(db, "OTHER01", "OTHER02")
    head = login_user(client, db, role="O&M Head")
    seed_work_categories(db, "Other", "Miscellaneous", "Street Light")
    global_owner = _assignee(db, "Other global", "other-global@test.example")
    local_owner = _assignee(db, "Other local", "other-local@test.example")
    backup = _assignee(db, "Other backup", "other-backup@test.example")
    misc_owner = _assignee(db, "Misc owner", "misc-owner@test.example")
    _act_as(db, head)

    assert canonical_key("Other") == canonical_key("others") == "cat_other"
    assert canonical_key("Miscellaneous") == "misc"
    assert pm_keys("Miscellaneous") == ["misc", "weather", "communication", "water_system"]
    categories = client.get(BASE + "?include_routing=false").json()["categories"]
    labels = {row["key"]: row["label"] for row in categories}
    assert labels["cat_other"] == "Other"
    assert labels["misc"] == "Miscellaneous"
    assert labels["cat_street_light"] == "Street Light"

    for key, owner in [("cat_other", global_owner), ("misc", misc_owner)]:
        result = client.put(BASE + "/category/" + key,
                            json={"primary_user_id": str(owner.id)})
        assert result.status_code == 200, result.text
    assert set_rule(client, [north], "cat_other", local_owner, backup).status_code == 200

    def check(plant, equipment, owner, description):
        result = _raise_issue(client, plant, equipment, description)
        assert result.status_code == 201, result.text
        assert result.json()["assigned_to"] == str(owner.id)

    check(north, "Other", local_owner, "Other plant override")
    check(south, "Other", global_owner, "Other portfolio default")
    check(north, "Miscellaneous", misc_owner, "Misc independent assignment")
    local_owner.is_active = False
    db.commit()
    check(north, "Other", backup, "Other plant backup")
