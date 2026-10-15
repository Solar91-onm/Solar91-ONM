from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException

from app.auth.service import _fetch_supabase_user, upsert_supabase_user, verify_session_token
from app.core.config import Settings
from app.core.models import Plant, User, UserPlantAssignment


JWT_SECRET = "unit-test-only-supabase-signing-secret"
AUTH_SUBJECT = "8f69f77b-03fb-45c5-82af-f2685c975a01"
AUTH_SETTINGS = Settings(
    app_env="test",
    supabase_url="https://solar91-test.supabase.co",
    supabase_anon_key="test-anon-key",
    supabase_jwt_secret=JWT_SECRET,
)
OPEN_SETTINGS = Settings(app_env="test", supabase_url="https://solar91-test.supabase.co", supabase_anon_key="test-anon-key",
                         supabase_jwt_secret=JWT_SECRET, allow_unregistered_signin=True)
ADMIN_SETTINGS = Settings(
    app_env="test",
    supabase_url="https://solar91-test.supabase.co",
    supabase_anon_key="test-anon-key",
    supabase_jwt_secret=JWT_SECRET,
    bootstrap_admin_emails="head@example.com",
)


def issue_token(**overrides: object) -> str:
    now = datetime.now(timezone.utc)
    claims: dict[str, object] = {
        "iss": "https://solar91-test.supabase.co/auth/v1",
        "aud": "authenticated",
        "sub": AUTH_SUBJECT,
        "role": "authenticated",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=10)).timestamp()),
        "email": "staff@example.com",
    }
    claims.update(overrides)
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def verified_profile(**overrides: object) -> dict[str, object]:
    profile: dict[str, object] = {
        "id": AUTH_SUBJECT,
        "email": "staff@example.com",
        "email_confirmed_at": "2026-10-12T00:00:00Z",
    }
    profile.update(overrides)
    return profile


def test_valid_supabase_token_is_accepted():
    claims = verify_session_token(issue_token(), AUTH_SETTINGS)
    assert claims["sub"] == AUTH_SUBJECT
    assert claims["role"] == "authenticated"


@pytest.mark.parametrize(
    "token",
    [
        "",
        "not-a-jwt",
        issue_token(exp=int((datetime.now(timezone.utc) - timedelta(minutes=1)).timestamp())),
        jwt.encode(
            {
                "iss": "https://solar91-test.supabase.co/auth/v1",
                "aud": "authenticated",
                "sub": "test-user",
                "role": "authenticated",
                "iat": int(datetime.now(timezone.utc).timestamp()),
                "exp": int((datetime.now(timezone.utc) + timedelta(minutes=10)).timestamp()),
            },
            "different-test-secret",
            algorithm="HS256",
        ),
        issue_token(aud="other-service"),
        issue_token(iss="https://attacker.example/auth/v1"),
        issue_token(iss="https://api.clerk.com"),
        issue_token(role="service_role"),
        issue_token(sub=""),
    ],
)
def test_invalid_supabase_tokens_are_rejected(token: str):
    with pytest.raises(HTTPException) as exc:
        verify_session_token(token, AUTH_SETTINGS)
    assert exc.value.status_code == 401


def test_missing_supabase_auth_configuration_fails_closed():
    settings = Settings(
        _env_file=None,
        app_env="test",
        supabase_url="",
        supabase_anon_key="",
        supabase_service_role_key="",
        supabase_jwt_secret="",
    )

    with pytest.raises(HTTPException) as exc:
        verify_session_token(issue_token(), settings)

    assert exc.value.status_code == 503


def test_authoritative_user_lookup_uses_supabase_auth_endpoint(monkeypatch):
    expected_profile = verified_profile()

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return expected_profile

    class Client:
        def __init__(self, timeout):
            assert timeout == 8.0

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return False

        @staticmethod
        def get(url, headers):
            assert url == "https://solar91-test.supabase.co/auth/v1/user"
            assert headers == {
                "apikey": "test-anon-key",
                "Authorization": "Bearer verified-session-token",
            }
            return Response()

    monkeypatch.setattr("app.auth.service.httpx.Client", Client)
    assert _fetch_supabase_user("verified-session-token", AUTH_SETTINGS) == expected_profile


