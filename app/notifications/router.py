from __future__ import annotations
from datetime import datetime,timezone
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.models import Notification, User
from app.core.security import get_current_user, require_csrf

router=APIRouter(prefix="/api/notifications",tags=["Notifications"])

def dto(n:Notification): return {"id":str(n.id),"title":n.title,"message":n.message,"event_type":n.event_type,"target_type":n.target_type,"target_id":n.target_id,"read":n.read_at is not None,"created_at":n.created_at}

@router.get("")
def list_notifications(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    stmt=select(Notification).where((Notification.user_id==user.id)|(Notification.user_id.is_(None))).order_by(Notification.created_at.desc()).limit(100)
    return [dto(n) for n in db.scalars(stmt)]

@router.post("/{notification_id}/read",dependencies=[Depends(require_csrf)])
def mark_read(notification_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    n=db.get(Notification,notification_id)
    if not n or (n.user_id and n.user_id!=user.id): raise HTTPException(404,"Notification not found")
    n.read_at=datetime.now(timezone.utc); db.commit(); return {"ok":True}

@router.post("/read-all",dependencies=[Depends(require_csrf)])
def mark_all(db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    for n in db.scalars(select(Notification).where((Notification.user_id==user.id)|(Notification.user_id.is_(None)),Notification.read_at.is_(None))): n.read_at=datetime.now(timezone.utc)
    db.commit(); return {"ok":True}
