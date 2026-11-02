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

    @field_validator("site_code", mode="before")
    @classmethod
    def canonical_site_code(cls, value):
        from app.plants.codes import normalize_site_code

        return normalize_site_code(value)

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
