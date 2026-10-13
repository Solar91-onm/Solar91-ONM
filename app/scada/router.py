from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.models import Plant, ScadaTelemetry, User
from app.core.security import get_current_user, require_csrf, require_permission, user_scoped_plant_ids

router = APIRouter(prefix="/api/scada", tags=["SCADA"])
settings = get_settings()


class Telemetry(BaseModel):
    siteId: str | None = None
    name: str | None = None
    generation: float | None = None
    availability: float | None = None
    pr: float | None = None
    alarms: int | None = None
    status: str | None = None
    at: datetime | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


def _normalize_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("sites", "data", "telemetry"):
            if isinstance(payload.get(key), list):
                return [x for x in payload[key] if isinstance(x, dict)]
    return []


def _to_telemetry(row: dict[str, Any]) -> Telemetry:
    return Telemetry(
        siteId=row.get("siteId") or row.get("id") or row.get("plantId"),
        name=row.get("name") or row.get("siteName") or row.get("plant"),
        generation=row.get("generation") or row.get("generationmWh") or row.get("energymWh"),
        availability=row.get("availability"),
        pr=row.get("pr") or row.get("performanceRatio"),
        alarms=row.get("alarms") if row.get("alarms") is not None else row.get("alarmCount"),
        status=row.get("status"),
        at=row.get("at") or row.get("timestamp"),
        raw=row,
    )


def _store(db: Session, rows: list[Telemetry], source: str) -> int:
    count = 0
    for r in rows:
        p = None
        if r.siteId:
            p = db.scalar(select(Plant).where(Plant.site_code == r.siteId))
        if not p and r.name:
            p = db.scalar(select(Plant).where(Plant.plant_name == r.name))
        db.add(ScadaTelemetry(
            plant_id=p.id if p else None,
            site_ref=r.siteId or r.name,
            source=source,
            generation=r.generation,
            availability=r.availability,
            performance_ratio=r.pr,
            alarms=r.alarms,
            status=r.status,
            observed_at=r.at or datetime.now(timezone.utc),
            raw_payload=r.raw or r.model_dump(mode="json"),
        ))
        count += 1
    db.commit()
    return count


@router.post("/ingest", dependencies=[Depends(require_csrf)])
def ingest(
    rows: list[Telemetry],
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("plants.manage"))],
):
    return {"accepted": _store(db, rows, "api")}


@router.post("/sync", dependencies=[Depends(require_csrf)])
async def sync_from_provider(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("plants.manage"))],
):
    if not settings.scada_base_url:
        raise HTTPException(503, "SCADA_BASE_URL is not configured on the server")
    url = settings.scada_base_url.rstrip("/") + "/" + settings.scada_telemetry_path.lstrip("/")
    headers = {"Accept": "application/json", "X-Solar91-Schema": "solar91.telemetry.v1"}
    if settings.scada_api_token:
        headers["Authorization"] = f"Bearer {settings.scada_api_token}"
    try:
        async with httpx.AsyncClient(timeout=settings.scada_timeout_seconds) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            raw_rows = _normalize_payload(response.json())
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "SCADA provider request failed") from exc
    rows = [_to_telemetry(x) for x in raw_rows]
    accepted = _store(db, rows, "provider")
    return {"accepted": accepted, "rows": [r.model_dump(mode="json") for r in rows]}


@router.get("/latest")
def latest(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    scope = user_scoped_plant_ids(db, user)
    stmt = select(ScadaTelemetry)
    if scope is not None:
        if not scope:
            return []
        stmt = stmt.where(ScadaTelemetry.plant_id.in_(scope))
    rows = db.scalars(stmt.order_by(ScadaTelemetry.observed_at.desc()).limit(200))
    return [
        {"siteId": x.site_ref, "generation": x.generation, "availability": x.availability, "pr": x.performance_ratio, "alarms": x.alarms, "status": x.status, "at": x.observed_at}
        for x in rows
    ]
