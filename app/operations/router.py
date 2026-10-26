from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.fastjson import json_response
from app.core.legacy_state import load_state, sync_state
from app.core.models import Plant, StateCollectionRevision, User
from app.core.security import ROLE_MODULES, ROLE_PERMISSIONS, get_current_user, has_portfolio_scope, require_csrf, user_scoped_equipment_ids, user_scoped_equipment_types, user_scoped_plant_ids
from app.operations.schemas import StateSyncRequest

router = APIRouter(prefix="/api", tags=["Application State"])


@router.get("/bootstrap")
def bootstrap(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
    lite: bool = False
):
    result = load_state(db, user, include_washing=not lite)
    allowed = user_scoped_plant_ids(db, user)
    equipment_scope = user_scoped_equipment_ids(db, user)
    type_scope = user_scoped_equipment_types(db, user)
    scope = {
        "type": "portfolio" if allowed is None else "equipment" if user.role == "Assignee" else "plant",
        "plant_ids": [str(x) for x in (allowed or set())],
        "equipment_ids": [str(x) for x in (equipment_scope or set())],
        "equipment_types": sorted(type_scope or set()),
    }
    if allowed is not None and len(allowed) == 1:
        plant = db.get(Plant, next(iter(allowed)))
        if plant:
            scope["plant"] = {
                "id": str(plant.id),
                "site_code": plant.site_code,
                "plant_name": plant.plant_name,
            }
    result["user"] = {
        "id": str(user.id),
        "external_id": user.external_subject,
        "name": user.display_name,
        "email": user.email,
        "role": user.role,
        "active": user.is_active,
    }
    result["scope"] = scope
    result["permissions"] = sorted(ROLE_PERMISSIONS.get(user.role, set()))
    result["modules"] = ROLE_MODULES.get(user.role, [])
    result["pending_access"] = (
        user.role == "Site Engineer" and len(scope["plant_ids"]) == 0
    ) or (user.role == "Assignee" and len(scope["equipment_types"]) == 0)
    return json_response(result)


@router.get("/state/collections")
def state_collections(
    keys: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    requested={key.strip() for key in keys.split(",") if key.strip()}
    result=load_state(db,user,include_washing="washing" in requested)
    state=result["state"]
    return {
        "state":{key:state[key] for key in requested if key in state},
        "collection_revisions":{
            key:result["collection_revisions"].get(key,0) for key in requested
        },
    }


@router.put("/state/sync", dependencies=[Depends(require_csrf)])
def state_sync(
    payload: StateSyncRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    revision = sync_state(
        db,payload.state,payload.revision,user,payload.collection_revisions
    )
    collection_revisions={
        row.collection:row.revision for row in db.query(StateCollectionRevision)
        .filter(StateCollectionRevision.collection.in_(payload.state))
    }
    return {"ok":True,"revision":revision,"collection_revisions":collection_revisions}


def _state_collection(db: Session, user: User, key: str):
    return load_state(db, user)["state"].get(key, [])


@router.get("/handovers", tags=["Project Handover"])
def list_handovers(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _state_collection(db, user, "handovers")


@router.get("/tasks", tags=["Preventive Maintenance"])
def list_tasks(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _state_collection(db, user, "tasks")


@router.get("/washing", tags=["Washing"])
def list_washing(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _state_collection(db, user, "washing")
