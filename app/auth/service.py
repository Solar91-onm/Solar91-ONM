from __future__ import annotations

from functools import lru_cache
from typing import Any

import httpx
import jwt
from fastapi import HTTPException, status
from jwt import PyJWKClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.auth.emails import canonical_email, is_gmail_family
from app.core.models import User


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_keys=True, timeout=5)


def verify_supabase_session_token(token: str, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    issuer = settings.supabase_auth_issuer
    secret = (settings.supabase_jwt_secret or "").strip()
    if not settings.supabase_configured or not issuer:
        raise HTTPException(status_code=503, detail="Supabase authentication is not configured")

    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        if algorithm == "HS256" and secret:
            claims = jwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                issuer=issuer,
                audience="authenticated",
                options={"require": ["exp", "sub", "iat", "iss", "aud"]},
                leeway=5,
            )
        else:
            if algorithm not in {"RS256", "ES256", "ES384", "EdDSA"}:
                raise jwt.InvalidAlgorithmError("Unsupported Supabase signing algorithm")
            signing_key_info = _jwks_client(f"{issuer}/.well-known/jwks.json").get_signing_key_from_jwt(token)
            if signing_key_info.algorithm_name and signing_key_info.algorithm_name != algorithm:
                raise jwt.InvalidAlgorithmError("JWT algorithm does not match the Supabase signing key")
            claims = jwt.decode(
                token,
                signing_key_info.key,
                algorithms=[algorithm],
                issuer=issuer,
                audience="authenticated",
                options={"require": ["exp", "sub", "iat", "iss", "aud"]},
                leeway=5,
            )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired Supabase session") from exc

    if not claims.get("sub"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Supabase session missing subject")
    if claims.get("role") != "authenticated":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Supabase session is not authenticated")
    return claims


def verify_session_token(token: str, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    return verify_supabase_session_token(token, settings)


def _fetch_supabase_user(token: str, settings: Settings) -> dict[str, Any]:
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=503, detail="Supabase authentication is not configured")

    try:
        with httpx.Client(timeout=8.0) as client:
            response = client.get(
                f"{settings.supabase_url.rstrip('/')}/auth/v1/user",
                headers={
                    "apikey": settings.supabase_anon_key,
                    "Authorization": f"Bearer {token}",
                },
            )
    except (httpx.RequestError, httpx.InvalidURL) as exc:
        raise HTTPException(status_code=503, detail="Could not verify the authenticated user with Supabase Auth") from exc

    if response.status_code in {401, 403}:
        raise HTTPException(status_code=401, detail="Supabase rejected the authenticated session")
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not verify the authenticated user with Supabase Auth")

    try:
        profile = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Supabase Auth returned an invalid user response") from exc
    if not isinstance(profile, dict):
        raise HTTPException(status_code=503, detail="Supabase Auth returned an invalid user response")
    return profile


def _verified_identity(
    claims: dict[str, Any], access_token: str | None, settings: Settings
) -> str:
    if not access_token:
        raise HTTPException(status_code=401, detail="Authentication required")

    subject = str(claims.get("sub") or "")
    profile = _fetch_supabase_user(access_token, settings)
    profile_subject = profile.get("id")
    if not subject or not isinstance(profile_subject, str) or profile_subject != subject:
        raise HTTPException(status_code=401, detail="Supabase user does not match the authenticated session")

    claim_email = claims.get("email")
    profile_email = profile.get("email")
    if not isinstance(claim_email, str) or not isinstance(profile_email, str):
        raise HTTPException(status_code=401, detail="Supabase session is missing a verified email identity")
    email = profile_email.strip()
    if not email or claim_email.strip().casefold() != email.casefold():
        raise HTTPException(status_code=401, detail="Supabase session email does not match the authenticated user")

    confirmed_at = profile.get("email_confirmed_at")
    if not isinstance(confirmed_at, str) or not confirmed_at.strip():
        raise HTTPException(status_code=403, detail="Verify your email address before accessing this account")
    return email


def upsert_supabase_user(
    db: Session,
    claims: dict[str, Any],
    settings: Settings | None = None,
    *,
    access_token: str | None = None,
) -> User:
    settings = settings or get_settings()
    subject = str(claims.get("sub") or "")
    if not subject:
        raise HTTPException(status_code=401, detail="Supabase session did not include a user identifier")

    user = db.scalar(select(User).where(User.auth_provider == "supabase", User.external_subject == subject))
    if user:
        if not user.is_active:
            raise HTTPException(status_code=403, detail="This Solar91 account is disabled")
        claimed_email = claims.get("email")
        if (
            user.role == "Viewer"
            and isinstance(claimed_email, str)
            and claimed_email.strip().casefold() in settings.admin_emails
        ):
            email = _verified_identity(claims, access_token, settings)
            if email.casefold() in settings.admin_emails:
                user.role = "O&M Head"
                db.commit()
                db.refresh(user)
        return user

    email = _verified_identity(claims, access_token, settings)
    invited_user = db.scalar(
        select(User).where(
            User.auth_provider == "supabase",
            User.external_subject.like("invite:%"),
            func.lower(User.email) == email.lower(),
        )
    )
    if invited_user is None and is_gmail_family(email):
        wanted = canonical_email(email)
        invited_user = next(
            (
                u
                for u in db.scalars(
                    select(User).where(
                        User.auth_provider == "supabase",
                        User.external_subject.like("invite:%"),
                        User.email.ilike("%@gmail.com") | User.email.ilike("%@googlemail.com"),
                    )
                )
                if canonical_email(u.email) == wanted
            ),
            None,
        )
    if invited_user:
        if not invited_user.is_active:
            raise HTTPException(status_code=403, detail="This Solar91 account is disabled")
        invited_user.external_subject = subject
        invited_user.email = email
        db.commit()
        db.refresh(invited_user)
        return invited_user

    display_name = str(claims.get("name") or "").strip() or str(claims.get("full_name") or "").strip() or email
    if not display_name or display_name == "None":
        display_name = email

    role = "Viewer"
    if email.casefold() in settings.admin_emails:
        role = "O&M Head"

    user = User(
        auth_provider="supabase",
        external_subject=subject,
        email=email,
        display_name=display_name,
        role=role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def upsert_user_for_claims(
    db: Session,
    claims: dict[str, Any],
    settings: Settings | None = None,
    *,
    access_token: str | None = None,
) -> User:
    return upsert_supabase_user(db, claims, settings, access_token=access_token)
