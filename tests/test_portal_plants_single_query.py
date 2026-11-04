"""/api/portal/plants and /api/portal/overview load plants and their people in one query.

Every statement costs a full round trip to Supabase on Render, so the plant list, the Site
Engineer lookup and the washing-assignee lookup were folded into one outer-joined select.
These tests pin the response to what the three separate helpers produced and pin the count.
"""
from __future__ import annotations

from sqlalchemy import event

from app.core.database import engine
from app.core.models import Plant, User, UserPlantAssignment, WashingConfig
from app.portal import service
from tests.conftest import login_user


class _Counter:
    def __init__(self):
        self.n = 0

    def __call__(self, *_args):
        self.n += 1


def _count_statements(fn):
    counter = _Counter()
    event.listen(engine, "before_cursor_execute", counter)
    try:
        result = fn()
    finally:
        event.remove(engine, "before_cursor_execute", counter)
    return result, counter.n


def _user(db, name, role, *, active=True, key=None):
    key = key or name.lower().replace(" ", ".")
    user = User(auth_provider="supabase", external_subject=f"t:{key}", email=f"{key}@example.com",
                display_name=name, role=role, is_active=active)
    db.add(user)
    db.flush()
    return user


def _seed(db):
    alpha = Plant(site_code="ALPHA", plant_name="Alpha")
    bravo = Plant(site_code="BRAVO", plant_name="Bravo")
    charlie = Plant(site_code="CHARLIE", plant_name="Charlie")
    db.add_all([charlie, alpha, bravo])  # inserted out of order: the response must still be ordered by name
    db.flush()

    zed = _user(db, "Zed Engineer", "Site Engineer")
    amy = _user(db, "Amy Engineer", "Site Engineer")
    twin_a = _user(db, "Same Name", "Site Engineer", key="twin.a")
    twin_b = _user(db, "Same Name", "Site Engineer", key="twin.b")
    gone = _user(db, "Gone Engineer", "Site Engineer", active=False)
    helper = _user(db, "Helper Assignee", "Assignee")
    washer = _user(db, "Wash Lead", "Assignee")

    # Alpha: two engineers (unsorted), an inactive one and an Assignee that must not be listed as an engineer.
    for user in (zed, amy, gone, helper):
        db.add(UserPlantAssignment(user_id=user.id, plant_id=alpha.id))
    # Bravo: two different people with the same name are both listed, as before.
    for user in (twin_a, twin_b):
        db.add(UserPlantAssignment(user_id=user.id, plant_id=bravo.id))
    db.add(WashingConfig(plant_id=alpha.id, assigned_user_id=washer.id))
    db.add(WashingConfig(plant_id=charlie.id, assigned_user_id=None))  # configured, nobody assigned
    db.commit()
    return alpha, bravo, charlie, helper


def _legacy_rows(db, plants):
    """What the route returned before: plants, then engineers, then washing assignees."""
    ids = [p.id for p in plants]
    engineers = service.site_engineers_by_plant(db, ids)
    washers = service.washing_assignees_by_plant(db, ids)
    return [service.plant_out(p, engineers.get(p.id, []), washers.get(p.id, "")) for p in plants]


def test_plants_match_the_three_query_result_in_one_statement(client, db):
    _seed(db)
    login_user(client, db, role="O&M Head")

    response, statements = _count_statements(lambda: client.get("/api/portal/plants"))

    assert response.status_code == 200
    body = response.json()["plants"]
    assert [p["site_code"] for p in body] == ["ALPHA", "BRAVO", "CHARLIE"]
    expected = _legacy_rows(db, service.visible_plants(db, db.get(User, _head_id(db))))
    assert body == _jsonish(expected)
    assert statements == 1  # was 3 (the signed-in user lookup is overridden in tests)


def test_people_folding_rules(client, db):
    alpha, bravo, charlie, _helper = _seed(db)
    login_user(client, db, role="O&M Head")
    by_code = {p["site_code"]: p for p in client.get("/api/portal/plants").json()["plants"]}

    alpha_out = service.plant_out(alpha, ["Amy Engineer", "Zed Engineer"], "Wash Lead")
    assert by_code["ALPHA"] == _jsonish([alpha_out])[0]
    assert by_code["BRAVO"] == _jsonish([service.plant_out(bravo, ["Same Name", "Same Name"], "")])[0]
    assert by_code["CHARLIE"] == _jsonish([service.plant_out(charlie, [], "")])[0]


def test_scoped_assignee_still_sees_only_assigned_plants(client, db):
    alpha, _bravo, _charlie, _helper = _seed(db)
    assignee = login_user(client, db, role="Assignee", name="Scoped", email="scoped@example.com")
    db.add(UserPlantAssignment(user_id=assignee.id, plant_id=alpha.id))
    db.commit()

    response, statements = _count_statements(lambda: client.get("/api/portal/plants"))

    assert [p["site_code"] for p in response.json()["plants"]] == ["ALPHA"]
    assert statements == 2  # scope lookup + the one plant/people select


def test_assignee_without_plants_sees_none_and_skips_the_select(client, db):
    _seed(db)
    login_user(client, db, role="Assignee", name="Unscoped", email="unscoped@example.com")

    response, statements = _count_statements(lambda: client.get("/api/portal/plants"))

    assert response.json() == {"plants": []}
    assert statements == 1  # the scope lookup only


def test_overview_rows_carry_the_same_plant_records(client, db):
    _seed(db)
    login_user(client, db, role="O&M Head")

    plants = client.get("/api/portal/plants").json()["plants"]
    rows = client.get("/api/portal/overview").json()["rows"]

    assert [row["plant"] for row in rows] == plants


def _head_id(db):
    return db.query(User).filter(User.role == "O&M Head").one().id


def _jsonish(value):
    from fastapi.encoders import jsonable_encoder
    return jsonable_encoder(value)
