from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import logging
import uuid

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.core.models import AuditLog, InventoryItem, InventoryMovement, Issue, IssueETCChange, IssueHistory, IssueStep, Plant, User, WorkCategory
from app.core.security import plant_scope_matches, text_is_current_user
from app.issues.deadlines import default_deadline
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

    def _ensure_assignee_scope(self, target: User, actor: User, plant_id) -> None:
        """Validate that an assigned ticket has a plant; Assignees have portfolio access."""
        if plant_id is None:
            raise HTTPException(422, "Choose the plant before assigning the ticket")

    def _auto_assignee(self, equipment: str | None, plant_id):
        """Resolve the site-specific rule, global owner, backup or default."""
        if plant_id is None:
            return None, None
        from app.equipment.issue_routing import IssueRouting
        from app.equipment.service import canonical_key
        return IssueRouting(self.db, {key} if (key := canonical_key(equipment)) else set(), {plant_id}).resolve(plant_id, equipment)

    DUPLICATE_WINDOW_SECONDS = 120

    def _recent_duplicate(self, user: User, payload: dict) -> Issue | None:
        """The creator's newest ticket if its submitted issue details match a recent retry."""
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
        def norm_datetime(value):
            if value is None:
                return None
            value = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
            return value.isoformat()
        same = latest.plant_id == payload.get("plant_id")
        for field in ("vertical", "subcategory", "description", "serial_no", "supplier_maker"):
            same = same and norm(getattr(latest, field)) == norm(payload.get(field))
        for field in ("unit_count", "equipment_running", "severity", "impact", "assigned_to"):
            same = same and getattr(latest, field) == payload.get(field)
        same = same and norm_datetime(latest.occurred_at) == norm_datetime(payload.get("occurred_at"))
        return latest if same else None

    def create(self,data:IssueCreate,user:User):
        payload = data.model_dump()
        assigned_to = payload.pop("assigned_to", None)
        if user.role == "Assignee":
            if assigned_to is not None and assigned_to != user.id:
                raise HTTPException(403, "Assignees can only assign new issues to themselves")
        # Serialize routing with ownership changes, including manually numbered tickets.
        _lock_issue_ticket_numbers(self.db)
        assignee_id = assigned_to
        ticket_no = (payload.pop("ticket_no", None) or "").strip()
        auto_number = not ticket_no
        plant_id = payload.get("plant_id")
        plant = self.db.get(Plant, plant_id) if plant_id else None
        if plant_id and not plant:
            raise HTTPException(404, "Plant not found")
        assignee = self._resolve_assignee(assigned_to, None) if assigned_to else None
        if assignee:
            self._ensure_assignee_scope(assignee, user, plant_id)
        # Nobody was chosen: resolve plant overrides, equipment owners, backups and the default.
        # Keep the existing escalation if no eligible owner is configured.
        auto_equipment = None
        auto_rule = None
        if assignee is None:
            candidate, auto_rule = self._auto_assignee(payload.get("vertical"), plant_id)
            if candidate is not None:
                assignee, assignee_id = candidate, candidate.id
                auto_equipment = payload.get("vertical") or "Site issue"
            elif user.role == "Assignee":
                assignee, assignee_id = user, user.id
        if payload.get("etc_at") is None:
            # No deadline sent: the priority's default duration, which the O&M Head sets (app/issues/deadlines.py).
            payload["etc_at"] = default_deadline(self.db, payload["severity"])
        row = None
        for attempt in range(6):
            if auto_number:
                _lock_issue_ticket_numbers(self.db)
                # Checked under the ticket-number lock so simultaneous submissions of the same form cannot each
                # pass the check before either ticket is saved.
                duplicate = self._recent_duplicate(user, {**payload, "assigned_to": assignee_id})
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
                legacy_payload={"evidence": []},
            )
            self.db.add(row)
            try:
                self.db.flush()
                self._history(row,"issue.created",user,status_to=row.status)
                if auto_equipment and assignee is not None:
                    self._history(
                        row, "issue.auto_assigned", user, status_to=row.status,
                        note=(f"Assigned automatically to {assignee.display_name}, the responsible "
                              f"person for {auto_equipment} ({auto_rule})."),
                        metadata={"rule": auto_rule, "equipment": auto_equipment,
                                  "assigned_to": str(assignee.id)})
                elif row.assigned_to is None and payload.get("vertical"):
                    self._history(
                        row, "issue.assignment_skipped", user, status_to=row.status,
                        note=(f"Unassigned - responsibility not configured for "
                              f"{payload.get('vertical')}. The O&M Head can assign it manually."),
                        metadata={"rule": "equipment_responsibility",
                                  "equipment": payload.get("vertical")})
                self.db.commit(); self.db.refresh(row)
                break
            except IntegrityError as exc:
                self.db.rollback()
                if not auto_number or attempt == 5:
                    raise HTTPException(409,"Ticket number already exists") from exc
        if auto_equipment and row.assigned_to is not None:
            self._notify(
                plant_id=row.plant_id, assigned_to=row.assigned_to, event_type="ticket_assigned",
                title="Ticket assigned to you - " + row.ticket_no,
                message=f"{plant.site_code if plant else ''} · {auto_equipment} · {row.description[:180]}",
                target_id=row.ticket_no, dedupe_key=f"issue-auto-assign:{row.id}",
            )
        elif row.assigned_to is None and payload.get("vertical"):
            # Only when an equipment category was chosen and nobody is configured for it: a
            # ticket raised without a category is not a missing responsibility.
            try:
                from app.notifications.service import notify_users, users_with_role
                notify_users(
                    self.db, users_with_role(self.db, {"O&M Head"}), event_type="issue_unassigned",
                    title="Unassigned - responsibility not configured - " + row.ticket_no,
                    message=(f"{payload.get('vertical') or 'Equipment'} has no responsible person "
                             f"configured. Assign the ticket manually or set responsibility in Login Access."),
                    target_type="issue", target_id=row.ticket_no,
                    dedupe_key=f"issue-unassigned:{row.id}",
                )
                self.db.commit()
            except Exception:
                self.db.rollback()
                logger.exception("Unassigned-ticket notification failed; the ticket was created")
        self._notify(
            plant_id=row.plant_id, assigned_to=(None if auto_equipment and row.severity != "Critical" else row.assigned_to),
            event_type="critical_issue" if row.severity == "Critical" else "issue_created",
            title=("Critical issue raised — " if row.severity == "Critical" else "New issue raised — ")+row.ticket_no,
            message=f"{plant.site_code if plant else ''} · {row.vertical or 'Site issue'} · {row.description[:180]}",
            target_id=row.ticket_no,
            include_heads=True,
            dedupe_key=f"issue-created:{row.id}",
        )
        self.db.refresh(row)
        return row

    def update(self,issue_id,data:IssueUpdate,user:User):
        # Keep the same lock order as responsibility updates/backfill (routing lock, then ticket).
        if user.role == "O&M Head" and (data.assignment_mode in {"auto", "manual"} or "vertical" in data.model_fields_set):
            _lock_issue_ticket_numbers(self.db)
        row=self.repo.by_id(issue_id,for_update=True)
        if not row: raise HTTPException(404,"Issue not found")
        if user.role != "O&M Head":
            if user.role != "Assignee" or not (row.assigned_to == user.id or (row.assigned_to is None and text_is_current_user(row.assignee_text,user))):
                raise HTTPException(403,"Only the assigned Assignee can edit this ticket")
            if row.status == "Closed":
                raise HTTPException(409,"A closed ticket can only be edited by the O&M Head")
        changes=data.model_dump(exclude_unset=True)
        reason=(changes.pop("change_reason", None) or "").strip()
        mode=changes.pop("assignment_mode", None)
        requested_owner=changes.pop("assigned_to", None)
        if user.role != "O&M Head" and ({"vertical", "subcategory", "description", "assignment_mode", "assigned_to"} & data.model_fields_set):
            raise HTTPException(403,"Only the O&M Head can correct equipment, original remarks or assignment")
        if requested_owner is not None and mode != "manual":
            raise HTTPException(422,"Choose manual assignment to select an Assignee")
        if "description" in changes:
            # An explicit empty string clears a remark; null and accidental whitespace are invalid.
            if changes["description"] is None or (changes["description"] and not changes["description"].strip()):
                raise HTTPException(422,"Use an empty string to clear the remark")
            changes["description"]=changes["description"].strip()
        category_changed="vertical" in changes and changes["vertical"] != row.vertical
        if category_changed or ("subcategory" in changes and changes["subcategory"] != row.subcategory):
            category=self.db.scalar(select(WorkCategory).where(WorkCategory.name==changes.get("vertical",row.vertical),WorkCategory.active.is_(True)))
            if not category:
                raise HTTPException(422,"Choose an active configured equipment category")
            if category_changed:
                changes.setdefault("subcategory",None)
                # Breakdown flags describe the previous equipment, not its replacement.
                changes.setdefault("equipment_running",None)
            if changes.get("subcategory") and changes["subcategory"] not in (category.sub_problems or []):
                raise HTTPException(422,"Choose a problem configured for the selected equipment")
        if (changes.get("vertical",row.vertical) or "").strip().casefold() in {"inverter","string"} and changes.get("equipment_running",row.equipment_running) is False:
            if not (changes.get("serial_no",row.serial_no) or "").strip() or not (changes.get("description",row.description) or "").strip():
                raise HTTPException(422,"A breakdown requires selected units and a remark")
        # Closed/resolved/closure-pending history can be corrected, but its owner is protected.
        protected=row.status in {"Closed","Resolved","Pending Closure"}
        if mode is None:
            mode="auto" if category_changed and not protected else "retain"
        route_source=None
        if mode != "retain":
            if protected:
                raise HTTPException(409,"Retain the owner of a resolved, closed or closure-pending ticket")
            if mode == "auto":
                target,route_source=self._auto_assignee(changes.get("vertical",row.vertical),row.plant_id)
                if target is None:
                    raise HTTPException(422,"No eligible automatic Assignee. Configure responsibility or choose retain/manual assignment")
            else:
                target=self._resolve_assignee(requested_owner,None)
                route_source="manual"
            self._ensure_assignee_scope(target,user,row.plant_id)
            changes.update(assigned_to=target.id,assignee_text=target.display_name)
            if row.status == "Open": changes["status"]="Assigned"
        def utc(v):
            if v is None: return None
            return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v.astimezone(timezone.utc)
        for key in ("occurred_at","etc_at"):
            if key in changes:
                if changes[key] is None: raise HTTPException(422,"The start date cannot be empty" if key=="occurred_at" else "The deadline cannot be empty")
                changes[key]=utc(changes[key])
        before={key:getattr(row,key) for key in changes if (utc(getattr(row,key)) if key in ("occurred_at","etc_at") else getattr(row,key))!=changes[key]}
        if not before: return row
        new_start=changes.get("occurred_at",utc(row.occurred_at) or utc(row.created_at)); new_etc=changes.get("etc_at",utc(row.etc_at))
        if ("occurred_at" in before or "etc_at" in before) and new_start and new_etc and new_etc<new_start:
            raise HTTPException(422,"The deadline cannot be before the start date")
        if "etc_at" in before:
            # A deadline edit is logged like every other deadline change (ETC change history on the ticket).
            self.db.add(IssueETCChange(issue_id=row.id,old_etc=row.etc_at,new_etc=changes["etc_at"],reason=reason or "Ticket details corrected",changed_by=user.id,changed_by_name=user.display_name))
        for key in before: setattr(row,key,changes[key])
        row.updated_at=datetime.now(timezone.utc)
        def stamp(v): return str(v) if isinstance(v,uuid.UUID) else (v.isoformat() if isinstance(v,(date,datetime)) else v)
        self._history(row,"issue.edited",user,note=reason or "Ticket details corrected",
                      status_from=before.get("status"),status_to=row.status if "status" in before else None,metadata={
            "changes":{key:{"before":stamp(old),"after":stamp(changes[key])} for key,old in before.items()},
            "assignment_rule":route_source,
        })
        self.db.commit()
        if "assigned_to" in before:
            self._notify(plant_id=row.plant_id,assigned_to=row.assigned_to,event_type="ticket_reassigned",
                         title="Ticket reassigned — "+row.ticket_no,message="Issue responsibility updated",
                         target_id=row.ticket_no,include_heads=False,
                         dedupe_key=f"issue-edit-assign:{row.id}:{row.updated_at.isoformat()}")
        self.db.refresh(row); return row

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
        new_start=utc(fields["occurred_at"]) if "occurred_at" in fields else (utc(issue.occurred_at) or utc(issue.created_at))
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
        self._ensure_assignee_scope(target,user,row.plant_id)
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
            self._ensure_assignee_scope(target,user,row.plant_id)
            self.db.flush()   # a newly granted plant must be visible to the next ticket's scope check
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
            "In Progress": {"Pending Vendor", "Pending Parts/Vendor", "Pending Closure", "Resolved"},
            "Pending Vendor": {"In Progress", "Pending Closure", "Resolved"},
            "Pending Parts/Vendor": {"In Progress", "Pending Closure", "Resolved"},
            "Pending Closure": {"Closed", "In Progress"},
        }
        if row.status == "Pending Closure" and user.role != "O&M Head":
            raise HTTPException(403, "Only the O&M Head can confirm or reject a closure request")
        if row.status == "Pending Closure" and next_status == "In Progress" and not (note or "").strip():
            raise HTTPException(422, "Add a remark when sending this issue back to In Progress")
        if next_status not in transitions.get(row.status, set()):
            raise HTTPException(409, f"Cannot move an issue from {row.status} to {next_status}")
        if next_status == "Closed" and (row.status != "Pending Closure" or user.role != "O&M Head"):
            raise HTTPException(403, "Only the O&M Head can confirm a pending closure")
        before=row.status
        now=datetime.now(timezone.utc)
        if next_status == "Resolved":
            # The resolution details and fix photos are optional, so a transition without them
            # resolves the ticket with an empty resolution.
            if resolve is None:
                resolve = ResolveRequest()
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
        if next_status == "Closed":
            closed_on = issue_local_date(now)
            row.closed_on = closed_on
            closure = dict(row.closure or {})
            requested = closure.get("closure_request") or {}
            closure.update({
                "closed_on": closed_on.isoformat(),
                "closed_at": now.isoformat(),
                "closedAt": now.isoformat(),
                "closed_by": user.display_name,
                "verified_on": closed_on.isoformat(),
                "verifiedOn": closed_on.isoformat(),
                "verified_by_name": user.display_name,
                "verifiedBy": user.display_name,
                "verified_at": now.isoformat(),
                "verifiedAt": now.isoformat(),
                "note": requested.get("remark") or note,
            })
            row.closure = closure
        row.updated_at=now
        if next_status == "Pending Closure":
            action = "issue.closure_requested"
        elif before == "Pending Closure" and next_status == "Closed":
            action = "issue.closure_confirmed"
        elif before == "Pending Closure" and next_status == "In Progress":
            action = "issue.closure_rejected"
        else:
            action = "issue.status_changed"
        self._history(
            row,action,user,note=note or ((resolve.remark or resolve.note) if resolve else None),
            status_from=before,status_to=next_status,
            metadata={"closure":dict(row.closure or {})}
            if resolve or next_status in {"Pending Closure", "Closed"} else None,
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
        if data.resolved is not None:
            remark = (data.remark or "").strip()
            if data.resolved:
                if row.status == "Resolved":
                    return self.close(issue_id, CloseRequest(note=remark), user)
                return self.transition(
                    issue_id, "Resolved", user,
                    resolve=ResolveRequest(note=remark, remark=remark),
                )
            if user.role == "Assignee":
                if row.status not in {"In Progress", "Pending Vendor", "Pending Parts/Vendor"}:
                    raise HTTPException(409, "Only an in-progress issue can be sent for closure approval")
                before = row.status
                now = datetime.now(timezone.utc)
                closure = dict(row.closure or {})
                closure["closure_request"] = {
                    "remark": remark,
                    "requested_by": user.display_name,
                    "requested_at": now.isoformat(),
                }
                row.closure = closure
                row.status = "Pending Closure"
                row.updated_at = now
                self._history(
                    row, "issue.closure_requested", user, note=remark,
                    status_from=before, status_to="Pending Closure",
                    metadata={"requested_by": user.display_name, "requested_by_id": str(user.id)},
                )
                self.db.commit()
                plant = self.db.get(Plant, row.plant_id) if row.plant_id else None
                self._notify(
                    plant_id=row.plant_id,
                    assigned_to=None,
                    event_type="issue_closure_requested",
                    title=f"Closure requested — {row.ticket_no}",
                    message=f"{plant.site_code if plant else ''} · {remark}",
                    target_id=row.ticket_no,
                    dedupe_key=f"issue-closure-request:{row.id}:{now.isoformat()}",
                )
                self.db.refresh(row)
                return row
            if user.role == "O&M Head":
                return self.close(issue_id, CloseRequest(note=remark, direct=True), user)
            raise HTTPException(403, "Only the O&M Head or the ticket's Assignee can close a ticket")
        if row.status == "Pending Closure" and user.role != "O&M Head":
            raise HTTPException(403, "Only the O&M Head can confirm a pending closure")
        if data.direct:
            if user.role != "O&M Head":
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
