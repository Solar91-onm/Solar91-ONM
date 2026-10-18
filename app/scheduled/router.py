from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import uuid
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.timeutil import business_today, log_stamp, utc_now
from app.core.config import get_settings
from app.core.database import get_db
from app.core.models import AuditLog, Equipment, Issue, OMTask, PMAlertLog, PMDueChange, PMFollowUp, Plant, User, WashingHistory, WashingTable, WashingConfig, Permit, StateRevision
from app.core.security import WASHING_TYPE, equipment_scope_matches, get_current_user, require_csrf, require_permission, user_scoped_equipment_types, user_scoped_plant_ids, resolve_equipment_id
from app.plants.codes import find_plant_by_code, normalize_site_code
from app.pmplan.units import distribute, next_cycle_id
from app.scheduled.schemas import PMFollowUpCreate, ProblemTaskCreate, TaskCompletion, TaskIssueLink, TaskReassign, TaskScheduleEdit, TaskUnitPlanEdit, WashingCycleDateRequest, WashingCycleScheduleRequest, WashingDailyReportRequest, WashingReportReviewRequest, WashingReportUpdateRequest, WashingSetupRequest
from app.storage.service import SupabaseStorage
from app.issues.service import next_issue_ticket_no
from app.pmplan.followups import FOLLOW_UP_OUTCOMES, follow_up_out, get_follow_up_state
from app.pmplan.alerts import alert_log_out, task_alert_scope
from app.scheduled.washing_cycles import create_daily_report, delete_daily_report, get_overview, list_assignees, month_cycles, review_daily_report, save_cycle_schedule, set_cycle_date, setup_plant, update_daily_report
from app.scheduled.washing_import import MAX_IMPORT_BYTES, export_bytes, import_setup, template_bytes

router = APIRouter(prefix="/api/scheduled", tags=["Preventive Maintenance"])
settings = get_settings()
FREQ_DAYS = {"Daily":1,"Weekly":7,"Monthly":30,"Quarterly":91,"Half-yearly":182,"Annual":365}
CREATOR_ROLES = {"O&M Head", "Assignee"}


def _plant(db: Session, value: str) -> Plant:
    try:
        row = db.get(Plant, UUID(value))
    except Exception:
        row = None
    if not row:
        row = find_plant_by_code(db, value)
    if not row:
        row = db.scalar(select(Plant).where(func.lower(Plant.plant_name) == value.casefold()))
    if not row:
        raise HTTPException(404, "Plant not found")
    return row


def _task(db: Session, work_order_no: str, *, for_update: bool = False) -> OMTask:
    stmt=select(OMTask).where(OMTask.work_order_no == work_order_no)
    if for_update:
        stmt=stmt.with_for_update().execution_options(populate_existing=True)
    row = db.scalar(stmt)
    if not row:
        raise HTTPException(404, "Preventive Maintenance task not found")
    return row


def _ensure_washing_scope(db: Session, user: User, table: WashingTable) -> None:
    if user.role == "O&M Head":
        return
    if user.role == "Assignee":
        if equipment_scope_matches(db,user,table.plant_id,None,None,WASHING_TYPE):
            return
        raise HTTPException(403, "Panel washing is outside your assigned equipment types")
    allowed = user_scoped_plant_ids(db, user) or set()
    if table.plant_id not in allowed:
        raise HTTPException(403, "This washing table is outside your assigned scope")


def _can_view_task(db: Session, user: User, task: OMTask) -> bool:
    if user.role in {"O&M Head", "Administration"}:
        return True
    if user.role == "Site Engineer":
        allowed = user_scoped_plant_ids(db, user) or set()
        return task.plant_id in allowed
    if user.role == "Assignee":
        return equipment_scope_matches(db,user,task.plant_id,None,task.equipment_ref,task.task_type)
    return False


def _can_execute_task(db: Session, user: User, task: OMTask) -> bool:
    if user.role == "O&M Head":
        return True
    if user.role == "Site Engineer":
        allowed = user_scoped_plant_ids(db, user) or set()
        return task.plant_id in allowed
    if user.role == "Assignee":
        return equipment_scope_matches(db,user,task.plant_id,None,task.equipment_ref,task.task_type)
    return False


def _task_list_lookups(db: Session, tasks: list[OMTask], allowed_types: set[str] | None = None) -> dict:
    """Load list serialization lookups in batches instead of issuing queries per task."""
    plant_names: dict[uuid.UUID, str] = {}
    plant_ids = {task.plant_id for task in tasks if task.plant_id}
    equipment_ids: set[uuid.UUID] = set()
    equipment_refs: set[str] = set()
    for task in tasks:
        reference = (task.equipment_ref or "").strip()
        if not reference:
            continue
        equipment_refs.add(reference.casefold())
        try:
            equipment_ids.add(uuid.UUID(reference))
        except ValueError:
            pass

    predicates = []
    if plant_ids:
        predicates.append(Equipment.plant_id.in_(plant_ids))
    if equipment_ids:
        predicates.append(Equipment.id.in_(equipment_ids))
    equipment_rows = []
    if predicates and tasks:
        equipment_stmt = select(
            Equipment.id, Equipment.plant_id, Equipment.equipment_code, Equipment.equipment_name,
            Equipment.equipment_type, Equipment.quantity, Equipment.status,
        ).where(or_(*predicates))
        if allowed_types is not None:
            type_filter = func.lower(Equipment.equipment_type).in_(allowed_types) if allowed_types else None
            reference_filter = []
            if equipment_ids:
                reference_filter.append(Equipment.id.in_(equipment_ids))
            if plant_ids and equipment_refs:
                reference_filter.append(and_(
                    Equipment.plant_id.in_(plant_ids),
                    or_(
                        func.lower(Equipment.equipment_code).in_(equipment_refs),
                        func.lower(Equipment.equipment_name).in_(equipment_refs),
                    ),
                ))
            if type_filter is not None:
                reference_filter.append(and_(Equipment.plant_id.in_(plant_ids), type_filter))
            equipment_stmt = equipment_stmt.where(or_(*reference_filter)) if reference_filter else equipment_stmt.where(False)
        equipment_rows = db.execute(equipment_stmt).all()

    equipment_by_id = {}
    codes_by_plant: dict[tuple[uuid.UUID, str], list[uuid.UUID]] = {}
    names_by_plant: dict[tuple[uuid.UUID, str], list[uuid.UUID]] = {}
    quantities: dict[tuple[uuid.UUID, str], int] = {}
    for row in equipment_rows:
        if row.status != "inactive":
            equipment_by_id[row.id] = row
        # Preserve the existing task quantity aggregate, which includes inactive inventory.
        if row.equipment_code and row.status is not None and row.status != "inactive":
            codes_by_plant.setdefault((row.plant_id, row.equipment_code.lower()), []).append(row.id)
        if row.equipment_name and row.status is not None and row.status != "inactive":
            names_by_plant.setdefault((row.plant_id, row.equipment_name.lower()), []).append(row.id)
        if row.equipment_type:
            key = (row.plant_id, row.equipment_type.lower())
            quantities[key] = quantities.get(key, 0) + (row.quantity or 0)

    equipment_id_by_task: dict[uuid.UUID, uuid.UUID | None] = {}
    for task in tasks:
        reference = (task.equipment_ref or "").strip()
        resolved = None
        if reference:
            try:
                candidate = equipment_by_id.get(uuid.UUID(reference))
            except ValueError:
                candidate = None
            if candidate and (task.plant_id is None or candidate.plant_id == task.plant_id):
                resolved = candidate.id
            elif task.plant_id is not None:
                code_matches = codes_by_plant.get((task.plant_id, reference.casefold()), [])
                if code_matches:
                    resolved = code_matches[0] if len(code_matches) == 1 else None
                else:
                    name_matches = names_by_plant.get((task.plant_id, reference.casefold()), [])
                    resolved = name_matches[0] if len(name_matches) == 1 else None
        equipment_id_by_task[task.id] = resolved

    return {
        "plant_names": plant_names,
        "equipment_by_id": equipment_by_id,
        "equipment_ids": equipment_id_by_task,
        "quantities": quantities,
    }


