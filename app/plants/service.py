from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.models import AuditLog, Equipment, Plant, User
from app.plants.codes import find_plant_by_code, normalize_site_code
from app.plants.repository import EquipmentRepository, PlantRepository
from app.plants.schemas import EquipmentBulkCreate, EquipmentCreate, EquipmentUpdate, PlantCreate, PlantUpdate


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


class EquipmentService:
    def __init__(self, db: Session): self.db=db; self.repo=EquipmentRepository(db)

    @staticmethod
    def _snapshot(row: Equipment) -> dict:
        keys = [
            "plant_id","equipment_code","equipment_name","equipment_type","maker","model","serial_number","status",
            "discom","feeder_or_gss","rating","capacity_kw","quantity","location_in_plant","manufacture_year",
            "commissioned_on","warranty_start","warranty_end","amc_vendor","amc_end","supplier","purchase_order_no",
            "criticality","notes","in_charge_user_id","last_service_on","next_service_due",
        ]
        out={}
        for k in keys:
            v=getattr(row,k,None)
            out[k]=str(v) if v is not None and k in {"plant_id","in_charge_user_id","commissioned_on","warranty_start","warranty_end","amc_end","last_service_on","next_service_due"} else (float(v) if k=="capacity_kw" and v is not None else v)
        return out

    def _audit(self, user: User, action: str, row: Equipment, before=None, after=None, metadata=None):
        self.db.add(AuditLog(
            user_id=user.id, actor_name=user.display_name, action=action, module="Equipment Register",
            entity_type="equipment", entity_id=str(row.id), before_state=before, after_state=after,
            metadata_json=metadata or {},
        ))

    def _validate_links(self, payload: dict, plant: Plant | None = None):
        if plant is None:
            plant = self.db.get(Plant,payload.get("plant_id")) if payload.get("plant_id") else None
        if not plant:
            raise HTTPException(404,"Plant not found")
        uid=payload.get("in_charge_user_id")
        if uid is not None:
            person=self.db.get(User,uid)
            if not person or not person.is_active:
                raise HTTPException(422,"Person in charge must be an active user")
        if payload.get("discom") in (None, ""):
            payload["discom"] = plant.discom
        return plant

    def create(self, data: EquipmentCreate, user: User):
        payload=data.model_dump(); metadata=payload.pop("metadata")
        self._validate_links(payload)
        row=Equipment(**payload, metadata_json=metadata, created_by=user.id)
        try:
            self.db.add(row); self.db.flush()
            self._audit(user,"Created equipment",row,after=self._snapshot(row))
            self.db.commit(); self.db.refresh(row); return row
        except IntegrityError as exc:
            self.db.rollback(); raise HTTPException(409,"Equipment code already exists for this plant") from exc

    def bulk_create(self, data: EquipmentBulkCreate, user: User):
        rows=[]; seen=set()
        try:
            for item in data.items:
                payload=item.model_dump(); metadata=payload.pop("metadata")
                self._validate_links(payload)
                code=(payload.get("equipment_code") or "").strip().casefold()
                key=(str(payload["plant_id"]),code)
                if code and key in seen:
                    raise HTTPException(409,f"Duplicate equipment code in upload: {payload.get('equipment_code')}")
                seen.add(key)
                row=Equipment(**payload,metadata_json=metadata,created_by=user.id)
                self.db.add(row); rows.append(row)
            self.db.flush()
            for row in rows:
                self._audit(user,"Bulk-created equipment",row,after=self._snapshot(row),metadata={"batch_size":len(rows)})
            self.db.commit()
            for row in rows: self.db.refresh(row)
            return rows
        except HTTPException:
            self.db.rollback(); raise
        except IntegrityError as exc:
            self.db.rollback(); raise HTTPException(409,"Bulk add stopped: an equipment code already exists for this plant. Nothing was created.") from exc

    def update(self,equipment_id,data:EquipmentUpdate,user: User):
        row=self.repo.by_id(equipment_id)
        if not row: raise HTTPException(404,"Equipment not found")
        before=self._snapshot(row)
        payload=data.model_dump(exclude_unset=True)
        if "metadata" in payload: row.metadata_json=payload.pop("metadata")
        if "plant_id" in payload:
            if payload["plant_id"] is None: payload.pop("plant_id")
            else: self._validate_links(payload)
        elif "in_charge_user_id" in payload:
            self._validate_links({"plant_id":row.plant_id,"in_charge_user_id":payload["in_charge_user_id"],"discom":row.discom})
        for k,v in payload.items(): setattr(row,k,v)
        if row.discom in (None,""):
            plant=self.db.get(Plant,row.plant_id); row.discom=plant.discom if plant else None
        try:
            self.db.add(row); self.db.flush()
            after=self._snapshot(row)
            moved=before.get("plant_id")!=after.get("plant_id")
            action="Moved equipment to another plant" if moved else "Updated equipment"
            meta={"from_plant_id":before.get("plant_id"),"to_plant_id":after.get("plant_id")} if moved else None
            self._audit(user,action,row,before=before,after=after,metadata=meta)
            self.db.commit(); self.db.refresh(row); return row
        except IntegrityError as exc:
            self.db.rollback(); raise HTTPException(409,"Equipment code already exists for this plant") from exc

    def move(self,equipment_id,plant_id,user:User):
        row=self.repo.by_id(equipment_id)
        if not row: raise HTTPException(404,"Equipment not found")
        plant=self.db.get(Plant,plant_id)
        if not plant: raise HTTPException(404,"Plant not found")
        before=self._snapshot(row); old_plant=row.plant_id
        row.plant_id=plant.id
        if not row.discom: row.discom=plant.discom
        try:
            self.db.add(row); self.db.flush()
            self._audit(user,"Moved equipment to another plant",row,before=before,after=self._snapshot(row),metadata={"from_plant_id":str(old_plant),"to_plant_id":str(plant.id)})
            self.db.commit(); self.db.refresh(row); return row
        except IntegrityError as exc:
            self.db.rollback(); raise HTTPException(409,"Equipment code already exists for the destination plant") from exc

    def retire(self,equipment_id,user:User):
        row=self.repo.by_id(equipment_id)
        if not row: raise HTTPException(404,"Equipment not found")
        before=self._snapshot(row); row.status="inactive"
        self.db.add(row); self.db.flush(); self._audit(user,"Retired equipment",row,before=before,after=self._snapshot(row)); self.db.commit(); self.db.refresh(row); return row

    def delete(self,equipment_id,user:User):
        row=self.repo.by_id(equipment_id)
        if not row: raise HTTPException(404,"Equipment not found")
        before=self._snapshot(row)
        self._audit(user,"Permanently deleted equipment",row,before=before,after=None)
        self.db.delete(row); self.db.commit()
