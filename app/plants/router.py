from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.models import User
from app.core.security import (
    get_current_user, require_csrf, require_permission, user_scoped_plant_ids, visible_custom_fields,
)
from app.plants.repository import PlantRepository
from app.plants.schemas import PlantCreate, PlantOut, PlantUpdate
from app.plants.service import PlantService

router=APIRouter(prefix="/api", tags=["Plants"])
settings=get_settings()


@router.get("/plants", response_model=list[PlantOut])
def list_plants(db:Annotated[Session,Depends(get_db)], user:Annotated[User,Depends(get_current_user)], q:str|None=None,district:str|None=None,project:str|None=None,engineer:str|None=None,offset:int=0,limit:int=Query(50,le=200)):
    rows=PlantRepository(db).list(q=q,district=district,project=project,engineer=engineer,allowed_plant_ids=user_scoped_plant_ids(db,user),offset=offset,limit=limit)
    # Validate first, then redact the copy: the ORM rows (and the stored link) are never modified.
    out=[PlantOut.model_validate(p) for p in rows]
    for plant in out:
        plant.custom_fields=visible_custom_fields(plant.custom_fields,user)
    return out


@router.post("/plants", response_model=PlantOut, status_code=201, dependencies=[Depends(require_csrf)])
def create_plant(data:PlantCreate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("plants.manage"))]): return PlantService(db).create(data,user)


@router.patch("/plants/{plant_id}", response_model=PlantOut, dependencies=[Depends(require_csrf)])
def update_plant(plant_id:UUID,data:PlantUpdate,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("plants.manage"))]): return PlantService(db).update(plant_id,data)


@router.delete("/plants/{plant_id}", status_code=204, dependencies=[Depends(require_csrf)])
def delete_plant(plant_id:UUID,db:Annotated[Session,Depends(get_db)],user:Annotated[User,Depends(require_permission("plants.manage"))]): PlantService(db).delete(plant_id); return Response(status_code=204)
