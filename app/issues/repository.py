from __future__ import annotations

from sqlalchemy import String, and_, cast, exists, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.core.models import Equipment, Issue, Plant, User
from app.plants.codes import normalize_site_code


class IssueRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(
        self, *, plant_id=None, status=None, severity=None, assignee=None, vertical=None, maker=None,
        equipment=None, site_code=None, project_number=None, occurred_from=None, occurred_to=None,
        q=None, allowed_plant_ids=None, allowed_equipment_types=None, assigned_user: User | None = None, offset=0, limit=50, include_deleted=False, deleted_only=False,
    ):
        stmt = select(Issue)
        if deleted_only:
            stmt = stmt.where(Issue.deleted_at.is_not(None))
        elif not include_deleted:
            stmt = stmt.where(Issue.deleted_at.is_(None))
        if site_code or project_number:
            stmt = stmt.join(Plant, Plant.id == Issue.plant_id, isouter=True)
        if allowed_plant_ids is not None:
            if not allowed_plant_ids:
                return []
            stmt = stmt.where(Issue.plant_id.in_(allowed_plant_ids))
        if allowed_equipment_types is not None:
            if not allowed_equipment_types:
                return []
            linked_type = exists(
                select(Equipment.id).where(
                    Equipment.id == Issue.equipment_id,
                    func.lower(func.trim(func.coalesce(Equipment.equipment_type, ""))).in_(allowed_equipment_types),
                )
            )
            stmt = stmt.where(or_(
                func.lower(func.trim(func.coalesce(Issue.vertical, ""))).in_(allowed_equipment_types),
                and_(func.trim(func.coalesce(Issue.vertical, "")) == "", linked_type),
            ))
        if assigned_user is not None:
            identities = [assigned_user.display_name]
            if assigned_user.email:
                identities.append(assigned_user.email)
            text_conditions = [func.lower(func.coalesce(Issue.assignee_text, "")).like(f"%{x.lower()}%") for x in identities if x]
            stmt = stmt.where(or_(Issue.assigned_to == assigned_user.id, *text_conditions))
        if plant_id: stmt = stmt.where(Issue.plant_id == plant_id)
        if status: stmt = stmt.where(Issue.status == status)
        if severity == "Critical": stmt = stmt.where(Issue.severity.in_(("Critical", "High")))
        elif severity: stmt = stmt.where(Issue.severity == severity)
        if assignee: stmt = stmt.where(Issue.assignee_text == assignee)
        if vertical: stmt = stmt.where(Issue.vertical == vertical)
        if maker: stmt = stmt.where(Issue.maker == maker)
        if equipment: stmt = stmt.where(func.lower(func.coalesce(Issue.equipment_ref, "")).like(f"%{equipment.lower()}%"))
        if site_code:
            stmt = stmt.where(Plant.site_code == normalize_site_code(site_code))
        if project_number:
            # Project number is retained in legacy_payload across older migrations.
            # Casting JSON to text keeps the filter portable across PostgreSQL and SQLite.
            needle = f"%{project_number.lower()}%"
            stmt = stmt.where(or_(cast(Issue.legacy_payload, String).ilike(needle), cast(Plant.custom_fields, String).ilike(needle), cast(Plant.legacy_payload, String).ilike(needle)))
        if occurred_from: stmt = stmt.where(Issue.occurred_at >= occurred_from)
        if occurred_to: stmt = stmt.where(Issue.occurred_at <= occurred_to)
        if q:
            like = f"%{q.lower()}%"
            stmt = stmt.where(or_(func.lower(Issue.ticket_no).like(like), func.lower(Issue.description).like(like), func.lower(func.coalesce(Issue.equipment_ref, " ")).like(like)))
        return list(self.db.scalars(stmt.order_by(Issue.created_at.desc()).offset(offset).limit(limit)))

    def by_id(self, issue_id, *, include_deleted=False, for_update=False):
        if for_update:
            # Flush authorization-side changes in this request before refreshing the locked row.
            self.db.flush()
            stmt = (
                select(Issue)
                .where(Issue.id == issue_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            row = self.db.scalar(stmt)
        else:
            row=self.db.get(Issue, issue_id)
        return row if row and (include_deleted or row.deleted_at is None) else None
    def by_ticket(self, ticket_no, *, include_deleted=False):
        stmt=select(Issue).where(Issue.ticket_no == ticket_no)
        if not include_deleted: stmt=stmt.where(Issue.deleted_at.is_(None))
        return self.db.scalar(stmt)
    def add(self, row): self.db.add(row); self.db.commit(); self.db.refresh(row); return row
    def save(self, row): self.db.add(row); self.db.commit(); self.db.refresh(row); return row
