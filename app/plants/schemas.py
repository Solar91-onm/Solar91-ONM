from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PlantBase(BaseModel):
    site_code: str = Field(min_length=1, max_length=80)
    plant_name: str = Field(min_length=1, max_length=255)
    project_company: str | None = None
    district: str | None = None
    discom: str | None = None
    location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    dc_capacity_kw: float | None = None
    ac_capacity_kw: float | None = None
    commissioned_on: date | None = None
    status: str = "active"
    assigned_engineer: str | None = None
    custom_fields: dict[str, Any] = Field(default_factory=dict)

    @field_validator("latitude")
    @classmethod
    def lat_range(cls, value):
        if value is not None and not -90 <= value <= 90:
            raise ValueError("latitude must be between -90 and 90")
        return value

    @field_validator("longitude")
    @classmethod
    def lon_range(cls, value):
        if value is not None and not -180 <= value <= 180:
            raise ValueError("longitude must be between -180 and 180")
        return value


class PlantCreate(PlantBase):
    pass


class PlantUpdate(BaseModel):
    plant_name: str | None = None
    project_company: str | None = None
    district: str | None = None
    discom: str | None = None
    location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    dc_capacity_kw: float | None = None
    ac_capacity_kw: float | None = None
    commissioned_on: date | None = None
    status: str | None = None
    assigned_engineer: str | None = None
    custom_fields: dict[str, Any] | None = None


class PlantOut(PlantBase):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    source: str
    created_at: datetime
    updated_at: datetime


class EquipmentBase(BaseModel):
    plant_id: UUID
    equipment_code: str | None = None
    equipment_name: str
    equipment_type: str | None = None
    maker: str | None = None
    model: str | None = None
    serial_number: str | None = None
    status: str = "active"
    discom: str | None = None
    feeder_or_gss: str | None = None
    rating: str | None = None
    capacity_kw: float | None = None
    quantity: int = Field(default=1, ge=1)
    location_in_plant: str | None = None
    manufacture_year: int | None = Field(default=None, ge=1900, le=2200)
    commissioned_on: date | None = None
    warranty_start: date | None = None
    warranty_end: date | None = None
    amc_vendor: str | None = None
    amc_end: date | None = None
    supplier: str | None = None
    purchase_order_no: str | None = None
    criticality: str | None = None
    notes: str | None = None
    in_charge_user_id: UUID | None = None
    last_service_on: date | None = None
    next_service_due: date | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("status")
    @classmethod
    def status_allowed(cls, value: str):
        value = (value or "active").strip().lower()
        if value not in {"active", "maintenance", "fault", "inactive"}:
            raise ValueError("status must be active, maintenance, fault or inactive")
        return value

    @field_validator("criticality")
    @classmethod
    def criticality_allowed(cls, value):
        if value in (None, ""):
            return None
        normalized = str(value).strip().title()
        if normalized not in {"High", "Medium", "Low"}:
            raise ValueError("criticality must be High, Medium or Low")
        return normalized


class EquipmentCreate(EquipmentBase):
    pass


class EquipmentUpdate(BaseModel):
    plant_id: UUID | None = None
    equipment_code: str | None = None
    equipment_name: str | None = None
    equipment_type: str | None = None
    maker: str | None = None
    model: str | None = None
    serial_number: str | None = None
    status: str | None = None
    discom: str | None = None
    feeder_or_gss: str | None = None
    rating: str | None = None
    capacity_kw: float | None = None
    quantity: int | None = Field(default=None, ge=1)
    location_in_plant: str | None = None
    manufacture_year: int | None = Field(default=None, ge=1900, le=2200)
    commissioned_on: date | None = None
    warranty_start: date | None = None
    warranty_end: date | None = None
    amc_vendor: str | None = None
    amc_end: date | None = None
    supplier: str | None = None
    purchase_order_no: str | None = None
    criticality: str | None = None
    notes: str | None = None
    in_charge_user_id: UUID | None = None
    last_service_on: date | None = None
    next_service_due: date | None = None
    metadata: dict[str, Any] | None = None

    @field_validator("status")
    @classmethod
    def update_status_allowed(cls, value):
        if value is None:
            return None
        value = value.strip().lower()
        if value not in {"active", "maintenance", "fault", "inactive"}:
            raise ValueError("status must be active, maintenance, fault or inactive")
        return value

    @field_validator("criticality")
    @classmethod
    def update_criticality_allowed(cls, value):
        if value in (None, ""):
            return None
        normalized = str(value).strip().title()
        if normalized not in {"High", "Medium", "Low"}:
            raise ValueError("criticality must be High, Medium or Low")
        return normalized


class EquipmentOut(EquipmentBase):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    metadata: dict[str, Any] = Field(default_factory=dict)
    in_charge_name: str | None = None
    type_owners: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class EquipmentBulkCreate(BaseModel):
    items: list[EquipmentCreate] = Field(min_length=1, max_length=500)


class EquipmentMove(BaseModel):
    plant_id: UUID


class EquipmentPage(BaseModel):
    items: list[EquipmentOut]
    total: int
    offset: int
    limit: int

