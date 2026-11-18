from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, aliased

from app.core.database import get_db
from app.core.models import Plant, RequirementTicket, User
from app.core.security import require_csrf, require_permission, user_scoped_plant_ids

router = APIRouter(prefix="/api/requirements", tags=["Requirements"])
MANAGER_ROLES = {"O&M Head", "Assignee", "Administration"}


def _demand_count(description: str) -> int:
    return sum(1 for line in description.splitlines() if line.strip())


class RequirementCreate(BaseModel):
    plant_id: UUID
    description: str = Field(min_length=1, max_length=5000)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter at least one requirement")
        return value


class RequirementPriorityUpdate(BaseModel):
    priority: Literal["Critical", "Medium", "Low"]


class RequirementStatusUpdate(BaseModel):
    status: Literal["Open", "Completed"]


class RequirementUpdate(BaseModel):
    description: str = Field(min_length=1, max_length=5000)
    priority: Literal["Critical", "Medium", "Low"]
    status: Literal["Open", "Completed"]

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter at least one requirement")
        return value


class RequirementOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: UUID
    ticket_no: str = Field(serialization_alias="ticketNo")
    plant_id: UUID | None = Field(serialization_alias="plantId")
    site_code: str = Field(serialization_alias="siteCode")
    description: str
    demand_count: int = Field(serialization_alias="demandCount")
    priority: str
    status: str
    created_by_name: str | None = Field(serialization_alias="createdByName")
    created_at: datetime = Field(serialization_alias="createdAt")
    completed_by_name: str | None = Field(serialization_alias="completedByName")
    completed_at: datetime | None = Field(serialization_alias="completedAt")


class RequirementPage(BaseModel):
    items: list[RequirementOut]
    total: int
    offset: int
    limit: int


def _requirement_dict(
    ticket: RequirementTicket,
    created_by_name: str | None,
    completed_by_name: str | None,
) -> dict[str, object]:
    return {
        "id": ticket.id,
        "ticket_no": ticket.ticket_no,
        "plant_id": ticket.plant_id,
        "site_code": ticket.site_code,
        "description": ticket.description,
        "demand_count": ticket.demand_count,
        "priority": ticket.priority,
        "status": ticket.status,
        "created_by_name": created_by_name,
        "created_at": ticket.created_at,
        "completed_by_name": completed_by_name,
        "completed_at": ticket.completed_at,
    }


def _scoped_ticket(db: Session, user: User, ticket_id: UUID) -> RequirementTicket:
    ticket = db.get(RequirementTicket, ticket_id)
    if ticket is None:
        raise HTTPException(404, "Requirement ticket not found")
    scope = user_scoped_plant_ids(db, user)
    if scope is not None and ticket.plant_id not in scope:
        raise HTTPException(404, "Requirement ticket not found")
    return ticket


