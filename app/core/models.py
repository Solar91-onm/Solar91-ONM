from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, JSON, Numeric, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.core.database import Base
from app.plants.codes import normalize_site_code


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = uuid_pk()
    auth_provider: Mapped[str] = mapped_column(String(80), nullable=False)
    external_subject: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(320))
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(80), default="Viewer")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    __table_args__ = (UniqueConstraint("auth_provider", "external_subject"),)



class Plant(Base, TimestampMixin):
    __tablename__ = "plants"
    id: Mapped[uuid.UUID] = uuid_pk()
    site_code: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    plant_name: Mapped[str] = mapped_column(String(255), nullable=False)
    project_company: Mapped[str | None] = mapped_column(String(255))
    district: Mapped[str | None] = mapped_column(String(120))
    discom: Mapped[str | None] = mapped_column(String(120))
    location: Mapped[str | None] = mapped_column(String(255))
    latitude: Mapped[float | None] = mapped_column(Numeric(10, 7))
    longitude: Mapped[float | None] = mapped_column(Numeric(10, 7))
    dc_capacity_kw: Mapped[float | None] = mapped_column(Numeric(14, 3))
    ac_capacity_kw: Mapped[float | None] = mapped_column(Numeric(14, 3))
    commissioned_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(60), default="active")
    assigned_engineer: Mapped[str | None] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(String(60), default="database")
    custom_fields: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    legacy_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    @validates("site_code")
    def _canonicalize_site_code(self, _key: str, value: str) -> str:
        code = normalize_site_code(value)
        if not code:
            raise ValueError("site_code must contain at least one letter or digit")
        return code


class UserPlantAssignment(Base):
    __tablename__ = "user_plant_assignments"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    plant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"), primary_key=True)
    assignment_role: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserEquipmentAssignment(Base):
    __tablename__ = "user_equipment_assignments"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    equipment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserEquipmentTypeAssignment(Base):
    """Assignee responsibility by equipment TYPE (e.g. Inverter) across every plant."""
    __tablename__ = "user_equipment_type_assignments"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    equipment_type: Mapped[str] = mapped_column(String(120), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Equipment(Base, TimestampMixin):
    __tablename__ = "equipment"
    id: Mapped[uuid.UUID] = uuid_pk()
    plant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"), nullable=False)
    equipment_code: Mapped[str | None] = mapped_column(String(120))
    equipment_name: Mapped[str] = mapped_column(String(255), nullable=False)
    equipment_type: Mapped[str | None] = mapped_column(String(120))
    maker: Mapped[str | None] = mapped_column(String(120))
    model: Mapped[str | None] = mapped_column(String(120))
    serial_number: Mapped[str | None] = mapped_column(String(180))
    status: Mapped[str] = mapped_column(String(60), default="active")
    discom: Mapped[str | None] = mapped_column(String(120))
    feeder_or_gss: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[str | None] = mapped_column(String(120))
    capacity_kw: Mapped[float | None] = mapped_column(Numeric(14, 3))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    location_in_plant: Mapped[str | None] = mapped_column(String(255))
    manufacture_year: Mapped[int | None] = mapped_column(Integer)
    commissioned_on: Mapped[date | None] = mapped_column(Date)
    warranty_start: Mapped[date | None] = mapped_column(Date)
    warranty_end: Mapped[date | None] = mapped_column(Date)
    amc_vendor: Mapped[str | None] = mapped_column(String(255))
    amc_end: Mapped[date | None] = mapped_column(Date)
    supplier: Mapped[str | None] = mapped_column(String(255))
    purchase_order_no: Mapped[str | None] = mapped_column(String(160))
    criticality: Mapped[str | None] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(Text)
    in_charge_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    last_service_on: Mapped[date | None] = mapped_column(Date)
    next_service_due: Mapped[date | None] = mapped_column(Date)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    __table_args__ = (UniqueConstraint("plant_id", "equipment_code"),)


class EquipmentDocument(Base):
    __tablename__ = "equipment_documents"
    id: Mapped[uuid.UUID] = uuid_pk()
    equipment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(80), nullable=False)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Issue(Base):
    __tablename__ = "issues"
    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_no: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    equipment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("equipment.id", ondelete="SET NULL"))
    equipment_ref: Mapped[str | None] = mapped_column(String(255))
    vertical: Mapped[str | None] = mapped_column(String(120))
    subcategory: Mapped[str | None] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(60), default="Open")
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    etc_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fixed_on: Mapped[date | None] = mapped_column(Date)
    closed_on: Mapped[date | None] = mapped_column(Date)
    assignee_text: Mapped[str | None] = mapped_column(String(255))
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    maker: Mapped[str | None] = mapped_column(String(160))
    impact: Mapped[str | None] = mapped_column(Text)
    photo_count: Mapped[int] = mapped_column(Integer, default=0)
    vendor: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    closure: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    source_task: Mapped[str | None] = mapped_column(String(100))
    reopened_from: Mapped[str | None] = mapped_column(String(100))
    reopen_count: Mapped[int] = mapped_column(Integer, default=0)
    legacy_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    deletion_reason: Mapped[str | None] = mapped_column(Text)

    @property
    def supplier(self) -> str | None:
        return (self.legacy_payload or {}).get("supplier")

    @property
    def serial_number(self) -> str | None:
        return (self.legacy_payload or {}).get("serial_number")

    @property
    def evidence(self) -> list[dict[str, Any]]:
        return [
            {key:value for key,value in entry.items() if key!="storage_path"}
            for entry in (self.legacy_payload or {}).get("evidence", [])
            if isinstance(entry,dict)
        ]


