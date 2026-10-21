from __future__ import annotations

from app.auth.service import upsert_clerk_user
from app.core.models import AuditLog, Issue, OMTask, User
from tests.conftest import login_user
from tests.test_clerk_auth import CLERK_SETTINGS, SUBJECT, verified_profile


def _person(db, email, *, name=None, role="Assignee", invited=False, active=True):
    u = User(auth_provider="clerk", external_subject=("invite:" + email) if invited else f"user_{email}",
             email=email, display_name=name or email, role=role, is_active=active)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _patch(client, user, **body):
    body.setdefault("expected_name", user.display_name)
    body.setdefault("expected_email", user.email)
    return client.patch(f"/api/users/{user.id}/profile", json=body)


def test_head_corrects_a_signed_in_persons_name_and_it_is_audited(client, db):
    login_user(client, db, email="head@example.com")
    target = _person(db, "ravi@example.com", name="Rvai Kumar")
    r = _patch(client, target, name="  Ravi   Kumar ")
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Ravi Kumar"
    listing = {u["email"]: u for u in client.get("/api/users").json()}
    assert listing["ravi@example.com"]["name"] == "Ravi Kumar"
    log = db.query(AuditLog).filter_by(action="Edited user details", entity_id=str(target.id)).one()
    assert log.before_state["name"] == "Rvai Kumar" and log.after_state["name"] == "Ravi Kumar"


def test_signed_in_persons_email_is_locked(client, db):
    login_user(client, db, email="head@example.com")
    target = _person(db, "ravi@example.com", name="Ravi")
    r = _patch(client, target, email="other@example.com")
    assert r.status_code == 409
    db.refresh(target)
    assert target.email == "ravi@example.com" and target.external_subject == "user_ravi@example.com"


def test_invited_persons_wrong_email_is_fixed_and_a_new_invite_is_sent(client, db, monkeypatch):
    from app.users import invites as inv
    sent = []
    monkeypatch.setattr(inv, "send_invite_email", lambda **kw: (sent.append(kw) or (True, "sent")))
    login_user(client, db, email="head@example.com")
    target = _person(db, "vikas@exmaple.com", name="Vikas", invited=True)
    r = _patch(client, target, email="Vikas.S@Gmail.com")
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "Vikas.S@Gmail.com" and r.json()["email_sent"] is True and r.json()["invited"] is True
    assert sent[0]["to_email"] == "Vikas.S@Gmail.com"
    db.refresh(target)
    # The pending invite now matches the corrected mailbox at first sign-in.
    assert target.external_subject == "invite:vikass@gmail.com"


def test_email_already_used_by_someone_else_is_rejected(client, db):
    login_user(client, db, email="head@example.com")
    _person(db, "ramkumar@gmail.com", name="Ram Kumar")
    target = _person(db, "typo@example.com", name="Other", invited=True)
    for taken in ("RAMKUMAR@gmail.com", "ram.kumar+site@googlemail.com"):
        r = _patch(client, target, email=taken)
        assert r.status_code == 409, taken
    assert _patch(client, target, email="not-an-email").status_code == 422
    db.refresh(target)
    assert target.email == "typo@example.com"


def test_stale_edit_is_rejected(client, db):
    login_user(client, db, email="head@example.com")
    target = _person(db, "a@example.com", name="Anil")
    r = _patch(client, target, name="Anil Sharma", expected_name="Someone Else")
    assert r.status_code == 409
    db.refresh(target)
    assert target.display_name == "Anil"


def test_name_cannot_be_empty_or_copy_another_active_person(client, db):
    login_user(client, db, email="head@example.com")
    _person(db, "x@example.com", name="Suresh Patel")
    _person(db, "old@example.com", name="Mahesh", active=False)
    target = _person(db, "y@example.com", name="Sursh")
    assert _patch(client, target, name="   ").status_code == 422
    assert _patch(client, target, name="suresh patel").status_code == 409
    assert _patch(client, target, name="Mahesh").status_code == 200  # only active people block a name


def test_rename_carries_to_assigned_tickets_and_tasks_without_touching_others(client, db):
    login_user(client, db, email="head@example.com")
    target = _person(db, "ravi@example.com", name="Rvai")
    other = _person(db, "o@example.com", name="Other")
    mine = Issue(ticket_no="T-1", description="d", severity="High", assignee_text="Rvai", assigned_to=target.id)
    legacy = Issue(ticket_no="T-2", description="d", severity="High", assignee_text=" rvai ")
    theirs = Issue(ticket_no="T-3", description="d", severity="High", assignee_text="Other", assigned_to=other.id)
    task = OMTask(work_order_no="WO-1", task_name="Clean", status="Scheduled", assignee_text="Rvai", assignee_user_id=target.id)
    db.add_all([mine, legacy, theirs, task]); db.commit()
    stamp = db.get(Issue, mine.id).updated_at
    r = _patch(client, target, name="Ravi")
    assert r.status_code == 200, r.text
    assert r.json()["renamed_assignments"] == 3
    db.expire_all()
    assert [db.get(Issue, x.id).assignee_text for x in (mine, legacy, theirs)] == ["Ravi", "Ravi", "Other"]
    assert db.get(OMTask, task.id).assignee_text == "Ravi"
    assert db.get(Issue, mine.id).updated_at == stamp  # a name fix is not ticket activity


def test_unlinked_text_rows_are_left_alone_when_the_old_name_is_shared(client, db):
    login_user(client, db, email="head@example.com")
    target = _person(db, "a@example.com", name="Amit")
    _person(db, "b@example.com", name="Amit", active=False)
    legacy = Issue(ticket_no="T-9", description="d", severity="Low", assignee_text="Amit")
    db.add(legacy); db.commit()
    assert _patch(client, target, name="Amit Verma").status_code == 200
    db.expire_all()
    assert db.get(Issue, legacy.id).assignee_text == "Amit"


def test_only_head_can_edit_people(client, db):
    login_user(client, db, role="Assignee", email="a@example.com")
    target = _person(db, "t@example.com", name="T")
    assert _patch(client, target, name="New").status_code == 403


def test_head_corrected_name_survives_first_sign_in(client, db, monkeypatch):
    login_user(client, db, email="head@example.com")
    invited = _person(db, "staff@example.com", name="Sollar", role="Site Engineer", invited=True)
    assert _patch(client, invited, name="Solar Kumar").status_code == 200
    monkeypatch.setattr("app.auth.service._fetch_clerk_user", lambda subject, settings: verified_profile())
    db.expire_all()  # sign-in runs in its own request/session
    user = upsert_clerk_user(db, {"sub": SUBJECT}, CLERK_SETTINGS)
    assert user.id == invited.id and user.external_subject == SUBJECT
    assert user.display_name == "Solar Kumar"
