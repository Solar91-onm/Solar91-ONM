from __future__ import annotations

from typing import Annotated
from datetime import date, datetime, timedelta, timezone
import uuid
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.models import Issue, IssueHistory, User, UserEquipmentTypeAssignment
from app.core.security import ensure_equipment_scope, ensure_plant_scope, equipment_scope_matches, get_current_user, is_head, require_csrf, require_permission, text_is_current_user, user_scoped_equipment_types, user_scoped_plant_ids
from app.issues import importer as issue_importer
from app.issues.repository import IssueRepository
from app.issues.schemas import AssignmentRequest, CloseRequest, IssueCommentCreate, IssueCreate, IssueDatesUpdate, IssueETCUpdate, IssueOut, IssueStatusRequest, IssueStepCreate, IssueStepUpdate, IssueUpdate, IssueDeleteRequest, IssueRestoreRequest, ProgressRequest, ResolveRequest, ReopenRequest, normalize_issue_severity
from app.issues.service import IssueService
from app.storage.service import SupabaseStorage

router=APIRouter(prefix="/api/issues",tags=["Site Issues"])
PLANT_TIMEZONE=timezone(timedelta(hours=5,minutes=30))

@router.get("/assignees")
def list_issue_assignees(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.create"))]):
    rows=list(db.scalars(select(User).where(User.role=="Assignee",User.is_active.is_(True)).order_by(User.display_name)))
    type_rows=db.execute(
        select(UserEquipmentTypeAssignment.user_id,UserEquipmentTypeAssignment.equipment_type)
        .join(User,User.id==UserEquipmentTypeAssignment.user_id)
        .where(User.role=="Assignee",User.is_active.is_(True))
        .order_by(UserEquipmentTypeAssignment.equipment_type)
    ).all()
    by_user:dict[UUID,list[str]]={}
    for user_id,equipment_type in type_rows:
        by_user.setdefault(user_id,[]).append(equipment_type)
    return [{"id":str(row.id),"name":row.display_name,"equipment_types":by_user.get(row.id,[])} for row in rows]

@router.get("/import/template")
def issue_upload_template(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.create"))]):
    return Response(content=issue_importer.template_bytes(db,user),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition":'attachment; filename="Site_Issues_Template.xlsx"'})

@router.post("/import",dependencies=[Depends(require_csrf)])
def upload_issues(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.create"))],file:UploadFile=File(...),dry_run:bool=True):
    return issue_importer.import_issues(db,user,file.filename or "",file.file.read(issue_importer.MAX_ISSUE_BYTES+1),dry_run=dry_run)

@router.get("/pulse")
def issues_pulse(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    """Very cheap change detector used by open browsers (one aggregate query, no row data).

    The browser re-fetches its data only when ``count`` or ``latest`` differ from the last pulse.
    """
    plant_scope=user_scoped_plant_ids(db,user)
    stmt=select(func.count(Issue.id),func.max(Issue.updated_at)).where(Issue.deleted_at.is_(None))
    if plant_scope is not None:
        if not plant_scope:
            return {"count":0,"latest":None}
        stmt=stmt.where(Issue.plant_id.in_(plant_scope))
    count,latest=db.execute(stmt).one()
    return {"count":int(count or 0),"latest":latest.isoformat() if latest else None}

@router.get("",response_model=list[IssueOut])
def list_issues(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)],plant_id:UUID|None=None,status:str|None=None,severity:str|None=None,assignee:str|None=None,vertical:str|None=None,maker:str|None=None,equipment:str|None=None,site_code:str|None=None,project_number:str|None=None,occurred_from:datetime|None=None,occurred_to:datetime|None=None,q:str|None=None,offset:int=0,limit:int=Query(50,le=200)):
    plant_scope=user_scoped_plant_ids(db,user)
    equipment_scope=user_scoped_equipment_types(db,user) if user.role == "Assignee" else None
    severity = normalize_issue_severity(severity)
    return IssueRepository(db).list(plant_id=plant_id,status=status,severity=severity,assignee=assignee,vertical=vertical,maker=maker,equipment=equipment,site_code=site_code,project_number=project_number,occurred_from=occurred_from,occurred_to=occurred_to,q=q,allowed_plant_ids=plant_scope,allowed_equipment_types=equipment_scope,offset=offset,limit=limit)

@router.get("/deleted", response_model=list[IssueOut])
def list_deleted_issues(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.manage"))],limit:int=Query(100,ge=1,le=200)):
    return IssueRepository(db).list(deleted_only=True,limit=limit)

@router.delete("/{issue_id}", dependencies=[Depends(require_csrf)])
def delete_issue(issue_id:UUID, data:IssueDeleteRequest, db:Annotated[Session,Depends(get_db)], user:Annotated[User,Depends(require_permission("issues.manage"))]):
    return IssueService(db).archive(issue_id,data,user)

@router.post("/{issue_id}/restore", response_model=IssueOut, dependencies=[Depends(require_csrf)])
def restore_issue(issue_id:UUID, data:IssueRestoreRequest, db:Annotated[Session,Depends(get_db)], user:Annotated[User,Depends(require_permission("issues.manage"))]):
    return IssueService(db).restore(issue_id,data,user)

@router.get("/{issue_id}/activity")
def get_issue_activity(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)],include_days:bool=False):
    issue=IssueRepository(db).by_id(issue_id)
    if not issue:
        raise HTTPException(404,"Issue not found")
    _require_issue_action_scope(db,user,issue_id)
    rows=list(db.scalars(select(IssueHistory).where(IssueHistory.issue_id==issue_id).order_by(IssueHistory.created_at,IssueHistory.id)))
    entries=[{
        "id":str(row.id),"action":row.action,"note":row.note,
        "status_from":row.status_from,"status_to":row.status_to,
        "metadata":row.metadata_json or {},"actor":row.actor_name or "System",
        "at":row.created_at.isoformat() if row.created_at else None,
        "work_date":row.work_date.isoformat() if row.work_date else None,
        "day_status":row.day_status,"next_step":row.next_step,
        "next_expected_on":row.next_expected_on.isoformat() if row.next_expected_on else None,
        "review_state":row.review_state,"reviewed_by":str(row.reviewed_by) if row.reviewed_by else None,
        "reviewed_by_name":row.reviewed_by_name,
        "reviewed_at":row.reviewed_at.isoformat() if row.reviewed_at else None,
        "review_note":row.review_note,
        "review_on_behalf_of":str(row.review_on_behalf_of) if row.review_on_behalf_of else None,
        "date":(row.work_date or (row.created_at.replace(tzinfo=timezone.utc) if row.created_at and row.created_at.tzinfo is None else row.created_at).astimezone(PLANT_TIMEZONE).date()).isoformat() if row.work_date or row.created_at else None,
    } for row in rows]
    if not include_days:
        return entries

    created_at=issue.created_at
    if created_at.tzinfo is None:
        created_at=created_at.replace(tzinfo=timezone.utc)
    first_day=created_at.astimezone(PLANT_TIMEZONE).date()
    today=datetime.now(timezone.utc).astimezone(PLANT_TIMEZONE).date()
    last_day=issue.closed_on if issue.status=="Closed" and issue.closed_on else today
    if last_day<first_day:
        last_day=first_day
    grouped:dict[date,list[dict]]={}
    for entry in entries:
        entry_date=date.fromisoformat(entry["date"]) if entry["date"] else first_day
        grouped.setdefault(entry_date,[]).append(entry)
    days=[]
    round_no=1
    current=first_day
    while current<=last_day:
        day_entries=grouped.get(current,[])
        if any(entry["action"]=="issue.reopened" for entry in day_entries):
            round_no+=1
        work_entries=[entry for entry in day_entries if entry["action"]=="issue.progress"]
        hours=sum(float((entry["metadata"] or {}).get("hours",0) or 0) for entry in work_entries)
        statuses=[entry.get("day_status") or "Worked" for entry in work_entries]
        if not day_entries:
            summary="no update"
        elif "Worked" in statuses:
            summary=f"Worked · {hours:g} hrs" if hours else "Worked"
        elif statuses:
            summary=statuses[-1]
        else:
            summary=f"{len(day_entries)} update(s)"
        days.append({
            "date":current.isoformat(),"day_no":(current-first_day).days+1,
            "round_no":round_no,"summary":summary,"hours":round(hours,2),
            "day_status":statuses[-1] if statuses else None,"entries":day_entries,
        })
        current+=timedelta(days=1)
    return {"activity":entries,"days":days}

@router.post("/{issue_id}/comments",dependencies=[Depends(require_csrf)])
def create_issue_comment(issue_id:UUID,data:IssueCommentCreate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.view"))]):
    row=IssueRepository(db).by_id(issue_id)
    if not row: raise HTTPException(404,"Issue not found")
    _require_issue_action_scope(db,user,issue_id)
    if row.status=="Closed":
        # The O&M Head closing a ticket ends its conversation; the full history stays on the ticket.
        raise HTTPException(409,"This ticket is closed. Reopen it to continue the conversation")
    evidence_ids={
        str(entry.get("id"))
        for entry in (row.legacy_payload or {}).get("evidence",[])
        if isinstance(entry,dict)
    }
    if any(evidence_id not in evidence_ids for evidence_id in data.evidence_ids):
        raise HTTPException(422,"Comment photos must be uploaded to this issue first")
    comment=data.message.strip()
    if not comment and not data.evidence_ids:
        raise HTTPException(422,"Add a message or attach a photo")
    entry=IssueHistory(
        issue_id=row.id,action="issue.message",note=comment or "Shared photo update",
        actor_id=user.id,actor_name=user.display_name,
        metadata_json={"evidence_ids":data.evidence_ids,"intent":data.intent,"role":user.role},
    )
    db.add(entry)
    row.updated_at=datetime.now(timezone.utc)
    db.flush()
    from app.notifications.service import notify_issue_assignee_and_heads
    notify_issue_assignee_and_heads(
        db,plant_id=row.plant_id,assigned_to=row.assigned_to,
        event_type="issue_message",title=f"Ticket update — {row.ticket_no}",
        message=comment[:240] or "A photo update was added to the ticket.",
        target_id=row.ticket_no,include_heads=True,
        dedupe_key=f"issue-message:{entry.id}",
        additional_user_ids=[row.created_by] if row.created_by and row.created_by!=user.id else [],
    )
    db.commit()
    db.refresh(entry)
    return {
        "id":str(entry.id),"action":entry.action,"note":entry.note,
        "status_from":None,"status_to":None,"metadata":entry.metadata_json,
        "actor":entry.actor_name,"at":entry.created_at.isoformat() if entry.created_at else None,
    }

@router.post("/{issue_id}/evidence",dependencies=[Depends(require_csrf)])
def upload_issue_evidence(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.create"))],files:list[UploadFile]=File(...)):
    row=IssueRepository(db).by_id(issue_id)
    if not row: raise HTTPException(404,"Issue not found")
    _require_issue_action_scope(db,user,issue_id)
    if not files: raise HTTPException(422,"Choose at least one photo")
    existing=[dict(entry) for entry in (row.legacy_payload or {}).get("evidence",[]) if isinstance(entry,dict)]
    if len(existing)+len(files)>10: raise HTTPException(422,"An issue can have no more than 10 evidence photos")
    max_bytes=get_settings().max_upload_mb*1024*1024
    accepted={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"}
    prepared=[]
    for file in files:
        content_type=(file.content_type or "").lower()
        if content_type not in accepted: raise HTTPException(415,"Only JPEG, PNG and WebP photos are supported")
        data=file.file.read(max_bytes+1)
        if len(data)>max_bytes: raise HTTPException(413,f"Each photo must be no larger than {get_settings().max_upload_mb} MB")
        if len(data)<32: raise HTTPException(422,"A selected photo is empty or invalid")
        prepared.append((file,data,content_type,accepted[content_type]))
    storage=SupabaseStorage()
    uploaded=[]
    try:
        for file,data,content_type,ext in prepared:
            evidence_id="ISSUEEV-"+uuid.uuid4().hex[:12].upper()
            path=f"issues/{row.id}/{uuid.uuid4().hex}.{ext}"
            storage.upload(path,data,content_type)
            uploaded.append({
                "id":evidence_id,"at":datetime.now(timezone.utc).isoformat(),"by":user.display_name,
                "name":file.filename or f"photo.{ext}","size":len(data),"content_type":content_type,
                "storage_path":path,"url":f"/api/issues/{row.id}/evidence/{evidence_id}",
            })
        row.legacy_payload={**(row.legacy_payload or {}),"evidence":existing+uploaded}
        row.photo_count=len(existing)+len(uploaded)
        row.updated_at=datetime.now(timezone.utc)
        db.add(IssueHistory(issue_id=row.id,action="issue.evidence_uploaded",note=f"Uploaded {len(uploaded)} evidence photo(s)",actor_id=user.id,actor_name=user.display_name,metadata_json={"evidence_ids":[entry["id"] for entry in uploaded]}))
        db.commit()
        return uploaded
    except Exception:
        db.rollback()
        storage.remove([entry["storage_path"] for entry in uploaded])
        raise

@router.get("/{issue_id}/evidence/{evidence_id}")
def get_issue_evidence(issue_id:UUID,evidence_id:str,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    row=IssueRepository(db).by_id(issue_id)
    if not row: raise HTTPException(404,"Issue not found")
    _require_issue_action_scope(db,user,issue_id)
    entry=next((item for item in (row.legacy_payload or {}).get("evidence",[]) if item.get("id")==evidence_id),None)
    if not entry or not entry.get("storage_path"): raise HTTPException(404,"Issue photo evidence not found")
    data,content_type=SupabaseStorage().download(str(entry["storage_path"]))
    return Response(content=data,media_type=content_type,headers={"Cache-Control":"private, max-age=60"})

@router.post("",response_model=IssueOut,status_code=201,dependencies=[Depends(require_csrf)])
def create_issue(data:IssueCreate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.create"))]):
    plant_id = data.plant_id
    if plant_id is None and not is_head(user):
        allowed = user_scoped_plant_ids(db, user) or set()
        if len(allowed) == 1:
            plant_id = next(iter(allowed))
        else:
            raise HTTPException(422, "A plant is required for scoped issue creation")
    if plant_id:
        if user.role == "Assignee":
            ensure_equipment_scope(db,user,plant_id,data.equipment_id,data.equipment_ref,data.vertical)
        else:
            ensure_plant_scope(db,user,plant_id)
    # The Assignee is validated (and, for the O&M Head, given the equipment scope) inside IssueService.create.
    if plant_id != data.plant_id:
        data = data.model_copy(update={"plant_id": plant_id})
    return IssueService(db).create(data,user)

@router.patch("/{issue_id}",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def update_issue(issue_id:UUID,data:IssueUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.manage"))]): return IssueService(db).update(issue_id,data,user)

@router.patch("/{issue_id}/dates",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def change_issue_dates(issue_id:UUID,data:IssueDatesUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    """Start date + deadline of a ticket: O&M Head, or the Assignee the ticket is assigned to. Never a Site Engineer."""
    _require_issue_workflow_role(user)
    _require_issue_workflow_scope(db,user,issue_id)
    return IssueService(db).change_dates(issue_id,data,user)

@router.post("/{issue_id}/reset",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def reset_issue(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.manage"))]):
    _require_issue_action_scope(db,user,issue_id)
    return IssueService(db).reset(issue_id,user)

@router.post("/{issue_id}/assign",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def assign_issue(issue_id:UUID,data:AssignmentRequest,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.manage"))]): return IssueService(db).assign(issue_id,data,user,False)

@router.post("/{issue_id}/reassign",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def reassign_issue(issue_id:UUID,data:AssignmentRequest,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.manage"))]): return IssueService(db).assign(issue_id,data,user,True)

def _require_issue_action_scope(db:Session,user:User,issue_id:UUID):
    row=IssueRepository(db).by_id(issue_id)
    if not row: return
    if user.role=="O&M Head": return
    if user.role == "Assignee":
        ensure_equipment_scope(db,user,row.plant_id,row.equipment_id,row.equipment_ref,row.vertical)
    else:
        ensure_plant_scope(db,user,row.plant_id)

def _require_issue_workflow_role(user:User):
    if user.role not in {"O&M Head","Assignee"}:
        raise HTTPException(403,"Only an Assignee or O&M Head can advance the issue workflow")

def _require_issue_workflow_scope(db:Session,user:User,issue_id:UUID):
    row=IssueRepository(db).by_id(issue_id,for_update=True)
    if not row:
        raise HTTPException(404,"Issue not found")
    _require_issue_action_scope(db,user,issue_id)
    if user.role=="Assignee":
        if row.assigned_to is not None and row.assigned_to!=user.id:
            raise HTTPException(403,"Only the assigned Assignee can advance this ticket")
        if row.assigned_to is None:
            # Older tickets were assigned by name only. Accept the person whose name it is and link the ticket to them.
            if not row.assignee_text:
                raise HTTPException(403,"This ticket has not been assigned yet. Ask the O&M Head to assign it first")
            if not text_is_current_user(row.assignee_text,user):
                raise HTTPException(403,"Only the assigned Assignee can advance this ticket")
            row.assigned_to=user.id


@router.post("/{issue_id}/status",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def transition_issue_status(issue_id:UUID, data:IssueStatusRequest, db:Annotated[Session,Depends(get_db)], user:Annotated[User,Depends(get_current_user)]):
    _require_issue_workflow_role(user)
    status = data.status.strip()
    if status=="Pending Parts/Vendor":
        status="Pending Vendor"
    allowed_statuses = {"Acknowledged","In Progress","Pending Vendor","Pending Parts/Vendor"}
    if status not in allowed_statuses:
        raise HTTPException(422, "Unsupported issue status")
    _require_issue_workflow_scope(db,user,issue_id)
    return IssueService(db).transition(issue_id,status,user,note=(data.note or "").strip() or None)

@router.post("/{issue_id}/reopen",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def reopen_issue(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.manage"))],data:ReopenRequest|None=None):
    return IssueService(db).reopen(issue_id,(data.model_dump() if data else {}),user)

@router.post("/{issue_id}/acknowledge",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def acknowledge_issue(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.progress"))]):
    _require_issue_workflow_role(user)
    _require_issue_workflow_scope(db,user,issue_id); return IssueService(db).transition(issue_id,"Acknowledged",user)

@router.post("/{issue_id}/start",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def start_issue(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.progress"))]):
    _require_issue_workflow_role(user)
    _require_issue_workflow_scope(db,user,issue_id); return IssueService(db).transition(issue_id,"In Progress",user)

@router.post("/{issue_id}/progress",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def add_progress(issue_id:UUID,data:ProgressRequest,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.progress"))]):
    _require_issue_workflow_role(user)
    _require_issue_workflow_scope(db,user,issue_id); return IssueService(db).progress(issue_id,data,user)

def _require_issue_step_editor(db:Session,user:User,issue_id:UUID):
    if user.role not in {"O&M Head","Assignee"}:
        raise HTTPException(403,"Only the assigned Assignee or O&M Head can edit work steps")
    _require_issue_workflow_scope(db,user,issue_id)

@router.get("/{issue_id}/steps")
def list_issue_steps(issue_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.view"))]):
    if not IssueRepository(db).by_id(issue_id):
        raise HTTPException(404,"Issue not found")
    _require_issue_action_scope(db,user,issue_id)
    return IssueService(db).list_steps(issue_id)

@router.post("/{issue_id}/steps",dependencies=[Depends(require_csrf)])
def add_issue_step(issue_id:UUID,data:IssueStepCreate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    _require_issue_step_editor(db,user,issue_id)
    return IssueService(db).add_step(issue_id,data.title,data.position,user)

@router.patch("/{issue_id}/steps/{step_id}",dependencies=[Depends(require_csrf)])
def update_issue_step(issue_id:UUID,step_id:UUID,data:IssueStepUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    _require_issue_step_editor(db,user,issue_id)
    return IssueService(db).update_step(issue_id,step_id,data,user)

@router.delete("/{issue_id}/steps/{step_id}",dependencies=[Depends(require_csrf)])
def remove_issue_step(issue_id:UUID,step_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    _require_issue_step_editor(db,user,issue_id)
    IssueService(db).remove_step(issue_id,step_id,user)
    return {"removed":True}

@router.post("/{issue_id}/etc",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def change_issue_etc(issue_id:UUID,data:IssueETCUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    _require_issue_workflow_role(user)
    _require_issue_workflow_scope(db,user,issue_id)
    return IssueService(db).change_etc(issue_id,data,user)

@router.post("/{issue_id}/resolve",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def resolve_issue(issue_id:UUID,data:ResolveRequest,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.resolve"))]):
    _require_issue_workflow_role(user)
    _require_issue_workflow_scope(db,user,issue_id); return IssueService(db).transition(issue_id,"Resolved",user,resolve=data)

@router.post("/{issue_id}/close",response_model=IssueOut,dependencies=[Depends(require_csrf)])
def close_issue(issue_id:UUID,data:CloseRequest,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("issues.close"))]): return IssueService(db).close(issue_id,data,user)