def _task_out(
    db: Session,
    task: OMTask,
    latest_follow_up: PMFollowUp | None = None,
    followup_loaded: bool = False,
    lookups: dict | None = None,
) -> dict:
    plant = db.get(Plant, task.plant_id) if task.plant_id and lookups is None else None
    if not followup_loaded:
        latest_follow_up = db.scalar(
            select(PMFollowUp).where(PMFollowUp.task_id == task.id)
            .order_by(PMFollowUp.at.desc(), PMFollowUp.id.desc()).limit(1)
        )
    quantity = task.quantity if task.quantity is not None else task.total_units
    if quantity is None and task.plant_id and task.task_type and lookups is not None:
        quantity = lookups["quantities"].get((task.plant_id, task.task_type.casefold()))
    elif quantity is None and task.plant_id and task.task_type:
        quantity = db.scalar(select(func.sum(Equipment.quantity)).where(
            Equipment.plant_id == task.plant_id,
            func.lower(Equipment.equipment_type) == task.task_type.casefold(),
            Equipment.status != "inactive",
        ))
    due_date = task.planned_due_on or task.due_on
    days_late = max(0, (business_today() - due_date).days) if (
        due_date and due_date < business_today() and task.status not in {"Completed", "Cancelled"}
    ) else 0
    evidence = []
    for item in task.evidence or []:
        clean = {k:v for k,v in dict(item).items() if k != "url"}
        kind = clean.get("kind")
        if kind in {"before", "after"}:
            clean["url"] = f"/api/scheduled/tasks/{task.work_order_no}/evidence/{kind}"
        evidence.append(clean)
    equipment_id = (
        lookups["equipment_ids"].get(task.id)
        if lookups is not None
        else resolve_equipment_id(db, task.plant_id, None, task.equipment_ref)
    )
    return {
        "id": task.work_order_no, "db_id": str(task.id),
        "plant": lookups["plant_names"].get(task.plant_id, "") if lookups is not None else plant.plant_name if plant else "",
        "plant_id": str(task.plant_id) if task.plant_id else None, "name": task.task_name,
        "equipmentId": str(equipment_id) if equipment_id else None,
        "type": task.task_type, "problem": task.problem, "problemSource": task.problem_source,
        "equip": task.equipment_ref, "freq": task.frequency, "due": task.due_on.isoformat() if task.due_on else None,
        "start": task.start_on.isoformat() if task.start_on else None,
        "assignee": task.assignee_text, "assigneeUserId": str(task.assignee_user_id) if task.assignee_user_id else None, "status": task.status, "sop": task.sop, "safety": task.safety,
        "tools": task.tools, "duration": task.duration, "completion": task.completion,
        "steps": (task.legacy_payload or {}).get("steps"),
        "actualCompleted": task.actual_completed_on.isoformat() if task.actual_completed_on else None,
        "delayDays": task.delay_days, "problemFound": task.problem_found, "recurrenceOf": task.recurrence_parent_no,
        "linkedIssue": task.linked_issue, "evidence": evidence, "log": task.log or [],
        "unitNo": task.unit_no, "totalUnits": task.total_units, "cycleId": task.cycle_id, "cycleDay": task.cycle_day,
        "plannedDue": task.planned_due_on.isoformat() if task.planned_due_on else None,
        "missedDays": task.missed_days or 0, "rolledCount": task.rolled_count or 0,
        "quantity": int(quantity) if quantity is not None else None,
        "days_late": days_late,
        "critical": days_late >= 7,
        "follow_up_state": get_follow_up_state(db, task, latest=latest_follow_up, latest_loaded=True),
        "last_follow_up": follow_up_out(latest_follow_up) if latest_follow_up else None,
        "planned_due_on": due_date.isoformat() if due_date else None,
    }


def _audit(db: Session, user: User, action: str, task: OMTask, metadata: dict | None = None) -> None:
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action=action, module="Scheduled O&M", metadata_json={"work_order_no": task.work_order_no, **(metadata or {})}))


