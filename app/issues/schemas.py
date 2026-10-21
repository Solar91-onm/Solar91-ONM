from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

ISSUE_SEVERITIES = {"Critical", "Medium"}
# Issues have two levels. Older rows, files and clients may still say High or Low: High reads as Critical and
# Low as Medium, so nothing stored needs rewriting.
_SEVERITY_ALIASES = {"critical": "Critical", "high": "Critical", "medium": "Medium", "low": "Medium"}
SEVERITY_STORED_AS = {"Critical": ("Critical", "High"), "Medium": ("Medium", "Low")}


def normalize_issue_severity(value: Any) -> Any:
    if isinstance(value, str):
        return _SEVERITY_ALIASES.get(value.strip().casefold(), value)
    return value


def validate_issue_severity(value: Any) -> Any:
    normalized = normalize_issue_severity(value)
    if normalized not in ISSUE_SEVERITIES:
        raise ValueError("severity must be Critical or Medium")
    return normalized


class IssueCreate(BaseModel):
    ticket_no: str | None = Field(default=None, min_length=1, max_length=80)
    plant_id: UUID | None = None
    equipment_id: UUID | None = None
    equipment_ref: str | None = None
    vertical: str | None = None
    subcategory: str | None = None
    description: str = Field(min_length=1)
    severity: str
    assigned_to: UUID | None = None
    occurred_at: datetime | None = None
    etc_at: datetime | None = None
    maker: str | None = None
    supplier: str | None = None
    serial_number: str | None = None
    impact: str | None = None
    photo_count: int = 0
    # One ticket can cover several registered units of the same plant (e.g. four inverters with the same fault).
    unit_ids: list[UUID] = Field(default_factory=list, max_length=500)

    @field_validator("severity", mode="before")
    @classmethod
    def normalize_severity(cls, value: Any) -> Any:
        return validate_issue_severity(value)


class IssueUpdate(BaseModel):
    equipment_id: UUID | None = None
    equipment_ref: str | None = None
    vertical: str | None = None
    subcategory: str | None = None
    description: str | None = None
    severity: str | None = None
    occurred_at: datetime | None = None
    etc_at: datetime | None = None
    maker: str | None = None
    impact: str | None = None
    change_reason: str | None = Field(default=None, max_length=500)

    @field_validator("severity", mode="before")
    @classmethod
    def normalize_severity(cls, value: Any) -> Any:
        return None if value is None else validate_issue_severity(value)


class IssueDeleteRequest(BaseModel):
    reason: str = Field(min_length=8, max_length=500)
    confirm_ticket: str = Field(min_length=1, max_length=80)


class IssueRestoreRequest(BaseModel):
    reason: str = Field(min_length=8, max_length=500)


class AssignmentRequest(BaseModel):
    assignee_text: str | None = None          # display name; used only when assigned_to is not sent
    assigned_to: UUID | None = None           # the Assignee's user id (preferred)
    vendor: dict[str, Any] | None = None
    note: str | None = None


class ProgressRequest(BaseModel):
    note: str = Field(min_length=1, max_length=4000)
    parts: str | None = None
    hours: float | None = Field(default=None, ge=0)
    inventory_item_id: str | None = None
    quantity: float | None = Field(default=None, gt=0)
    work_date: date | None = None
    day_status: str = Field(default="Worked", max_length=80)
    next_step: str | None = Field(default=None, max_length=1000)
    next_expected_on: date | None = None
    step_ids_done: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("day_status")
    @classmethod
    def validate_day_status(cls, value: str) -> str:
        allowed = {
            "Worked", "Waiting for parts", "Waiting for vendor",
            "Waiting for shutdown or access", "Weather or site condition", "No work today",
        }
        if value not in allowed:
            raise ValueError("Choose a valid daily work status")
        return value


class ResolveRequest(BaseModel):
    note: str | None = None
    root_cause: str = Field(min_length=1, max_length=4000)
    corrective_action: str = Field(min_length=1, max_length=4000)
    evidence_ids: list[str] = Field(min_length=1, max_length=10)
    fixed_on: date | None = None
    remark: str | None = Field(default=None, max_length=4000)


class IssueStepCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    position: int | None = Field(default=None, ge=0, le=1000)


class IssueStepUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    position: int | None = Field(default=None, ge=0, le=1000)
    done: bool | None = None
    done_on: date | None = None
    remark: str | None = Field(default=None, max_length=1000)


class IssueETCUpdate(BaseModel):
    new_etc: datetime
    reason: str = Field(min_length=1, max_length=4000)


class IssueDatesUpdate(BaseModel):
    """Change an issue's start date (occurred_at) and/or deadline (etc_at). O&M Head or the assigned Assignee only."""
    occurred_at: datetime | None = None
    etc_at: datetime | None = None
    reason: str = Field(min_length=3, max_length=4000)


ISSUE_MESSAGE_INTENTS = {"update", "work_done", "question", "blocked", "confirm"}


class IssueCommentCreate(BaseModel):
    message: str = Field(default="", max_length=4000)
    evidence_ids: list[str] = Field(default_factory=list, max_length=10)
    intent: str = Field(default="update", max_length=20)

    @field_validator("intent", mode="before")
    @classmethod
    def validate_intent(cls, value: Any) -> Any:
        value = (value or "update").strip() if isinstance(value, str) or value is None else value
        if value not in ISSUE_MESSAGE_INTENTS:
            raise ValueError("intent must be update, work_done, question, blocked or confirm")
        return value


class IssueStatusRequest(BaseModel):
    status: str
    note: str | None = None


class ReopenRequest(BaseModel):
    reason: str | None = None


class CloseRequest(BaseModel):
    note: str | None = None
    closure: dict[str, Any] = Field(default_factory=dict)
    direct: bool = False                      # O&M Head only: close without the resolution step (a reason is required)


class IssueOut(BaseModel):
    model_config=ConfigDict(from_attributes=True)
    id: UUID
    ticket_no: str
    plant_id: UUID | None
    equipment_id: UUID | None
    equipment_ref: str | None
    vertical: str | None
    subcategory: str | None
    description: str
    severity: str
    status: str
    occurred_at: datetime | None
    created_at: datetime
    updated_at: datetime
    etc_at: datetime | None
    fixed_on: date | None = None
    closed_on: date | None = None
    assignee_text: str | None
    assigned_to: UUID | None
    maker: str | None
    impact: str | None
    photo_count: int
    vendor: dict[str, Any] | None
    closure: dict[str, Any] | None
    source_task: str | None
    reopened_from: str | None
    reopen_count: int
    deleted_at: datetime | None = None
    deletion_reason: str | None = None

    @field_validator("severity", mode="before")
    @classmethod
    def normalize_legacy_severity(cls, value: Any) -> Any:
        return normalize_issue_severity(value)

    supplier: str | None = None
    serial_number: str | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    units: list[dict[str, Any]] = Field(default_factory=list)
