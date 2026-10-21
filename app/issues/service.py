from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import logging
import uuid

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.core.models import AuditLog, Equipment, InventoryItem, InventoryMovement, Issue, IssueETCChange, IssueHistory, IssueStep, Plant, User, UserEquipmentTypeAssignment
from app.core.security import EQUIPMENT_TYPES, resolve_equipment_id
from app.issues.repository import IssueRepository
from app.issues.schemas import AssignmentRequest, BulkAssignRequest, CloseRequest, StepBackRequest, IssueCreate, IssueUpdate, ProgressRequest, ResolveRequest


logger=logging.getLogger(__name__)
PLANT_TIMEZONE=timezone(timedelta(hours=5,minutes=30))


def issue_local_today() -> date:
    return datetime.now(timezone.utc).astimezone(PLANT_TIMEZONE).date()


def issue_local_date(value: datetime | None) -> date:
    if value is None:
        return issue_local_today()
    if value.tzinfo is None:
        value=value.replace(tzinfo=timezone.utc)
    return value.astimezone(PLANT_TIMEZONE).date()


def validate_issue_work_date(issue: Issue, value: date | None) -> date:
    work_date=value or issue_local_today()
    created_on=issue_local_date(issue.created_at)
    if work_date > issue_local_today():
        raise HTTPException(422,"Work date cannot be in the future")
    if work_date < created_on:
        raise HTTPException(422,"Work date cannot be before the ticket was created")
    return work_date


def next_issue_ticket_no(db:Session)->str:
    existing=db.scalars(select(Issue.ticket_no).where(Issue.ticket_no.like("ISS-%"))).all()
    numbers=[int(value[4:]) for value in existing if value[4:].isdigit()]
    return f"ISS-{max(numbers,default=0)+1:04d}"


def _lock_issue_ticket_numbers(db: Session) -> None:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": 910091001})