class IssueHistory(Base):
    __tablename__ = "issue_history"
    id: Mapped[uuid.UUID] = uuid_pk()
    issue_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), nullable=False)
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    status_from: Mapped[str | None] = mapped_column(String(60))
    status_to: Mapped[str | None] = mapped_column(String(60))
    note: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_name: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    work_date: Mapped[date | None] = mapped_column(Date)
    day_status: Mapped[str | None] = mapped_column(String(80))
    next_step: Mapped[str | None] = mapped_column(Text)
    next_expected_on: Mapped[date | None] = mapped_column(Date)
    review_state: Mapped[str | None] = mapped_column(String(20))
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_by_name: Mapped[str | None] = mapped_column(String(255))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    review_on_behalf_of: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (
        Index("ix_issue_history_issue_work_date", "issue_id", "work_date"),
        Index("ix_issue_history_issue_review_state", "issue_id", "review_state"),
    )


class IssueStep(Base):
    __tablename__ = "issue_steps"
    id: Mapped[uuid.UUID] = uuid_pk()
    issue_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    done_on: Mapped[date | None] = mapped_column(Date)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    done_by_name: Mapped[str | None] = mapped_column(String(255))
    remark: Mapped[str | None] = mapped_column(Text)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (Index("ix_issue_steps_issue_position", "issue_id", "position"),)


class IssueETCChange(Base):
    __tablename__ = "issue_etc_changes"
    id: Mapped[uuid.UUID] = uuid_pk()
    issue_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), nullable=False)
    old_etc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    new_etc: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    changed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    changed_by_name: Mapped[str] = mapped_column(String(255), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    __table_args__ = (Index("ix_issue_etc_changes_issue_changed_at", "issue_id", "changed_at"),)


class LegacyRecordMixin(TimestampMixin):
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Handover(Base, TimestampMixin):
    __tablename__ = "handovers"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    handover_no: Mapped[str | None] = mapped_column(String(120), unique=True)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    location: Mapped[str | None] = mapped_column(String(255))
    project_type: Mapped[str | None] = mapped_column(String(120))
    capacity_mw: Mapped[float | None] = mapped_column(Numeric(14,3))
    dc_capacity: Mapped[str | None] = mapped_column(String(120))
    gps: Mapped[str | None] = mapped_column(String(255))
    asset_layout: Mapped[str | None] = mapped_column(Text)
    commissioned_text: Mapped[str | None] = mapped_column(String(120))
    epc: Mapped[str | None] = mapped_column(String(255))
    client: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(80), nullable=False)
    approval: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    certificate: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    log: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    legacy_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class HandoverItem(Base):
    __tablename__ = "handover_items"
    id: Mapped[uuid.UUID] = uuid_pk()
    handover_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("handovers.id", ondelete="CASCADE"), nullable=False)
    legacy_id: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str | None] = mapped_column(String(120))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    mandatory: Mapped[bool] = mapped_column(Boolean, default=False)
    assignee_text: Mapped[str | None] = mapped_column(String(255))
    due_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(80), nullable=False)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    instructions: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    __table_args__ = (UniqueConstraint("handover_id", "legacy_id"),)


