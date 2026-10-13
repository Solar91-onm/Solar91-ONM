from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.models import Equipment, Plant


class PlantRepository:
    def __init__(self, db: Session): self.db = db

    def list(self, *, q: str | None = None, district: str | None = None, project: str | None = None, engineer: str | None = None, allowed_plant_ids=None, offset: int = 0, limit: int = 50):
        stmt = select(Plant)
        if allowed_plant_ids is not None:
            if not allowed_plant_ids: return []
            stmt = stmt.where(Plant.id.in_(allowed_plant_ids))
        if q:
            like = f"%{q.lower()}%"
            stmt = stmt.where(or_(func.lower(Plant.plant_name).like(like), func.lower(Plant.site_code).like(like), func.lower(func.coalesce(Plant.project_company, "")).like(like)))
        if district: stmt = stmt.where(Plant.district == district)
        if project: stmt = stmt.where(Plant.project_company == project)
        if engineer: stmt = stmt.where(Plant.assigned_engineer == engineer)
        return list(self.db.scalars(stmt.order_by(Plant.site_code).offset(offset).limit(limit)))

    def by_id(self, plant_id): return self.db.get(Plant, plant_id)
    def by_site_code(self, site_code: str): return self.db.scalar(select(Plant).where(Plant.site_code == site_code))

    def add(self, plant: Plant):
        self.db.add(plant); self.db.commit(); self.db.refresh(plant); return plant

    def save(self, plant: Plant):
        self.db.add(plant); self.db.commit(); self.db.refresh(plant); return plant

    def delete(self, plant: Plant): self.db.delete(plant); self.db.commit()


class EquipmentRepository:
    def __init__(self, db: Session): self.db = db

    def query(self, plant_id=None, q=None, allowed_plant_ids=None, allowed_equipment_ids=None,
              equipment_type=None, maker=None, status=None, discom=None, in_charge_user_id=None,
              warranty=None, no_in_charge=False, maker_missing=False, serial_missing=False):
        stmt = select(Equipment)
        if allowed_equipment_ids is not None:
            if not allowed_equipment_ids:
                return stmt.where(False)
            stmt = stmt.where(Equipment.id.in_(allowed_equipment_ids))
        if allowed_plant_ids is not None:
            if not allowed_plant_ids:
                return stmt.where(False)
            stmt = stmt.where(Equipment.plant_id.in_(allowed_plant_ids))
        if plant_id: stmt = stmt.where(Equipment.plant_id == plant_id)
        if equipment_type: stmt = stmt.where(Equipment.equipment_type == equipment_type)
        if maker: stmt = stmt.where(Equipment.maker == maker)
        if status: stmt = stmt.where(Equipment.status == status)
        if discom: stmt = stmt.where(Equipment.discom == discom)
        if in_charge_user_id: stmt = stmt.where(Equipment.in_charge_user_id == in_charge_user_id)
        if no_in_charge: stmt = stmt.where(Equipment.in_charge_user_id.is_(None))
        if maker_missing: stmt = stmt.where(or_(Equipment.maker.is_(None), func.trim(Equipment.maker) == ""))
        if serial_missing: stmt = stmt.where(or_(Equipment.serial_number.is_(None), func.trim(Equipment.serial_number) == ""))
        if warranty:
            from datetime import date, timedelta
            today = date.today()
            if warranty == "expired":
                stmt = stmt.where(Equipment.warranty_end.is_not(None), Equipment.warranty_end < today)
            elif warranty in {"expiring", "90"}:
                stmt = stmt.where(Equipment.warranty_end.is_not(None), Equipment.warranty_end >= today,
                                  Equipment.warranty_end <= today + timedelta(days=90))
            elif warranty == "missing":
                stmt = stmt.where(or_(Equipment.warranty_start.is_(None), Equipment.warranty_end.is_(None)))
        if q:
            like=f"%{q.lower()}%"
            stmt=stmt.where(or_(
                func.lower(Equipment.equipment_name).like(like),
                func.lower(func.coalesce(Equipment.equipment_code," ")).like(like),
                func.lower(func.coalesce(Equipment.maker," ")).like(like),
                func.lower(func.coalesce(Equipment.model," ")).like(like),
                func.lower(func.coalesce(Equipment.serial_number," ")).like(like),
                func.lower(func.coalesce(Equipment.discom," ")).like(like),
                func.lower(func.coalesce(Equipment.location_in_plant," ")).like(like),
            ))
        return stmt

    def list(self, plant_id=None, q=None, allowed_plant_ids=None, allowed_equipment_ids=None, offset=0, limit=100,
             equipment_type=None, maker=None, status=None, discom=None, in_charge_user_id=None,
             warranty=None, no_in_charge=False, maker_missing=False, serial_missing=False):
        stmt = self.query(plant_id=plant_id,q=q,allowed_plant_ids=allowed_plant_ids,
                          allowed_equipment_ids=allowed_equipment_ids,equipment_type=equipment_type,maker=maker,
                          status=status,discom=discom,in_charge_user_id=in_charge_user_id,warranty=warranty,
                          no_in_charge=no_in_charge,maker_missing=maker_missing,serial_missing=serial_missing)
        return list(self.db.scalars(stmt.order_by(Equipment.equipment_name).offset(offset).limit(limit)))

    def count(self, **filters):
        stmt = self.query(**filters).with_only_columns(func.count()).order_by(None)
        return int(self.db.scalar(stmt) or 0)

    def by_id(self, equipment_id): return self.db.get(Equipment, equipment_id)
    def add(self, row): self.db.add(row); self.db.commit(); self.db.refresh(row); return row
    def save(self, row): self.db.add(row); self.db.commit(); self.db.refresh(row); return row
    def delete(self,row): self.db.delete(row); self.db.commit()