class IssueService:
    def __init__(self,db:Session): self.db=db; self.repo=IssueRepository(db)

    def _history(
        self,issue:Issue,action:str,user:User,note:str|None=None,status_from:str|None=None,
        status_to:str|None=None,metadata:dict|None=None,work_date:date|None=None,
        day_status:str|None=None,next_step:str|None=None,next_expected_on:date|None=None,
    ):
        self.db.add(IssueHistory(
            issue_id=issue.id,action=action,note=note,status_from=status_from,status_to=status_to,
            actor_id=user.id,actor_name=user.display_name,metadata_json=metadata or {},
            work_date=work_date,day_status=day_status,next_step=next_step,next_expected_on=next_expected_on,
        ))
        self.db.add(AuditLog(user_id=user.id,actor_name=user.display_name,action=action,module="Issues",entity_type="issue",entity_id=issue.ticket_no,before_state={"status":status_from} if status_from else None,after_state={"status":status_to} if status_to else None,metadata_json=metadata or {}))

    def _notify(self,**kwargs):
        """Send notifications AFTER the ticket change is saved. A failing notification must never undo or block a workflow step."""
        try:
            from app.notifications.service import notify_issue_assignee_and_heads
            notify_issue_assignee_and_heads(self.db,**kwargs)
            self.db.commit()
        except Exception:
            self.db.rollback()
            logger.exception("Issue notification failed; the ticket change itself was saved")

    def _resolve_assignee(self,assigned_to,assignee_text:str|None)->User:
        """The person a ticket is assigned to must be an active user with the Assignee role, taken from the database."""
        target=self.db.get(User,assigned_to) if assigned_to else None
        if not target and assignee_text and not assigned_to:
            name=assignee_text.strip().casefold()
            matches=[u for u in self.db.scalars(select(User).where(User.role=="Assignee",User.is_active.is_(True))) if (u.display_name or "").strip().casefold()==name]
            if len(matches)==1: target=matches[0]
            elif len(matches)>1: raise HTTPException(422,"More than one Assignee has that name; pick the person from the list")
        if not target or not target.is_active or target.role!="Assignee":
            raise HTTPException(422,"Choose an active user with the Assignee role")
        return target

    def _ensure_assignee_scope(self,target:User,actor:User,plant_id,equipment_id,equipment_ref,vertical)->None:
        """An Assignee can only work tickets of the equipment types in their scope. The O&M Head may extend that scope
        while assigning (so a ticket can never be left with someone who cannot open it); nobody else can."""
        kind=(vertical or "").strip()
        if not kind:
            eq_id=resolve_equipment_id(self.db,plant_id,equipment_id,equipment_ref)
            eq=self.db.get(Equipment,eq_id) if eq_id else None
            kind=(eq.equipment_type or "").strip() if eq else ""
        if not kind:
            raise HTTPException(422,"Choose the issue category before assigning the ticket")
        owned={(t or "").strip().casefold() for t in self.db.scalars(select(UserEquipmentTypeAssignment.equipment_type).where(UserEquipmentTypeAssignment.user_id==target.id))}
        if kind.casefold() in owned:
            return
        if actor.role!="O&M Head":
            raise HTTPException(422,"The selected Assignee is not assigned to this issue category")
        canonical=next((t for t in EQUIPMENT_TYPES if t.casefold()==kind.casefold()),kind)
        self.db.add(UserEquipmentTypeAssignment(user_id=target.id,equipment_type=canonical))
        self.db.add(AuditLog(user_id=actor.id,actor_name=actor.display_name,action="Equipment scope added while assigning a ticket",module="Issues",entity_type="user",entity_id=str(target.id),after_state={"equipment_type":canonical,"assignee":target.display_name}))

    DUPLICATE_WINDOW_SECONDS = 120

    def _recent_duplicate(self, user: User, payload: dict, units: list[dict]) -> Issue | None:
        """The creator's newest ticket if it is identical and was raised moments ago (double submit)."""
        latest = self.db.scalar(
            select(Issue).where(Issue.created_by == user.id, Issue.deleted_at.is_(None))
            .order_by(Issue.created_at.desc()).limit(1)
        )
        if latest is None or latest.created_at is None:
            return None
        created = latest.created_at if latest.created_at.tzinfo else latest.created_at.replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - created).total_seconds() > self.DUPLICATE_WINDOW_SECONDS:
            return None
        def norm(value):
            return " ".join(str(value or "").split()).casefold()
        same = (
            latest.plant_id == payload.get("plant_id")
            and latest.equipment_id == payload.get("equipment_id")
            and norm(latest.equipment_ref) == norm(payload.get("equipment_ref"))
            and norm(latest.vertical) == norm(payload.get("vertical"))
            and norm(latest.description) == norm(payload.get("description"))
            and sorted(str(u.get("id")) for u in latest.units) == sorted(str(u.get("id")) for u in units)
        )
        return latest if same else None

    MAX_UNITS_IN_REF = 255

    def _resolve_units(self, plant_id, unit_ids) -> list[dict]:
        """Registered units one ticket covers. Every unit must be active equipment of the ticket's plant."""
        ordered = list(dict.fromkeys(unit_ids or []))
        if not ordered:
            return []
        if plant_id is None:
            raise HTTPException(422, "Choose the plant before selecting units")
        rows = {row.id: row for row in self.db.scalars(select(Equipment).where(Equipment.id.in_(ordered)))}
        units = []
        for unit_id in ordered:
            row = rows.get(unit_id)
            if row is None:
                raise HTTPException(404, "A selected unit was not found in the equipment register")
            if row.plant_id != plant_id:
                raise HTTPException(422, "Every selected unit must belong to the selected plant")
            if str(row.status or "active").lower() == "inactive":
                raise HTTPException(422, f"{row.equipment_code or row.equipment_name} is retired and cannot be ticketed")
            units.append({"id": str(row.id), "code": row.equipment_code or row.equipment_name, "name": row.equipment_name, "type": row.equipment_type})
        return units

    @classmethod
    def _units_ref(cls, units: list[dict]) -> str:
        codes = [str(u.get("code") or u.get("name") or "").strip() for u in units]
        text_ref = ", ".join(code for code in codes if code)
        if len(text_ref) <= cls.MAX_UNITS_IN_REF:
            return text_ref
        return f"{len(units)} units: " + text_ref[: cls.MAX_UNITS_IN_REF - 20].rsplit(",", 1)[0] + " …"

    def create(self,data:IssueCreate,user:User):
        payload = data.model_dump()
        assigned_to = payload.pop("assigned_to", None)
        supplier = payload.pop("supplier", None)
        serial_number = payload.pop("serial_number", None)
        unit_ids = payload.pop("unit_ids", None) or []
        ticket_no = (payload.pop("ticket_no", None) or "").strip()
        auto_number = not ticket_no
        plant_id = payload.get("plant_id")
        if plant_id and not self.db.get(Plant, plant_id):
            raise HTTPException(404, "Plant not found")
        units = self._resolve_units(plant_id, unit_ids)
        if units:
            if len(units) == 1 and not payload.get("equipment_id"):
                payload["equipment_id"] = uuid.UUID(units[0]["id"])
            elif len(units) > 1:
                # A multi-unit ticket is not tied to one unit; the covered units are listed on the ticket.
                payload["equipment_id"] = None
            if len(units) > 1 or not (payload.get("equipment_ref") or "").strip():
                payload["equipment_ref"] = self._units_ref(units)
            if not (payload.get("vertical") or "").strip():
                payload["vertical"] = next((u["type"] for u in units if u.get("type")), None)
        equipment_id = payload.get("equipment_id")
        if equipment_id:
            equipment = self.db.get(Equipment, equipment_id)
            if not equipment:
                raise HTTPException(404, "Equipment not found")
            if plant_id is not None and equipment.plant_id != plant_id:
                raise HTTPException(422, "Equipment does not belong to the selected plant")
        assignee = self._resolve_assignee(assigned_to, None) if assigned_to else None
        if assignee:
            self._ensure_assignee_scope(assignee, user, plant_id, equipment_id, payload.get("equipment_ref"), payload.get("vertical"))
        row = None
        for attempt in range(6):
            if auto_number:
                _lock_issue_ticket_numbers(self.db)
                # Checked under the ticket-number lock so simultaneous submissions of the same form cannot each
                # pass the check before either ticket is saved.
                duplicate = self._recent_duplicate(user, payload, units)
                if duplicate is not None:
                    # A repeated click or resubmission of the same form returns the ticket that was already saved.
                    self.db.rollback()
                    return duplicate
                ticket_no = next_issue_ticket_no(self.db)
            row=Issue(
                ticket_no=ticket_no, **payload,
                assigned_to=assignee.id if assignee else None,
                assignee_text=assignee.display_name if assignee else None,
                status="Assigned" if assignee else "Open",
                created_by=user.id,
                legacy_payload={"supplier": supplier, "serial_number": serial_number, "evidence": [], **({"units": units} if units else {})},
            )
            self.db.add(row)
            try:
                self.db.flush()
                self._history(row,"issue.created",user,status_to=row.status)
                self.db.commit(); self.db.refresh(row)
                break
            except IntegrityError as exc:
                self.db.rollback()
                if not auto_number or attempt == 5:
                    raise HTTPException(409,"Ticket number already exists") from exc
        try:
            from app.notifications.service import equipment_responsible_users, notify_users
            if row.assigned_to is None:
                responsible = equipment_responsible_users(self.db, plant_id=row.plant_id, equipment_id=row.equipment_id, equipment_ref=row.equipment_ref, equipment_type=row.vertical)
                notify_users(self.db, responsible, event_type="issue_created", title=f"New issue — {row.ticket_no}",
                             message=f"{row.plant_id or ''} · {row.description[:180]}", target_type="issue", target_id=row.ticket_no,
                             dedupe_key=f"issue-owner:{row.id}")
                self.db.commit()
        except Exception:
            self.db.rollback(); logger.exception("Issue owner notification failed; the ticket was created")
        self._notify(
            plant_id=row.plant_id, assigned_to=row.assigned_to,
            event_type="critical_issue" if row.severity == "Critical" else "issue_created",
            title=("Critical issue raised — " if row.severity == "Critical" else "New issue raised — ")+row.ticket_no,
            message=f"{row.plant_id or ''} · {row.description[:180]}",
            target_id=row.ticket_no,
            include_heads=True,
            dedupe_key=f"issue-created:{row.id}",
        )
        self.db.refresh(row)
        return row

    def update(self,issue_id,data:IssueUpdate,user:User):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        changes=data.model_dump(exclude_unset=True)
        reason=(changes.pop("change_reason", None) or "").strip()
        if "description" in changes and (changes["description"] is None or not changes["description"].strip()):
            raise HTTPException(422,"Issue description cannot be blank")
        if "description" in changes: changes["description"]=changes["description"].strip()
        before={key:getattr(row,key) for key in changes if getattr(row,key)!=changes[key]}
        if not before: return row
        for key in before: setattr(row,key,changes[key])
        row.updated_at=datetime.now(timezone.utc)
        def stamp(v): return v.isoformat() if isinstance(v,(date,datetime,uuid.UUID)) else v
        self._history(row,"issue.edited",user,note=reason or "Ticket details corrected",metadata={
            "changes":{key:{"before":stamp(old),"after":stamp(changes[key])} for key,old in before.items()}
        })
        self.db.commit(); self.db.refresh(row); return row

    def change_dates(self,issue_id:uuid.UUID,data,user:User):
        """Edit the start date (occurred_at) and/or deadline (etc_at) of an open issue, with a mandatory reason."""
        issue=self.repo.by_id(issue_id,for_update=True)
        if not issue: raise HTTPException(404,"Issue not found")
        if issue.status=="Closed": raise HTTPException(409,"A closed ticket's dates cannot be changed")
        fields=data.model_dump(exclude_unset=True)
        fields.pop("reason",None)
        if not fields: raise HTTPException(422,"Choose a start date or a deadline to change")
        reason=data.reason.strip()
        if not reason: raise HTTPException(422,"A reason is required to change ticket dates")
        def utc(v):
            if v is None: return None
            return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v.astimezone(timezone.utc)
        new_start=utc(fields["occurred_at"]) if "occurred_at" in fields else utc(issue.occurred_at)
        new_etc=utc(fields["etc_at"]) if "etc_at" in fields else utc(issue.etc_at)
        if "occurred_at" in fields and new_start is None: raise HTTPException(422,"The start date cannot be empty")
        if "etc_at" in fields and new_etc is None: raise HTTPException(422,"The deadline cannot be empty")
        if new_start and new_etc and new_etc<new_start:
            raise HTTPException(422,"The deadline cannot be before the start date")
        def norm(v): return v.astimezone(timezone.utc) if v is not None and v.tzinfo else (v.replace(tzinfo=timezone.utc) if v is not None else None)
        changed={}
        if "occurred_at" in fields and norm(issue.occurred_at)!=new_start:
            changed["occurred_at"]={"before":issue.occurred_at.isoformat() if issue.occurred_at else None,"after":new_start.isoformat()}
            issue.occurred_at=new_start
        if "etc_at" in fields and norm(issue.etc_at)!=new_etc:
            changed["etc_at"]={"before":issue.etc_at.isoformat() if issue.etc_at else None,"after":new_etc.isoformat()}
            self.db.add(IssueETCChange(issue_id=issue.id,old_etc=issue.etc_at,new_etc=new_etc,reason=reason,changed_by=user.id,changed_by_name=user.display_name))
            issue.etc_at=new_etc
        if not changed: return issue
        issue.updated_at=datetime.now(timezone.utc)
        self._history(issue,"issue.dates_changed",user,note=reason,metadata={"changes":changed},work_date=issue_local_today())
        self.db.commit(); self.db.refresh(issue); return issue

    def archive(self,issue_id,data,user:User):
        row=self.repo.by_id(issue_id,include_deleted=True,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if row.deleted_at is not None: raise HTTPException(409,"Ticket is already in Deleted tickets")
        if data.confirm_ticket.strip()!=row.ticket_no:
            raise HTTPException(422,"Enter the exact ticket number to confirm deletion")
        reason=data.reason.strip()
        if len(reason)<8: raise HTTPException(422,"Explain why this ticket is being deleted (at least 8 characters)")
        now=datetime.now(timezone.utc)
        row.deleted_at=now; row.deleted_by=user.id; row.deletion_reason=reason; row.updated_at=now
        self._history(row,"issue.deleted",user,note=reason,metadata={"deleted_at":now.isoformat()})
        self.db.commit()
        return {"ticket_no":row.ticket_no,"deleted":True,"restorable":True}

    def restore(self,issue_id,data,user:User):
        row=self.repo.by_id(issue_id,include_deleted=True,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if row.deleted_at is None: raise HTTPException(409,"Ticket is not deleted")
        reason=data.reason.strip()
        if len(reason)<8: raise HTTPException(422,"Explain why this ticket is being restored (at least 8 characters)")
        previous=row.deleted_at
        row.deleted_at=None; row.deleted_by=None; row.deletion_reason=None; row.updated_at=datetime.now(timezone.utc)
        self._history(row,"issue.restored",user,note=reason,metadata={"previously_deleted_at":previous.isoformat()})
        self.db.commit(); self.db.refresh(row); return row

    def reset(self,issue_id,user:User):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        before=row.status
        row.status="Open"
        row.assignee_text=None
        row.assigned_to=None
        row.vendor=None
        row.closure=None
        row.fixed_on=None
        row.closed_on=None
        row.updated_at=datetime.now(timezone.utc)
        legacy=dict(row.legacy_payload or {})
        legacy["progress"]=[{
            "at":datetime.now(timezone.utc).isoformat(),
            "note":f"Reset to Open by {user.display_name} (was {before})",
            "parts":"—","hrs":0,
        },*(legacy.get("progress") or [])]
        row.legacy_payload=legacy
        self._history(
            row,"issue.reset",user,note="Reset to Open",
            status_from=before,status_to="Open",work_date=issue_local_today(),
        )
        self.db.commit()
        self.db.refresh(row)
        return row

    def assign(self,issue_id,data:AssignmentRequest,user:User,reassign:bool=False):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if row.status not in {"Open","Assigned","Acknowledged"}:
            raise HTTPException(409,"A completed or active-work ticket cannot be reassigned")
        target=self._resolve_assignee(data.assigned_to,data.assignee_text)
        self._ensure_assignee_scope(target,user,row.plant_id,row.equipment_id,row.equipment_ref,row.vertical)
        before=row.status; previous=row.assignee_text
        next_status="Assigned"          # the (new) owner acknowledges it themselves
        row.assignee_text=target.display_name; row.assigned_to=target.id; row.vendor=data.vendor; row.status=next_status; row.updated_at=datetime.now(timezone.utc)
        self._history(row,"issue.reassigned" if reassign else "issue.assigned",user,note=data.note,status_from=before,status_to=next_status,metadata={"from_assignee":previous,"to_assignee":target.display_name})
        self.db.commit()
        self._notify(
            plant_id=row.plant_id,
            assigned_to=row.assigned_to,
            event_type="ticket_reassigned" if reassign else "ticket_assigned",
            title=("Ticket reassigned — " if reassign else "Ticket assigned — ")+row.ticket_no,
            message=f"{row.plant_id or ''} · {row.assignee_text or 'Unassigned'}",
            target_id=row.ticket_no,
            include_heads=False,
            dedupe_key=f"issue-assign:{row.id}:{row.updated_at.isoformat()}",
            additional_user_ids=[row.created_by] if row.created_by and row.created_by!=user.id else [],
        )
        self.db.refresh(row); return row

    def bulk_assign(self,data:BulkAssignRequest,user:User)->dict:
        """Assign many tickets in ONE transaction with the same rules as assign(); tickets that cannot be assigned are
        skipped with a reason. The Assignee gets one summary notification instead of one per ticket."""
        if user.role!="O&M Head":
            raise HTTPException(403,"Only the O&M Head can assign tickets in bulk")
        target=self._resolve_assignee(data.assigned_to,None)
        ids=list(dict.fromkeys(data.issue_ids))
        self.db.flush()
        rows={row.id:row for row in self.db.scalars(
            select(Issue).where(Issue.id.in_(ids),Issue.deleted_at.is_(None)).order_by(Issue.id).with_for_update())}
        assigned:list[Issue]=[]; skipped:list[dict]=[]
        for issue_id in ids:
            row=rows.get(issue_id)
            if row is None:
                skipped.append({"id":str(issue_id),"ticket_no":None,"reason":"Not found or deleted"}); continue
            if row.status not in {"Open","Assigned","Acknowledged"}:
                skipped.append({"id":str(row.id),"ticket_no":row.ticket_no,"reason":f"{row.status} — work has started or it is finished"}); continue
            if row.assigned_to==target.id:
                skipped.append({"id":str(row.id),"ticket_no":row.ticket_no,"reason":f"Already assigned to {target.display_name}"}); continue
            already=row.assigned_to is not None or bool((row.assignee_text or "").strip())
            if already and not data.reassign:
                skipped.append({"id":str(row.id),"ticket_no":row.ticket_no,"reason":f"Already assigned to {row.assignee_text or 'someone'}"}); continue
            self._ensure_assignee_scope(target,user,row.plant_id,row.equipment_id,row.equipment_ref,row.vertical)
            self.db.flush()   # a newly granted equipment type must be visible to the next ticket's scope check
            before=row.status; previous=row.assignee_text
            row.assignee_text=target.display_name; row.assigned_to=target.id; row.status="Assigned"; row.updated_at=datetime.now(timezone.utc)
            self._history(row,"issue.reassigned" if already else "issue.assigned",user,note=data.note or "Bulk assigned",
                          status_from=before,status_to="Assigned",metadata={"from_assignee":previous,"to_assignee":target.display_name,"bulk":True})
            assigned.append(row)
        self.db.commit()
        if assigned:
            self._notify_bulk(target,user,assigned)
        for row in assigned:
            self.db.refresh(row)
        return {"assigned":assigned,"skipped":skipped,"assignee":target.display_name}

    def _notify_bulk(self,target:User,actor:User,rows:list[Issue])->None:
        """One summary per person (the Assignee, and each other person who raised some of the tickets)."""
        try:
            from app.notifications.service import create_notification
            def numbers(items): return ", ".join(r.ticket_no for r in items[:8])+(f" and {len(items)-8} more" if len(items)>8 else "")
            stamp=datetime.now(timezone.utc).isoformat()
            create_notification(self.db,user_id=target.id,event_type="ticket_assigned",
                                title=f"{len(rows)} ticket{'s' if len(rows)!=1 else ''} assigned to you",message=numbers(rows),
                                target_type="issue",target_id=rows[0].ticket_no,dedupe_key=f"issue-bulk-assign:{target.id}:{stamp}")
            by_creator:dict={}
            for r in rows:
                if r.created_by and r.created_by not in {actor.id,target.id}:
                    by_creator.setdefault(r.created_by,[]).append(r)
            for creator,items in by_creator.items():
                create_notification(self.db,user_id=creator,event_type="ticket_assigned",
                                    title=f"{len(items)} of your ticket{'s' if len(items)!=1 else ''} assigned to {target.display_name}",
                                    message=numbers(items),target_type="issue",target_id=items[0].ticket_no,
                                    dedupe_key=f"issue-bulk-assign:{creator}:{stamp}")
            self.db.commit()
        except Exception:
            self.db.rollback()
            logger.exception("Bulk assignment notification failed; the assignments themselves were saved")

    def transition(self,issue_id,next_status:str,user:User,note:str|None=None,resolve:ResolveRequest|None=None):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        transitions = {
            "Open": {"Assigned", "Acknowledged"},
            "Assigned": {"Acknowledged"},
            "Acknowledged": {"In Progress"},
            "In Progress": {"Pending Vendor", "Pending Parts/Vendor", "Resolved"},
            "Pending Vendor": {"In Progress", "Resolved"},
            "Pending Parts/Vendor": {"In Progress", "Resolved"},
        }
        if next_status not in transitions.get(row.status, set()):
            raise HTTPException(409, f"Cannot move an issue from {row.status} to {next_status}")
        before=row.status
        now=datetime.now(timezone.utc)
        if next_status == "Resolved":
            if resolve is None:
                raise HTTPException(422, "Resolution details and fix photo evidence are required")
            if not resolve.root_cause.strip() or not resolve.corrective_action.strip():
                raise HTTPException(422, "Root cause and corrective action are required")
            evidence_by_id = {
                str(entry.get("id")): entry
                for entry in (row.legacy_payload or {}).get("evidence", [])
                if isinstance(entry, dict) and entry.get("storage_path")
            }
            if any(evidence_id not in evidence_by_id for evidence_id in resolve.evidence_ids):
                raise HTTPException(422, "Resolution photos must be uploaded to this ticket before submission")
            fixed_on=validate_issue_work_date(row,resolve.fixed_on)
            progress_rows=list(self.db.scalars(
                select(IssueHistory).where(IssueHistory.issue_id==row.id,IssueHistory.action=="issue.progress")
            ))
            all_work_dates=[
                entry.work_date or issue_local_date(entry.created_at)
                for entry in progress_rows
            ]
            first_work_date=min(all_work_dates) if all_work_dates else None
            if first_work_date and fixed_on < first_work_date:
                raise HTTPException(422,"Fixed date cannot be before the first work date")
            days_worked=len({
                entry.work_date or issue_local_date(entry.created_at)
                for entry in progress_rows
                if (entry.day_status or "Worked")=="Worked"
                and (entry.work_date or issue_local_date(entry.created_at)) <= fixed_on
            })
            hours_total=round(sum(
                float((entry.metadata_json or {}).get("hours",0) or 0)
                for entry in progress_rows
                if (entry.work_date or issue_local_date(entry.created_at)) <= fixed_on
            ),2)
            days_open=(fixed_on-issue_local_date(row.created_at)).days+1
            submitted_on=issue_local_today()
            row.fixed_on=fixed_on
            row.closure = {
                "rootCause": resolve.root_cause.strip(),
                "corrective": resolve.corrective_action.strip(),
                "evidenceIds": resolve.evidence_ids,
                "photos": len(resolve.evidence_ids),
                "fixed_on": fixed_on.isoformat(),
                "fixedOn": fixed_on.isoformat(),
                "submitted_on": submitted_on.isoformat(),
                "submittedOn": submitted_on.isoformat(),
                "verified_on": None,
                "verifiedOn": None,
                "days_open": days_open,
                "daysOpen": days_open,
                "days_worked": days_worked,
                "daysWorked": days_worked,
                "hours_total": hours_total,
                "hoursTotal": hours_total,
                "actualTimeToCloseHours": hours_total,
                "resolutionHrs": hours_total,
                "note": resolve.remark or resolve.note,
                "closed_directly": False,
            }
        row.status=next_status
        row.updated_at=now
        self._history(
            row,"issue.status_changed",user,note=note or ((resolve.remark or resolve.note) if resolve else None),
            status_from=before,status_to=next_status,
            metadata={"closure":dict(row.closure or {})} if resolve else None,
        )
        self.db.commit()
        self._notify(
            plant_id=row.plant_id, assigned_to=row.assigned_to,
            event_type="issue_status_changed", title=f"{row.ticket_no} → {next_status}",
            message=f"{row.plant_id or ''} · {row.description[:180]}",
            target_id=row.ticket_no, include_heads=True,
            dedupe_key=f"issue-status:{row.id}:{next_status}:{now.isoformat()}",
            additional_user_ids=[row.created_by] if row.created_by and row.created_by!=user.id else [],
        )
        self.db.refresh(row); return row

    def progress(self,issue_id,data:ProgressRequest,user:User):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if row.status not in {"Acknowledged","In Progress"}:
            raise HTTPException(409, "Acknowledge the ticket before adding work progress")
        work_date=validate_issue_work_date(row,data.work_date)
        note=data.note.strip()
        if not note:
            raise HTTPException(422,"Add a remark for this daily update")
        if data.day_status!="Worked" and not note:
            raise HTTPException(422,"Add a reason when no work was completed")
        if data.next_expected_on and data.next_expected_on < work_date:
            raise HTTPException(422,"Next expected date cannot be before the work date")
        steps=[]
        if data.step_ids_done:
            steps=list(self.db.scalars(
                select(IssueStep).where(
                    IssueStep.issue_id==row.id,
                    IssueStep.id.in_(data.step_ids_done),
                    IssueStep.removed_at.is_(None),
                )
            ))
            if len(steps)!=len(set(data.step_ids_done)):
                raise HTTPException(422,"One or more selected work steps are not available on this ticket")
            if any(step.done for step in steps):
                raise HTTPException(409,"One or more selected work steps are already complete")
        part_label=data.parts or "—"
        if data.inventory_item_id:
            item=self.db.scalar(select(InventoryItem).where(InventoryItem.legacy_id==data.inventory_item_id))
            if not item:
                try:
                    item=self.db.get(InventoryItem,uuid.UUID(data.inventory_item_id))
                except ValueError:
                    item=None
            if not item or (item.plant_id and item.plant_id!=row.plant_id):
                raise HTTPException(404, "Spare part was not found for this plant")
            quantity=Decimal(str(data.quantity or 0))
            available=Decimal(str(item.quantity or 0))
            if quantity<=0:
                raise HTTPException(422, "A positive spare-part quantity is required")
            if available<quantity:
                raise HTTPException(409, f"Insufficient stock: {available} available")
            result = self.db.execute(
                update(InventoryItem)
                .where(InventoryItem.id == item.id, InventoryItem.quantity >= quantity)
                .values(quantity=InventoryItem.quantity - quantity)
                .execution_options(synchronize_session=False)
            )
            if result.rowcount != 1:
                current = self.db.scalar(
                    select(InventoryItem.quantity).where(InventoryItem.id == item.id)
                )
                raise HTTPException(409, f"Insufficient stock: {current or 0} available")
            self.db.expire(item, ["quantity"])
            part_label=f"{item.item_name or item.legacy_id} x{quantity:g}"
            self.db.add(InventoryMovement(
                legacy_id="MV-"+uuid.uuid4().hex[:16].upper(),
                inventory_item_id=item.id,
                plant_id=item.plant_id or row.plant_id,
                movement_type="Issue consumption",
                quantity=-quantity,
                movement_at=datetime.now(timezone.utc),
                actor=user.display_name,
                notes=f"Consumed against issue {row.ticket_no}",
                payload={"issue_id":str(row.id),"ticket_no":row.ticket_no},
            ))
        elif data.quantity is not None:
            raise HTTPException(422, "Select a tracked spare part before entering its quantity")
        before=row.status
        now=datetime.now(timezone.utc)
        payload=dict(row.legacy_payload or {})
        items=list(payload.get("progress") or [])
        items.insert(0,{
            "at":now.isoformat(),"work_date":work_date.isoformat(),"day_status":data.day_status,
            "note":note,"parts":part_label,"hrs":data.hours or 0,"by":user.display_name,
            "next_step":data.next_step.strip() if data.next_step else None,
            "next_expected_on":data.next_expected_on.isoformat() if data.next_expected_on else None,
        })
        payload["progress"]=items
        row.legacy_payload=payload
        if row.status=="Acknowledged": row.status="In Progress"
        row.updated_at=now
        self._history(
            row,"issue.progress",user,note=note,
            status_from=before if before!=row.status else None,status_to=row.status,
            metadata={"parts":part_label,"hours":data.hours or 0},
            work_date=work_date,day_status=data.day_status,
            next_step=data.next_step.strip() if data.next_step else None,
            next_expected_on=data.next_expected_on,
        )
        for step in steps:
            step.done=True
            step.done_on=work_date
            step.done_at=now
            step.done_by=user.id
            step.done_by_name=user.display_name
            self._history(
                row,"issue.step_done",user,note=step.remark,
                metadata={"step_id":str(step.id),"title":step.title,"work_date":work_date.isoformat(),"via_progress":True},
                work_date=work_date,
            )
        self.db.commit()
        self._notify(
            plant_id=row.plant_id, assigned_to=row.assigned_to,
            event_type="issue_progress", title=f"Progress update — {row.ticket_no}",
            message=note[:240], target_id=row.ticket_no, include_heads=True,
            dedupe_key=f"issue-progress:{row.id}:{now.isoformat()}",
            additional_user_ids=[row.created_by] if row.created_by and row.created_by!=user.id else [],
        )
        self.db.refresh(row); return row

    @staticmethod
    def _step_out(step:IssueStep)->dict:
        return {
            "id":str(step.id),"issue_id":str(step.issue_id),"position":step.position,
            "title":step.title,"done":step.done,"done_on":step.done_on.isoformat() if step.done_on else None,
            "done_at":step.done_at.isoformat() if step.done_at else None,
            "done_by":str(step.done_by) if step.done_by else None,"done_by_name":step.done_by_name,
            "remark":step.remark,"created_by":str(step.created_by) if step.created_by else None,
            "created_at":step.created_at.isoformat() if step.created_at else None,
        }

    def list_steps(self,issue_id:UUID)->list[dict]:
        steps=self.db.scalars(
            select(IssueStep).where(
                IssueStep.issue_id==issue_id,IssueStep.removed_at.is_(None),
            ).order_by(IssueStep.position,IssueStep.created_at,IssueStep.id)
        )
        return [self._step_out(step) for step in steps]

    def add_step(self,issue_id:UUID,title:str,position:int|None,user:User)->dict:
        issue=self.repo.by_id(issue_id,for_update=True)
        if not issue: raise HTTPException(404,"Issue not found")
        steps=list(self.db.scalars(
            select(IssueStep).where(IssueStep.issue_id==issue.id,IssueStep.removed_at.is_(None))
            .order_by(IssueStep.position,IssueStep.created_at,IssueStep.id)
        ))
        index=len(steps) if position is None else min(position,len(steps))
        steps.insert(index,IssueStep(issue_id=issue.id,title=title.strip(),position=index,created_by=user.id))
        for current_index,step in enumerate(steps):
            step.position=current_index
            self.db.add(step)
        self._history(
            issue,"issue.step_added",user,note=title.strip(),
            work_date=issue_local_today(),metadata={"position":index},
        )
        self.db.commit()
        created=steps[index]
        self.db.refresh(created)
        return self._step_out(created)

    def update_step(self,issue_id:UUID,step_id:UUID,data,user:User)->dict:
        issue=self.repo.by_id(issue_id,for_update=True)
        if not issue: raise HTTPException(404,"Issue not found")
        steps=list(self.db.scalars(
            select(IssueStep).where(IssueStep.issue_id==issue.id,IssueStep.removed_at.is_(None))
            .order_by(IssueStep.position,IssueStep.created_at,IssueStep.id)
        ))
        step=next((current for current in steps if current.id==step_id),None)
        if step is None: raise HTTPException(404,"Work step not found")
        changes=data.model_dump(exclude_unset=True)
        work_date=validate_issue_work_date(issue,changes.get("done_on"))
        if "title" in changes and changes["title"] is not None and changes["title"].strip()!=step.title:
            before=step.title
            step.title=changes["title"].strip()
            self._history(issue,"issue.step_updated",user,note=step.title,work_date=work_date,metadata={"step_id":str(step.id),"old_title":before,"new_title":step.title})
        if "position" in changes and changes["position"] is not None and changes["position"]!=step.position:
            old_position=step.position
            steps.remove(step)
            steps.insert(min(changes["position"],len(steps)),step)
            for position,current in enumerate(steps):
                current.position=position
            self._history(issue,"issue.step_reordered",user,note=step.title,work_date=work_date,metadata={"step_id":str(step.id),"old_position":old_position,"new_position":step.position})
        if changes.get("remark") is not None:
            step.remark=changes["remark"].strip() or None
        if "done" in changes and changes["done"] is not None and changes["done"]!=step.done:
            if changes["done"]:
                step.done=True
                step.done_on=work_date
                step.done_at=datetime.now(timezone.utc)
                step.done_by=user.id
                step.done_by_name=user.display_name
                action="issue.step_done"
            else:
                step.done=False
                step.done_on=None
                step.done_at=None
                step.done_by=None
                step.done_by_name=None
                action="issue.step_reopened"
            self._history(
                issue,action,user,note=step.remark,work_date=work_date,
                metadata={"step_id":str(step.id),"title":step.title},
            )
        self.db.commit()
        self.db.refresh(step)
        return self._step_out(step)

    def remove_step(self,issue_id:UUID,step_id:UUID,user:User)->None:
        issue=self.repo.by_id(issue_id,for_update=True)
        if not issue: raise HTTPException(404,"Issue not found")
        step=self.db.scalar(select(IssueStep).where(
            IssueStep.issue_id==issue.id,IssueStep.id==step_id,IssueStep.removed_at.is_(None),
        ))
        if step is None: raise HTTPException(404,"Work step not found")
        removed_at=datetime.now(timezone.utc)
        step.removed_at=removed_at
        remaining=list(self.db.scalars(
            select(IssueStep).where(IssueStep.issue_id==issue.id,IssueStep.removed_at.is_(None))
            .order_by(IssueStep.position,IssueStep.created_at,IssueStep.id)
        ))
        for position,current in enumerate(remaining):
            current.position=position
        self._history(
            issue,"issue.step_removed",user,note=step.title,
            work_date=issue_local_date(removed_at),metadata={"step_id":str(step.id),"title":step.title},
        )
        self.db.commit()

    def change_etc(self,issue_id:UUID,data,user:User):
        issue=self.repo.by_id(issue_id,for_update=True)
        if not issue: raise HTTPException(404,"Issue not found")
        old_etc=issue.etc_at
        new_etc=data.new_etc
        if new_etc.tzinfo is None:
            new_etc=new_etc.replace(tzinfo=timezone.utc)
        else:
            new_etc=new_etc.astimezone(timezone.utc)
        reason=data.reason.strip()
        if not reason: raise HTTPException(422,"A reason is required to change the fix-time target")
        issue.etc_at=new_etc
        issue.updated_at=datetime.now(timezone.utc)
        change=IssueETCChange(
            issue_id=issue.id,old_etc=old_etc,new_etc=new_etc,reason=reason,
            changed_by=user.id,changed_by_name=user.display_name,
        )
        self.db.add(change)
        self._history(
            issue,"issue.etc_changed",user,note=reason,
            metadata={"old_etc":old_etc.isoformat() if old_etc else None,"new_etc":new_etc.isoformat()},
            work_date=issue_local_today(),
        )
        self.db.commit()
        self._notify(
            plant_id=issue.plant_id,assigned_to=issue.assigned_to,
            event_type="issue_etc_changed",title=f"Fix-time target changed — {issue.ticket_no}",
            message=reason[:240],target_id=issue.ticket_no,include_heads=True,
            dedupe_key=f"issue-etc:{issue.id}:{new_etc.isoformat()}",
            additional_user_ids=[issue.created_by] if issue.created_by and issue.created_by!=user.id else [],
        )
        self.db.refresh(issue)
        return issue

    # One stage back. Closed tickets use reopen(); Open has nothing before it.
    STEP_BACK={"Assigned":"Open","Acknowledged":"Assigned","In Progress":"Acknowledged",
               "Pending Vendor":"In Progress","Pending Parts/Vendor":"In Progress","Resolved":"In Progress"}

    def step_back(self,issue_id,data:StepBackRequest,user:User):
        """The O&M Head (any ticket) or the ticket's Assignee moves it back one stage when the result did not hold,
        e.g. a "done" report that turned out wrong. Callers check role and ticket scope first."""
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        before=row.status
        target=self.STEP_BACK.get(before)
        if target is None:
            raise HTTPException(409,"A closed ticket is reopened instead" if before=="Closed" else f"A ticket that is {before} has no earlier stage")
        if target=="Assigned" and row.assigned_to is None and not (row.assignee_text or "").strip():
            target="Open"
        reason=data.reason.strip()
        metadata={"reason":reason}
        if before=="Assigned":
            if user.role!="O&M Head":
                raise HTTPException(403,"Only the O&M Head can take a ticket back from its Assignee")
            metadata["from_assignee"]=row.assignee_text
            row.assigned_to=None; row.assignee_text=None
        if before=="Resolved":
            # the fix did not hold: the submitted resolution leaves the ticket but stays in its history
            metadata["withdrawn_resolution"]=row.closure; metadata["withdrawn_fixed_on"]=row.fixed_on.isoformat() if row.fixed_on else None
            row.closure=None; row.fixed_on=None
        row.status=target; row.updated_at=datetime.now(timezone.utc)
        self._history(row,"issue.stepped_back",user,note=reason,status_from=before,status_to=target,metadata=metadata)
        self.db.commit()
        self._notify(
            plant_id=row.plant_id,
            assigned_to=row.assigned_to if row.assigned_to!=user.id else None,
            event_type="issue_stepped_back",
            title=f"Ticket moved back to {target} — {row.ticket_no}",
            message=f"{user.display_name}: {reason}"[:240],
            target_id=row.ticket_no,
            include_heads=user.role!="O&M Head",
            dedupe_key=f"issue-step-back:{row.id}:{row.updated_at.isoformat()}",
        )
        self.db.refresh(row); return row

    def reopen(self,issue_id,data:dict,user:User):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if row.status not in {"Resolved","Closed"}:
            raise HTTPException(409, "Only a resolved or closed issue can be reopened")
        before=row.status
        row.status="Open"
        row.reopened_from=row.ticket_no
        row.reopen_count=(row.reopen_count or 0)+1
        row.updated_at=datetime.now(timezone.utc)
        reason=str((data or {}).get("reason") or "Issue reopened").strip()
        self._history(row,"issue.reopened",user,note=reason,status_from=before,status_to="Open")
        self.db.commit()
        self._notify(
            plant_id=row.plant_id, assigned_to=row.assigned_to,
            event_type="issue_reopened", title=f"Issue reopened — {row.ticket_no}",
            message=reason[:240], target_id=row.ticket_no, include_heads=True,
            dedupe_key=f"issue-reopened:{row.id}:{row.reopen_count}",
            additional_user_ids=[row.created_by] if row.created_by and row.created_by!=user.id else [],
        )
        self.db.refresh(row); return row

    def close(self,issue_id,data:CloseRequest,user:User):
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if data.direct:
            if user.role!="O&M Head":
                raise HTTPException(403,"Only the O&M Head can close a ticket directly")
            if row.status=="Closed":
                raise HTTPException(409,"This ticket is already closed")
            if not (data.note or "").strip():
                raise HTTPException(422,"A reason is required to close a ticket directly")
        elif row.status!="Resolved":
            raise HTTPException(409, "Only a resolved issue can be verified and closed")
        before=row.status
        verified_at=datetime.now(timezone.utc)
        closed_on=issue_local_date(verified_at)
        row.status="Closed"
        row.closed_on=closed_on
        closure={**(row.closure or {}),**data.closure,"note":data.note}
        closure.update({
            "closed_on":closed_on.isoformat(),"closed_at":verified_at.isoformat(),
            "closedAt":verified_at.isoformat(),"closed_by":user.display_name,
            "verified_on":closed_on.isoformat(),"verifiedOn":closed_on.isoformat(),
            "verified_by_name":user.display_name,"verifiedBy":user.display_name,
            "verified_at":verified_at.isoformat(),"verifiedAt":verified_at.isoformat(),
        })
        if data.direct:
            reason=(data.note or "").strip()
            closure.update({
                "closed_directly":True,"directClose":True,"direct_reason":reason,
                "direct_closed_on":closed_on.isoformat(),"direct_closed_by":user.display_name,
                "rootCause":closure.get("rootCause") or "Direct close (no resolution flow)",
                "corrective":closure.get("corrective") or reason,
            })
        row.closure=closure
        row.updated_at=verified_at
        self._history(row,"issue.closed" if not data.direct else "issue.closed_directly",user,note=data.note,status_from=before,status_to="Closed")
        self.db.commit()
        self._notify(
            plant_id=row.plant_id, assigned_to=row.assigned_to,
            event_type="ticket_completed", title=f"Ticket completed — {row.ticket_no}",
            message=f"{row.plant_id or ''} · {row.description[:180]}",
            target_id=row.ticket_no, include_heads=True,
            dedupe_key=f"issue-closed:{row.id}:{verified_at.isoformat()}",
            additional_user_ids=[row.created_by] if row.created_by and row.created_by!=user.id else [],
        )
        self.db.refresh(row); return row
