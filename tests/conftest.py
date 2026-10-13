from __future__ import annotations

import os
from pathlib import Path
import tempfile

TEST_DB = Path(tempfile.gettempdir()) / 'solar91_test.sqlite3'
if TEST_DB.exists():
    TEST_DB.unlink()
os.environ['DATABASE_URL'] = f'sqlite:///{TEST_DB.as_posix()}'
os.environ['APP_ENV'] = 'test'

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.models import User
from app.core.security import get_current_user
from app.main import app

_CURRENT_USER: User | None = None


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


def login_user(client: TestClient, db, *, role='O&M Head', name='Test User', email='test@example.com') -> User:
    global _CURRENT_USER
    user = User(auth_provider='supabase', external_subject=f'test:{role}:{email}', email=email, display_name=name, role=role, is_active=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    _CURRENT_USER = user
    return user