def test_public_auth_configuration_and_portal_shell_use_supabase(client):
    configuration = client.get("/api/auth/config")
    assert configuration.status_code == 200
    assert configuration.json()["provider"] == "supabase"
    assert "legacy_clerk_enabled" not in configuration.json()

    page = client.get("/")
    assert page.status_code == 200
    assert "@supabase/supabase-js@2.57.0" in page.text
    assert "supabaseClient" in page.text


def test_user_metadata_cannot_grant_application_privileges(db, monkeypatch):
    monkeypatch.setattr("app.auth.service._fetch_supabase_user", lambda token, settings: verified_profile())
    user = upsert_supabase_user(
        db,
        {
            "sub": AUTH_SUBJECT,
            "email": "staff@example.com",
            "role": "authenticated",
            "app_metadata": {"role": "O&M Head"},
            "user_metadata": {"role": "O&M Head"},
        },
        OPEN_SETTINGS,
        access_token="verified-session-token",
    )
    assert user.auth_provider == "supabase"
    assert user.role == "Viewer"
    assert user.metadata_json == {}


def test_unverified_allowlisted_email_cannot_obtain_admin_role(db, monkeypatch):
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(email="head@example.com", email_confirmed_at=None),
    )
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(
            db,
            {"sub": AUTH_SUBJECT, "email": "head@example.com"},
            ADMIN_SETTINGS,
            access_token="unverified-session-token",
        )
    assert exc.value.status_code == 403
    assert db.query(User).count() == 0


def test_verified_allowlisted_email_is_provisioned_as_admin(db, monkeypatch):
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(email="head@example.com"),
    )
    user = upsert_supabase_user(
        db,
        {"sub": AUTH_SUBJECT, "email": "head@example.com", "app_metadata": {"role": "Viewer"}},
        ADMIN_SETTINGS,
        access_token="verified-session-token",
    )
    assert user.role == "O&M Head"
    assert user.email == "head@example.com"
    assert user.metadata_json == {}


def test_existing_bootstrap_viewer_is_promoted_only_after_authoritative_verification(db, monkeypatch):
    existing = User(
        auth_provider="supabase",
        external_subject=AUTH_SUBJECT,
        email="head@example.com",
        display_name="Bootstrap Head",
        role="Viewer",
        is_active=True,
    )
    db.add(existing)
    db.commit()
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(email="head@example.com", email_confirmed_at=None),
    )
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(
            db,
            {"sub": AUTH_SUBJECT, "email": "head@example.com"},
            ADMIN_SETTINGS,
            access_token="unverified-session-token",
        )
    assert exc.value.status_code == 403
    db.refresh(existing)
    assert existing.role == "Viewer"

    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(email="head@example.com"),
    )
    promoted = upsert_supabase_user(
        db,
        {"sub": AUTH_SUBJECT, "email": "head@example.com"},
        ADMIN_SETTINGS,
        access_token="verified-session-token",
    )
    assert promoted.role == "O&M Head"


def test_unverified_email_cannot_claim_invitation(db, monkeypatch):
    invited = User(
        auth_provider="supabase",
        external_subject="invite:engineer@example.com",
        email="engineer@example.com",
        display_name="Invited Engineer",
        role="Site Engineer",
        is_active=True,
    )
    db.add(invited)
    db.commit()
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(
            email="engineer@example.com",
            email_confirmed_at=None,
        ),
    )
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(
            db,
            {"sub": AUTH_SUBJECT, "email": "engineer@example.com"},
            AUTH_SETTINGS,
            access_token="unverified-session-token",
        )
    assert exc.value.status_code == 403
    db.refresh(invited)
    assert invited.external_subject == "invite:engineer@example.com"
    assert db.query(User).count() == 1


def test_verified_invited_user_claims_correct_invitation_without_losing_scope(db, monkeypatch):
    plant = Plant(site_code="AUTH01", plant_name="Auth Scope Plant")
    invited = User(
        auth_provider="supabase",
        external_subject="invite:engineer@example.com",
        email="engineer@example.com",
        display_name="Invited Engineer",
        role="Site Engineer",
        is_active=True,
    )
    db.add_all([plant, invited])
    db.commit()
    db.add(UserPlantAssignment(user_id=invited.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(email="ENGINEER@example.com"),
    )
    authenticated = upsert_supabase_user(
        db,
        {"sub": AUTH_SUBJECT, "email": "engineer@example.com"},
        AUTH_SETTINGS,
        access_token="verified-session-token",
    )
    assert authenticated.id == invited.id
    assert authenticated.external_subject == AUTH_SUBJECT
    assert authenticated.role == "Site Engineer"
    assert db.query(UserPlantAssignment).filter_by(user_id=invited.id, plant_id=plant.id).count() == 1


def test_disabled_invited_user_remains_blocked(db, monkeypatch):
    invited = User(
        auth_provider="supabase",
        external_subject="invite:engineer@example.com",
        email="engineer@example.com",
        display_name="Disabled Engineer",
        role="Site Engineer",
        is_active=False,
    )
    db.add(invited)
    db.commit()
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(email="engineer@example.com"),
    )
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(
            db,
            {"sub": AUTH_SUBJECT, "email": "engineer@example.com"},
            AUTH_SETTINGS,
            access_token="verified-session-token",
        )
    assert exc.value.status_code == 403
    db.refresh(invited)
    assert invited.external_subject == "invite:engineer@example.com"


