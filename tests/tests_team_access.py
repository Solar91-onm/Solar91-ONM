from __future__ import annotations

from app.core.models import Equipment, Plant, User, UserEquipmentTypeAssignment, UserPlantAssignment
from tests import conftest as test_context
from tests.conftest import login_user


def _person(db, email, role="Viewer", name=None):
    u = User(auth_provider="supabase", external_subject=f"x:{email}", email=email,
             display_name=name or email, role=role, is_active=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _plants(db, n=2):
    rows = [Plant(site_code=f"T{i:02d}", plant_name=f"Plant {i}") for i in range(n)]
    db.add_all(rows); db.commit()
    return rows


def test_head_assigns_site_engineer_role_and_plant_atomically(client, db):
    p1, p2 = _plants(db)
    login_user(client, db, name="Head", email="head@example.com")
    pending = _person(db, "new@example.com")
    r = client.put(f"/api/users/{pending.id}/access", json={"role": "Site Engineer", "plant_ids": [str(p1.id)]})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "Site Engineer"
    listing = {u["email"]: u for u in client.get("/api/users").json()}
    assert [p["site_code"] for p in listing["new@example.com"]["plants"]] == ["T00"]


def test_site_engineer_requires_exactly_one_plant(client, db):
    p1, p2 = _plants(db)
    login_user(client, db, email="head@example.com")
    target = _person(db, "se@example.com")
    for ids in ([], [str(p1.id), str(p2.id)]):
        r = client.put(f"/api/users/{target.id}/access", json={"role": "Site Engineer", "plant_ids": ids})
        assert r.status_code == 422


def test_portfolio_roles_drop_plant_rows(client, db):
    p1, _ = _plants(db)
    login_user(client, db, email="head@example.com")
    target = _person(db, "cto@example.com")
    r = client.put(f"/api/users/{target.id}/access", json={"role": "Administration", "plant_ids": [str(p1.id)]})
    assert r.status_code == 200
    assert db.query(UserPlantAssignment).filter_by(user_id=target.id).count() == 0


def test_assignee_scope_is_equipment_types_across_all_plants(client, db):
    first, second = _plants(db)
    login_user(client, db, email="head@example.com")
    target = _person(db, "assignee@example.com")
    response = client.put(
        f"/api/users/{target.id}/access",
        json={"role": "Assignee", "equipment_types": ["Inverter", "Module"]},
    )
    assert response.status_code == 200, response.text
    listing = {u["email"]: u for u in client.get("/api/users").json()}
    assert listing["assignee@example.com"]["equipment_types"] == ["Inverter", "Module"]
    assert db.query(UserEquipmentTypeAssignment).filter_by(user_id=target.id).count() == 2

    db.refresh(target)
    test_context._CURRENT_USER = target
    assert {row["id"] for row in client.get("/api/plants").json()} == {str(first.id), str(second.id)}


def test_assignee_cannot_be_assigned_plant_scope_and_types_are_assignee_only(client, db):
    plant = _plants(db, 1)[0]
    login_user(client, db, email="head@example.com")
    target = _person(db, "assignee@example.com")
    plant_scope = client.put(
        f"/api/users/{target.id}/access",
        json={"role": "Assignee", "plant_ids": [str(plant.id)]},
    )
    assert plant_scope.status_code == 422
    not_assignee = client.put(
        f"/api/users/{target.id}/access",
        json={"role": "Administration", "equipment_types": ["Inverter"]},
    )
    assert not_assignee.status_code == 422


def test_assignee_invite_uses_equipment_types(client, db):
    login_user(client, db, email="head@example.com")
    response = client.post("/api/users/invite", json={
        "name": "New Assignee", "email": "new-assignee@example.com", "role": "Assignee",
        "equipment": ["inverter", "Module"],
    })
    assert response.status_code == 201, response.text
    target = db.query(User).filter_by(email="new-assignee@example.com").one()
    assert {r.equipment_type for r in db.query(UserEquipmentTypeAssignment).filter_by(user_id=target.id)} == {"Inverter", "Module"}

    bad = client.post("/api/users/invite", json={
        "name": "Bad", "email": "bad@example.com", "role": "Assignee", "equipment": ["Toaster"],
    })
    assert bad.status_code == 422
    invalid = client.post("/api/users/invite", json={
        "name": "Invalid Assignee", "email": "invalid-assignee@example.com", "role": "Assignee",
        "plants": ["T00"],
    })
    assert invalid.status_code == 422


def test_assignee_csv_import_accepts_equipment_type_column(client, db):
    login_user(client, db, email="head@example.com")
    csv_data = (
        "Name,Email,Role,Equipment Types\n"
        "Imported Assignee,imported@example.com,Assignee,Inverter|Transformer\n"
    ).encode()
    response = client.post(
        "/api/users/import",
        files={"file": ("team.csv", csv_data, "text/csv")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 1
    target = db.query(User).filter_by(email="imported@example.com").one()
    assert db.query(UserEquipmentTypeAssignment).filter_by(user_id=target.id).count() == 2


def test_cannot_demote_or_deactivate_self_or_last_head(client, db):
    head = login_user(client, db, email="head@example.com")
    r = client.put(f"/api/users/{head.id}/access", json={"role": "Viewer", "plant_ids": []})
    assert r.status_code == 409
    r = client.patch(f"/api/users/{head.id}/active", json={"is_active": False})
    assert r.status_code == 409
    r = client.patch(f"/api/users/{head.id}/role", json={"role": "Assignee"})
    assert r.status_code == 409


def test_non_head_cannot_manage_users(client, db):
    login_user(client, db, role="Assignee", email="a@example.com")
    other = _person(db, "o@example.com")
    assert client.get("/api/users").status_code == 403
    assert client.put(f"/api/users/{other.id}/access", json={"role": "O&M Head", "plant_ids": []}).status_code == 403


def test_deactivate_and_reactivate_user(client, db):
    login_user(client, db, email="head@example.com")
    target = _person(db, "gone@example.com", role="Assignee")
    assert client.patch(f"/api/users/{target.id}/active", json={"is_active": False}).json()["active"] is False
    assert client.patch(f"/api/users/{target.id}/active", json={"is_active": True}).json()["active"] is True

def test_invite_sends_designed_email_and_reports_failure(client, db, monkeypatch):
    from app.users import invites as inv
    sent = []
    monkeypatch.setattr(inv, "send_invite_email", lambda **kw: (sent.append(kw) or (True, "sent")))
    login_user(client, db, email="head@example.com")
    r = client.post("/api/users/invite", json={
        "name": "Vikash", "email": "vikash@example.com", "role": "Assignee", "equipment": ["Inverter"]})
    assert r.status_code == 201, r.text
    assert r.json()["email_sent"] is True
    assert sent[0]["to_email"] == "vikash@example.com" and "Inverter" in sent[0]["scope"]

    monkeypatch.setattr(inv, "send_invite_email", lambda **kw: (False, "not set up"))
    r2 = client.post("/api/users/invite", json={
        "name": "B", "email": "b@example.com", "role": "Administration"})
    assert r2.status_code == 201 and r2.json()["email_sent"] is False  # person is still saved
    uid = r2.json()["id"]
    assert client.post(f"/api/users/{uid}/resend-invite").json()["email_note"] == "not set up"


def test_email_template_renders_and_escapes():
    from app.notifications.mailer import _invite_html
    html = _invite_html("<b>Ravi</b>", "r@x.com", "Assignee", "Inverter — in every plant", "Head", "https://app.example.com")
    assert "&lt;b&gt;Ravi" in html and "<b>Ravi</b>" not in html and "https://app.example.com" in html