@router.get("", response_model=RequirementPage)
def list_requirements(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("requirements.view"))],
    status: Literal["Open", "Completed"] | None = None,
    filter_site_code: str | None = None,
    filter_description: str | None = None,
    filter_status: Literal["Open", "Completed"] | None = None,
    filter_demand_count: int | None = Query(None, ge=1),
    filter_priority: Literal["Critical", "Medium", "Low"] | None = None,
    sort_by: Literal["siteCode", "description", "status", "demandCount", "priority"] = "siteCode",
    sort_dir: Literal["asc", "desc"] = "asc",
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
):
    scope = user_scoped_plant_ids(db, user)
    filters = []
    if scope is not None:
        if not scope:
            return {"items": [], "total": 0, "offset": offset, "limit": limit}
        filters.append(RequirementTicket.plant_id.in_(scope))
    if status:
        filters.append(RequirementTicket.status == status)
    if filter_site_code:
        filters.append(RequirementTicket.site_code == filter_site_code)
    if filter_description:
        filters.append(RequirementTicket.description == filter_description)
    if filter_status:
        filters.append(RequirementTicket.status == filter_status)
    if filter_demand_count is not None:
        filters.append(RequirementTicket.demand_count == filter_demand_count)
    if filter_priority:
        filters.append(RequirementTicket.priority == filter_priority)

    total = int(db.scalar(select(func.count(RequirementTicket.id)).where(*filters)) or 0)
    creator = aliased(User)
    completer = aliased(User)
    sort_columns = {
        "siteCode": RequirementTicket.site_code,
        "description": RequirementTicket.demand_count,
        "status": RequirementTicket.status,
        "demandCount": RequirementTicket.demand_count,
        "priority": case(
            (RequirementTicket.priority == "Critical", 3),
            (RequirementTicket.priority == "Medium", 2),
            else_=1,
        ),
    }
    sort_column = sort_columns[sort_by]
    sort_expression = sort_column.desc() if sort_dir == "desc" else sort_column.asc()
    rows = db.execute(
        select(
            RequirementTicket,
            creator.display_name,
            completer.display_name,
        )
        .outerjoin(creator, creator.id == RequirementTicket.created_by)
        .outerjoin(completer, completer.id == RequirementTicket.completed_by)
        .where(*filters)
        .order_by(sort_expression, RequirementTicket.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "items": [_requirement_dict(ticket, creator, completer) for ticket, creator, completer in rows],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@router.post("", response_model=RequirementOut, status_code=201, dependencies=[Depends(require_csrf)])
def create_requirement(
    data: RequirementCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("requirements.create"))],
):
    plant = db.get(Plant, data.plant_id)
    if plant is None:
        raise HTTPException(404, "Plant not found")
    scope = user_scoped_plant_ids(db, user)
    if scope is not None and plant.id not in scope:
        raise HTTPException(403, "This plant is outside your assigned plants")

    ticket_id = uuid4()
    ticket = RequirementTicket(
        id=ticket_id,
        ticket_no=f"REQ-{ticket_id.hex[:12].upper()}",
        plant_id=plant.id,
        site_code=plant.site_code,
        description=data.description,
        demand_count=_demand_count(data.description),
        priority="Medium",
        status="Open",
        created_by=user.id,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    return _requirement_dict(ticket, user.display_name, None)


@router.patch(
    "/{ticket_id}",
    response_model=RequirementOut,
    dependencies=[Depends(require_csrf)],
)
def update_requirement(
    ticket_id: UUID,
    data: RequirementUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("requirements.manage"))],
):
    ticket = _scoped_ticket(db, user, ticket_id)
    if user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Only an Administrator, Assignee or O&M Head can edit requirements")

    ticket.description = data.description
    ticket.demand_count = _demand_count(data.description)
    ticket.priority = data.priority
    ticket.status = data.status
    if data.status == "Completed":
        ticket.completed_by = ticket.completed_by or user.id
        ticket.completed_at = ticket.completed_at or datetime.now(timezone.utc)
    else:
        ticket.completed_by = None
        ticket.completed_at = None
    db.commit()
    db.refresh(ticket)
    creator = db.get(User, ticket.created_by) if ticket.created_by else None
    completer = db.get(User, ticket.completed_by) if ticket.completed_by else None
    return _requirement_dict(
        ticket,
        creator.display_name if creator else None,
        completer.display_name if completer else None,
    )


@router.patch(
    "/{ticket_id}/priority",
    response_model=RequirementOut,
    dependencies=[Depends(require_csrf)],
)
def update_requirement_priority(
    ticket_id: UUID,
    data: RequirementPriorityUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("requirements.manage"))],
):
    ticket = _scoped_ticket(db, user, ticket_id)
    if user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Only an Assignee or O&M Head can set requirement priority")
    ticket.priority = data.priority
    db.commit()
    db.refresh(ticket)
    creator = db.get(User, ticket.created_by) if ticket.created_by else None
    completer = db.get(User, ticket.completed_by) if ticket.completed_by else None
    return _requirement_dict(
        ticket,
        creator.display_name if creator else None,
        completer.display_name if completer else None,
    )


@router.patch(
    "/{ticket_id}/status",
    response_model=RequirementOut,
    dependencies=[Depends(require_csrf)],
)
def update_requirement_status(
    ticket_id: UUID,
    data: RequirementStatusUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("requirements.manage"))],
):
    ticket = _scoped_ticket(db, user, ticket_id)
    if user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Only an Assignee or O&M Head can change requirement status")
    ticket.status = data.status
    if data.status == "Completed":
        ticket.completed_by = user.id
        ticket.completed_at = datetime.now(timezone.utc)
    else:
        ticket.completed_by = None
        ticket.completed_at = None
    db.commit()
    db.refresh(ticket)
    creator = db.get(User, ticket.created_by) if ticket.created_by else None
    completer = db.get(User, ticket.completed_by) if ticket.completed_by else None
    return _requirement_dict(
        ticket,
        creator.display_name if creator else None,
        completer.display_name if completer else None,
    )
