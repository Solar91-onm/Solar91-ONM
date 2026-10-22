from __future__ import annotations

from datetime import date
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Literal
from uuid import UUID


ALLOWED_ASSETS = {
    "Inverter", "Module", "Transformer", "Aux. Transformer", "VCB Panel", "VCB-Kiosk",
    "ACCB Panel", "Switchyard - Plant side", "Switchyard - GSS side", "Transmission line",
    "RMS", "WMS", "CCTV", "Boundary wall", "String", "Earthing", "LA", "Water pipe line",
    "Vegetation", "Modules cleaning", "ABT meters", "Street Light", "MMS", "BIKE", "Piling and Foundation", "Other",
    "MCCB", "OLTC(RTCC)", "4 Pole", "VCB - GSS side", "4 Pole - GSS side", "Transmission line - GSS side",
}
ALLOWED_FREQUENCIES = {"Daily", "Weekly", "Monthly", "Quarterly", "Half-yearly", "Annual"}


class ProblemTaskCreate(BaseModel):
    plant_id: str
    asset: str
    problem: str | None = Field(default=None, max_length=255)
    task_name: str = Field(min_length=2, max_length=255)
    equipment_ref: str | None = Field(default=None, max_length=255)
    frequency: str
    due_on: date
    assignee: str | None = Field(default=None, max_length=255)
    sop: str | None = None
    safety: str | None = None
    tools: str | None = None
    duration: str | None = Field(default=None, max_length=120)

    @field_validator("asset")
    @classmethod
    def asset_allowed(cls, value: str) -> str:
        if value not in ALLOWED_ASSETS:
            raise ValueError("Unsupported maintenance category")
        return value

    @field_validator("frequency")
    @classmethod
    def frequency_allowed(cls, value: str) -> str:
        if value not in ALLOWED_FREQUENCIES:
            raise ValueError("Unsupported recurrence frequency")
        return value


class TaskCompletion(BaseModel):
    completed_on: date
    readings: str | None = None
    remarks: str | None = None
    anomaly: bool = False
    checklist: list[str] = Field(default_factory=list)


class TaskReassign(BaseModel):
    assignee: str = Field(min_length=1, max_length=255)
    assignee_user_id: str | None = None


class TaskIssueLink(BaseModel):
    ticket_no: str = Field(min_length=1, max_length=80)