@pytest.mark.parametrize(
    ("profile_overrides", "claim_email"),
    [
        ({"id": "different-supabase-user"}, "staff@example.com"),
        ({"email": "different@example.com"}, "staff@example.com"),
    ],
)
def test_mismatched_authoritative_identity_is_rejected_without_provisioning(
    db, monkeypatch, profile_overrides, claim_email
):
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: verified_profile(**profile_overrides),
    )
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(
            db,
            {"sub": AUTH_SUBJECT, "email": claim_email},
            AUTH_SETTINGS,
            access_token="verified-session-token",
        )
    assert exc.value.status_code == 401
    assert db.query(User).count() == 0


def test_supabase_auth_failure_does_not_claim_invitation_or_provision_user(db, monkeypatch):
    invited = User(
        auth_provider="supabase",
        external_subject="invite:engineer@example.com",
        email="engineer@example.com",
        display_name="Invited Engineer",
        role="Site Engineer",
        is_active=True,
    )
    db.add(invited)
    db.commit()

    def fail_verification(token, settings):
        raise HTTPException(status_code=503, detail="Supabase Auth unavailable")

    monkeypatch.setattr("app.auth.service._fetch_supabase_user", fail_verification)
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(
            db,
            {"sub": AUTH_SUBJECT, "email": "engineer@example.com"},
            AUTH_SETTINGS,
            access_token="session-token",
        )
    assert exc.value.status_code == 503
    db.refresh(invited)
    assert invited.external_subject == "invite:engineer@example.com"
    assert db.query(User).count() == 1


def test_existing_user_keeps_established_role_and_disabled_restriction(db, monkeypatch):
    existing = User(
        auth_provider="supabase",
        external_subject=AUTH_SUBJECT,
        email="staff@example.com",
        display_name="Existing Engineer",
        role="Site Engineer",
        is_active=True,
    )
    db.add(existing)
    db.commit()
    monkeypatch.setattr(
        "app.auth.service._fetch_supabase_user",
        lambda token, settings: pytest.fail("ordinary existing users do not need email-based provisioning"),
    )
    authenticated = upsert_supabase_user(
        db,
        {"sub": AUTH_SUBJECT, "email": "staff@example.com"},
        AUTH_SETTINGS,
    )
    assert authenticated.id == existing.id
    assert authenticated.role == "Site Engineer"

    existing.is_active = False
    db.commit()
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(db, {"sub": AUTH_SUBJECT}, AUTH_SETTINGS)
    assert exc.value.status_code == 403


def test_unregistered_email_is_refused_and_not_created(db, monkeypatch):
    monkeypatch.setattr("app.auth.service._fetch_supabase_user", lambda token, settings: verified_profile())
    with pytest.raises(HTTPException) as exc:
        upsert_supabase_user(db, {"sub": AUTH_SUBJECT, "email": "staff@example.com"}, AUTH_SETTINGS,
                             access_token="verified-session-token")
    assert exc.value.status_code == 403
    assert db.query(User).count() == 0


def test_pre_added_email_can_sign_in(db, monkeypatch):
    db.add(User(auth_provider="supabase", external_subject="invite:staff@example.com", email="staff@example.com",
                display_name="Staff", role="Assignee", is_active=True))
    db.commit()
    monkeypatch.setattr("app.auth.service._fetch_supabase_user", lambda token, settings: verified_profile())
    user = upsert_supabase_user(db, {"sub": AUTH_SUBJECT, "email": "staff@example.com"}, AUTH_SETTINGS,
                                access_token="verified-session-token")
    assert user.role == "Assignee" and user.external_subject == AUTH_SUBJECT
