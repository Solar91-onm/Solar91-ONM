from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any
import uuid
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.core.models import (
    AppSetting, AuditLog, Document, Handover, HandoverItem, Incident, InventoryItem, InventoryMovement,
    Equipment, Issue, Notification, NotificationRule, OfflineQueueItem, OMTask, Permit, Plant, SLAContract,
    ServiceRequest, StateCollectionRevision, StateRevision, User, Vendor, WashingConfig, WashingHistory, WashingTable,
)
from app.core.security import WASHING_TYPE, assignee_has_type, equipment_scope_matches, has_portfolio_scope, is_head, resolve_equipment_id, text_is_current_user, user_scoped_equipment_ids, user_scoped_plant_ids
from app.core.config import get_settings
from app.issues.schemas import normalize_issue_severity

BUSINESS_KEYS = ["plants","handovers","tasks","washing","washMeta","issues","inventory","movements","ptw","incidents","docs","vendors","rules","sla","audit","offlineQueue","serviceRequests","events"]
SETTING_KEYS = ["washPlant","schedScope","view","omTab","extSub","hoOpen","opsDate","scada","scadaConfig","plantEnrich","customPlantColumns","plantCustomValues","_seq"]


def _date(v):
    if not v: return None
    if isinstance(v,date) and not isinstance(v,datetime): return v
    try: return date.fromisoformat(str(v)[:10])
    except Exception: return None


def _uuid_or_none(value):
    if not value:
        return None
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _dt(v):
    if not v: return None
    if isinstance(v,datetime): return v
    s=str(v)
    try: return datetime.fromisoformat(s.replace("Z","+00:00"))
    except Exception: return None


def _num(v):
    try: return float(v) if v not in (None,"") else None
    except Exception: return None

_FREQ_DAYS={"Daily":1,"Weekly":7,"Monthly":30,"Quarterly":91,"Half-yearly":182,"Annual":365}
def _recurrence_due(due:date|None,frequency:str|None)->date|None:
    if not due: return None
    return due + timedelta(days=_FREQ_DAYS.get(frequency or "",30))




def _clean_evidence(items):
    out=[]
    for item in items or []:
        if not isinstance(item,dict):
            continue
        row={k:v for k,v in item.items() if k != "url"}
        if row.get("kind") in {"before","after"}:
            out.append(row)
    return out

def _plant_key(value:Any)->str:
    """Normalise a plant name/code for matching: trim, collapse spaces, ignore case."""
    return " ".join(str(value or "").split()).casefold()


class _TolerantLookup(dict):
    """dict that falls back to a whitespace/case-insensitive match.

    Washing tables, tasks etc. store the plant as free text. A trailing space or
    different casing used to leave plant_id NULL, which orphaned the rows from
    their plant (they still counted as "due" but never appeared under any plant).
    """
    def __init__(self,items):
        super().__init__(items)
        self._norm={}
        for k,v in items.items():
            self._norm.setdefault(_plant_key(k),v)

    def get(self,key,default=None):
        if key in self:
            return dict.__getitem__(self,key)
        if key is None:
            return default
        return self._norm.get(_plant_key(key),default)


def _plant_maps(db:Session):
    rows=list(db.scalars(select(Plant)))
    by_name=_TolerantLookup({p.plant_name:p for p in rows}); by_code=_TolerantLookup({p.site_code:p for p in rows})
    return rows,by_name,by_code


def _plant_legacy(p:Plant)->dict:
    r=dict(p.legacy_payload or {})
    r.update({
        "id":p.site_code,"dbId":str(p.id),"name":p.plant_name,
        "capacity":float(p.dc_capacity_kw)/1000 if p.dc_capacity_kw is not None else r.get("capacity"),
        "project":p.project_company or "","district":p.district or "","discom":p.discom or "",
        "dcCapacitykW":float(p.dc_capacity_kw) if p.dc_capacity_kw is not None else None,
        "acCapacitykW":float(p.ac_capacity_kw) if p.ac_capacity_kw is not None else None,
        "cod":p.commissioned_on.isoformat() if p.commissioned_on else "",
        "location":p.location or "","active":p.status!="inactive","source":"database",
        "geo":{"lat":float(p.latitude),"lng":float(p.longitude),"city":p.location or "","source":"database"} if p.latitude is not None and p.longitude is not None else r.get("geo"),
    })
    return r


