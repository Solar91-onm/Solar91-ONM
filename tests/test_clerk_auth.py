from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.auth.service import _fetch_clerk_user, upsert_clerk_user, verify_session_token
from app.core.config import Settings
from app.core.models import User


PUBLISHABLE_KEY = "pk_test_c2lsdmVyLWV3ZS0yOS5jbGVyay5hY2NvdW50cy5kZXYk"
ISSUER = "https://silver-ewe-29.clerk.accounts.dev"
SUBJECT = "user_2abc123"
CLERK_SETTINGS = Settings(
    _env_file=None,
    app_env="test",
    clerk_publishable_key=PUBLISHABLE_KEY,
    clerk_secret_key="sk_test_unit_test_only",
    clerk_issuer=ISSUER,
)
ADMIN_SETTINGS = Settings(
    _env_file=None,
    app_env="test",
    clerk_publishable_key=PUBLISHABLE_KEY,
    clerk_secret_key="sk_test_unit_test_only",
    clerk_issuer=ISSUER,
    bootstrap_admin_emails="head@example.com",
)


def issue_token(private_key, **overrides: object) -> str:
    now = datetime.now(timezone.utc)
    claims: dict[str, object] = {
        "iss": ISSUER,
        "sub": SUBJECT,
        "sid": "sess_2abc123",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=10)).timestamp()),
    }
    claims.update(overrides)
    return jwt.encode(claims, private_key, algorithm="EdDSA")


def verified_profile(**overrides: object) -> dict[str, object]:
    profile: dict[str, object] = {
        "id": SUBJECT,
        "primary_email_address_id": "idn_primary",
        "first_name": "Solar",
        "last_name": "Operator",
        "email_addresses": [
            {
                "id": "idn_primary",
                "email_address": "staff@example.com",
                "verification": {"status": "verified", "strategy": "email_code"},
            }
        ],
    }
    profile.update(overrides)
    return profile


def test_clerk_publishable_key_produces_frontend_api_and_configured_state():
    assert CLERK_SETTINGS.clerk_frontend_api == "silver-ewe-29.clerk.accounts.dev"
    assert CLERK_SETTINGS.clerk_configured


@pytest.mark.parametrize(
    "issuer",
    [
        "http://attacker.example",
        "https://clerk.example/v1",
        "https://user:pass@clerk.example",
        "https://clerk.example?issuer=bad",
    ],
)
def test_clerk_issuer_rejects_non_origin_values(issuer):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, clerk_issuer=issuer)


