from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
import sys

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import text
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.exc import SQLAlchemyError

from app.audit.router import router as audit_router
from app.field.router import router as field_router
from app.auth.router import router as auth_router
from app.core.config import get_settings
from app.imports.router import router as imports_router
from app.issues.router import router as issues_router
from app.notifications.router import router as notifications_router
from app.operations.router import router as operations_router
from app.plants.router import router as plants_router
from app.pmplan.router import router as pmplan_router
from app.scada.router import router as scada_router
from app.scheduled.router import router as scheduled_router
from app.services.router import router as services_router
from app.users.invites import router as users_invites_router
from app.users.router import router as users_router

settings=get_settings()
BASE=Path(__file__).resolve().parents[1]
logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger=logging.getLogger("solar91")
SETUP_RETRY_INITIAL_SECONDS = 5
SETUP_RETRY_MAX_SECONDS = 60
SETUP_SCRIPT_TIMEOUT_SECONDS = 60

@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.app_env == "production":
        app.state.bootstrap_task = asyncio.create_task(_run_deploy_setup())
        app.state.bootstrap_ready = False
    else:
        app.state.bootstrap_ready = True

    if settings.app_env != "test" and os.getenv("PM_DAILY_JOB", "0") == "1":
        app.state.pm_job = asyncio.create_task(_start_pm_daily_job_loop())
    else:
        app.state.pm_job = None

    try:
        yield
    finally:
        tasks = [
            task
            for task in (
                getattr(app.state, "bootstrap_task", None),
                getattr(app.state, "pm_job", None),
            )
            if task is not None and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if settings.app_env != "test":
            from app.core.database import engine
            engine.dispose()

app=FastAPI(
    title="Solar91 O&M Command Center API",
    version="1.6.0",
    description="FastAPI backend for the Solar91 O&M Command Center. Persistent business data is stored in Supabase PostgreSQL; authentication is provided by Clerk.",
    lifespan=lifespan,
)
app.state.bootstrap_ready = settings.app_env != "production"
app.add_middleware(CORSMiddleware,allow_origins=settings.origins,allow_credentials=True,allow_methods=["GET","POST","PATCH","PUT","DELETE","OPTIONS"],allow_headers=["Content-Type","Authorization"])

# Compress big responses (the 740 KB page shrinks to roughly 130 KB) so pages load fast on site-office mobile networks.
app.add_middleware(GZipMiddleware,minimum_size=1000)

@app.middleware("http")
async def require_bootstrap(request: Request, call_next):
    if settings.app_env == "production" and not app.state.bootstrap_ready and request.url.path not in {"/health", "/health/ready"}:
        return JSONResponse(status_code=503,content={"status":"initializing"})
    return await call_next(request)

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
    if request.url.path.startswith("/static/"):
        response.headers.setdefault("Cache-Control", "public, max-age=0, must-revalidate" if request.url.path.endswith((".js", ".html")) else "public, max-age=3600")
    if settings.app_env == "production":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.url.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response

async def _run_setup_script(script: str) -> int:
    path = BASE / "scripts" / script
    logger.info("Running deployment setup: %s", script)
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(path), cwd=str(BASE)
    )
    try:
        return await asyncio.wait_for(
            process.wait(), timeout=SETUP_SCRIPT_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        logger.error(
            "Deployment setup timed out: %s exceeded %s seconds",
            script,
            SETUP_SCRIPT_TIMEOUT_SECONDS,
        )
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        return 3
    except asyncio.CancelledError:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        raise


async def _run_deploy_setup():
    delay = SETUP_RETRY_INITIAL_SECONDS
    while True:
        try:
            transient_failure = False
            for script in ("preflight.py", "ensure_storage.py"):
                exit_code = await _run_setup_script(script)
                if exit_code == 0:
                    continue
                if exit_code == 3:
                    transient_failure = True
                    break
                logger.error(
                    "Deployment setup failed: %s exited with status %s",
                    script,
                    exit_code,
                )
                return

            if not transient_failure:
                app.state.bootstrap_ready = True
                logger.info("Deployment setup complete; application is ready.")
                return
            logger.warning(
                "Deployment setup encountered a temporary dependency failure; "
                "retrying in %s seconds.",
                delay,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "Deployment setup attempt failed; application remains unavailable."
            )
            return

        await asyncio.sleep(delay)
        delay = min(delay * 2, SETUP_RETRY_MAX_SECONDS)

async def _start_pm_daily_job_loop():
    """Hourly PM reminders and washing monthly-target notifications; opt in on one worker only."""
    def _once():
        from app.core.database import SessionLocal
        from app.pmplan.units import run_daily
        with SessionLocal() as db:
            result = run_daily(db)
            from app.scheduled.washing_cycles import check_missed_monthly_targets, check_washing_overdue, check_weekly_compliance_alerts
            result["washing_monthly_targets_notified"] = check_missed_monthly_targets(db)
            result["washing_weekly_compliance_alerts"] = check_weekly_compliance_alerts(db)
            result["washing_overdue_alerts"] = check_washing_overdue(db)
            return result

    while True:
        if not app.state.bootstrap_ready:
            await asyncio.sleep(30)
            continue
        try:
            await asyncio.to_thread(_once)
        except Exception:  # the job must never take the API down
            logging.getLogger("solar91.pm").exception("Daily PM job failed")
        await asyncio.sleep(3600)

STATIC=BASE/"frontend"/"static"; TEMPLATES=BASE/"frontend"/"templates"
if STATIC.is_dir():
    app.mount("/static",StaticFiles(directory=STATIC),name="static")
templates=Jinja2Templates(directory=TEMPLATES)

app.include_router(auth_router)
app.include_router(field_router)
app.include_router(plants_router)
app.include_router(issues_router)
app.include_router(operations_router)
app.include_router(services_router)
app.include_router(imports_router)
app.include_router(notifications_router)
app.include_router(audit_router)
app.include_router(scada_router)
app.include_router(scheduled_router)
app.include_router(pmplan_router)
app.include_router(users_router)
app.include_router(users_invites_router)

@app.get("/",include_in_schema=False)
def index(request:Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "auth_provider": "clerk",
            "clerk_publishable_key": settings.clerk_publishable_key,
            "clerk_frontend_api": settings.clerk_frontend_api,
        },
    )