def load_state(db:Session,user:User)->dict[str,Any]:
    plants,by_name,by_code=_plant_maps(db); name_by_id={p.id:p.plant_name for p in plants}
    state:dict[str,Any]={"plants":[_plant_legacy(p) for p in plants]}
    equipment_rows=list(db.scalars(select(Equipment).order_by(Equipment.equipment_name)))
    user_ids={e.in_charge_user_id for e in equipment_rows if e.in_charge_user_id}
    users_by_id={u.id:u for u in db.scalars(select(User).where(User.id.in_(user_ids)))} if user_ids else {}
    equipment=[]
    equipment_by_id={e.id:e for e in equipment_rows}
    equipment_codes=defaultdict(set)
    equipment_names=defaultdict(set)
    for e in equipment_rows:
        if e.status!="inactive":
            if e.equipment_code:
                equipment_codes[(e.plant_id,e.equipment_code.casefold())].add(e.id)
            if e.equipment_name:
                equipment_names[(e.plant_id,e.equipment_name.casefold())].add(e.id)
    for e in equipment_rows:
        in_charge=users_by_id.get(e.in_charge_user_id)
        equipment.append({
            "id":str(e.id),"plant_id":str(e.plant_id),"equipment_code":e.equipment_code,"equipment_name":e.equipment_name,
            "equipment_type":e.equipment_type,"maker":e.maker,"model":e.model,"serial_number":e.serial_number,"status":e.status,
            "discom":e.discom,"feeder_or_gss":e.feeder_or_gss,"rating":e.rating,
            "capacity_kw":float(e.capacity_kw) if e.capacity_kw is not None else None,"quantity":e.quantity or 1,
            "location_in_plant":e.location_in_plant,"manufacture_year":e.manufacture_year,
            "commissioned_on":e.commissioned_on.isoformat() if e.commissioned_on else None,
            "warranty_start":e.warranty_start.isoformat() if e.warranty_start else None,"warranty_end":e.warranty_end.isoformat() if e.warranty_end else None,
            "amc_vendor":e.amc_vendor,"amc_end":e.amc_end.isoformat() if e.amc_end else None,"supplier":e.supplier,
            "purchase_order_no":e.purchase_order_no,"criticality":e.criticality,"notes":e.notes,
            "in_charge_user_id":str(e.in_charge_user_id) if e.in_charge_user_id else None,"in_charge_name":in_charge.display_name if in_charge else None,
            "last_service_on":e.last_service_on.isoformat() if e.last_service_on else None,"next_service_due":e.next_service_due.isoformat() if e.next_service_due else None,
            "metadata":e.metadata_json or {},
        })
    state["equipment"]=equipment

    issues=[]
    issue_query=select(Issue).where(Issue.deleted_at.is_(None))
    closed_days=int(getattr(get_settings(),"bootstrap_closed_issue_days",0) or 0)
    if closed_days>0:
        cutoff=datetime.now(timezone.utc)-timedelta(days=closed_days)
        issue_query=issue_query.where(or_(Issue.status!="Closed",Issue.updated_at>=cutoff))
    for x in db.scalars(issue_query.order_by(Issue.created_at.desc())):
        r=dict(x.legacy_payload or {})
        r.update({"id":x.ticket_no,"dbId":str(x.id),"plant":name_by_id.get(x.plant_id,r.get("plant") or "") or "","equipmentId":str(x.equipment_id) if x.equipment_id else None,"vertical":x.vertical,"sub":x.subcategory,"equip":x.equipment_ref or "—","desc":x.description,"severity":normalize_issue_severity(x.severity),"status":x.status,"occurred":x.occurred_at.isoformat() if x.occurred_at else r.get("occurred"),"created":x.created_at.isoformat() if x.created_at else r.get("created"),"updated":x.updated_at.isoformat() if x.updated_at else r.get("updated"),"etc":x.etc_at.isoformat() if x.etc_at else r.get("etc"),"assignee":x.assignee_text,"assignedTo":str(x.assigned_to) if x.assigned_to else None,"maker":x.maker or "","supplier":x.supplier,"serialNumber":x.serial_number,"evidence":x.evidence,"impact":x.impact,"photos":x.photo_count,"vendor":x.vendor,"closure":x.closure,"sourceTask":x.source_task,"reopenedFrom":x.reopened_from,"reopenCount":x.reopen_count})
        issues.append(r)
    state["issues"]=issues

    handovers=[]
    handover_rows=list(db.scalars(select(Handover).order_by(Handover.created_at.desc())))
    items_by_handover=defaultdict(list)
    if handover_rows:
        for i in db.scalars(select(HandoverItem).where(HandoverItem.handover_id.in_([h.id for h in handover_rows]))):
            items_by_handover[i.handover_id].append(i)
    for h in handover_rows:
        r=dict(h.legacy_payload or {})
        items=[]
        for i in items_by_handover[h.id]:
            ir=dict(i.payload or {}); ir.update({"id":i.legacy_id,"c":i.category,"t":i.title,"mandatory":i.mandatory,"assignee":i.assignee_text,"due":i.due_on.isoformat() if i.due_on else None,"status":i.status,"evidence":i.evidence,"instructions":i.instructions or ""}); items.append(ir)
        r.update({"id":h.legacy_id,"handoverId":h.handover_no,"name":h.project_name,"location":h.location or "","projectType":h.project_type or "","capacity":float(h.capacity_mw) if h.capacity_mw is not None else "","dcCapacity":h.dc_capacity or "","gps":h.gps or "","assetLayout":h.asset_layout or "","commissioned":h.commissioned_text or "","epc":h.epc or "","client":h.client or "","status":h.status,"approval":h.approval,"certificate":h.certificate,"log":h.log or [],"items":items})
        handovers.append(r)
    state["handovers"]=handovers

    tasks=[]
    for t in db.scalars(select(OMTask).order_by(OMTask.created_at.desc())):
        r=dict(t.legacy_payload or {})
        ev=[]
        for item in t.evidence or []:
            clean=dict(item)
            kind=clean.get("kind")
            if kind in {"before","after"}:
                clean["url"]=f"/api/scheduled/tasks/{t.work_order_no}/evidence/{kind}"
                ev.append(clean)
        equipment_ref=(t.equipment_ref or "").strip()
        equipment_id=None
        try:
            candidate=equipment_by_id.get(UUID(equipment_ref))
        except ValueError:
            candidate=None
        if candidate and candidate.status!="inactive" and (t.plant_id is None or candidate.plant_id==t.plant_id):
            equipment_id=candidate.id
        elif t.plant_id and equipment_ref:
            matches=equipment_codes.get((t.plant_id,equipment_ref.casefold()),set())
            if not matches:
                matches=equipment_names.get((t.plant_id,equipment_ref.casefold()),set())
            if len(matches)==1:
                equipment_id=next(iter(matches))
        r.update({"id":t.work_order_no,"plant":name_by_id.get(t.plant_id,r.get("plant") or "") or "","equipmentId":str(equipment_id) if equipment_id else None,"name":t.task_name or "","type":t.task_type or "","problem":t.problem,"problemSource":t.problem_source,"equip":t.equipment_ref,"freq":t.frequency,"due":t.due_on.isoformat() if t.due_on else None,"start":t.start_on.isoformat() if t.start_on else None,"assignee":t.assignee_text,"assigneeUserId":str(t.assignee_user_id) if t.assignee_user_id else None,"status":t.status,"sop":t.sop,"safety":t.safety,"tools":t.tools,"duration":t.duration,"completion":t.completion,"actualCompleted":t.actual_completed_on.isoformat() if t.actual_completed_on else None,"delayDays":t.delay_days,"problemFound":t.problem_found,"recurrenceOf":t.recurrence_parent_no,"linkedIssue":t.linked_issue,"evidence":ev,"log":t.log or []}); tasks.append(r)
    state["tasks"]=tasks

    washing=[]
    washing_rows=list(db.scalars(select(WashingTable).order_by(WashingTable.table_code)))
    history_by_table=defaultdict(list)
    if washing_rows:
        for hh in db.scalars(select(WashingHistory).where(WashingHistory.washing_table_id.in_([w.id for w in washing_rows])).order_by(WashingHistory.event_date)):
            history_by_table[hh.washing_table_id].append(hh)
    for w in washing_rows:
        r=dict(w.legacy_payload or {}); hist=[]
        for hh in history_by_table[w.id]:
            x=dict(hh.payload or {}); x.update({"type":hh.event_type,"date":hh.event_date.isoformat() if hh.event_date else None,"by":hh.actor,"reason":hh.reason,"notes":hh.notes}); hist.append({k:v for k,v in x.items() if v is not None})
        r.update({"id":w.legacy_id,"plant":name_by_id.get(w.plant_id,r.get("plant") or "") or "","inv":w.inverter_no,"invSecondary":w.secondary_inverter_no,"tableId":w.table_code,"history":hist,"nextDue":w.next_due_on.isoformat() if w.next_due_on else r.get("nextDue"),"rescheduledTo":w.rescheduled_to.isoformat() if w.rescheduled_to else None}); washing.append(r)
    state["washing"]=washing
    wm={}
    for c in db.scalars(select(WashingConfig)):
        nm=name_by_id.get(c.plant_id)
        if nm: wm[nm]={"team":c.team or [],"freq":c.frequency_days}
    state["washMeta"]=wm

    def payloads(model, order=None):
        stmt=select(model)
        if order is not None: stmt=stmt.order_by(order)
        return [dict(x.payload or {}) for x in db.scalars(stmt)]
    state["inventory"]=payloads(InventoryItem,InventoryItem.created_at.desc())
    state["movements"]=payloads(InventoryMovement,InventoryMovement.created_at.desc())
    state["ptw"]=payloads(Permit,Permit.created_at.desc())
    state["incidents"]=payloads(Incident,Incident.created_at.desc())
    state["docs"]=payloads(Document,Document.created_at.desc())
    state["vendors"]=payloads(Vendor,Vendor.created_at.desc())
    state["serviceRequests"]=payloads(ServiceRequest,ServiceRequest.created_at.desc())
    state["sla"]=payloads(SLAContract,SLAContract.created_at.desc())
    state["offlineQueue"]=payloads(OfflineQueueItem,OfflineQueueItem.created_at.desc())
    state["rules"]=[{**dict(x.payload or {}),"id":x.legacy_id,"event":x.event_name,"channel":x.channel,"to":x.recipients,"tiers":x.tiers,"on":x.enabled} for x in db.scalars(select(NotificationRule).order_by(NotificationRule.created_at))]
    state["events"]=[{**dict(x.payload or {}),"id":x.legacy_id or str(x.id),"dbId":str(x.id),"title":x.title,"meta":x.message or "","targetType":x.target_type,"targetId":x.target_id,"read":x.read_at is not None} for x in db.scalars(select(Notification).where(or_(Notification.user_id==user.id,Notification.user_id.is_(None))).order_by(Notification.created_at.desc()))]
    state["audit"]=[{"id":x.legacy_id or str(x.id),"at":x.created_at.isoformat(),"module":x.module,"text":x.action,"user":x.actor_name,**dict(x.metadata_json or {})} for x in db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(500))]

    settings={x.setting_key:x.setting_value for x in db.scalars(select(AppSetting))}
    for k in SETTING_KEYS: state[k]=settings.get(k)
    state["view"]=state.get("view") or "dashboard"; state["omTab"]=state.get("omTab") or "handover"; state["extSub"]=state.get("extSub") or "requests"; state["opsDate"]=state.get("opsDate") or date.today().isoformat(); state["customPlantColumns"]=state.get("customPlantColumns") or []; state["plantCustomValues"]=state.get("plantCustomValues") or {}; state["plantEnrich"]=state.get("plantEnrich") or {}; state["scada"]=state.get("scada") or {"mode":"database","connected":False,"source":"backend"}
    state["currentRole"]=user.role; state["currentUser"]=user.display_name; state["_roleLabel"]=user.role
    state=_scope_state(db,user,state)
    if user.role=="Site Engineer" and state.get("plants"):
        state["_sePlant"]=state["plants"][0].get("name")
        state["dashPlant"]=state["_sePlant"]; state["schedScope"]=state["_sePlant"]; state["washPlant"]=state["_sePlant"]
        state.setdefault("issF",{}); state["issF"]["plant"]=state["_sePlant"]
    state["_readOnly"]=user.role in {"Administration","Viewer"}
    rev=db.get(StateRevision,1)
    collection_revisions={row.collection:row.revision for row in db.scalars(select(StateCollectionRevision)).all()}
    return {"state":state,"revision":rev.revision if rev else 0,"collection_revisions":collection_revisions}



