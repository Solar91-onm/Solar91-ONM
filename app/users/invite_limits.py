from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.auth.emails import canonical_email
from app.core.config import get_settings
from app.core.models import InviteImportReceipt, InviteRateLimitBucket

WINDOW_SECONDS = 3600
BUCKET_RETENTION = timedelta(days=7)


def _insert_for(db: Session, model):
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        return postgres_insert(model)
    if dialect == "sqlite":
        return sqlite_insert(model)
    raise RuntimeError("Invite throttling requires PostgreSQL or SQLite.")


def _recipient_key(email: str) -> str:
    canonical = canonical_email(email).casefold()
    return "recipient:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _actor_key(actor_id: UUID, channel: str) -> str:
    bucket = "bulk" if channel == "bulk" else "profile" if channel == "profile" else "direct"
    return f"actor:{bucket}:{actor_id}"


def _recent(events: list[dict[str, Any]], now: int) -> list[dict[str, Any]]:
    return [
        event for event in events
        if isinstance(event, dict) and isinstance(event.get("at"), int) and now - event["at"] < WINDOW_SECONDS
    ]


def _retry_after(events: list[dict[str, Any]], limit: int, added: int, now: int) -> int:
    ordered = sorted(event["at"] for event in events)
    excess = len(ordered) + added - limit
    if excess <= 0 or excess > len(ordered):
        return WINDOW_SECONDS
    return max(1, ordered[excess - 1] + WINDOW_SECONDS - now)


def _http_429(retry_after: int, detail: str) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail=detail,
        headers={"Retry-After": str(max(1, retry_after))},
    )


