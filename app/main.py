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
from sqlalchemy import inspect as sa_inspect, text
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.exc import SQLAlchemyError

from app.audit.router import router as audit_router
from app.field.router import router as field_router
from app.auth.router import router as auth_router
from app.core.assets import asset_hash, build_info, version_static_urls
from app.core.config import get_settings
from app.imports.router import router as imports_router
from app.issues.router import router as issues_router
from app.notifications.router import router as notifications_router
from app.operations.router import router as operations_router
from app.plants.router import router as plants_router
from app.pmplan.router import router as pmplan_router
from app.scada.router import router as scada_router
from app.scheduled.router import router as scheduled_router
from app.scheduled.washing_cycles import invalidate_overview_cache
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
    info = build_info(app.version, settings.app_env)
    logger.info("Solar91 starting version=%s commit=%s frontend_bundle=%s", info["app_version"], info["commit_short"] or "unknown", info["frontend_bundle"])
    if settings.app_env != "test":
        # One line in the service log with the network round trip to the database: every SQL statement, new connection
        # and health check costs at least this much, so slow-request lines can be read against it.
        app.state.latency_probe = asyncio.create_task(_log_database_latency())
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
                getattr(app.state, "latency_probe", None),
                getattr(app.state, "bootstrap_task", None),
                getattr(app.state, "pm_job", None),
            )
            if task is not None and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        from app.storage.service import close_storage_http_client
        close_storage_http_client()
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Request-ID", "Rndr-Id"],
    expose_headers=["X-Request-ID", "Rndr-Id", "Server-Timing"],
)

# Compress big responses (the 740 KB page shrinks to roughly 130 KB) so pages load fast on site-office mobile networks.
app.add_middleware(GZipMiddleware,minimum_size=1000)

@app.middleware("http")
async def require_bootstrap(request: Request, call_next):
    if settings.app_env == "production" and not app.state.bootstrap_ready and request.url.path not in {"/health", "/health/ready", "/health/version"}:
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
        # The portal page links every asset as /static/...?v=<content hash>. A request carrying the current
        # hash can be cached for a year (a changed file gets a new URL); anything else is revalidated.
        version = request.query_params.get("v")
        current = asset_hash(request.url.path[len("/static/"):]) if version else None
        response.headers.setdefault(
            "Cache-Control",
            "public, max-age=31536000, immutable" if version and version == current else "public, max-age=0, must-revalidate",
        )
    if settings.app_env == "production":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.url.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response

@app.middleware("http")
async def drop_washing_cache_after_writes(request: Request, call_next):
    try:
        return await call_next(request)
    finally:  # also runs if the write fails half-way, so the cached overview is never left stale
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/"):
            invalidate_overview_cache()

from app.core.database import engine as _engine_for_timing
from app.core.observability import install_connection_timing, install_query_counter, make_timing_middleware

install_query_counter(_engine_for_timing)
install_connection_timing(_engine_for_timing)
app.middleware("http")(make_timing_middleware(settings.slow_request_ms))  # added last = outermost, so it times everything

async def _log_database_latency() -> None:
    from app.core.database import engine
    from app.core.observability import measure_database_latency

    rtt = await asyncio.to_thread(measure_database_latency, engine)
    if rtt is None:
        logger.warning("database_latency unavailable (database not reachable at startup)")
    else:
        logger.log(logging.WARNING if rtt >= 50 else logging.INFO,
                   "database_latency round_trip_ms=%.0f%s", rtt,
                   " (high: the app and database are probably in different regions; each query costs at least this much)" if rtt >= 50 else "")


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
    info = build_info(app.version, settings.app_env)
    html = templates.get_template("index.html").render(
        request=request,
        auth_provider="clerk",
        clerk_publishable_key=settings.clerk_publishable_key,
        clerk_frontend_api=settings.clerk_frontend_api,
        build_id=(info["commit_short"] or "local") + "." + info["frontend_bundle"],
    )
    return HTMLResponse(version_static_urls(html))

@app.get("/health",tags=["System"])
def health(): return {"status":"ok","app":settings.app_name,"environment":settings.app_env}

@app.get("/health/version",tags=["System"])
def version():
    """Which code is running: compare ``commit`` with GitHub and ``frontend_bundle`` with scripts/asset_version.py."""
    return build_info(app.version, settings.app_env)

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
            schema_ok = sa_inspect(conn).has_table("users")
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(status_code=503,content={"status":"database_unreachable"})
    if not schema_ok:
        logger.error("Readiness check: the database is reachable but the Solar91 schema (users table) is missing; apply database/migrations.")
        return JSONResponse(status_code=503,content={"status":"schema_missing"})
    return {
        "status": "ready",
        "auth_provider": "clerk",
        "auth_configured": settings.auth_configured,
        "storage_configured": settings.storage_configured,
    }

@app.exception_handler(RequestValidationError)
async def validation_error(request:Request,exc:RequestValidationError):
    return JSONResponse(status_code=422,content=jsonable_encoder({"error":"validation_error","detail":exc.errors()}, custom_encoder={ValueError: str}))

_SCHEMA_MISSING_LOGGED={"at":0.0}

def _is_missing_core_table(message:str)->bool:
    """True when PostgreSQL/SQLite reports that a core Solar91 table does not exist (schema never applied)."""
    return any(f'relation "{name}" does not exist' in message or f"no such table: {name}" in message for name in ("users","plants","issues","om_tasks"))

@app.exception_handler(SQLAlchemyError)
async def database_error(request:Request,exc:SQLAlchemyError):
    text=str(getattr(exc,"orig",exc)).lower()
    if _is_missing_core_table(text):
        # One concise line per minute instead of a full traceback on every page refresh.
        import time
        now=time.monotonic()
        if now-_SCHEMA_MISSING_LOGGED["at"]>60:
            _SCHEMA_MISSING_LOGGED["at"]=now
            logger.error("Database schema missing on %s: %s. DATABASE_URL reaches a database without the Solar91 tables; apply database/migrations to that Supabase project.",request.url.path,text.splitlines()[0][:200])
        return JSONResponse(status_code=503,content={"error":"database_schema_missing","detail":"The Solar91 database tables were not found. An administrator must connect the portal to the correct Supabase project or apply the database migrations."})
    logger.exception("Database error on %s",request.url.path)
    if ("does not exist" in text or "no such column" in text or "no such table" in text) and any(k in text for k in ("unit_no","cycle_id","units_per_day","pm_unit_config","pm_scope_config","planned_due_on","missed_days","rolled_count","total_units","cycle_day")):
        return JSONResponse(status_code=503,content={"error":"database_migration_pending","detail":"The database is missing the latest Preventive Maintenance update. Run database/SUPABASE_RUN_THIS.sql in the Supabase SQL editor, then reload."})
    return JSONResponse(status_code=503,content={"error":"database_error","detail":"The database operation could not be completed."})

@app.exception_handler(Exception)
async def unexpected_error(request:Request,exc:Exception):
    logger.exception("Unhandled error on %s",request.url.path)
    return JSONResponse(status_code=500,content={"error":"internal_server_error","detail":"An unexpected server error occurred."})