class OMTask(Base, TimestampMixin):
    __tablename__ = "om_tasks"
    id: Mapped[uuid.UUID] = uuid_pk()
    work_order_no: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    task_name: Mapped[str] = mapped_column(String(255), nullable=False)
    task_type: Mapped[str | None] = mapped_column(String(180))
    equipment_ref: Mapped[str | None] = mapped_column(String(255))
    frequency: Mapped[str | None] = mapped_column(String(80))
    due_on: Mapped[date | None] = mapped_column(Date)
    assignee_text: Mapped[str | None] = mapped_column(String(255))
    assignee_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    status: Mapped[str] = mapped_column(String(80), nullable=False)
    sop: Mapped[str | None] = mapped_column(Text)
    safety: Mapped[str | None] = mapped_column(Text)
    tools: Mapped[str | None] = mapped_column(Text)
    duration: Mapped[str | None] = mapped_column(String(120))
    completion: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    actual_completed_on: Mapped[date | None] = mapped_column(Date)
    delay_days: Mapped[int | None] = mapped_column(Integer)
    problem_found: Mapped[bool] = mapped_column(Boolean, default=False)
    recurrence_parent_no: Mapped[str | None] = mapped_column(String(120))
    linked_issue: Mapped[str | None] = mapped_column(String(120))
    problem: Mapped[str | None] = mapped_column(String(255))
    problem_source: Mapped[str | None] = mapped_column(String(120))
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    log: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    legacy_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Unit-level PM scheduling (migration 016). All nullable: tasks created before it keep working unchanged.
    unit_no: Mapped[int | None] = mapped_column(Integer)            # 1..N within the equipment type at this plant
    total_units: Mapped[int | None] = mapped_column(Integer)        # units in this PM cycle
    cycle_id: Mapped[str | None] = mapped_column(String(60), index=True)   # groups the units of one cycle ("ab12cd34", next period "ab12cd34.1")
    cycle_day: Mapped[int | None] = mapped_column(Integer)          # day-in-cycle the unit is planned for
    planned_due_on: Mapped[date | None] = mapped_column(Date)       # original plan; due_on moves when a missed unit is rolled
    missed_days: Mapped[int] = mapped_column(Integer, default=0)    # days overdue when last rolled (kept for reporting)
    rolled_count: Mapped[int] = mapped_column(Integer, default=0)   # how many times the unit was rolled forward
    quantity: Mapped[int | None] = mapped_column(Integer)
    start_on: Mapped[date | None] = mapped_column(Date)             # planned start of work (migration 027); due_on is the deadline


class PMFollowUp(Base):
    __tablename__ = "pm_followups"
    id: Mapped[uuid.UUID] = uuid_pk()
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("om_tasks.id", ondelete="CASCADE"), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    by_name: Mapped[str] = mapped_column(String(255), nullable=False)
    how: Mapped[str] = mapped_column(String(40), nullable=False)
    spoke_to: Mapped[str | None] = mapped_column(String(255))
    outcome: Mapped[str] = mapped_column(String(80), nullable=False)
    promised_on: Mapped[date | None] = mapped_column(Date)
    next_follow_up_on: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (Index("ix_pm_followups_task_at", "task_id", "at"),)