@router.get("/tasks")
def list_tasks(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    task_rows = db.execute(
        select(OMTask, Plant.plant_name)
        .outerjoin(Plant, Plant.id == OMTask.plant_id)
        .order_by(OMTask.due_on, OMTask.created_at.desc())
    ).all()
    rows = [row[0] for row in task_rows]
    plant_names = {task.plant_id: name for task, name in task_rows if task.plant_id and name}

    allowed_types = None
    list_lookups = None
    if user.role in {"O&M Head", "Administration"}:
        visible = rows
    elif user.role == "Site Engineer":
        allowed_plants = user_scoped_plant_ids(db, user) or set()
        visible = [task for task in rows if task.plant_id in allowed_plants]
    elif user.role == "Assignee":
        allowed_types = user_scoped_equipment_types(db, user) or set()
        candidates = [
            task for task in rows
            if not (task.task_type or "").strip() or (task.task_type or "").strip().casefold() in allowed_types
        ]
        list_lookups = _task_list_lookups(db, candidates, allowed_types)
        visible = []
        for task in candidates:
            task_type = (task.task_type or "").strip().casefold()
            if task_type in allowed_types:
                visible.append(task)
                continue
            equipment_id = list_lookups["equipment_ids"].get(task.id)
            equipment = list_lookups["equipment_by_id"].get(equipment_id)
            if equipment and (equipment.equipment_type or "").strip().casefold() in allowed_types:
                visible.append(task)
    else:
        visible = []

    lookups = list_lookups if list_lookups is not None else _task_list_lookups(db, visible, allowed_types)
    lookups["plant_names"] = plant_names
    latest: dict[uuid.UUID, PMFollowUp] = {}
    if visible:
        task_ids = [task.id for task in visible]
        ranked_follow_ups = select(
            PMFollowUp.id.label("id"),
            func.row_number().over(
                partition_by=PMFollowUp.task_id,
                order_by=(PMFollowUp.at.desc(), PMFollowUp.id.desc()),
            ).label("row_number"),
        ).where(PMFollowUp.task_id.in_(task_ids)).subquery()
        for follow_up in db.scalars(
            select(PMFollowUp)
            .join(ranked_follow_ups, ranked_follow_ups.c.id == PMFollowUp.id)
            .where(ranked_follow_ups.c.row_number == 1)
        ):
            latest.setdefault(follow_up.task_id, follow_up)
    return [_task_out(db, task, latest.get(task.id), followup_loaded=True, lookups=lookups) for task in visible]


def _require_pm_follow_up_access(db: Session, user: User, task: OMTask) -> None:
    if user.role == "O&M Head":
        return
    if user.role == "Assignee" and (
        task.assignee_user_id == user.id
        or equipment_scope_matches(db,user,task.plant_id,None,task.equipment_ref,task.task_type)
    ):
        return
    raise HTTPException(403,"Only the O&M Head or an assigned/in-scope Assignee can access follow-ups")


@router.get("/tasks/{work_order_no}/alerts")
def list_task_alerts(
    work_order_no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    task = _task(db, work_order_no)
    if not _can_view_task(db, user, task):
        raise HTTPException(403, "This Preventive Maintenance task is outside your scope")
    related = task_alert_scope(db, task)
    if task not in related:
        related.append(task)
    active_due_dates = [
        row.planned_due_on or row.due_on
        for row in related
        if row.status in {"Scheduled", "In Progress"} and (row.planned_due_on or row.due_on)
    ]
    due_on = max(active_due_dates, default=task.planned_due_on or task.due_on)
    rows = list(db.scalars(
        select(PMAlertLog)
        .where(PMAlertLog.task_id.in_([row.id for row in related]))
        .order_by(PMAlertLog.sent_at.desc(), PMAlertLog.id.desc())
    ))
    return {
        "alerts": [alert_log_out(row) for row in rows],
        "levels_reached": sorted({row.level for row in rows if row.due_on == due_on}),
    }


@router.get("/tasks/{work_order_no}/followups")
def list_task_followups(
    work_order_no: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    task=_task(db,work_order_no)
    _require_pm_follow_up_access(db,user,task)
    rows=db.scalars(
        select(PMFollowUp).where(PMFollowUp.task_id==task.id)
        .order_by(PMFollowUp.at.desc(),PMFollowUp.id.desc())
    )
    return [follow_up_out(row) for row in rows]


@router.post("/tasks/{work_order_no}/followups",dependencies=[Depends(require_csrf)])
def create_task_followup(
    work_order_no: str,
    payload: PMFollowUpCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    task=_task(db,work_order_no)
    _require_pm_follow_up_access(db,user,task)
    if task.status in {"Completed","Cancelled"}:
        raise HTTPException(409,"Completed or cancelled jobs cannot receive follow-ups")
    today=business_today()
    if payload.promised_on and payload.promised_on<today:
        raise HTTPException(422,"Promised date cannot be in the past")
    if payload.next_follow_up_on and payload.next_follow_up_on<today:
        raise HTTPException(422,"Next follow-up date cannot be in the past")
    if payload.outcome not in FOLLOW_UP_OUTCOMES:
        raise HTTPException(422,"Choose a valid follow-up outcome")
    row=PMFollowUp(
        task_id=task.id,by_user_id=user.id,by_name=user.display_name,
        how=payload.how,spoke_to=payload.spoke_to.strip() if payload.spoke_to else None,
        outcome=payload.outcome,promised_on=payload.promised_on,
        next_follow_up_on=payload.next_follow_up_on,note=payload.note.strip() if payload.note else None,
    )
    db.add(row)
    _audit(db,user,"Logged PM site follow-up",task,{
        "how":payload.how,"outcome":payload.outcome,
        "promised_on":payload.promised_on.isoformat() if payload.promised_on else None,
    })
    db.commit()
    db.refresh(row)
    return follow_up_out(row)


@router.post("/tasks/problem", status_code=201, dependencies=[Depends(require_csrf)])
def create_problem_task(payload: ProblemTaskCreate, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    if user.role not in CREATOR_ROLES:
        raise HTTPException(403, "Only O&M Head and Assignee/O&M Team can create Preventive Maintenance tasks")
    plant = _plant(db, payload.plant_id)
    if user.role == "Assignee":
        if not equipment_scope_matches(db,user,plant.id,None,payload.equipment_ref,payload.asset):
            raise HTTPException(403, "This equipment is outside your assigned scope")
    assigned_user = None
    if payload.assignee:
        assigned_user = db.scalar(select(User).where(
            User.is_active.is_(True),
            (User.display_name.ilike(payload.assignee.strip())) | (User.email.ilike(payload.assignee.strip()))
        ))
    _require_assignee_role(assigned_user)
    if assigned_user and assigned_user.role == "Assignee" and not equipment_scope_matches(
        db, assigned_user, plant.id, None, payload.equipment_ref, payload.asset
    ):
        raise HTTPException(422, "The selected Assignee is not assigned to this equipment type")
    task = OMTask(
        work_order_no="WO-" + uuid.uuid4().hex[:10].upper(), plant_id=plant.id,
        task_name=payload.task_name, task_type=payload.asset, problem=payload.problem,
        problem_source="Site Issues problem library", equipment_ref=payload.equipment_ref,
        quantity=db.scalar(select(func.sum(Equipment.quantity)).where(
            Equipment.plant_id==plant.id,
            func.lower(Equipment.equipment_type)==payload.asset.casefold(),
            Equipment.status!="inactive",
        )),
        frequency=payload.frequency, due_on=payload.due_on, assignee_text=payload.assignee,
        assignee_user_id=assigned_user.id if assigned_user else None,
        status="Scheduled", sop=payload.sop, safety=payload.safety, tools=payload.tools,
        duration=payload.duration or "4 hrs", completion=None, evidence=[],
        log=[{"at": log_stamp(), "text": f"Created from {payload.asset}{(' → ' + payload.problem) if payload.problem else ''}", "actor": user.display_name}],
        legacy_payload={"problem": payload.problem, "problemSource": "Site Issues problem library"}, created_by=user.id,
    )
    db.add(task); db.flush(); _audit(db, user, "Created problem-based scheduled task", task, {"asset": payload.asset, "problem": payload.problem})
    from app.notifications.service import create_notification, equipment_responsible_users, notify_users
    if assigned_user:
        create_notification(
            db, user_id=assigned_user.id, event_type="task_assigned",
            title=f"Task assigned — {task.work_order_no}",
            message=f"{plant.plant_name} · {task.task_name}",
            target_type="task", target_id=task.work_order_no,
            dedupe_key=f"task-created:{task.id}:{assigned_user.id}",
        )
    else:
        responsible=equipment_responsible_users(db,plant_id=plant.id,equipment_ref=payload.equipment_ref,equipment_type=payload.asset)
        notify_users(db,responsible,event_type="task_assigned",title=f"Task assigned — {task.work_order_no}",
                     message=f"{plant.plant_name} · {task.task_name}",target_type="task",target_id=task.work_order_no,
                     dedupe_key=f"task-owner:{task.id}")
    db.commit(); db.refresh(task)
    return _task_out(db, task)


def _requires_permit(task: OMTask) -> bool:
    safety = (task.safety or "").lower()
    return "ptw" in safety or "loto" in safety


def _ensure_pending_permit(db: Session, task: OMTask, user: User) -> Permit:
    permit = db.scalar(select(Permit).where(Permit.task_id == task.id).order_by(Permit.created_at.desc()))
    if permit:
        return permit
    plant = db.get(Plant, task.plant_id) if task.plant_id else None
    permit = Permit(
        permit_no="PTW-" + uuid.uuid4().hex[:10].upper(),
        task_id=task.id,
        plant_id=task.plant_id,
        permit_type="PTW",
        hazard=task.safety,
        loto="loto" in (task.safety or "").lower(),
        valid_from=datetime.now(timezone.utc),
        status="Pending Approval",
        requested_by=user.display_name,
        payload={
            "id": "PTW-" + "PENDING",
            "task": task.work_order_no,
            "task_name": task.task_name,
            "plant": plant.plant_name if plant else "",
            "type": "PTW",
            "hazard": task.safety,
            "loto": "loto" in (task.safety or "").lower(),
            "status": "Pending Approval",
            "requestedBy": user.display_name,
            "safety": task.safety,
            "requested_by": user.display_name,
        },
    )
    permit.payload = {**(permit.payload or {}), "id": permit.permit_no}
    db.add(permit)
    db.flush()
    _audit(db, user, "Raised PTW request", task, {"permit_no": permit.permit_no, "loto": bool(permit.loto)})
    from app.notifications.service import create_notification, users_with_role
    for manager in users_with_role(db, {"O&M Head"}):
        create_notification(
            db, user_id=manager.id, event_type="ptw_pending",
            title=f"PTW approval required — {task.work_order_no}",
            message=f"{task.task_name} · {permit.permit_no}", target_type="task",
            target_id=task.work_order_no, dedupe_key=f"ptw-pending:{permit.id}:{manager.id}",
        )
    return permit


@router.post("/tasks/{work_order_no}/start", dependencies=[Depends(require_csrf)])
def start_task(work_order_no: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    task = _task(db, work_order_no)
    if not _can_execute_task(db, user, task):
        raise HTTPException(403, "You cannot execute this scheduled task")
    if task.status == "Completed":
        raise HTTPException(409, "Task is already completed")

    if _requires_permit(task):
        permit = db.scalar(select(Permit).where(Permit.task_id == task.id).order_by(Permit.created_at.desc()))
        if not permit:
            permit = _ensure_pending_permit(db, task, user)
            db.commit()
            raise HTTPException(409, detail={
                "message": "PTW approval is required before this task can start",
                "permit_no": permit.permit_no,
                "status": permit.status,
            })
        if permit.status != "Approved":
            raise HTTPException(409, detail={
                "message": "PTW approval is required before this task can start",
                "permit_no": permit.permit_no,
                "status": permit.status or "Pending Approval",
            })

    task.status = "In Progress"
    task.log = [{"at": log_stamp(), "text": "Marked In Progress — work started", "actor": user.display_name}, *(task.log or [])]
    _audit(db, user, "Started scheduled task", task); db.commit(); db.refresh(task)
    return _task_out(db, task)


@router.post("/permits/{permit_no}/approve", dependencies=[Depends(require_csrf)])
def approve_permit(permit_no: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("tasks.manage"))]):
    permit = db.scalar(select(Permit).where(Permit.permit_no == permit_no))
    if not permit:
        raise HTTPException(404, "Permit not found")
    permit.status = "Approved"
    permit.approver = user.display_name
    permit.payload = {**(permit.payload or {}), "status": "Approved", "id": permit.permit_no, "approved_at": datetime.now(timezone.utc).isoformat(), "approved_by": user.display_name}
    task = db.get(OMTask, permit.task_id) if permit.task_id else None
    if task:
        _audit(db, user, "Approved PTW", task, {"permit_no": permit.permit_no})
    db.add(permit)
    db.commit()
    return {"ok": True, "permit_no": permit.permit_no, "status": permit.status, "task": task.work_order_no if task else None}


@router.post("/permits/{permit_no}/reject", dependencies=[Depends(require_csrf)])
def reject_permit(permit_no: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("tasks.manage"))]):
    permit = db.scalar(select(Permit).where(Permit.permit_no == permit_no))
    if not permit:
        raise HTTPException(404, "Permit not found")
    permit.status = "Rejected"
    permit.approver = user.display_name
    permit.payload = {**(permit.payload or {}), "status": "Rejected", "id": permit.permit_no, "rejected_at": datetime.now(timezone.utc).isoformat(), "rejected_by": user.display_name}
    task = db.get(OMTask, permit.task_id) if permit.task_id else None
    if task:
        _audit(db, user, "Rejected PTW", task, {"permit_no": permit.permit_no})
    db.add(permit)
    db.commit()
    return {"ok": True, "permit_no": permit.permit_no, "status": permit.status, "task": task.work_order_no if task else None}


@router.post("/permits/{permit_no}/close", dependencies=[Depends(require_csrf)])
def close_permit(permit_no: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    permit = db.scalar(select(Permit).where(Permit.permit_no == permit_no))
    if not permit:
        raise HTTPException(404, "Permit not found")
    task = db.get(OMTask, permit.task_id) if permit.task_id else None
    if user.role != "O&M Head" and (not task or not _can_execute_task(db, user, task)):
        raise HTTPException(403, "You cannot close this permit")
    permit.status = "Closed"
    permit.payload = {**(permit.payload or {}), "status": "Closed", "id": permit.permit_no, "closed_at": datetime.now(timezone.utc).isoformat(), "closed_by": user.display_name}
    if task:
        _audit(db, user, "Closed PTW", task, {"permit_no": permit.permit_no})
    db.add(permit)
    db.commit()
    return {"ok": True, "permit_no": permit.permit_no, "status": permit.status, "task": task.work_order_no if task else None}


@router.post("/tasks/{work_order_no}/evidence/{kind}", dependencies=[Depends(require_csrf)])
def upload_evidence(
    work_order_no: str, kind: str,
    db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...), note: str = Form(default=""),
):
    if kind not in {"before", "after"}:
        raise HTTPException(422, "Evidence kind must be before or after")
    task = _task(db, work_order_no)
    if not _can_execute_task(db, user, task):
        raise HTTPException(403, "You cannot add evidence to this task")
    if task.status == "Completed":
        raise HTTPException(409, "Completed tasks are immutable; reopen through an authorized workflow before changing evidence")
    content_type = (file.content_type or "").lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "Only JPEG, PNG and WebP images are supported")
    data = file.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"Image exceeds {settings.max_upload_mb} MB")
    if len(data) < 32:
        raise HTTPException(422, "Image is empty or invalid")
    ext = {"image/jpeg":"jpg", "image/png":"png", "image/webp":"webp"}[content_type]
    object_path = f"scheduled/{task.id}/{kind}-{uuid.uuid4().hex}.{ext}"
    storage = SupabaseStorage()
    storage.upload(object_path, data, content_type)
    old_paths = [str(e.get("storage_path")) for e in (task.evidence or []) if e.get("kind") == kind and e.get("storage_path")]
    entry = {
        "id": "PMEV-" + uuid.uuid4().hex[:10].upper(), "kind": kind, "at": log_stamp(),
        "by": user.display_name, "note": note.strip(), "name": file.filename or f"{kind}.{ext}",
        "size": len(data), "content_type": content_type, "storage_path": object_path,
    }
    task.evidence = [dict(e) for e in (task.evidence or []) if e.get("kind") != kind] + [entry]
    _audit(db, user, f"Uploaded {kind} photo evidence", task); db.commit(); db.refresh(task)
    if old_paths:
        storage.remove(old_paths)
    return {**entry, "url": f"/api/scheduled/tasks/{task.work_order_no}/evidence/{kind}"}


