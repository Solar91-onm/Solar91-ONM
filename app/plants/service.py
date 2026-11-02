from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.models import Plant, User
from app.plants.codes import find_plant_by_code, normalize_site_code
from app.plants.repository import PlantRepository
from app.plants.schemas import PlantCreate, PlantUpdate


class PlantService:
    def __init__(self, db: Session): self.db=db; self.repo=PlantRepository(db)

    def create(self, data: PlantCreate, user: User):
        values = data.model_dump()
        values["site_code"] = normalize_site_code(values["site_code"])
        if find_plant_by_code(self.db, values["site_code"]):
            raise HTTPException(409, "A plant with this site code already exists")
        row = Plant(**values, source="api", created_by=user.id, legacy_payload={})
        try: return self.repo.add(row)
        except IntegrityError as exc:
            self.db.rollback(); raise HTTPException(409, "A plant with this site code already exists") from exc

    def update(self, plant_id, data: PlantUpdate):
        row=self.repo.by_id(plant_id)
        if not row: raise HTTPException(404,"Plant not found")
        for k,v in data.model_dump(exclude_unset=True).items(): setattr(row,k,v)
        return self.repo.save(row)

    def delete(self, plant_id):
        row=self.repo.by_id(plant_id)
        if not row: raise HTTPException(404,"Plant not found")
        self.repo.delete(row)
