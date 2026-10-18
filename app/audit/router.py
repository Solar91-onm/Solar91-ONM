from __future__ import annotations
from typing import Annotated
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.models import AuditLog, User
from app.core.security import require_permission

router=APIRouter(prefix="/api/audit",tags=["Audit"])

@router.get("")
def list_audit(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("audit.view"))],entity_type:str|None=None,entity_id:str|None=None,limit:int=Query(100,le=500)):
    stmt=select(AuditLog)
    if entity_type: stmt=stmt.where(AuditLog.entity_type==entity_type)
    if entity_id: stmt=stmt.where(AuditLog.entity_id==entity_id)
    rows=db.scalars(stmt.order_by(AuditLog.created_at.desc()).limit(limit))
    return [{"id":str(x.id),"at":x.created_at,"user":x.actor_name,"action":x.action,"module":x.module,"entity_type":x.entity_type,"entity_id":x.entity_id,"before":x.before_state,"after":x.after_state,"metadata":x.metadata_json} for x in rows]