class TaskScheduleEdit(BaseModel):
    """Edit an open Preventive Maintenance task's schedule (O&M Head)."""
    name: str | None = Field(default=None, min_length=1, max_length=255)
    equipment_ref: str | None = Field(default=None, max_length=255)
    frequency: str | None = None
    start_on: date | None = None
    due_on: date | None = None
    quantity: int | None = Field(default=None, ge=1, le=1000000)
    reason: str | None = Field(default=None, max_length=4000)
    assignee: str | None = Field(default=None, max_length=255)
    sop: str | None = None
    safety: str | None = None
    tools: str | None = None
    duration: str | None = Field(default=None, max_length=120)
    steps: list[str] | None = Field(default=None, max_length=80)
    apply_to_similar: bool = False

    @field_validator("steps")
    @classmethod
    def validate_steps(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned=[]
        seen=set()
        for item in value:
            step=item.strip()
            if not step or len(step)>160:
                raise ValueError("Each task step must contain 1-160 characters")
            normalized=step.casefold()
            if normalized in seen:
                raise ValueError("Task steps must be unique")
            seen.add(normalized)
            cleaned.append(step)
        return cleaned


class PMFollowUpCreate(BaseModel):
    how: Literal["Called", "Messaged", "Visited"]
    spoke_to: str | None = Field(default=None, max_length=255)
    outcome: Literal[
        "Will finish by the promised date",
        "Blocked: waiting for shutdown",
        "Blocked: waiting for parts",
        "Blocked: no access",
        "Could not reach anyone",
    ]
    promised_on: date | None = None
    next_follow_up_on: date | None = None
    note: str | None = Field(default=None, max_length=4000)


class TaskUnitPlanEdit(BaseModel):
    total_units: int = Field(ge=1, le=500)
    units_per_day: int = Field(ge=1, le=500)


class WashingSetupRequest(BaseModel):
    plant_id: UUID
    table_count: int = Field(ge=1, le=5000)
    assignee_user_id: UUID
    compliance_threshold_percent: int = Field(default=85, ge=1, le=100)


class WashingDailyReportRequest(BaseModel):
    plant_id: UUID
    tables_cleaned: int = Field(ge=0, le=5000)
    cleaned_table_codes: list[str] = Field(default_factory=list, max_length=5000)
    job_status: Literal["Done", "Not done"]
    exception_reason: Literal["Rain", "Water shortage", "Equipment breakdown", "Access restriction", "Safety stand-down", "Other"] | None = None
    remarks: str | None = Field(default=None, max_length=4000)
    report_date: date | None = None

    @model_validator(mode="after")
    def validate_report(self):
        if self.job_status == "Not done" and self.exception_reason is None:
            raise ValueError("Choose an exception reason for work that was not done")
        if self.job_status == "Done" and self.exception_reason is not None:
            raise ValueError("An exception reason is only valid when the job was not done")
        if self.job_status == "Done" and self.cleaned_table_codes and len(set(self.cleaned_table_codes)) != self.tables_cleaned:
            raise ValueError("Select each cleaned table exactly once")
        if self.job_status == "Done" and self.tables_cleaned < 1:
            raise ValueError("Enter how many tables were cleaned")
        if self.job_status == "Not done" and (self.tables_cleaned or self.cleaned_table_codes):
            raise ValueError("A not-done exception cannot include cleaned tables")
        return self


class WashingSheetEntry(BaseModel):
    """One day of a cycle sheet: how many tables were cleaned that day, or why nothing was done."""
    report_date: date
    tables_cleaned: int = Field(default=0, ge=0, le=5000)
    job_status: Literal["Done", "Not done"]
    exception_reason: Literal["Rain", "Water shortage", "Equipment breakdown", "Access restriction", "Safety stand-down", "Other"] | None = None
    remarks: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_entry(self):
        if self.job_status == "Not done" and self.exception_reason is None:
            raise ValueError("Choose an exception reason for work that was not done")
        if self.job_status == "Done" and self.exception_reason is not None:
            raise ValueError("An exception reason is only valid when the job was not done")
        if self.job_status == "Done" and self.tables_cleaned < 1:
            raise ValueError("Enter how many tables were cleaned")
        if self.job_status == "Not done" and self.tables_cleaned:
            raise ValueError("A not-done exception cannot include cleaned tables")
        return self


class WashingSheetRequest(BaseModel):
    """Several days of one plant saved together (all or nothing)."""
    plant_id: UUID
    entries: list[WashingSheetEntry] = Field(min_length=1, max_length=62)


class WashingReportReviewRequest(BaseModel):
    decision: Literal["Confirm", "Reject"]
    remarks: str | None = Field(default=None, max_length=4000)


class WashingBulkConfirmRequest(BaseModel):
    """Confirm several pending daily reports of one plant at once (all or nothing)."""
    plant_id: UUID
    report_ids: list[UUID] = Field(min_length=1, max_length=100)
    remarks: str | None = Field(default=None, max_length=4000)


class WashingReportUpdateRequest(BaseModel):
    """Edit a washing report. Omitted fields stay as they are."""
    report_date: date | None = None
    job_status: Literal["Done", "Not done"] | None = None
    tables_cleaned: int | None = Field(default=None, ge=0, le=5000)
    exception_reason: Literal["Rain", "Water shortage", "Equipment breakdown", "Access restriction", "Safety stand-down", "Other"] | None = None
    remarks: str | None = Field(default=None, max_length=4000)


class WashingCycleDates(BaseModel):
    cycle_no: int = Field(ge=1, le=3)
    start_date: date
    due_date: date


class WashingCycleScheduleRequest(BaseModel):
    """All three cycles of one month; with apply_to_future the same days repeat every month from this one."""
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    cycles: list[WashingCycleDates] = Field(min_length=3, max_length=3)
    apply_to_future: bool = False


class WashingCycleDateRequest(BaseModel):
    """Move one cycle's start date or deadline. A null date resets it to the default (start 1st / 11th / 21st; deadline 10th / 20th / month-end)."""
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    cycle_no: int = Field(ge=1, le=3)
    field: Literal["due", "start"] = "due"
    due_date: date | None = None
    start_date: date | None = None
