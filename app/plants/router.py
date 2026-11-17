from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.models import User
from app.core.security import (
    get_current_user, require_csrf, require_permission, user_scoped_plant_ids, visible_custom_fields,
)
from app.plants.repository import PlantRepository
from app.plants.schemas import (
    PlantCreate, PlantOut, PlantUpdate, SecurityContactMove, SecurityContactMoveOut,
    SecurityContactsUpdate,
)
from app.plants.service import PlantService

router=APIRouter(prefix="/api", tags=["Plants"])
settings=get_settings()

# Who may move a site engineer or guard from one plant's register to another's. The same pair the
# Inverter Health unit-config save allows (app/pmplan/router.py); every other role reads the
# register only.
SECURITY_MOVE_ROLES={"O&M Head","Assignee"}


@router.get("/plants", response_model=list[PlantOut])
def list_plants(db:Annotated[Session,Depends(get_db)], user:Annotated[User,Depends(get_current_user)], q:str|None=None,district:str|None=None,project:str|None=None,engineer:str|None=None,offset:int=0,limit:int=Query(50,le=200)):
    rows=PlantRepository(db).list(q=q,district=district,project=project,engineer=engineer,allowed_plant_ids=user_scoped_plant_ids(db,user),offset=offset,limit=limit)
    # Validate first, then redact the copy: the ORM rows (and the stored link) are never modified.
    out=[PlantOut.model_validate(p) for p in rows]
    for plant in out:
        plant.custom_fields=visible_custom_fields(plant.custom_fields,user)
    return out


@router.post("/plants/security/move", response_model=SecurityContactMoveOut, dependencies=[Depends(require_csrf)])
def move_security_contact(data:SecurityContactMove,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    """Move one site engineer or guard to another plant, as a single two-plant write.

    One endpoint rather than two PATCHes, because a half-finished move either loses a person or
    lists them twice. Both plants are returned as they now stand, redacted for the caller, so the
    register can update the two rows in place.
    """
    if user.role not in SECURITY_MOVE_ROLES:
        raise HTTPException(403,"Only the O&M Head or an Assignee can move a person between plants")
    # An Assignee is scoped to assigned plants, so BOTH ends of the move must be inside that scope
    # -- the same check the unit-config save makes before it writes.
    scope=user_scoped_plant_ids(db,user)
    if scope is not None:
        for code in (data.from_site_code,data.to_site_code):
            plant=PlantRepository(db).by_site_code(code)
            if plant is not None and plant.id not in scope:
                raise HTTPException(403,f"{code} is outside your assigned plants")
    source,destination,person=PlantService(db).move_security_contact(data)
    out=[]
    for plant in (source,destination):
        validated=PlantOut.model_validate(plant)
        validated.custom_fields=visible_custom_fields(validated.custom_fields,user)
        out.append(validated)
    return SecurityContactMoveOut(kind=data.kind,person=person,from_plant=out[0],to_plant=out[1])


@router.patch("/plants/{plant_id}/security-contacts", response_model=PlantOut, dependencies=[Depends(require_csrf)])
def update_security_contacts(plant_id:UUID,data:SecurityContactsUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(get_current_user)]):
    """Edit a single plant's security register (site engineers and guards).

    Gated the same way the move is: the O&M Head and Assignees only, and an Assignee only within
    their assigned plants. This is deliberately narrower than ``plants.manage`` -- it writes nothing
    but ``security_contacts`` -- so the O&M team can keep the register current without the ability
    to rewrite every other plant field.
    """
    if user.role not in SECURITY_MOVE_ROLES:
        raise HTTPException(403,"Only the O&M Head or an Assignee can edit security contacts")
    scope=user_scoped_plant_ids(db,user)
    if scope is not None and plant_id not in scope:
        raise HTTPException(403,"This plant is outside your assigned plants")
    plant=PlantService(db).set_security_contacts(plant_id,data.as_contacts())
    out=PlantOut.model_validate(plant)
    out.custom_fields=visible_custom_fields(out.custom_fields,user)
    return out


@router.post("/plants", response_model=PlantOut, status_code=201, dependencies=[Depends(require_csrf)])
def create_plant(data:PlantCreate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("plants.manage"))]): return PlantService(db).create(data,user)


@router.patch("/plants/{plant_id}", response_model=PlantOut, dependencies=[Depends(require_csrf)])
def update_plant(plant_id:UUID,data:PlantUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("plants.manage"))]): return PlantService(db).update(plant_id,data)


@router.delete("/plants/{plant_id}", status_code=204, dependencies=[Depends(require_csrf)])
def delete_plant(plant_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("plants.manage"))]): PlantService(db).delete(plant_id); return Response(status_code=204)