class PMDueChange(Base):
    __tablename__ = "pm_due_changes"
    id: Mapped[uuid.UUID] = uuid_pk()
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("om_tasks.id", ondelete="CASCADE"), nullable=False)
    old_due: Mapped[date | None] = mapped_column(Date)
    new_due: Mapped[date] = mapped_column(Date, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    by_name: Mapped[str] = mapped_column(String(255), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    __table_args__ = (Index("ix_pm_due_changes_task_at", "task_id", "at"),)


class PMAlertLog(Base):
    __tablename__ = "pm_alert_log"
    id: Mapped[uuid.UUID] = uuid_pk()
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("om_tasks.id", ondelete="CASCADE"), nullable=False)
    level: Mapped[str] = mapped_column(String(80), nullable=False)
    due_on: Mapped[date | None] = mapped_column(Date)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    recipients_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    dedupe_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    __table_args__ = (Index("ix_pm_alert_log_task_sent", "task_id", "sent_at"),)


class NotificationPreference(Base, TimestampMixin):
    __tablename__ = "notification_preferences"
    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    module: Mapped[str] = mapped_column(String(40), nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"))
    preferences: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    __table_args__ = (
        Index(
            "uq_notification_preferences_global", "user_id", "module", unique=True,
            postgresql_where=text("plant_id IS NULL"), sqlite_where=text("plant_id IS NULL"),
        ),
        Index(
            "uq_notification_preferences_plant", "user_id", "module", "plant_id", unique=True,
            postgresql_where=text("plant_id IS NOT NULL"), sqlite_where=text("plant_id IS NOT NULL"),
        ),
    )


class WashingConfig(Base):
    __tablename__ = "washing_config"
    plant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"), primary_key=True)
    team: Mapped[list[str]] = mapped_column(JSON, default=list)
    frequency_days: Mapped[int] = mapped_column(Integer, default=14)
    assigned_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    compliance_threshold_percent: Mapped[int] = mapped_column(Integer, nullable=False, default=85)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notes: Mapped[str | None] = mapped_column(String(500))
    cycle_overrides: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class WashingTable(Base, TimestampMixin):
    __tablename__ = "washing_tables"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"))
    inverter_no: Mapped[int | None] = mapped_column(Integer)
    secondary_inverter_no: Mapped[int | None] = mapped_column(Integer)
    table_code: Mapped[str | None] = mapped_column(String(120))
    next_due_on: Mapped[date | None] = mapped_column(Date)
    rescheduled_to: Mapped[date | None] = mapped_column(Date)
    legacy_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class WashingHistory(Base):
    __tablename__ = "washing_history"
    id: Mapped[uuid.UUID] = uuid_pk()
    washing_table_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("washing_tables.id", ondelete="CASCADE"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    event_date: Mapped[date | None] = mapped_column(Date)
    actor: Mapped[str | None] = mapped_column(String(255))
    reason: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WashingDailyReport(Base):
    __tablename__ = "washing_daily_reports"
    __table_args__ = (
        Index("ix_washing_daily_reports_plant_month_cycle", "plant_id", "cycle_month", "cycle_no"),
        Index("ix_washing_daily_reports_plant_date", "plant_id", "report_date"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    plant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"), nullable=False)
    cycle_month: Mapped[str] = mapped_column(String(7), nullable=False)
    cycle_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_date: Mapped[date] = mapped_column(Date, nullable=False)
    job_status: Mapped[str] = mapped_column(String(40), nullable=False)
    tables_cleaned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cleaned_table_codes: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    remarks: Mapped[str | None] = mapped_column(Text)
    exception_reason: Mapped[str | None] = mapped_column(String(80))
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    reported_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reported_by: Mapped[str] = mapped_column(String(255), nullable=False)
    review_status: Mapped[str] = mapped_column(String(40), nullable=False, default="Pending")
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_by: Mapped[str | None] = mapped_column(String(255))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    cycle_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class InventoryItem(Base, TimestampMixin):
    __tablename__ = "inventory_items"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    item_name: Mapped[str | None] = mapped_column(String(255))
    sku: Mapped[str | None] = mapped_column(String(120))
    quantity: Mapped[float | None] = mapped_column(Numeric(14,3))
    minimum_quantity: Mapped[float | None] = mapped_column(Numeric(14,3))
    unit: Mapped[str | None] = mapped_column(String(60))
    location: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str | None] = mapped_column(String(80))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class InventoryMovement(Base):
    __tablename__ = "inventory_movements"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    inventory_item_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("inventory_items.id", ondelete="SET NULL"))
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    movement_type: Mapped[str | None] = mapped_column(String(80))
    quantity: Mapped[float | None] = mapped_column(Numeric(14,3))
    movement_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actor: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Permit(Base, TimestampMixin):
    __tablename__ = "permits"
    id: Mapped[uuid.UUID] = uuid_pk()
    permit_no: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("om_tasks.id", ondelete="SET NULL"))
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    permit_type: Mapped[str | None] = mapped_column(String(120))
    hazard: Mapped[str | None] = mapped_column(Text)
    loto: Mapped[bool | None] = mapped_column(Boolean)
    valid_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    valid_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str | None] = mapped_column(String(80))
    requested_by: Mapped[str | None] = mapped_column(String(255))
    approver: Mapped[str | None] = mapped_column(String(255))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Incident(Base, TimestampMixin):
    __tablename__ = "incidents"
    id: Mapped[uuid.UUID] = uuid_pk()
    incident_no: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    category: Mapped[str | None] = mapped_column(String(120))
    severity: Mapped[str | None] = mapped_column(String(80))
    status: Mapped[str | None] = mapped_column(String(80))
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    description: Mapped[str | None] = mapped_column(Text)
    reported_by: Mapped[str | None] = mapped_column(String(255))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Document(Base, TimestampMixin):
    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    title: Mapped[str | None] = mapped_column(String(255))
    document_type: Mapped[str | None] = mapped_column(String(120))
    owner: Mapped[str | None] = mapped_column(String(255))
    expires_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str | None] = mapped_column(String(80))
    storage_path: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Vendor(Base, TimestampMixin):
    __tablename__ = "vendors"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    vendor_name: Mapped[str] = mapped_column(String(255), nullable=False)
    contact: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320))
    status: Mapped[str | None] = mapped_column(String(80))
    categories: Mapped[list[Any]] = mapped_column(JSON, default=list)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class ServiceRequest(Base, TimestampMixin):
    __tablename__ = "service_requests"
    id: Mapped[uuid.UUID] = uuid_pk()
    request_no: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    project: Mapped[str | None] = mapped_column(String(255))
    category: Mapped[str | None] = mapped_column(String(120))
    priority: Mapped[str | None] = mapped_column(String(80))
    provider: Mapped[str | None] = mapped_column(String(255))
    owner: Mapped[str | None] = mapped_column(String(255))
    estimate: Mapped[float | None] = mapped_column(Numeric(14,2))
    progress: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str | None] = mapped_column(String(80))
    target_on: Mapped[date | None] = mapped_column(Date)
    history: Mapped[list[dict[str,Any]]] = mapped_column(JSON, default=list)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class NotificationRule(Base, TimestampMixin):
    __tablename__ = "notification_rules"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    event_name: Mapped[str] = mapped_column(String(255), nullable=False)
    channel: Mapped[str | None] = mapped_column(String(255))
    recipients: Mapped[str | None] = mapped_column(Text)
    tiers: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class SLAContract(Base, TimestampMixin):
    __tablename__ = "sla_contracts"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    name: Mapped[str | None] = mapped_column(String(255))
    severity: Mapped[str | None] = mapped_column(String(80))
    target_hours: Mapped[float | None] = mapped_column(Numeric(12,2))
    status: Mapped[str | None] = mapped_column(String(80))
    breach: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class OfflineQueueItem(Base, TimestampMixin):
    __tablename__ = "offline_queue"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    operation: Mapped[str | None] = mapped_column(String(120))
    entity_type: Mapped[str | None] = mapped_column(String(120))
    entity_id: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str | None] = mapped_column(String(80))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str | None] = mapped_column(String(120), unique=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    event_type: Mapped[str | None] = mapped_column(String(120))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str | None] = mapped_column(Text)
    target_type: Mapped[str | None] = mapped_column(String(80))
    target_id: Mapped[str | None] = mapped_column(String(120))
    dedupe_key: Mapped[str | None] = mapped_column(String(255))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[uuid.UUID] = uuid_pk()
    legacy_id: Mapped[str | None] = mapped_column(String(120))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_name: Mapped[str | None] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    module: Mapped[str | None] = mapped_column(String(120))
    entity_type: Mapped[str | None] = mapped_column(String(120))
    entity_id: Mapped[str | None] = mapped_column(String(120))
    before_state: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    after_state: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScadaTelemetry(Base):
    __tablename__ = "scada_telemetry"
    id: Mapped[uuid.UUID] = uuid_pk()
    plant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"))
    site_ref: Mapped[str | None] = mapped_column(String(120))
    source: Mapped[str | None] = mapped_column(String(120))
    generation: Mapped[float | None] = mapped_column(Float)
    availability: Mapped[float | None] = mapped_column(Float)
    performance_ratio: Mapped[float | None] = mapped_column(Float)
    alarms: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str | None] = mapped_column(String(80))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AppSetting(Base):
    __tablename__ = "app_settings"
    setting_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    setting_value: Mapped[Any] = mapped_column(JSON, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class StateRevision(Base):
    __tablename__ = "state_revisions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class StateCollectionRevision(Base):
    __tablename__ = "state_collection_revisions"
    collection: Mapped[str] = mapped_column(String(80), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PMTemplate(Base, TimestampMixin):
    """Reusable Preventive Maintenance job for one equipment type (e.g. Inverter - monthly fan clean).

    `checks` is a list of readings to record: [{"name","unit","min","max"}].
    Tasks are generated from a template for chosen plants (one per equipment unit).
    """
    __tablename__ = "pm_templates"
    id: Mapped[uuid.UUID] = uuid_pk()
    equipment_type: Mapped[str] = mapped_column(String(120), nullable=False)
    task_name: Mapped[str] = mapped_column(String(255), nullable=False)
    steps: Mapped[str | None] = mapped_column(Text)
    frequency: Mapped[str] = mapped_column(String(80), nullable=False, default="Monthly")
    safety: Mapped[str | None] = mapped_column(String(80))
    est_hours: Mapped[float | None] = mapped_column(Numeric(6, 2))
    tools: Mapped[str | None] = mapped_column(Text)
    checks: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    units_per_day: Mapped[int | None] = mapped_column(Integer)      # optional default daily capacity (plant configuration wins)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    __table_args__ = (UniqueConstraint("equipment_type", "task_name"),)


class PMScopeConfig(Base, TimestampMixin):
    """Single row: the O&M Head's edit of the Maintenance Scope Library (which equipment sits in which section / is hidden)."""
    __tablename__ = "pm_scope_config"
    id: Mapped[uuid.UUID] = uuid_pk()
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class PMUnitConfig(Base, TimestampMixin):
    """Per plant + equipment type: how many units exist and how many can be maintained per day."""
    __tablename__ = "pm_unit_config"
    id: Mapped[uuid.UUID] = uuid_pk()
    plant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True)
    equipment_type: Mapped[str] = mapped_column(String(120), nullable=False)
    total_units: Mapped[int] = mapped_column(Integer, nullable=False)
    units_per_day: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    __table_args__ = (UniqueConstraint("plant_id", "equipment_type"),)