def test_valid_clerk_session_token_is_accepted(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private_key = Ed25519PrivateKey.generate()

    class SigningKey:
        algorithm_name = "EdDSA"
        key = private_key.public_key()

    class Jwks:
        @staticmethod
        def get_signing_key_from_jwt(_token):
            return SigningKey()

    monkeypatch.setattr("app.auth.service._jwks_client", lambda url: Jwks())
    claims = verify_session_token(issue_token(private_key), CLERK_SETTINGS)
    assert claims["sub"] == SUBJECT
    assert claims["sid"] == "sess_2abc123"


def test_invalid_clerk_token_is_rejected(monkeypatch):
    class Jwks:
        @staticmethod
        def get_signing_key_from_jwt(_token):
            raise jwt.PyJWKClientError("unknown key")

    monkeypatch.setattr("app.auth.service._jwks_client", lambda url: Jwks())
    with pytest.raises(HTTPException) as exc:
        verify_session_token("invalid.token.value", CLERK_SETTINGS)
    assert exc.value.status_code == 401


def test_clerk_user_lookup_uses_secret_server_side_api(monkeypatch):
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
            assert url == f"https://api.clerk.com/v1/users/{SUBJECT}"
            assert headers == {"Authorization": "Bearer sk_test_unit_test_only"}
            return Response()

    monkeypatch.setattr("app.auth.service.httpx.Client", Client)
    assert _fetch_clerk_user(SUBJECT, CLERK_SETTINGS) == expected_profile


def test_verified_clerk_identity_promotes_invite_preserving_access(db, monkeypatch):
    invited = User(
        auth_provider="clerk",
        external_subject="invite:staff@example.com",
        email="staff@example.com",
        display_name="Invited Operator",
        role="Site Engineer",
        is_active=True,
    )
    db.add(invited)
    db.commit()
    monkeypatch.setattr("app.auth.service._fetch_clerk_user", lambda subject, settings: verified_profile())

    user = upsert_clerk_user(db, {"sub": SUBJECT}, CLERK_SETTINGS)
    assert user.id == invited.id
    assert user.auth_provider == "clerk"
    assert user.external_subject == SUBJECT
    assert user.role == "Site Engineer"
    assert user.display_name == "Solar Operator"


def test_verified_clerk_identity_migrates_existing_supabase_user(db, monkeypatch):
    existing = User(
        auth_provider="supabase",
        external_subject="legacy-supabase-subject",
        email="staff@example.com",
        display_name="Legacy Operator",
        role="Assignee",
        is_active=True,
    )
    db.add(existing)
    db.commit()
    monkeypatch.setattr("app.auth.service._fetch_clerk_user", lambda subject, settings: verified_profile())

    user = upsert_clerk_user(db, {"sub": SUBJECT}, CLERK_SETTINGS)
    assert user.id == existing.id
    assert user.auth_provider == "clerk"
    assert user.external_subject == SUBJECT
    assert user.role == "Assignee"


def test_unverified_clerk_primary_email_cannot_claim_invite(db, monkeypatch):
    invited = User(
        auth_provider="clerk",
        external_subject="invite:staff@example.com",
        email="staff@example.com",
        display_name="Invited Operator",
        role="Assignee",
        is_active=True,
    )
    db.add(invited)
    db.commit()
    profile = verified_profile(
        email_addresses=[
            {
                "id": "idn_primary",
                "email_address": "staff@example.com",
                "verification": {"status": "unverified", "strategy": "email_code"},
            }
        ]
    )
    monkeypatch.setattr("app.auth.service._fetch_clerk_user", lambda subject, settings: profile)

    with pytest.raises(HTTPException) as exc:
        upsert_clerk_user(db, {"sub": SUBJECT}, CLERK_SETTINGS)
    assert exc.value.status_code == 403
    db.refresh(invited)
    assert invited.external_subject == "invite:staff@example.com"


def test_unknown_clerk_user_is_not_provisioned_without_allowlist(db, monkeypatch):
    monkeypatch.setattr("app.auth.service._fetch_clerk_user", lambda subject, settings: verified_profile())
    with pytest.raises(HTTPException) as exc:
        upsert_clerk_user(db, {"sub": SUBJECT}, CLERK_SETTINGS)
    assert exc.value.status_code == 403
    assert db.query(User).count() == 0


def test_bootstrap_admin_is_provisioned_from_verified_email(db, monkeypatch):
    monkeypatch.setattr(
        "app.auth.service._fetch_clerk_user",
        lambda subject, settings: verified_profile(
            email_addresses=[
                {
                    "id": "idn_primary",
                    "email_address": "head@example.com",
                    "verification": {"status": "verified", "strategy": "email_code"},
                }
            ]
        ),
    )
    user = upsert_clerk_user(db, {"sub": SUBJECT}, ADMIN_SETTINGS)
    assert user.auth_provider == "clerk"
    assert user.role == "O&M Head"
    assert user.email == "head@example.com"


def test_inactive_existing_account_remains_blocked(db, monkeypatch):
    existing = User(
        auth_provider="clerk",
        external_subject=SUBJECT,
        email="staff@example.com",
        display_name="Disabled",
        role="Assignee",
        is_active=False,
    )
    db.add(existing)
    db.commit()
    with pytest.raises(HTTPException) as exc:
        upsert_clerk_user(db, {"sub": SUBJECT}, CLERK_SETTINGS)
    assert exc.value.status_code == 403


def test_public_auth_configuration_and_portal_shell_use_clerk(client, monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_publishable_key", PUBLISHABLE_KEY)
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_unit_test_only")
    monkeypatch.setattr(settings, "clerk_issuer", ISSUER)
    configuration = client.get("/api/auth/config")
    assert configuration.status_code == 200
    assert configuration.json()["provider"] == "clerk"
    assert "secret_key" not in configuration.json()

    page = client.get("/")
    assert page.status_code == 200
    assert '"authProvider": "clerk"' in page.text
    assert "@clerk/clerk-js@6" in page.text
    assert "silver-ewe-29.clerk.accounts.dev" in page.text
    assert "supabase-js" not in page.text