def _scope_state(db:Session,user:User,state:dict[str,Any])->dict[str,Any]:
    """Server-side least-privilege projection for the rev14 production role model."""
    if has_portfolio_scope(user):
        # Administration gets portfolio data for dashboards/reports but mutating endpoints remain permission-gated.
        if user.role=="Administration":
            state["handovers"]=[]
            state["inventory"]=[]; state["movements"]=[]; state["ptw"]=[]; state["incidents"]=[]
            state["vendors"]=[]; state["serviceRequests"]=[]; state["sla"]=[]; state["offlineQueue"]=[]; state["audit"]=[]
            state["docs"]=[]
        return state

    allowed_ids=user_scoped_plant_ids(db,user) or set()
    allowed_equipment_ids=user_scoped_equipment_ids(db,user) if user.role=="Assignee" else None
    allowed_ids_str={str(x) for x in allowed_ids}
    allowed_plant_rows=list(db.scalars(select(Plant).where(Plant.id.in_(allowed_ids)))) if allowed_ids else []
    allowed_plants=[p for p in state.get("plants",[]) if str(p.get("dbId")) in allowed_ids_str]
    allowed_names={str(p.get("name") or "") for p in allowed_plants}
    allowed_codes={str(p.get("id") or "") for p in allowed_plants}
    state["plants"]=allowed_plants
    allowed_equipment_ids=allowed_equipment_ids or set()
    allowed_equipment_ids_str={str(x) for x in allowed_equipment_ids}
    state["equipment"]=[e for e in state.get("equipment",[]) if
                        (str(e.get("id")) in allowed_equipment_ids_str if user.role=="Assignee"
                         else str(e.get("plant_id")) in allowed_ids_str)]

    issue_rows={x.ticket_no:x for x in db.scalars(select(Issue).where(Issue.deleted_at.is_(None)))}
    filtered=[]
    for r in state.get("issues",[]):
        row=issue_rows.get(str(r.get("id") or ""))
        if not row: continue
        if user.role=="Assignee":
            ok=equipment_scope_matches(db,user,row.plant_id,row.equipment_id,row.equipment_ref,row.vertical)
        else: # Site Engineer and Viewer
            ok=row.plant_id in allowed_ids
        if ok: filtered.append(r)
    state["issues"]=filtered

    if user.role=="Assignee":
        state["tasks"]=[t for t in state.get("tasks",[]) if assignee_has_type(db,user,t.get("type"))]
    elif user.role=="Site Engineer":
        state["tasks"]=[t for t in state.get("tasks",[]) if t.get("plant") in allowed_names or t.get("plant") in allowed_codes]
    else:
        state["tasks"]=[]

    if user.role in {"Assignee","Site Engineer"}:
        state["washing"]=[w for w in state.get("washing",[]) if w.get("plant") in allowed_names or w.get("plant") in allowed_codes]
        if user.role=="Assignee":
            if not assignee_has_type(db,user,WASHING_TYPE): state["washing"]=[]
            allowed_wash_plants={w.get("plant") for w in state["washing"]}
            state["washMeta"]={k:v for k,v in (state.get("washMeta") or {}).items() if k in allowed_wash_plants}
        else:
            state["washMeta"]={k:v for k,v in (state.get("washMeta") or {}).items() if k in allowed_names or k in allowed_codes}
    else:
        state["washing"]=[]; state["washMeta"]={}

    # Field and pending roles never receive fleet administration collections.
    state["handovers"]=[]
    state["inventory"]=[]; state["movements"]=[]; state["ptw"]=[]; state["incidents"]=[]
    state["vendors"]=[]; state["serviceRequests"]=[]; state["sla"]=[]; state["rules"]=[]
    state["offlineQueue"]=[]; state["audit"]=[]; state["docs"]=[]
    pe=state.get("plantEnrich") or {}; state["plantEnrich"]={k:v for k,v in pe.items() if k in allowed_codes}
    pcv=state.get("plantCustomValues") or {}; state["plantCustomValues"]={k:v for k,v in pcv.items() if k in allowed_codes}
    return state