@router.get("/tasks/{work_order_no}/evidence/{kind}")
def get_evidence(work_order_no: str, kind: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    task = _task(db, work_order_no)
    if not _can_view_task(db, user, task):
        raise HTTPException(403, "This task is outside your scope")
    entry = next((e for e in (task.evidence or []) if e.get("kind") == kind), None)
    if not entry or not entry.get("storage_path"):
        raise HTTPException(404, "Photo evidence not found")
    data, content_type = SupabaseStorage().download(str(entry["storage_path"]))
    return Response(content=data, media_type=content_type, headers={"Cache-Control":"private, max-age=60"})


@router.delete("/tasks/{work_order_no}/evidence/{kind}", status_code=204, dependencies=[Depends(require_csrf)])
def delete_evidence(work_order_no: str, kind: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    task = _task(db, work_order_no)
    if not _can_execute_task(db, user, task):
        raise HTTPException(403, "You cannot remove evidence from this task")
    if task.status == "Completed":
        raise HTTPException(409, "Completed tasks are immutable; photo evidence cannot be removed")
    old = [dict(e) for e in (task.evidence or []) if e.get("kind") == kind]
    task.evidence = [dict(e) for e in (task.evidence or []) if e.get("kind") != kind]
    _audit(db, user, f"Removed {kind} photo evidence", task); db.commit()
    paths = [str(e.get("storage_path")) for e in old if e.get("storage_path")]
    if paths and settings.storage_configured:
        SupabaseStorage().remove(paths)
    return Response(status_code=204)


@router.post("/tasks/{work_order_no}/complete", dependencies=[Depends(require_csrf)])
def complete_task(work_order_no: str, payload: TaskCompletion, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    task = _task(db, work_order_no, for_update=True)
    if not _can_execute_task(db, user, task):
        raise HTTPException(403, "You cannot complete this task")
    if task.status == "Completed":
        raise HTTPException(409, "Task is already completed")
    kinds = {e.get("kind") for e in (task.evidence or [])}
    if not {"before", "after"}.issubset(kinds):
        raise HTTPException(422, "Both Before and After photo evidence are required")
    delay = max(0, (payload.completed_on - task.due_on).days) if task.due_on else 0
    task.status = "Completed"; task.actual_completed_on = payload.completed_on; task.delay_days = delay; task.problem_found = payload.anomaly
    task.completion = {"date":payload.completed_on.isoformat(),"sub":payload.checklist,"readings":payload.readings or "—","photos":2,"remarks":payload.remarks or "—","anomaly":payload.anomaly,"delay":delay}
    task.log = [{"at":log_stamp(),"text":f"Completed with Before/After evidence; delay {delay}d","actor":user.display_name}, *(task.log or [])]
    linked_issue = None
    if payload.anomaly:
        linked_issue = next_issue_ticket_no(db)
        issue = Issue(ticket_no=linked_issue, plant_id=task.plant_id, equipment_ref=task.equipment_ref, vertical=task.task_type or "Other", description=f'From Preventive Maintenance task "{task.task_name}": {payload.remarks or "problem found during execution"}', severity="Critical", status="Open", occurred_at=utc_now(), assignee_text=task.assignee_text, photo_count=2, source_task=task.work_order_no, legacy_payload={"evidence":[{**dict(e),"url":f"/api/scheduled/tasks/{task.work_order_no}/evidence/{e.get('kind')}"} for e in (task.evidence or [])]}, created_by=user.id)
        db.add(issue); task.linked_issue = linked_issue
    # Unit tasks repeat from their ORIGINAL planned day so the unit-by-day pattern holds even after a missed unit was rolled.
    cadence_base = (task.planned_due_on or task.due_on) if task.unit_no else task.due_on
    next_due = cadence_base + timedelta(days=FREQ_DAYS.get(task.frequency or "", 30)) if cadence_base else None
    if next_due and task.unit_no and next_due <= payload.completed_on:
        next_due = payload.completed_on + timedelta(days=1)
    if next_due:
        exists_query = select(OMTask.id).where(
            OMTask.plant_id == task.plant_id, OMTask.task_name == task.task_name,
            OMTask.due_on == next_due, OMTask.status.not_in(["Completed", "Cancelled"]),
        )
        exists_query = exists_query.where(OMTask.unit_no == task.unit_no) if task.unit_no is not None else exists_query.where(OMTask.unit_no.is_(None))
        exists = db.scalar(exists_query)
        if not exists:
            db.add(OMTask(work_order_no="WO-"+uuid.uuid4().hex[:10].upper(), plant_id=task.plant_id, task_name=task.task_name, task_type=task.task_type, problem=task.problem, problem_source=task.problem_source, equipment_ref=task.equipment_ref, frequency=task.frequency, due_on=next_due, unit_no=task.unit_no, total_units=task.total_units, cycle_id=next_cycle_id(task.cycle_id), cycle_day=task.cycle_day, planned_due_on=next_due if task.unit_no else None, assignee_text=task.assignee_text, assignee_user_id=task.assignee_user_id, status="Scheduled", sop=task.sop, safety=task.safety, tools=task.tools, duration=task.duration, completion=None, evidence=[], recurrence_parent_no=task.work_order_no, log=[{"at":log_stamp(),"text":f"Auto-generated next occurrence; due {next_due.isoformat()}","actor":"System"}], legacy_payload={"recurrenceOf":task.work_order_no}, created_by=user.id))
    _audit(db, user, "Completed scheduled task", task, {"delay_days":delay,"linked_issue":linked_issue})
    from app.notifications.service import create_notification, users_with_role
    if user.role == "Site Engineer":
        recipients = users_with_role(db, {"O&M Head"})
        if task.assignee_user_id:
            assignee = db.get(User, task.assignee_user_id)
            if assignee:
                recipients.append(assignee)
        for recipient in recipients:
            create_notification(
                db, user_id=recipient.id, event_type="task_reported",
                title=f"PM completion reported — {task.work_order_no}",
                message=f"{task.task_name} · completed {payload.completed_on.isoformat()}",
                target_type="task", target_id=task.work_order_no,
                dedupe_key=f"task-reported:{task.id}:{task.actual_completed_on}",
            )
    if task.assignee_user_id and task.assignee_user_id != user.id:
        create_notification(
            db, user_id=task.assignee_user_id, event_type="task_completed",
            title=f"Task completed — {task.work_order_no}",
            message=f"{task.plant_id or ''} · {task.task_name}",
            target_type="task", target_id=task.work_order_no,
            dedupe_key=f"task-completed:{task.id}:{task.actual_completed_on}",
        )
    if linked_issue:
        for manager in users_with_role(db, {"O&M Head"}):
            create_notification(
                db, user_id=manager.id, event_type="task_anomaly",
                title=f"Task anomaly — {task.work_order_no}",
                message=f"{task.plant_id or ''} · linked Site Issue {linked_issue}",
                target_type="task", target_id=task.work_order_no,
                dedupe_key=f"task-anomaly:{task.id}",
            )
    permit = db.scalar(select(Permit).where(Permit.task_id == task.id, Permit.status == "Approved").order_by(Permit.created_at.desc()))
    if permit:
        permit.status = "Closed"
        permit.payload = {**(permit.payload or {}), "status": "Closed", "id": permit.permit_no, "closed_at": datetime.now(timezone.utc).isoformat(), "closed_by": user.display_name}
        db.add(permit)

    db.commit(); db.refresh(task)
    return {"task": _task_out(db, task), "linked_issue": linked_issue}


def _require_assignee_role(target: User | None) -> None:
    """Field work is owned by people with the Assignee role, never by an O&M Head, Administration or Site Engineer.
    Names that match no portal user (older free-text records) are left as they are."""
    if target is not None and target.role != "Assignee":
        raise HTTPException(422, f"Work can only be assigned to a user with the Assignee role ({target.display_name} is {target.role})")


@router.get("/washing/assignees")
def washing_assignees(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return list_assignees(db, user)


@router.get("/washing/overview")
def washing_overview(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)], include_tables: bool = False, report_days: int = 35):
    return get_overview(db, user, include_tables=include_tables, report_days=report_days)


@router.post("/washing/setup", dependencies=[Depends(require_csrf)])
def setup_washing_plant(payload: WashingSetupRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return setup_plant(db, user, payload)


@router.get("/washing/template")
def washing_setup_template(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return Response(
        content=template_bytes(db, user),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="Washing_Setup_Template.xlsx"'},
    )


@router.get("/washing/export")
def export_washing_setup(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
    plant_ids: str | None = None,
):
    selected = plant_ids.split(",") if plant_ids is not None else None
    return Response(
        content=export_bytes(db, user, selected),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="Washing_Setup.xlsx"'},
    )


@router.post("/washing/import", dependencies=[Depends(require_csrf)])
def import_washing_setup(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
    dry_run: bool = True,
):
    return import_setup(db, user, file.filename or "", file.file.read(MAX_IMPORT_BYTES + 1), dry_run=dry_run)


@router.post("/washing/daily-reports", dependencies=[Depends(require_csrf)])
def submit_washing_report(payload: WashingDailyReportRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return create_daily_report(db, user, payload)


@router.post("/washing/daily-reports/{report_id}/evidence", dependencies=[Depends(require_csrf)])
def upload_washing_evidence(
    report_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
    files: list[UploadFile] = File(...),
    kind: Annotated[str, Form()] = "other",
):
    from app.core.models import WashingDailyReport
    from app.scheduled.washing_cycles import _can_access_plant, _can_add_washing_evidence

    report = db.scalar(select(WashingDailyReport).where(WashingDailyReport.id == report_id).with_for_update())
    if not report:
        raise HTTPException(404, "Daily washing report not found")
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == report.plant_id))
    if not config or not _can_access_plant(db, user, report.plant_id, config):
        raise HTTPException(403, "This washing report is outside your plant scope")
    if not _can_add_washing_evidence(user, report, config):
        raise HTTPException(403, "Only the report submitter, the O&M Head or this plant's washing Assignee can add evidence before review")
    if not files:
        raise HTTPException(422, "Choose at least one photo")
    kind = (kind or "other").strip().lower()
    if kind not in {"before", "after", "other"}:
        raise HTTPException(422, "Photo kind must be before, after or other")
    existing = [dict(entry) for entry in (report.evidence or []) if isinstance(entry, dict)]
    if len(existing) + len(files) > 10:
        raise HTTPException(422, "A washing report can have no more than 10 evidence photos")
    accepted = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
    max_bytes = settings.max_upload_mb * 1024 * 1024
    prepared = []
    for file in files:
        content_type = (file.content_type or "").lower()
        if content_type not in accepted:
            raise HTTPException(415, "Only JPEG, PNG and WebP photos are supported")
        data = file.file.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise HTTPException(413, f"Each photo must be no larger than {settings.max_upload_mb} MB")
        if len(data) < 32:
            raise HTTPException(422, "A selected photo is empty or invalid")
        prepared.append((file, data, content_type, accepted[content_type]))

    storage = SupabaseStorage()
    uploaded = []
    try:
        for file, data, content_type, ext in prepared:
            evidence_id = "WASHEV-" + uuid.uuid4().hex[:12].upper()
            path = f"washing/{report.id}/{uuid.uuid4().hex}.{ext}"
            storage.upload(path, data, content_type)
            uploaded.append({
                "id": evidence_id, "at": datetime.now(timezone.utc).isoformat(),
                "by": user.display_name, "name": file.filename or f"photo.{ext}",
                "size": len(data), "content_type": content_type, "storage_path": path, "kind": kind,
            })
        report.evidence = existing + uploaded
        db.add(AuditLog(
            user_id=user.id, actor_name=user.display_name, action="Uploaded washing photo evidence",
            module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
            metadata_json={"evidence_ids": [entry["id"] for entry in uploaded]},
        ))
        db.commit()
        return [
            {**{key: value for key, value in entry.items() if key != "storage_path"},
             "url": f"/api/scheduled/washing/daily-reports/{report.id}/evidence/{entry['id']}"}
            for entry in uploaded
        ]
    except Exception:
        db.rollback()
        storage.remove([entry["storage_path"] for entry in uploaded])
        raise


@router.get("/washing/daily-reports/{report_id}/evidence/{evidence_id}")
def get_washing_evidence(
    report_id: UUID, evidence_id: str,
    db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
):
    from app.core.models import WashingDailyReport
    from app.scheduled.washing_cycles import _can_access_plant

    report = db.get(WashingDailyReport, report_id)
    if not report:
        raise HTTPException(404, "Daily washing report not found")
    config = db.get(WashingConfig, report.plant_id)
    if not config or not _can_access_plant(db, user, report.plant_id, config):
        raise HTTPException(403, "This washing report is outside your plant scope")
    entry = next((item for item in (report.evidence or []) if item.get("id") == evidence_id), None)
    if not entry or not entry.get("storage_path"):
        raise HTTPException(404, "Washing photo evidence not found")
    data, content_type = SupabaseStorage().download(str(entry["storage_path"]))
    return Response(content=data, media_type=content_type, headers={"Cache-Control": "private, max-age=60"})


@router.patch("/washing/daily-reports/{report_id}", dependencies=[Depends(require_csrf)])
def edit_washing_report(report_id: UUID, payload: WashingReportUpdateRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return update_daily_report(db, user, report_id, payload)


@router.delete("/washing/daily-reports/{report_id}", dependencies=[Depends(require_csrf)])
def remove_washing_report(report_id: UUID, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return delete_daily_report(db, user, report_id)


@router.patch("/washing/plants/{plant_id}/cycle-date", dependencies=[Depends(require_csrf)])
def change_washing_cycle_date(plant_id: UUID, payload: WashingCycleDateRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return set_cycle_date(db, user, plant_id, payload)


@router.get("/washing/plants/{plant_id}/cycles")
def washing_month_cycles(plant_id: UUID, month: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return month_cycles(db, user, plant_id, month)


@router.put("/washing/plants/{plant_id}/cycle-schedule", dependencies=[Depends(require_csrf)])
def save_washing_cycle_schedule(plant_id: UUID, payload: WashingCycleScheduleRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return save_cycle_schedule(db, user, plant_id, payload)


@router.post("/washing/daily-reports/{report_id}/review", dependencies=[Depends(require_csrf)])
def confirm_washing_report(report_id: UUID, payload: WashingReportReviewRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    return review_daily_report(db, user, report_id, payload)


@router.post("/washing/{legacy_id}/log", dependencies=[Depends(require_csrf)])
def log_washing(legacy_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.log"))]):
    table = db.scalar(select(WashingTable).where(WashingTable.legacy_id == legacy_id))
    if not table:
        raise HTTPException(404, "Washing table not found")
    _ensure_washing_scope(db,user,table)
    raise HTTPException(409, "Individual table logging is retired; submit a plant daily washing report for review")

@router.post("/washing/{legacy_id}/exception", dependencies=[Depends(require_csrf)])
def log_washing_exception(legacy_id: str, payload: dict, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.log"))]):
    table = db.scalar(select(WashingTable).where(WashingTable.legacy_id == legacy_id))
    if not table:
        raise HTTPException(404, "Washing table not found")
    _ensure_washing_scope(db,user,table)
    raise HTTPException(409, "Use the plant daily washing report to record completed or not-done work and remarks")



@router.delete("/tasks/{work_order_no}", dependencies=[Depends(require_csrf)])
def delete_task(work_order_no: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("tasks.manage"))],
                similar: bool = False):
    """Delete an open PM task (O&M Head). similar=true also deletes the other open tasks with the same name + equipment type.
    Completed tasks are history and are never deleted."""
    task = _task(db, work_order_no)
    if task.status == "Completed":
        raise HTTPException(409, "Completed tasks are kept as history and cannot be deleted")
    targets = [task]
    if similar:
        targets += list(db.scalars(select(OMTask).where(
            OMTask.id != task.id, OMTask.task_name == task.task_name,
            OMTask.task_type == task.task_type, OMTask.status != "Completed")))
    deleted = []
    for t in targets:
        _audit(db, user, "Deleted scheduled task", t, {"task": t.task_name, "bulk": t.id != task.id})
        deleted.append(t.work_order_no)
        db.delete(t)
    db.commit()
    return {"deleted": deleted, "count": len(deleted)}


@router.patch("/tasks/{work_order_no}/schedule", dependencies=[Depends(require_csrf)])
def edit_task_schedule(work_order_no: str, payload: TaskScheduleEdit, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    """Change name / frequency / due date / assignee / how-to / safety / duration of an open task.
    With apply_to_similar the same change is applied to every other open task with the same name and
    equipment type (other plants / units); their due dates move by the same number of days."""
    task = _task(db, work_order_no)
    is_head = user.role == "O&M Head"
    in_scope = lambda t: user.role == "Assignee" and equipment_scope_matches(db, user, t.plant_id, None, t.equipment_ref, t.task_type)
    if not is_head and not in_scope(task):
        raise HTTPException(403, "Only the O&M Head or the Assignee for this equipment type can change a task's schedule")
    if not is_head:
        # an Assignee may move the start date and deadline only; everything else stays with the O&M Head
        locked = payload.model_fields_set - {"start_on", "due_on", "reason", "apply_to_similar"}
        if locked:
            raise HTTPException(403, "An Assignee can change the start date and deadline only (not: " + ", ".join(sorted(locked)) + ")")
    if task.status == "Completed":
        raise HTTPException(409, "Completed tasks cannot be edited")
    if payload.frequency is not None and payload.frequency not in FREQ_DAYS:
        raise HTTPException(422, "Frequency must be one of: " + ", ".join(FREQ_DAYS))
    DASH = "—"
    targets = [task]
    if payload.apply_to_similar:
        targets += list(db.scalars(select(OMTask).where(
            OMTask.id != task.id, OMTask.task_name == task.task_name,
            OMTask.task_type == task.task_type, OMTask.status != "Completed")))
        targets = [t for t in targets if t.id == task.id or is_head or in_scope(t)]
    new_start = payload.start_on if "start_on" in payload.model_fields_set else None
    start_delta = (new_start - task.start_on).days if (new_start and task.start_on) else 0
    delta = (payload.due_on - task.due_on).days if (payload.due_on and task.due_on) else 0
    target_due_dates = {
        t.id: (payload.due_on if t.id == task.id else ((t.due_on + timedelta(days=delta)) if t.due_on and delta else t.due_on))
        for t in targets
    }
    moves_overdue_job_later = any(
        new_due and old_task.due_on and new_due > old_task.due_on
        and (old_task.planned_due_on or old_task.due_on) < business_today()
        and old_task.status not in {"Completed", "Cancelled"}
        for old_task in targets
        for new_due in [target_due_dates[old_task.id]]
    )
    eff_start = payload.start_on if "start_on" in payload.model_fields_set else task.start_on
    eff_due = payload.due_on or task.due_on
    if eff_start and eff_due and eff_start > eff_due:
        raise HTTPException(422, "The start date cannot be after the deadline")
    reason=(payload.reason or "").strip()
    overdue_due_date_only = moves_overdue_job_later and payload.model_fields_set <= {"due_on", "reason", "apply_to_similar"}
    if overdue_due_date_only and not reason:
        raise HTTPException(422, "A reason is required to move an overdue job's due date later")
    new_name = payload.name.strip() if payload.name else None
    who = payload.assignee.strip() if payload.assignee else None
    target_user = None
    if who:
        target_user = db.scalar(select(User).where(User.is_active.is_(True), (User.display_name.ilike(who)) | (User.email.ilike(who))))
        if any(who != (t.assignee_text or "") for t in targets):
            _require_assignee_role(target_user)
    changed = []
    for t in targets:
        notes = []
        is_main = t.id == task.id
        if new_name and new_name != t.task_name:
            notes.append(f"name → {new_name}"); t.task_name = new_name
        if is_main and "equipment_ref" in payload.model_fields_set and payload.equipment_ref != t.equipment_ref:
            t.equipment_ref=(payload.equipment_ref or "").strip() or None
            notes.append("equipment updated")
        if payload.frequency and payload.frequency != t.frequency:
            notes.append(f"frequency {t.frequency or DASH} → {payload.frequency}"); t.frequency = payload.frequency
        if payload.due_on:
            nd = target_due_dates[t.id]
            if nd and nd != t.due_on:
                old_due=t.due_on
                was_overdue=(t.planned_due_on or old_due)<business_today() if (t.planned_due_on or old_due) else False
                notes.append(f"due {t.due_on.isoformat() if t.due_on else DASH} → {nd.isoformat()}"); t.due_on = nd; t.planned_due_on = nd
                if old_due and nd>old_due and was_overdue and t.status not in {"Completed","Cancelled"}:
                    db.add(PMDueChange(
                        task_id=t.id,old_due=old_due,new_due=nd,reason=reason,
                        by_user_id=user.id,by_name=user.display_name,
                    ))
        if "start_on" in payload.model_fields_set:
            ns = payload.start_on if is_main else ((t.start_on + timedelta(days=start_delta)) if (t.start_on and start_delta) else t.start_on)
            if ns != t.start_on:
                notes.append(f"start {t.start_on.isoformat() if t.start_on else DASH} → {ns.isoformat() if ns else DASH}"); t.start_on = ns
        if is_main and "quantity" in payload.model_fields_set and payload.quantity != t.quantity:
            t.quantity=payload.quantity
            notes.append(f"quantity → {payload.quantity if payload.quantity is not None else DASH}")
        if who and who != (t.assignee_text or ""):
            if target_user and target_user.role == "Assignee" and not equipment_scope_matches(db, target_user, t.plant_id, None, t.equipment_ref, t.task_type):
                if is_main:
                    raise HTTPException(422, "The selected Assignee is not assigned to this equipment type")
            else:
                notes.append(f"assignee {t.assignee_text or DASH} → {who}"); t.assignee_text = who
                t.assignee_user_id = target_user.id if target_user else None
        for field, attr, label in (("sop", "sop", "how-to"), ("safety", "safety", "safety"), ("tools", "tools", "tools"), ("duration", "duration", "duration")):
            val = getattr(payload, field)
            if val is not None and val.strip() != (getattr(t, attr) or ""):
                setattr(t, attr, val.strip() or None); notes.append(label + " updated")
        if is_main and "steps" in payload.model_fields_set:
            legacy_payload=dict(t.legacy_payload or {})
            if payload.steps is None:
                legacy_payload.pop("steps",None)
            else:
                legacy_payload["steps"]=payload.steps
            t.legacy_payload=legacy_payload
            notes.append("execution steps updated")
        if notes:
            t.log = [{"at": log_stamp(), "text": "Schedule edited: " + "; ".join(notes), "actor": user.display_name}, *(t.log or [])]
            _audit(db, user, "Edited scheduled task", t, {"changes": notes, "bulk": not is_main})
            changed.append(t)
    if target_user and any(t.assignee_user_id == target_user.id for t in changed):
        from app.notifications.service import create_notification
        create_notification(db, user_id=target_user.id, event_type="task_reassigned",
            title=f"PM schedule updated — {task.work_order_no}", message=f"{task.task_name}",
            target_type="task", target_id=task.work_order_no,
            dedupe_key=f"task-edit:{task.id}:{datetime.now(timezone.utc).isoformat()}")
    db.commit()
    for t in changed:
        db.refresh(t)
    db.refresh(task)
    return {"task": _task_out(db, task), "updated": [_task_out(db, t) for t in changed if t.id != task.id], "count": len(changed)}


@router.post("/tasks/{work_order_no}/reset", dependencies=[Depends(require_csrf)])
def reset_task(work_order_no: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("tasks.manage"))]):
    task=_task(db,work_order_no)
    previous=task.status
    if previous=="Scheduled":
        return {"task":_task_out(db,task),"changed":False}
    task.status="Scheduled"
    task.completion=None
    task.actual_completed_on=None
    task.delay_days=None
    task.problem_found=False
    task.log=[{"at":log_stamp(),"text":f"Reset from {previous} to Scheduled","actor":user.display_name},*(task.log or [])]
    _audit(db,user,"Reset scheduled task",task,{"previous_status":previous})
    db.commit()
    db.refresh(task)
    return {"task":_task_out(db,task),"changed":True}


@router.post("/tasks/{work_order_no}/link-issue", dependencies=[Depends(require_csrf)])
def link_task_issue(
    work_order_no: str,
    payload: TaskIssueLink,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    task=_task(db,work_order_no)
    if not _can_execute_task(db,user,task):
        raise HTTPException(403,"You cannot link a Site Issue to this task")
    issue=db.scalar(select(Issue).where(Issue.ticket_no==payload.ticket_no.strip(),Issue.deleted_at.is_(None)))
    if not issue:
        raise HTTPException(404,"Site Issue was not found")
    if issue.plant_id != task.plant_id:
        raise HTTPException(422,"The Site Issue must belong to the same plant as the task")
    task.linked_issue=issue.ticket_no
    _audit(db,user,"Linked Site Issue to scheduled task",task,{"ticket_no":issue.ticket_no})
    db.commit()
    db.refresh(task)
    return _task_out(db,task)


@router.patch("/tasks/{work_order_no}/units", dependencies=[Depends(require_csrf)])
def edit_task_unit_plan(work_order_no: str, payload: TaskUnitPlanEdit, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    task = _task(db, work_order_no)
    if user.role != "O&M Head" and not (
        user.role == "Assignee" and equipment_scope_matches(
            db, user, task.plant_id, None, task.equipment_ref, task.task_type
        )
    ):
        raise HTTPException(403, "Only the O&M Head or an Assignee for this equipment type can change its unit plan")
    if task.status != "Scheduled":
        raise HTTPException(409, "Only scheduled tasks can have their unit plan changed")
    if payload.units_per_day > payload.total_units:
        raise HTTPException(422, "Units per day cannot exceed the number of units")
    if not task.plant_id or not task.task_type:
        raise HTTPException(422, "This task needs a plant and equipment type before units can be configured")

    cycle_id = task.cycle_id or uuid.uuid4().hex
    group = list(db.scalars(select(OMTask).where(OMTask.cycle_id == cycle_id))) if task.cycle_id else [task]
    if any(row.status == "In Progress" for row in group):
        raise HTTPException(409, "Finish or pause in-progress units before changing this unit plan")
    completed_units = [row.unit_no for row in group if row.status == "Completed" and row.unit_no is not None]
    if completed_units and max(completed_units) > payload.total_units:
        raise HTTPException(409, f"Unit count cannot be lower than completed unit {max(completed_units)}")
    starts = [row.planned_due_on or row.due_on for row in group if row.planned_due_on or row.due_on]
    start = min(starts) if starts else business_today()
    plan = distribute(list(range(1, payload.total_units + 1)), payload.units_per_day, start)
    by_unit: dict[int, OMTask] = {}
    for row in group:
        if row.unit_no is not None:
            by_unit.setdefault(row.unit_no, row)
    if task.unit_no is None:
        by_unit.setdefault(1, task)

    changed: list[OMTask] = []
    for row in group:
        if row.status not in {"Completed", "Cancelled"} and row.unit_no and row.unit_no > payload.total_units:
            row.status = "Cancelled"
            row.log = [{"at": log_stamp(), "text": "Unit removed from the PM plan; task retained as cancelled history", "actor": user.display_name}, *(row.log or [])]
            _audit(db, user, "Cancelled scheduled unit outside revised PM plan", row, {"total_units": payload.total_units})
            changed.append(row)

    for unit_no, cycle_day, due_on in plan:
        row = by_unit.get(unit_no)
        if row is None:
            row = next((candidate for candidate in group if candidate.status == "Cancelled" and candidate.unit_no == unit_no), None)
        if row is None:
            row = OMTask(
                work_order_no="WO-" + uuid.uuid4().hex[:10].upper(),
                plant_id=task.plant_id, task_name=task.task_name, task_type=task.task_type,
                problem=task.problem, problem_source=task.problem_source, equipment_ref=None,
                frequency=task.frequency, assignee_text=task.assignee_text, assignee_user_id=task.assignee_user_id,
                status="Scheduled", sop=task.sop, safety=task.safety, tools=task.tools, duration=task.duration,
                completion=None, evidence=[], log=[], legacy_payload={"created_by_unit_plan_edit": True},
                created_by=user.id,
            )
            db.add(row)
            group.append(row)
            by_unit[unit_no] = row
        if row.status == "Completed":
            continue
        was_cancelled = row.status == "Cancelled"
        row.status = "Scheduled"
        row.unit_no, row.total_units, row.cycle_id, row.cycle_day = unit_no, payload.total_units, cycle_id, cycle_day
        row.planned_due_on, row.due_on = due_on, due_on
        note = f"Unit plan updated: {payload.total_units} unit(s), {payload.units_per_day} per day"
        if was_cancelled:
            note = "Unit restored to revised PM plan; " + note
        row.log = [{"at": log_stamp(), "text": note, "actor": user.display_name}, *(row.log or [])]
        _audit(db, user, "Updated scheduled task unit plan", row, {
            "unit_no": unit_no, "total_units": payload.total_units,
            "units_per_day": payload.units_per_day, "cycle_id": cycle_id,
        })
        if row not in changed:
            changed.append(row)

    db.commit()
    result = [_task_out(db, row) for row in changed]
    return {"tasks": result, "count": len(result), "total_units": payload.total_units, "units_per_day": payload.units_per_day}


@router.patch("/tasks/{work_order_no}/assignee", dependencies=[Depends(require_csrf)])
def reassign_task(work_order_no: str, payload: TaskReassign, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("tasks.manage"))]):
    task = _task(db, work_order_no)
    target = None
    if payload.assignee_user_id:
        try:
            target = db.get(User, UUID(payload.assignee_user_id))
        except Exception:
            target = None
        if not target or not target.is_active:
            raise HTTPException(404, "Assignee user not found")
    else:
        target = db.scalar(select(User).where(
            User.is_active.is_(True),
            (User.display_name.ilike(payload.assignee.strip())) | (User.email.ilike(payload.assignee.strip()))
        ))
    _require_assignee_role(target)
    if target and target.role == "Assignee" and not equipment_scope_matches(
        db,target,task.plant_id,None,task.equipment_ref,task.task_type
    ):
        raise HTTPException(422, "The selected Assignee is not assigned to this equipment type")
    task.assignee_text = payload.assignee
    task.assignee_user_id = target.id if target else None
    task.log = [{"at":log_stamp(),"text":f"Reassigned to {payload.assignee}","actor":user.display_name}, *(task.log or [])]
    _audit(db, user, "Reassigned scheduled task", task, {"assignee":payload.assignee,"assignee_user_id":str(task.assignee_user_id) if task.assignee_user_id else None})
    if target:
        from app.notifications.service import create_notification
        create_notification(
            db, user_id=target.id, event_type="task_reassigned",
            title=f"Task reassigned — {task.work_order_no}",
            message=f"{task.plant_id or ''} · {task.task_name}",
            target_type="task", target_id=task.work_order_no,
            dedupe_key=f"task-reassign:{task.id}:{datetime.now(timezone.utc).isoformat()}",
        )
    db.commit(); db.refresh(task)
    return _task_out(db, task)


# ---------------------------------------------------------------------------
# Washing REGISTER maintenance (add / edit / delete / move tables).
# Operates directly on washing_tables so deletes are real (the generic state sync
# is upsert-only) and every change is validated so tables cannot be mis-linked.
# ---------------------------------------------------------------------------
def _wkey(value) -> str:
    return " ".join(str(value or "").split()).casefold()


def _wash_plant(db: Session, value) -> Plant:
    ref = str(value or "").strip()
    if not ref:
        raise HTTPException(422, "Choose a plant for this table")
    row = None
    try:
        row = db.get(Plant, UUID(ref))
    except Exception:
        row = None
    if not row:
        key = _wkey(ref)
        for cand in db.scalars(select(Plant)):
            if _wkey(cand.plant_name) == key or normalize_site_code(ref) == normalize_site_code(cand.site_code):
                row = cand
                break
    if not row:
        raise HTTPException(404, "Plant not found — pick a plant from the list")
    return row


def _wash_int(value, label: str, required: bool) -> int | None:
    if value in (None, ""):
        if required:
            raise HTTPException(422, f"{label} is required")
        return None
    try:
        n = int(str(value).strip())
    except Exception:
        raise HTTPException(422, f"{label} must be a whole number")
    if n < 1 or n > 999:
        raise HTTPException(422, f"{label} must be between 1 and 999")
    return n


def _wash_date(value) -> date | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except Exception:
        raise HTTPException(422, "Next due must be a valid date")


def _wash_out(w: WashingTable, plant: Plant) -> dict:
    return {"id": w.legacy_id, "plant": plant.plant_name, "inv": w.inverter_no, "invSecondary": w.secondary_inverter_no,
            "tableId": w.table_code, "nextDue": w.next_due_on.isoformat() if w.next_due_on else None,
            "rescheduledTo": w.rescheduled_to.isoformat() if w.rescheduled_to else None}


def _wash_bump_revision(db: Session) -> int:
    rev = db.scalar(select(StateRevision).where(StateRevision.id == 1).with_for_update())
    if not rev:
        rev = StateRevision(id=1, revision=0)
        db.add(rev)
        db.flush()
    rev.revision += 1
    db.add(rev)
    return rev.revision


def _wash_check_unique(db: Session, plant: Plant, table_code: str, exclude_id) -> None:
    key = _wkey(table_code)
    for other in db.scalars(select(WashingTable).where(WashingTable.plant_id == plant.id)):
        if other.id != exclude_id and _wkey(other.table_code) == key:
            raise HTTPException(409, f"{plant.plant_name} already has a table called {other.table_code}")


def _wash_fields(db: Session, payload: dict, current: WashingTable | None):
    plant = _wash_plant(db, payload.get("plant") if "plant" in payload or not current else current.plant_id)
    code = str(payload.get("table_id") if "table_id" in payload else (current.table_code if current else "") or "").strip()
    if not code:
        raise HTTPException(422, "Table ID is required")
    if len(code) > 60:
        raise HTTPException(422, "Table ID is too long (max 60 characters)")
    inv = _wash_int(payload.get("inverter") if "inverter" in payload else (current.inverter_no if current else None), "Inverter", True)
    sec = _wash_int(payload.get("secondary_inverter") if "secondary_inverter" in payload else (current.secondary_inverter_no if current else None), "Secondary inverter", False)
    if sec is not None and sec == inv:
        raise HTTPException(422, "Secondary inverter must differ from the main inverter")
    nd = _wash_date(payload.get("next_due") if "next_due" in payload else (current.next_due_on if current else None))
    _wash_check_unique(db, plant, code, current.id if current else None)
    return plant, code, inv, sec, nd


@router.post("/washing/register", dependencies=[Depends(require_csrf)])
def add_washing_table(payload: dict, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.manage"))]):
    plant, code, inv, sec, nd = _wash_fields(db, payload, None)
    w = WashingTable(legacy_id="TBL-" + uuid.uuid4().hex[:10].upper(), plant_id=plant.id, inverter_no=inv, secondary_inverter_no=sec,
                     table_code=code, next_due_on=nd, legacy_payload={})
    w.legacy_payload = {"id": w.legacy_id, "plant": plant.plant_name, "inv": inv, "invSecondary": sec, "tableId": code, "nextDue": nd.isoformat() if nd else None}
    db.add(w)
    if not db.get(WashingConfig, plant.id):
        db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14))
    db.flush()
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Added washing table", module="Washing", entity_type="washing_table", entity_id=w.legacy_id, metadata_json={"plant": plant.plant_name, "table": code}))
    revision = _wash_bump_revision(db)
    db.commit()
    return {"ok": True, "table": {**_wash_out(w, plant), "history": []}, "revision": revision}


@router.patch("/washing/{legacy_id}/register", dependencies=[Depends(require_csrf)])
def edit_washing_table(legacy_id: str, payload: dict, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.manage"))]):
    w = db.scalar(select(WashingTable).where(WashingTable.legacy_id == legacy_id))
    if not w:
        raise HTTPException(404, "Washing table not found")
    plant, code, inv, sec, nd = _wash_fields(db, payload, w)
    before = {"plant_id": str(w.plant_id) if w.plant_id else None, "table": w.table_code, "inv": w.inverter_no, "sec": w.secondary_inverter_no}
    w.plant_id, w.table_code, w.inverter_no, w.secondary_inverter_no, w.next_due_on = plant.id, code, inv, sec, nd
    w.legacy_payload = {**dict(w.legacy_payload or {}), "plant": plant.plant_name, "inv": inv, "invSecondary": sec, "tableId": code, "nextDue": nd.isoformat() if nd else None}
    db.add(w)
    if not db.get(WashingConfig, plant.id):
        db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14))
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Edited washing table", module="Washing", entity_type="washing_table", entity_id=w.legacy_id, metadata_json={"before": before, "plant": plant.plant_name, "table": code}))
    revision = _wash_bump_revision(db)
    db.commit()
    return {"ok": True, "table": _wash_out(w, plant), "revision": revision}


@router.delete("/washing/{legacy_id}/register", dependencies=[Depends(require_csrf)])
def delete_washing_table(legacy_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.manage"))]):
    w = db.scalar(select(WashingTable).where(WashingTable.legacy_id == legacy_id))
    if not w:
        raise HTTPException(404, "Washing table not found")
    info = {"table": w.table_code, "plant_id": str(w.plant_id) if w.plant_id else None}
    db.execute(delete(WashingHistory).where(WashingHistory.washing_table_id == w.id))
    db.delete(w)
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Deleted washing table", module="Washing", entity_type="washing_table", entity_id=legacy_id, metadata_json=info))
    revision = _wash_bump_revision(db)
    db.commit()
    return {"ok": True, "deleted": legacy_id, "revision": revision}


@router.post("/washing/move", dependencies=[Depends(require_csrf)])
def move_washing_tables(payload: dict, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.manage"))]):
    """Re-attach every table currently under `from_plant` (a real plant, or free text of an unlinked one) to `to_plant`."""
    target = _wash_plant(db, payload.get("to_plant"))
    src_text = str(payload.get("from_plant") or "").strip()
    if "from_plant" not in payload:
        raise HTTPException(422, "from_plant is required")
    src_key = _wkey(src_text)  # blank = tables that were saved without any plant
    src_code = normalize_site_code(src_text)
    src_plant = None
    for cand in db.scalars(select(Plant)):
        if _wkey(cand.plant_name) == src_key or (src_code and normalize_site_code(cand.site_code) == src_code):
            src_plant = cand
            break
    moving = []
    for w in db.scalars(select(WashingTable)):
        if src_plant is not None and w.plant_id == src_plant.id:
            moving.append(w)
        elif w.plant_id is None and (
            _wkey((w.legacy_payload or {}).get("plant")) == src_key
            or (src_code and normalize_site_code((w.legacy_payload or {}).get("plant")) == src_code)
        ):
            moving.append(w)
    if not moving:
        raise HTTPException(404, "No washing tables found under that plant")
    if src_plant is not None and src_plant.id == target.id:
        raise HTTPException(422, "Source and target plant are the same")
    existing = {_wkey(o.table_code) for o in db.scalars(select(WashingTable).where(WashingTable.plant_id == target.id))}
    clash = sorted({w.table_code for w in moving if _wkey(w.table_code) in existing})
    if clash:
        raise HTTPException(409, f"{target.plant_name} already has tables with the same IDs ({', '.join(clash[:5])}). Rename or delete those first.")
    for w in moving:
        w.plant_id = target.id
        w.legacy_payload = {**dict(w.legacy_payload or {}), "plant": target.plant_name}
        db.add(w)
    if src_plant is not None:
        src_cfg, tgt_cfg = db.get(WashingConfig, src_plant.id), db.get(WashingConfig, target.id)
        if src_cfg and not tgt_cfg:
            db.add(WashingConfig(plant_id=target.id, team=src_cfg.team or [], frequency_days=src_cfg.frequency_days or 14))
    elif not db.get(WashingConfig, target.id):
        db.add(WashingConfig(plant_id=target.id, team=[], frequency_days=14))
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Moved washing tables", module="Washing", entity_type="plant", entity_id=str(target.id), metadata_json={"from": src_text, "to": target.plant_name, "count": len(moving)}))
    revision = _wash_bump_revision(db)
    db.commit()
    return {"ok": True, "moved": len(moving), "plant": target.plant_name, "revision": revision}


def _wash_by_ids(db: Session, ids) -> list:
    keys = [str(i) for i in (ids or []) if i]
    if not keys:
        raise HTTPException(422, "Select at least one table")
    if len(keys) > 2000:
        raise HTTPException(422, "Too many tables in one action")
    return list(db.scalars(select(WashingTable).where(WashingTable.legacy_id.in_(keys))))


@router.post("/washing/bulk-delete", dependencies=[Depends(require_csrf)])
def bulk_delete_washing(payload: dict, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.manage"))]):
    """Delete selected tables, or every table of one plant ({plant: name}; blank = tables with no plant)."""
    if payload.get("ids"):
        rows = _wash_by_ids(db, payload.get("ids"))
    elif "plant" in payload:
        text = str(payload.get("plant") or "").strip()
        rows = []
        if text:
            plant = _wash_plant(db, text)
            rows = list(db.scalars(select(WashingTable).where(WashingTable.plant_id == plant.id)))
        else:
            rows = [w for w in db.scalars(select(WashingTable).where(WashingTable.plant_id.is_(None))) if not _wkey((w.legacy_payload or {}).get("plant"))]
    else:
        raise HTTPException(422, "Nothing to delete")
    if not rows:
        raise HTTPException(404, "No washing tables found")
    ids = [w.legacy_id for w in rows]
    for w in rows:
        db.execute(delete(WashingHistory).where(WashingHistory.washing_table_id == w.id))
        db.delete(w)
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Bulk deleted washing tables", module="Washing", entity_type="washing_table", entity_id="bulk", metadata_json={"count": len(ids)}))
    revision = _wash_bump_revision(db)
    db.commit()
    return {"ok": True, "deleted": ids, "revision": revision}


@router.post("/washing/bulk-move", dependencies=[Depends(require_csrf)])
def bulk_move_washing(payload: dict, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_permission("washing.manage"))]):
    target = _wash_plant(db, payload.get("to_plant"))
    rows = _wash_by_ids(db, payload.get("ids"))
    chosen = {w.id for w in rows}
    existing = {_wkey(o.table_code) for o in db.scalars(select(WashingTable).where(WashingTable.plant_id == target.id)) if o.id not in chosen}
    seen, clash = set(), set()
    for w in rows:
        k = _wkey(w.table_code)
        if k in existing or k in seen:
            clash.add(w.table_code)
        seen.add(k)
    if clash:
        raise HTTPException(409, f"{target.plant_name} already has tables with the same IDs ({', '.join(sorted(clash)[:5])}). Rename or delete those first.")
    for w in rows:
        w.plant_id = target.id
        w.legacy_payload = {**dict(w.legacy_payload or {}), "plant": target.plant_name}
        db.add(w)
    if not db.get(WashingConfig, target.id):
        db.add(WashingConfig(plant_id=target.id, team=[], frequency_days=14))
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Bulk moved washing tables", module="Washing", entity_type="plant", entity_id=str(target.id), metadata_json={"to": target.plant_name, "count": len(rows)}))
    revision = _wash_bump_revision(db)
    db.commit()
    return {"ok": True, "moved": [w.legacy_id for w in rows], "plant": target.plant_name, "revision": revision}
