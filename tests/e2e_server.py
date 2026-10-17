"""Isolated development-only HTTP server for browser smoke tests.

Never import this module from production: it has an intentionally synthetic
identity dependency override, is guarded by an explicit environment flag,
and uses an isolated SQLite database. No external Supabase credentials needed.
"""
import os
if os.environ.get("SOLAR91_E2E_TEST_MODE") != "1":
    raise RuntimeError("Test-only server: set SOLAR91_E2E_TEST_MODE=1")
if not os.environ.get("DATABASE_URL", "").startswith("sqlite:///"):
    raise RuntimeError("Browser test server requires an isolated SQLite database")
os.environ["APP_ENV"] = "test"
from fastapi import HTTPException, Request
from sqlalchemy import select
from datetime import date, timedelta
from app.core.timeutil import business_today
from app.core.database import Base, SessionLocal, engine
from app.core.models import User, UserEquipmentTypeAssignment, Plant, UserPlantAssignment, Issue, OMTask
from app.core.security import get_current_user
from app.main import app

Base.metadata.create_all(engine)
with SessionLocal() as db:
    if not db.scalar(select(User).where(User.external_subject == "e2e:isolated")):
        db.add(User(auth_provider="test", external_subject="e2e:isolated",
                    email="e2e@example.invalid", display_name="QA O&M Head",
                    role="O&M Head", is_active=True))
        db.commit()
    if not db.scalar(select(User).where(User.external_subject == "e2e:assignee")):
        user=User(auth_provider="test",external_subject="e2e:assignee",
                  email="assignee@example.invalid",display_name="QA Assignee",role="Assignee",is_active=True)
        db.add(user);db.flush()
        db.add(UserEquipmentTypeAssignment(user_id=user.id,equipment_type="Inverter"))
        db.commit()

# Dedicated synthetic Site Engineer with one demo plant and server-persisted issue/PM.
# All test data lives in the isolated SQLite URL supplied at server launch.
with SessionLocal() as db:
    se = db.scalar(select(User).where(User.external_subject == "e2e:site"))
    if not se:
        se=User(auth_provider="test",external_subject="e2e:site",email="site@example.invalid",
                display_name="QA Site Engineer",role="Site Engineer",is_active=True)
        db.add(se);db.flush()
    plant=db.scalar(select(Plant).where(Plant.site_code=="QA-SITE-01"))
    if not plant:
        plant=Plant(site_code="QA-SITE-01",plant_name="QA Site Plant",status="active")
        db.add(plant);db.flush()
    if not db.scalar(select(UserPlantAssignment).where(UserPlantAssignment.user_id==se.id)):
        db.add(UserPlantAssignment(user_id=se.id,plant_id=plant.id,assignment_role="Site Engineer"))
    if not db.scalar(select(Issue).where(Issue.ticket_no=="QA-FIELD-1")):
        db.add(Issue(ticket_no="QA-FIELD-1",plant_id=plant.id,description="Inspect panel connections on site",
                     vertical="Inverter",severity="High",status="Open"))
    if not db.scalar(select(OMTask).where(OMTask.work_order_no=="QA-PM-1")):
        db.add(OMTask(work_order_no="QA-PM-1",plant_id=plant.id,task_name="Monthly inverter inspection",
                      task_type="Inverter",status="Scheduled",due_on=business_today()+timedelta(days=1)))
    db.commit()

def browser_test_user(request: Request):
    # Test-only identity selector: this module cannot import without E2E_TEST_MODE.
    subject = "e2e:site" if request.headers.get("X-S91-E2E-USER") == "site" else "e2e:isolated"
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.external_subject == subject))
        if not user:
            raise HTTPException(401, "Test user missing")
        db.expunge(user)
        return user

app.dependency_overrides[get_current_user] = browser_test_user