def _sync_state_scoped(db:Session,state:dict[str,Any],expected_revision:int|None,user:User)->int:
    """Compatibility sync for non-admin roles. Only role-appropriate deltas can reach persistent data."""
    allowed_ids=user_scoped_plant_ids(db,user) or set()
    allowed_equipment_ids=user_scoped_equipment_ids(db,user) if user.role=="Assignee" else set()
    allowed_equipment_ids=allowed_equipment_ids or set()
    plants,by_name,by_code=_plant_maps(db)
    changed=False

    if user.role in {"Site Engineer","Assignee"}:
        for r in state.get("issues",[]) or []:
            no=str(r.get("id") or "").strip()
            if not no:
                continue
            p=by_name.get(r.get("plant")) or by_code.get(r.get("plant"))
            equipment_id=resolve_equipment_id(
                db,p.id,_uuid_or_none(r.get("equipmentId")),r.get("equip")
            ) if p else None
            existing=db.scalar(select(Issue).where(Issue.ticket_no==no))
            if existing:
                continue   # existing tickets change only through /api/issues (workflow, assignment, evidence); a browser copy must never overwrite them
            elif user.role=="Assignee" and p and assignee_has_type(db,user,r.get("vertical")):
                x=Issue(
                    ticket_no=no,plant_id=p.id,equipment_id=equipment_id,
                    equipment_ref=r.get("equip"),vertical=r.get("vertical"),
                    subcategory=r.get("sub"),description=r.get("desc") or "Issue",severity=normalize_issue_severity(r.get("severity") or "Medium"),
                    status="Open",occurred_at=_dt(r.get("occurred")),etc_at=_dt(r.get("etc")),assignee_text=r.get("assignee"),
                    maker=r.get("maker") or None,impact=r.get("impact"),photo_count=int(r.get("photos") or 0),
                    legacy_payload=r,created_by=user.id,
                )
                db.add(x); changed=True
            elif user.role=="Site Engineer" and p and p.id in allowed_ids:
                x=Issue(
                    ticket_no=no,plant_id=p.id,equipment_ref=r.get("equip"),vertical=r.get("vertical"),
                    subcategory=r.get("sub"),description=r.get("desc") or "Issue",severity=normalize_issue_severity(r.get("severity") or "Medium"),
                    status="Open",occurred_at=_dt(r.get("occurred")),etc_at=_dt(r.get("etc")),assignee_text=r.get("assignee"),
                    maker=r.get("maker") or None,impact=r.get("impact"),photo_count=int(r.get("photos") or 0),
                    legacy_payload=r,created_by=user.id,
                )
                db.add(x); changed=True

    if user.role in {"Site Engineer","Assignee"}:
        for r in state.get("tasks",[]) or []:
            no=str(r.get("id") or "").strip()
            t=db.scalar(select(OMTask).where(OMTask.work_order_no==no)) if no else None
            if not t:
                continue
            if t.unit_no is not None:
                continue
            task_allowed=(assignee_has_type(db,user,t.task_type)
                          if user.role=="Assignee" else t.plant_id in allowed_ids)
            if not task_allowed:
                continue
            requested=r.get("status") or t.status
            was_completed=t.status=="Completed"
            if requested == "Completed":
                kinds={e.get("kind") for e in (r.get("evidence") or t.evidence or []) if isinstance(e,dict)}
                if not {"before","after"}.issubset(kinds):
                    continue
            if requested in {"Scheduled","In Progress","Completed"}:
                t.status=requested
            t.completion=r.get("completion") or t.completion
            if isinstance(t.completion,dict):
                t.actual_completed_on=_date(t.completion.get("date"))
                t.delay_days=int(t.completion.get("delay") or 0)
                t.problem_found=bool(t.completion.get("anomaly"))
            t.linked_issue=r.get("linkedIssue") or t.linked_issue
            t.problem=r.get("problem") or t.problem; t.problem_source=r.get("problemSource") or t.problem_source
            # Evidence bytes live in Supabase Storage. State sync may update metadata only; URLs are never persisted.
            if r.get("evidence") is not None: t.evidence=_clean_evidence(r.get("evidence")) or t.evidence
            t.log=r.get("log") or t.log
            t.legacy_payload={**dict(t.legacy_payload or {}),"completion":t.completion,"log":t.log,"status":t.status,"linkedIssue":t.linked_issue,"problem":t.problem,"problemSource":t.problem_source}
            db.add(t); changed=True
            if requested=="Completed" and not was_completed:
                next_due=_recurrence_due(t.due_on,t.frequency)
                if next_due and not db.scalar(select(OMTask.id).where(OMTask.plant_id==t.plant_id,OMTask.task_name==t.task_name,OMTask.due_on==next_due,OMTask.status!="Completed")):
                    nxt=OMTask(work_order_no="WO-"+uuid.uuid4().hex[:10].upper(),plant_id=t.plant_id,task_name=t.task_name,task_type=t.task_type,problem=t.problem,problem_source=t.problem_source,equipment_ref=t.equipment_ref,frequency=t.frequency,due_on=next_due,assignee_text=t.assignee_text,assignee_user_id=t.assignee_user_id,status="Scheduled",sop=t.sop,safety=t.safety,tools=t.tools,duration=t.duration,completion=None,evidence=[],problem_found=False,recurrence_parent_no=t.work_order_no,linked_issue=None,log=[{"at":datetime.now().isoformat(),"text":f"Next occurrence auto-generated from recurrence rule ({t.frequency or 'Monthly'}) — due {next_due.isoformat()}","actor":"System"}],legacy_payload={"recurrenceOf":t.work_order_no},created_by=user.id)
                    db.add(nxt)

        # Washing reports are written only through the reviewed daily-report workflow.

    if changed:
        db.add(AuditLog(user_id=user.id,actor_name=user.display_name,action="compatibility state sync",module="Application State",metadata_json={"role":user.role}))
        db.commit()
    else:
        db.rollback()
    rev=db.get(StateRevision,1)
    return rev.revision if rev else 0

