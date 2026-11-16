from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.models import Plant, User
from app.plants.codes import find_plant_by_code, normalize_site_code
from app.plants.repository import PlantRepository
from app.plants.schemas import PlantCreate, PlantUpdate, SecurityContactMove

SECURITY_GROUPS = {"engineer": "site_engineers", "guard": "guards"}


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

    def move_security_contact(self, data: SecurityContactMove):
        """Move one site engineer or guard from one plant's register to another's, atomically.

        People move between plants constantly, and until now the only way to record that was to
        delete the person from one plant and retype them on the other — two writes, either of which
        could be the one that fails, which loses or duplicates a person.

        This is ONE transaction over both plants: the person is popped from the source array and
        appended to the destination array, and a single commit stores both. If either write fails,
        neither is kept, so a person is never lost. `custom_fields` is merged rather than replaced,
        so every other key on both plants (design links, liasoning, anything else) survives.
        """
        group = SECURITY_GROUPS[data.kind]
        label = "site engineer" if data.kind == "engineer" else "guard"
        source = find_plant_by_code(self.db, data.from_site_code)
        if not source:
            raise HTTPException(404, f"No plant with site code {data.from_site_code}")
        destination = find_plant_by_code(self.db, data.to_site_code)
        if not destination:
            raise HTTPException(404, f"No plant with site code {data.to_site_code}")
        if source.id == destination.id:
            raise HTTPException(400, "Choose a different plant to move this person to")

        locked = self.db.scalars(
            select(Plant)
            .where(Plant.id.in_((source.id, destination.id)))
            .order_by(Plant.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        by_id = {plant.id: plant for plant in locked}
        source = by_id[source.id]
        destination = by_id[destination.id]

        source_fields = dict(source.custom_fields or {})
        source_contacts = dict(source_fields.get("security_contacts") or {})
        people = list(source_contacts.get(group) or [])
        if data.index >= len(people):
            raise HTTPException(400, f"This plant has no {label} at position {data.index + 1}")
        if not isinstance(people[data.index], dict):
            raise HTTPException(400, f"That {label} entry cannot be moved")
        person = dict(people.pop(data.index))

        destination_fields = dict(destination.custom_fields or {})
        destination_contacts = dict(destination_fields.get("security_contacts") or {})
        arriving = list(destination_contacts.get(group) or [])
        arriving.append(person)

        source_contacts[group] = people
        source_fields["security_contacts"] = source_contacts
        destination_contacts[group] = arriving
        destination_fields["security_contacts"] = destination_contacts

        # Both rows, then ONE commit: a failure on either plant leaves both as they were.
        source.custom_fields = source_fields
        destination.custom_fields = destination_fields
        self.db.add(source)
        self.db.add(destination)
        try:
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        self.db.refresh(source)
        self.db.refresh(destination)
        return source, destination, person
