from __future__ import annotations

import os
from pathlib import Path
import tempfile

_TEST_DB_DIR = Path(tempfile.mkdtemp(prefix="solar91-test-"))
TEST_DB = _TEST_DB_DIR / "portal.sqlite3"
os.environ['DATABASE_URL'] = f'sqlite:///{TEST_DB.as_posix()}'
os.environ['APP_ENV'] = 'test'

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.models import Plant, User, UserPlantAssignment, WorkCategory
from app.core.security import get_current_user
from app.main import app

if engine.dialect.name != "sqlite" or engine.url.database != TEST_DB.as_posix():
    raise RuntimeError("Tests require the isolated per-run SQLite database.")

_CURRENT_USER: User | None = None


def pytest_sessionfinish(session, exitstatus):
    engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        path = Path(f"{TEST_DB}{suffix}")
        if path.exists():
            path.unlink()
    _TEST_DB_DIR.rmdir()


def _test_current_user() -> User:
    if _CURRENT_USER is None:
        raise HTTPException(status_code=401, detail='Authentication required')
    return _CURRENT_USER


app.dependency_overrides[get_current_user] = _test_current_user


@pytest.fixture(autouse=True)
def clean_db():
    global _CURRENT_USER
    _CURRENT_USER = None
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    from app.issues.router import invalidate_pulse_cache
    invalidate_pulse_cache()   # each test has a fresh database; a pulse cached by an earlier test must not leak in
    yield
    _CURRENT_USER = None


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client():
    # get_current_user is dependency-overridden in tests, so this bearer value is not
    # verified cryptographically. It exists to exercise the production write-auth rule.
    with TestClient(app, headers={"Authorization": "Bearer test-access-token"}) as c:
        yield c


def grant_assignee_plants(db, user_id, *plant_ids) -> None:
    """Give an Assignee their plant scope.

    Replaces the removed ``UserEquipmentTypeAssignment``: an Assignee used to be scoped
    by equipment type, which exposed every plant. Scope is now explicit plant rows, so
    with no ``plant_ids`` this assigns every plant that currently exists — the same
    visibility the equipment-type setup produced.
    """
    from sqlalchemy import select
    ids = list(plant_ids) or list(db.scalars(select(Plant.id)))
    existing = set(db.scalars(
        select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user_id)
    ))
    for plant_id in ids:
        if plant_id not in existing:
            db.add(UserPlantAssignment(user_id=user_id, plant_id=plant_id, assignment_role="Assignee"))
    db.commit()


DEFAULT_CATEGORIES = ("Inverter", "Module", "Transformer", "Vegetation", "Modules cleaning")


def seed_work_categories(db, *names, sub_problems=None) -> list[str]:
    """Configure work categories for a test.

    The ``work_categories`` table ships empty (the old hard-coded list was removed with
    the asset register), so any test that raises an issue by category or imports a
    spreadsheet has to say which categories exist.
    """
    from sqlalchemy import select
    wanted = list(names) or list(DEFAULT_CATEGORIES)
    existing = {(n or "").casefold() for n in db.scalars(select(WorkCategory.name))}
    for order, name in enumerate(wanted, start=1):
        if name.casefold() not in existing:
            db.add(WorkCategory(name=name, sub_problems=list(sub_problems or []), sort_order=order * 10))
    db.commit()
    return wanted


def login_user(client: TestClient, db, *, role='O&M Head', name='Test User', email='test@example.com') -> User:
    global _CURRENT_USER
    user = User(auth_provider='supabase', external_subject=f'test:{role}:{email}', email=email, display_name=name, role=role, is_active=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    _CURRENT_USER = user
    return user