def _lock_and_advance_collection_revisions(
    db:Session,state:dict[str,Any],expected_revisions:dict[str,int]
) -> dict[str,int]:
    collections=sorted(key for key in state if key in BUSINESS_KEYS or key in SETTING_KEYS)
    if not collections:
        return {}
    values=[{"collection":key,"revision":0} for key in collections]
    dialect=db.bind.dialect.name if db.bind else ""
    statement=pg_insert(StateCollectionRevision) if dialect=="postgresql" else sqlite_insert(StateCollectionRevision)
    db.execute(statement.values(values).on_conflict_do_nothing(index_elements=["collection"]))
    rows={row.collection:row for row in db.scalars(
        select(StateCollectionRevision)
        .where(StateCollectionRevision.collection.in_(collections))
        .order_by(StateCollectionRevision.collection)
        .with_for_update()
    ).all()}
    conflicts={
        key:rows[key].revision
        for key in collections
        if expected_revisions.get(key)!=rows[key].revision
    }
    if conflicts:
        db.rollback()
        raise HTTPException(
            409,
            detail={
                "message":"Some saved collections changed on the server. Your local edits are preserved.",
                "changed_collections":conflicts,
            },
        )
    for key in collections:
        rows[key].revision+=1
        db.add(rows[key])
    return {key:rows[key].revision for key in collections}