def reserve_invite_quota(
    db: Session,
    actor_id: UUID,
    emails: list[str],
    *,
    channel: str,
    commit: bool = True,
) -> None:
    if channel not in {"direct", "resend", "profile", "bulk"}:
        raise ValueError("Unknown invitation channel.")
    recipients = list(dict.fromkeys(_recipient_key(email) for email in emails))
    if not recipients:
        return

    settings = get_settings()
    if channel == "bulk":
        limit = settings.invite_bulk_per_hour
        per_import = settings.invite_bulk_max_per_import
        if len(recipients) > per_import:
            raise HTTPException(422, f"An import may send at most {per_import} invitations.")
    elif channel == "profile":
        limit = settings.invite_profile_per_hour
    else:
        limit = settings.invite_direct_per_hour

    now = int(datetime.now(timezone.utc).timestamp())
    actor_bucket = _actor_key(actor_id, channel)
    keys = sorted(set([actor_bucket, *recipients]))
    db.execute(
        _insert_for(db, InviteRateLimitBucket)
        .values([{"bucket_key": key, "events": []} for key in keys])
        .on_conflict_do_nothing(index_elements=["bucket_key"])
    )
    buckets = db.scalars(
        select(InviteRateLimitBucket)
        .where(InviteRateLimitBucket.bucket_key.in_(keys))
        .order_by(InviteRateLimitBucket.bucket_key)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    by_key = {bucket.bucket_key: bucket for bucket in buckets}
    if len(by_key) != len(keys):
        db.rollback()
        raise RuntimeError("Could not reserve invite rate-limit buckets.")

    recent_by_key = {
        key: _recent(list(by_key[key].events or []), now)
        for key in keys
    }
    retry_after = 0
    actor_events = recent_by_key[actor_bucket]
    if len(actor_events) + len(recipients) > limit:
        retry_after = max(retry_after, _retry_after(actor_events, limit, len(recipients), now))

    for recipient in recipients:
        events = recent_by_key[recipient]
        if len(events) + 1 > settings.invite_recipient_per_hour:
            retry_after = max(
                retry_after,
                _retry_after(events, settings.invite_recipient_per_hour, 1, now),
            )
        if channel == "resend" and settings.invite_resend_cooldown_seconds:
            last_resend = max(
                (event["at"] for event in events if event.get("channel") == "resend"),
                default=None,
            )
            if last_resend is not None:
                wait = last_resend + settings.invite_resend_cooldown_seconds - now
                retry_after = max(retry_after, wait)

    if retry_after:
        db.rollback()
        raise _http_429(retry_after, "Invitation email rate limit exceeded. Try again after the indicated delay.")

    event = {"at": now, "channel": channel}
    by_key[actor_bucket].events = recent_by_key[actor_bucket] + [event] * len(recipients)
    for recipient in recipients:
        by_key[recipient].events = recent_by_key[recipient] + [event]
    db.execute(
        delete(InviteRateLimitBucket).where(
            InviteRateLimitBucket.updated_at < datetime.now(timezone.utc) - BUCKET_RETENTION,
            InviteRateLimitBucket.bucket_key.not_in(keys),
        ).execution_options(synchronize_session=False)
    )
    db.flush()
    if commit:
        db.commit()


def begin_bulk_import(
    db: Session,
    actor_id: UUID,
    payload_hash: str,
    emails: list[str],
) -> dict[str, Any] | None:
    retention = timedelta(hours=get_settings().invite_import_idempotency_hours)
    now = datetime.now(timezone.utc)
    db.execute(
        delete(InviteImportReceipt).where(
            InviteImportReceipt.created_at < now - retention,
            InviteImportReceipt.status != "processing",
        ).execution_options(synchronize_session=False)
    )
    insert = _insert_for(db, InviteImportReceipt)
    result = db.execute(
        insert.values(
            actor_id=actor_id,
            payload_hash=payload_hash,
            status="processing",
            response_json=None,
        ).on_conflict_do_nothing(index_elements=["actor_id", "payload_hash"])
    )
    if not result.rowcount:
        receipt = db.scalar(
            select(InviteImportReceipt)
            .where(
                InviteImportReceipt.actor_id == actor_id,
                InviteImportReceipt.payload_hash == payload_hash,
            )
            .with_for_update()
        )
        status = receipt.status if receipt else None
        response = receipt.response_json if receipt else None
        db.rollback()
        if status == "completed" and response:
            return response
        raise HTTPException(
            409,
            "This import is already processing or did not finish. Do not retry it with the same file.",
        )
    reserve_invite_quota(db, actor_id, emails, channel="bulk", commit=False)
    db.commit()
    return None


def get_bulk_import_response(
    db: Session,
    actor_id: UUID,
    payload_hash: str,
) -> dict[str, Any] | None:
    retention = timedelta(hours=get_settings().invite_import_idempotency_hours)
    expired = db.execute(
        delete(InviteImportReceipt).where(
            InviteImportReceipt.actor_id == actor_id,
            InviteImportReceipt.payload_hash == payload_hash,
            InviteImportReceipt.created_at < datetime.now(timezone.utc) - retention,
            InviteImportReceipt.status != "processing",
        ).execution_options(synchronize_session=False)
    )
    if expired.rowcount:
        db.commit()
    receipt = db.scalar(
        select(InviteImportReceipt).where(
            InviteImportReceipt.actor_id == actor_id,
            InviteImportReceipt.payload_hash == payload_hash,
        )
    )
    if receipt is None:
        return None
    if receipt.status == "completed" and receipt.response_json:
        return receipt.response_json
    raise HTTPException(
        409,
        "This import is already processing or did not finish. Do not retry it with the same file.",
    )


def complete_bulk_import(
    db: Session,
    actor_id: UUID,
    payload_hash: str,
    response: dict[str, Any],
) -> None:
    receipt = db.scalar(
        select(InviteImportReceipt)
        .where(
            InviteImportReceipt.actor_id == actor_id,
            InviteImportReceipt.payload_hash == payload_hash,
        )
        .with_for_update()
    )
    if receipt is None:
        raise RuntimeError("The invitation import reservation disappeared.")
    receipt.status = "completed"
    receipt.response_json = response
    db.commit()