@app.get("/health",tags=["System"])
def health(): return {"status":"ok","app":settings.app_name,"environment":settings.app_env}

@app.get("/manifest.webmanifest",include_in_schema=False)
def manifest():
    return FileResponse(STATIC/"pwa"/"manifest.webmanifest",media_type="application/manifest+json",headers={"Cache-Control":"public, max-age=3600"})

@app.get("/sw.js",include_in_schema=False)
def service_worker():
    return FileResponse(STATIC/"pwa"/"sw.js",media_type="text/javascript",headers={"Cache-Control":"no-cache","Service-Worker-Allowed":"/"})

@app.get("/health/ready",tags=["System"])
def ready():
    """Confirms the database is reachable. Use this after deploying."""
    if not app.state.bootstrap_ready:
        return JSONResponse(status_code=503,content={"status":"initializing"})
    from app.core.database import engine
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(status_code=503,content={"status":"database_unreachable"})
    return {
        "status": "ready",
        "auth_provider": "clerk",
        "auth_configured": settings.auth_configured,
        "storage_configured": settings.storage_configured,
    }

@app.exception_handler(RequestValidationError)
async def validation_error(request:Request,exc:RequestValidationError):
    return JSONResponse(status_code=422,content=jsonable_encoder({"error":"validation_error","detail":exc.errors()}, custom_encoder={ValueError: str}))

@app.exception_handler(SQLAlchemyError)
async def database_error(request:Request,exc:SQLAlchemyError):
    logger.exception("Database error on %s",request.url.path)
    text=str(getattr(exc,"orig",exc)).lower()
    if ("does not exist" in text or "no such column" in text or "no such table" in text) and any(k in text for k in ("unit_no","cycle_id","units_per_day","pm_unit_config","pm_scope_config","planned_due_on","missed_days","rolled_count","total_units","cycle_day")):
        return JSONResponse(status_code=503,content={"error":"database_migration_pending","detail":"The database is missing the latest Preventive Maintenance update. Run database/SUPABASE_RUN_THIS.sql in the Supabase SQL editor, then reload."})
    return JSONResponse(status_code=503,content={"error":"database_error","detail":"The database operation could not be completed."})

@app.exception_handler(Exception)
async def unexpected_error(request:Request,exc:Exception):
    logger.exception("Unhandled error on %s",request.url.path)
    return JSONResponse(status_code=500,content={"error":"internal_server_error","detail":"An unexpected server error occurred."})
