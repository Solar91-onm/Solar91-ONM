from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.models import Plant
from app.plants.codes import find_plant_by_code, normalize_site_code


class PlantRepository:
    def __init__(self, db: Session): self.db = db

    def list(self, *, q: str | None = None, district: str | None = None, project: str | None = None, engineer: str | None = None, allowed_plant_ids=None, offset: int = 0, limit: int = 50):
        stmt = select(Plant)
        if allowed_plant_ids is not None:
            if not allowed_plant_ids: return []
            stmt = stmt.where(Plant.id.in_(allowed_plant_ids))
        if q:
            like = f"%{q.lower()}%"
            code = normalize_site_code(q)
            code_match = Plant.site_code == code if code else False
            stmt = stmt.where(or_(func.lower(Plant.plant_name).like(like), func.lower(Plant.site_code).like(like), code_match, func.lower(func.coalesce(Plant.project_company, "")).like(like)))
        if district: stmt = stmt.where(Plant.district == district)
        if project: stmt = stmt.where(Plant.project_company == project)
        if engineer: stmt = stmt.where(Plant.assigned_engineer == engineer)
        return list(self.db.scalars(stmt.order_by(Plant.site_code).offset(offset).limit(limit)))

    def by_id(self, plant_id): return self.db.get(Plant, plant_id)
    def by_site_code(self, site_code: str): return find_plant_by_code(self.db, site_code)

    def add(self, plant: Plant):
        self.db.add(plant); self.db.commit(); self.db.refresh(plant); return plant

    def save(self, plant: Plant):
        self.db.add(plant); self.db.commit(); self.db.refresh(plant); return plant

    def delete(self, plant: Plant): self.db.delete(plant); self.db.commit()
