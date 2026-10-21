from __future__ import annotations

from functools import lru_cache
from typing import Any
from urllib.parse import quote

import httpx
import jwt
from fastapi import HTTPException, status
from jwt import PyJWKClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.emails import canonical_email, is_gmail_family
from app.core.config import Settings, get_settings
from app.core.models import User


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_keys=True, timeout=5)


def verify_session_token(token: str, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    issuer = settings.clerk_issuer
    if not settings.clerk_configured:
        raise HTTPException(status_code=503, detail="Clerk authentication is not configured")

    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        if algorithm not in {"RS256", "ES256", "ES384", "EdDSA"}:
            raise jwt.InvalidAlgorithmError("Unsupported Clerk signing algorithm")
        signing_key = _jwks_client(f"{issuer}/.well-known/jwks.json").get_signing_key_from_jwt(token)
        if signing_key.algorithm_name and signing_key.algorithm_name != algorithm:
            raise jwt.InvalidAlgorithmError("JWT algorithm does not match the Clerk signing key")
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=[algorithm],
            issuer=issuer,
            options={"require": ["exp", "sub", "iat", "iss"]},
            leeway=5,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired Clerk session") from exc

    if not claims.get("sub") or not claims.get("sid"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Clerk session is missing its identity")
    return claims


def _fetch_clerk_user(subject: str, settings: Settings) -> dict[str, Any]:
    if not settings.clerk_secret_key.strip():
        raise HTTPException(status_code=503, detail="Clerk authentication is not configured")

    try:
        with httpx.Client(timeout=8.0) as client:
            response = client.get(
                f"https://api.clerk.com/v1/users/{quote(subject, safe='')}",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key.strip()}"},
            )
    except (httpx.RequestError, httpx.InvalidURL) as exc:
        raise HTTPException(status_code=503, detail="Could not verify the authenticated user with Clerk") from exc

    if response.status_code == 404:
        raise HTTPException(status_code=401, detail="Clerk rejected the authenticated session")
    if response.status_code in {401, 403}:
        raise HTTPException(status_code=503, detail="Could not verify the authenticated user with Clerk")
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not verify the authenticated user with Clerk")

    try:
        profile = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Clerk returned an invalid user response") from exc
    if not isinstance(profile, dict):
        raise HTTPException(status_code=503, detail="Clerk returned an invalid user response")
    return profile


def _verified_identity(claims: dict[str, Any], settings: Settings) -> tuple[str, str]:
    subject = str(claims.get("sub") or "")
    profile = _fetch_clerk_user(subject, settings)
    if profile.get("id") != subject:
        raise HTTPException(status_code=401, detail="Clerk user does not match the authenticated session")

    email_addresses = profile.get("email_addresses")
    if not isinstance(email_addresses, list):
        raise HTTPException(status_code=401, detail="Clerk user is missing a verified email identity")
    primary_id = profile.get("primary_email_address_id")
    primary = next(
        (
            address for address in email_addresses
            if isinstance(address, dict)
            and address.get("id") == primary_id
            and isinstance(address.get("email_address"), str)
            and isinstance(address.get("verification"), dict)
            and address["verification"].get("status") == "verified"
        ),
        None,
    )
    if primary is None:
        raise HTTPException(status_code=403, detail="Verify your primary email address before accessing this account")
    email = primary["email_address"].strip()
    if not email:
        raise HTTPException(status_code=401, detail="Clerk user is missing a verified email identity")

    name_parts = [profile.get("first_name"), profile.get("last_name")]
    name = " ".join(part.strip() for part in name_parts if isinstance(part, str) and part.strip())
    return email, name


def upsert_clerk_user(
    db: Session,
    claims: dict[str, Any],
    settings: Settings | None = None,
) -> User:
    settings = settings or get_settings()
    subject = str(claims.get("sub") or "")
    if not subject:
        raise HTTPException(status_code=401, detail="Clerk session did not include a user identifier")

    user = db.scalar(select(User).where(User.auth_provider == "clerk", User.external_subject == subject))
    email: str | None = None
    name = ""
    if user is None:
        email, name = _verified_identity(claims, settings)

        candidates = list(
            db.scalars(
                select(User).where(
                    User.auth_provider.in_(("clerk", "supabase")),
                    func.lower(User.email) == email.lower(),
                )
            )
        )
        if not candidates and is_gmail_family(email):
            wanted = canonical_email(email)
            candidates = [
                candidate
                for candidate in db.scalars(
                    select(User).where(
                        User.auth_provider.in_(("clerk", "supabase")),
                        User.email.ilike("%@gmail.com") | User.email.ilike("%@googlemail.com"),
                    )
                )
                if canonical_email(candidate.email or "") == wanted
            ]

        if len(candidates) > 1:
            raise HTTPException(status_code=409, detail="More than one Solar91 account matches this email. Ask your O&M Head to resolve it.")

        matching_invites = [candidate for candidate in candidates if candidate.external_subject.startswith("invite:")]
        legacy_accounts = [
            candidate for candidate in candidates
            if candidate.auth_provider == "supabase" and not candidate.external_subject.startswith("invite:")
        ]
        if matching_invites:
            user = matching_invites[0]
        elif legacy_accounts:
            user = legacy_accounts[0]
        elif candidates:
            raise HTTPException(status_code=409, detail="This email is linked to a different Clerk account. Ask your O&M Head to resolve it.")

        if user is not None:
            if not user.is_active:
                raise HTTPException(status_code=403, detail="This Solar91 account is disabled")
            user.auth_provider = "clerk"
            user.external_subject = subject
            user.email = email
            if name and not (user.metadata_json or {}).get("name_set_by_head"):
                user.display_name = name
            if user.role == "Viewer" and email.casefold() in settings.admin_emails:
                user.role = "O&M Head"
            db.commit()
            db.refresh(user)
            return user

        if email.casefold() not in settings.admin_emails and not settings.allow_unregistered_signin:
            raise HTTPException(
                status_code=403,
                detail="This email is not registered for Solar91. Ask your O&M Head to add you.",
            )

        user = User(
            auth_provider="clerk",
            external_subject=subject,
            email=email,
            display_name=name or email,
            role="O&M Head" if email.casefold() in settings.admin_emails else "Viewer",
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    if not user.is_active:
        raise HTTPException(status_code=403, detail="This Solar91 account is disabled")
    if user.role == "Viewer" and user.email and user.email.casefold() in settings.admin_emails:
        user.role = "O&M Head"
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
    return upsert_clerk_user(db, claims, settings)
