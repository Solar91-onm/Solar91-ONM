from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


def validate_custom_fields(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    fields = dict(value)
    if "security_guard" in fields and fields["security_guard"] is not None:
        guard = fields["security_guard"]
        if not isinstance(guard, dict):
            raise ValueError("security_guard must be an object")
        guard = dict(guard)
        name = guard.get("guard_name", "")
        mobile = guard.get("mobile_no", "")
        if not isinstance(name, str) or not isinstance(mobile, str):
            raise ValueError("Guard name and mobile number must be text")
        name = name.strip()
        mobile = mobile.strip()
        if len(name) > 160:
            raise ValueError("Guard name must be 160 characters or fewer")
        if mobile and (len(mobile) != 10 or not mobile.isascii() or not mobile.isdigit()):
            raise ValueError("Guard mobile number must contain exactly 10 digits")
        guard["guard_name"] = name
        guard["mobile_no"] = mobile
        fields["security_guard"] = guard

    if "security_contacts" in fields and fields["security_contacts"] is not None:
        contacts = fields["security_contacts"]
        if not isinstance(contacts, dict):
            raise ValueError("security_contacts must be an object")
        contacts = dict(contacts)
        for group, label in (("site_engineers", "Site engineer"), ("guards", "Guard")):
            people = contacts.get(group, [])
            if not isinstance(people, list):
                raise ValueError(f"{group} must be a list")
            validated = []
            for index, person in enumerate(people, start=1):
                if not isinstance(person, dict):
                    raise ValueError(f"{label} {index} must be an object")
                person = dict(person)
                name = person.get("name", "")
                mobile = person.get("mobile_no", "")
                shift = person.get("shift", "day")
                if not isinstance(name, str) or not isinstance(mobile, str) or not isinstance(shift, str):
                    raise ValueError(f"{label} {index} fields must be text")
                name = name.strip()
                mobile = mobile.strip()
                shift = shift.strip().lower()
                if not name and not mobile:
                    continue
                if not name:
                    raise ValueError(f"{label} {index} name is required")
                if len(name) > 160:
                    raise ValueError(f"{label} {index} name must be 160 characters or fewer")
                if mobile and (len(mobile) != 10 or not mobile.isascii() or not mobile.isdigit()):
                    raise ValueError(f"{label} {index} mobile number must contain exactly 10 digits")
                if shift not in {"day", "night"}:
                    raise ValueError(f"{label} {index} shift must be day or night")
                person["name"] = name
                person["mobile_no"] = mobile
                person["shift"] = shift
                validated.append(person)
            contacts[group] = validated
        fields["security_contacts"] = contacts
    return fields


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

    @field_validator("custom_fields")
    @classmethod
    def valid_custom_fields(cls, value):
        return validate_custom_fields(value)


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

    @field_validator("custom_fields")
    @classmethod
    def valid_custom_fields(cls, value):
        return validate_custom_fields(value)


class PlantOut(PlantBase):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    source: str
    created_at: datetime
    updated_at: datetime