def sync_state(
    db:Session,state:dict[str,Any],expected_revision:int|None,user:User,
    collection_revisions:dict[str,int]|None=None,
)->int:
    # These domains have dedicated APIs and must not be written by a browser-wide snapshot.
    state={key:value for key,value in state.items() if key not in {"tasks","issues","washing","washMeta"}}
    if collection_revisions is not None and is_head(user):
        _lock_and_advance_collection_revisions(db,state,collection_revisions)
    if is_head(user):
        return _sync_state_head(db,state,expected_revision,user)
    return _sync_state_scoped(db,state,expected_revision,user)

def _upsert_setting(db:Session,key:str,value:Any,user:User):
    row=db.get(AppSetting,key)
    if row: row.setting_value=value; row.updated_by=user.id
    else: db.add(AppSetting(setting_key=key,setting_value=value,updated_by=user.id))


def _sync_state_head(db:Session,state:dict[str,Any],expected_revision:int|None,user:User)->int:
    # Plants first, because nearly every operational entity points to a plant.
    for r in state.get("plants",[]) or []:
        code=str(r.get("id") or r.get("site_code") or "").strip()
        name=str(r.get("name") or r.get("plant_name") or "").strip()
        if not code or not name: continue
        p=db.scalar(select(Plant).where(Plant.site_code==code)) or Plant(site_code=code,plant_name=name,created_by=user.id)
        p.plant_name=name; p.project_company=r.get("project") or r.get("projectCompany"); p.district=r.get("district") or None; p.discom=r.get("discom") or None; p.location=r.get("location") or ((r.get("geo") or {}).get("city") if isinstance(r.get("geo"),dict) else None)
        geo=r.get("geo") or {}; p.latitude=_num(geo.get("lat")) if isinstance(geo,dict) else None; p.longitude=_num(geo.get("lng")) if isinstance(geo,dict) else None
        p.dc_capacity_kw=_num(r.get("dcCapacitykW")) or ((_num(r.get("capacity")) or 0)*1000 or None); p.ac_capacity_kw=_num(r.get("acCapacitykW")); p.commissioned_on=_date(r.get("cod") or r.get("commissionedOn")); p.status="active" if r.get("active",True) else "inactive"; p.assigned_engineer=r.get("assignedEngineer") or ((state.get("plantEnrich") or {}).get(code,{}) or {}).get("assignedEngineer"); p.custom_fields=r.get("dbCustomFields") or {}; p.legacy_payload=r; db.add(p)
    db.flush(); plants,by_name,by_code=_plant_maps(db)

    for r in state.get("issues",[]) or []:
        no=str(r.get("id") or "").strip()
        if not no: continue
        if db.scalar(select(Issue.id).where(Issue.ticket_no==no)):
            continue   # existing tickets change only through /api/issues; a stale browser copy must never undo an Acknowledge, assignment or closure
        severity=normalize_issue_severity(r.get("severity") or "Medium")
        x=db.scalar(select(Issue).where(Issue.ticket_no==no)) or Issue(ticket_no=no,description=r.get("desc") or "Issue",severity=severity,created_by=user.id)
        p=by_name.get(r.get("plant")) or by_code.get(r.get("plant")); x.plant_id=p.id if p else None; x.equipment_ref=r.get("equip"); x.vertical=r.get("vertical"); x.subcategory=r.get("sub"); x.description=r.get("desc") or x.description; x.severity=severity or x.severity; x.status=r.get("status") or "Open"; x.occurred_at=_dt(r.get("occurred")); x.etc_at=_dt(r.get("etc")); x.assignee_text=r.get("assignee"); x.maker=r.get("maker") or None; x.impact=r.get("impact"); x.photo_count=int(r.get("photos") or 0); x.vendor=r.get("vendor"); x.closure=r.get("closure"); x.source_task=r.get("sourceTask"); x.reopened_from=r.get("reopenedFrom"); x.reopen_count=int(r.get("reopenCount") or 0); x.legacy_payload=r; db.add(x)

    for r in state.get("handovers",[]) or []:
        lid=str(r.get("id") or "").strip()
        if not lid: continue
        h=db.scalar(select(Handover).where(Handover.legacy_id==lid)) or Handover(legacy_id=lid,project_name=r.get("name") or lid,status=r.get("status") or "pending_checklist",created_by=user.id)
        h.handover_no=r.get("handoverId"); h.project_name=r.get("name") or h.project_name; h.location=r.get("location") or ""; h.project_type=r.get("projectType") or ""; h.capacity_mw=_num(r.get("capacity")); h.dc_capacity=r.get("dcCapacity") or ""; h.gps=r.get("gps") or ""; h.asset_layout=r.get("assetLayout") or ""; h.commissioned_text=r.get("commissioned") or ""; h.epc=r.get("epc") or ""; h.client=r.get("client") or ""; h.status=r.get("status") or h.status; h.approval=r.get("approval"); h.certificate=r.get("certificate"); h.log=r.get("log") or []; h.legacy_payload=r; db.add(h); db.flush(); db.execute(delete(HandoverItem).where(HandoverItem.handover_id==h.id))
        for it in r.get("items") or []:
            db.add(HandoverItem(handover_id=h.id,legacy_id=str(it.get("id") or "item"),category=it.get("c") or it.get("category"),title=it.get("t") or it.get("title") or "Item",mandatory=bool(it.get("mandatory")),assignee_text=it.get("assignee"),due_on=_date(it.get("due")),status=it.get("status") or "not_started",evidence=it.get("evidence") or [],instructions=it.get("instructions") or "",payload=it))

    for r in state.get("tasks",[]) or []:
        no=str(r.get("id") or "").strip()
        if not no: continue
        t=db.scalar(select(OMTask).where(OMTask.work_order_no==no)) or OMTask(work_order_no=no,task_name=r.get("name") or no,status=r.get("status") or "Scheduled",created_by=user.id)
        p=by_name.get(r.get("plant")) or by_code.get(r.get("plant")); t.plant_id=p.id if p else None; t.task_name=r.get("name") or t.task_name; t.task_type=r.get("type"); t.problem=r.get("problem"); t.problem_source=r.get("problemSource"); t.equipment_ref=r.get("equip"); t.frequency=r.get("freq"); t.due_on=_date(r.get("due")); t.assignee_text=r.get("assignee"); t.assignee_user_id=uuid.UUID(str(r.get("assigneeUserId"))) if r.get("assigneeUserId") else t.assignee_user_id; t.status=r.get("status") or t.status; t.sop=r.get("sop"); t.safety=r.get("safety"); t.tools=r.get("tools"); t.duration=r.get("duration"); t.completion=r.get("completion"); t.actual_completed_on=_date((r.get("completion") or {}).get("date") if isinstance(r.get("completion"),dict) else r.get("actualCompleted")); t.delay_days=int((r.get("completion") or {}).get("delay") or r.get("delayDays") or 0) if r.get("completion") or r.get("delayDays") is not None else None; t.problem_found=bool((r.get("completion") or {}).get("anomaly")) if isinstance(r.get("completion"),dict) else bool(r.get("problemFound")); t.recurrence_parent_no=r.get("recurrenceOf"); t.linked_issue=r.get("linkedIssue"); t.evidence=_clean_evidence(r.get("evidence")) or t.evidence; t.log=r.get("log") or []; t.legacy_payload={k:v for k,v in r.items() if k!="evidence"}; db.add(t)
    db.flush()

    # Legacy client state is read-only for washing; configuration and reports use dedicated APIs.

    def upsert_inventory(r):
        lid=str(r.get("id") or ""); x=db.scalar(select(InventoryItem).where(InventoryItem.legacy_id==lid)) or InventoryItem(legacy_id=lid); p=by_name.get(r.get("plant")); x.plant_id=p.id if p else None; x.item_name=r.get("item"); x.sku=r.get("sku"); x.quantity=_num(r.get("qty")); x.minimum_quantity=_num(r.get("min")); x.unit=r.get("unit"); x.location=r.get("store"); x.status="On order" if r.get("onOrder") else "Available"; x.payload=r; db.add(x)
    for r in state.get("inventory",[]) or []:
        if r.get("id"): upsert_inventory(r)
    for r in state.get("movements",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(InventoryMovement).where(InventoryMovement.legacy_id==lid)) or InventoryMovement(legacy_id=lid); x.movement_type=r.get("ref"); x.quantity=_num(r.get("qty")); x.actor=r.get("by"); x.notes=r.get("note"); x.payload=r; db.add(x)
    for r in state.get("ptw",[]) or []:
        no=str(r.get("id") or "");
        if not no: continue
        x=db.scalar(select(Permit).where(Permit.permit_no==no)) or Permit(permit_no=no); p=by_name.get(r.get("plant")); x.plant_id=p.id if p else None; x.permit_type=r.get("type"); x.hazard=r.get("hazard"); x.loto=bool(r.get("loto")); x.valid_from=_dt(r.get("validFrom")); x.valid_to=_dt(r.get("validTo")); x.status=r.get("status"); x.requested_by=r.get("requestedBy"); x.approver=r.get("approver"); x.payload=r; db.add(x)
    for r in state.get("incidents",[]) or []:
        no=str(r.get("id") or "");
        if not no: continue
        x=db.scalar(select(Incident).where(Incident.incident_no==no)) or Incident(incident_no=no); p=by_name.get(r.get("plant")); x.plant_id=p.id if p else None; x.category=r.get("type"); x.severity=r.get("severity"); x.status=r.get("status") or "Logged"; x.description=r.get("desc"); x.reported_by=r.get("by"); x.payload=r; db.add(x)
    for r in state.get("docs",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(Document).where(Document.legacy_id==lid)) or Document(legacy_id=lid); p=by_name.get(r.get("plant")); x.plant_id=p.id if p else None; x.title=r.get("name"); x.document_type=r.get("type"); x.owner=r.get("owner"); x.expires_on=_date(r.get("expires")); x.status="Available"; x.storage_path=r.get("fileName"); x.payload=r; db.add(x)
    for r in state.get("vendors",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(Vendor).where(Vendor.legacy_id==lid)) or Vendor(legacy_id=lid,vendor_name=r.get("name") or lid); x.vendor_name=r.get("name") or x.vendor_name; x.status="Active"; x.categories=[r.get("type")] if r.get("type") else []; x.payload=r; db.add(x)
    for r in state.get("serviceRequests",[]) or []:
        no=str(r.get("id") or "");
        if not no: continue
        x=db.scalar(select(ServiceRequest).where(ServiceRequest.request_no==no)) or ServiceRequest(request_no=no); x.project=r.get("project"); x.category=r.get("category"); x.priority=r.get("priority"); x.provider=r.get("provider"); x.owner=r.get("owner"); x.estimate=_num(r.get("estimate")); x.progress=int(r.get("progress") or 0); x.status=r.get("status"); x.target_on=_date(r.get("target")); x.history=r.get("history") or []; x.payload=r; db.add(x)
    for r in state.get("rules",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(NotificationRule).where(NotificationRule.legacy_id==lid)) or NotificationRule(legacy_id=lid,event_name=r.get("event") or lid); x.event_name=r.get("event") or x.event_name; x.channel=r.get("channel"); x.recipients=r.get("to"); x.tiers=r.get("tiers"); x.enabled=bool(r.get("on",True)); x.payload=r; db.add(x)
    for r in state.get("sla",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(SLAContract).where(SLAContract.legacy_id==lid)) or SLAContract(legacy_id=lid); p=by_name.get(r.get("project")); x.plant_id=p.id if p else None; x.name=r.get("name"); x.status="Active"; x.payload=r; db.add(x)
    for r in state.get("offlineQueue",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(OfflineQueueItem).where(OfflineQueueItem.legacy_id==lid)) or OfflineQueueItem(legacy_id=lid); x.user_id=user.id; x.operation=r.get("operation") or r.get("op"); x.entity_type=r.get("entityType"); x.entity_id=r.get("entityId"); x.status=r.get("status"); x.payload=r; db.add(x)
    for r in state.get("events",[]) or []:
        lid=str(r.get("id") or "");
        if not lid: continue
        x=db.scalar(select(Notification).where(Notification.legacy_id==lid)) or Notification(legacy_id=lid,user_id=user.id,title=r.get("title") or "Notification"); x.user_id=x.user_id or user.id; x.event_type=r.get("type"); x.title=r.get("title") or x.title; x.message=r.get("meta"); x.target_type=r.get("targetType"); x.target_id=r.get("targetId"); x.dedupe_key=r.get("key"); x.read_at=datetime.now() if r.get("read") else None; x.payload=r; db.add(x)
    for r in state.get("audit",[]) or []:
        lid=str(r.get("id") or "")
        if not lid or db.scalar(select(AuditLog.id).where(AuditLog.legacy_id==lid)): continue
        db.add(AuditLog(legacy_id=lid,user_id=user.id,actor_name=r.get("user"),action=r.get("text") or "Legacy action",module=r.get("module"),before_state=r.get("before") if isinstance(r.get("before"),dict) else {"value":r.get("before")},after_state=r.get("after") if isinstance(r.get("after"),dict) else {"value":r.get("after")},metadata_json={"legacy_at":r.get("at")}))

    for k in SETTING_KEYS:
        if k in state: _upsert_setting(db,k,state.get(k),user)
    db.commit()
    rev=db.get(StateRevision,1)
    return rev.revision if rev else 0
