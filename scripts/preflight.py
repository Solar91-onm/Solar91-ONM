from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.core.config import get_settings


def bad(value: str | None) -> bool:
    v = (value or "").strip()
    return not v or any(marker in v for marker in ("REPLACE_ME", "YOUR_", "change-me", "<user>", "<password>", "<supabase-session-pooler-host>", "<project>"))


def main() -> int:
    env_file = ROOT / ".env"
    print("Solar91 preflight check")
    print("-----------------------")
    if not env_file.exists():
        print("NOTE: no .env file found. Using hosting environment variables (normal on Render).")

    settings = get_settings()
    problems: list[str] = []
    warnings: list[str] = []

    if bad(settings.database_url):
        problems.append("DATABASE_URL is missing or still contains a placeholder")
    if bad(settings.supabase_url):
        problems.append("SUPABASE_URL is missing or still contains a placeholder")
    if bad(settings.clerk_publishable_key):
        problems.append("CLERK_PUBLISHABLE_KEY is missing or still contains a placeholder")
    if bad(settings.clerk_secret_key):
        problems.append("CLERK_SECRET_KEY is missing or still contains a placeholder")
    if bad(settings.clerk_issuer):
        problems.append("CLERK_ISSUER is missing or still contains a placeholder")
    if not settings.clerk_frontend_api:
        problems.append("CLERK_PUBLISHABLE_KEY must be a valid Clerk publishable key")
    if bad(settings.supabase_service_role_key):
        problems.append(
            "SUPABASE_SERVICE_ROLE_KEY is missing or still contains a placeholder "
            "(required for private O&M photo evidence)"
        )
    if not settings.admin_emails:
        warnings.append("BOOTSTRAP_ADMIN_EMAILS is empty; first-time users will be Viewer only")

    if not bad(settings.database_url):
        try:
            db_url = make_url(settings.database_url)
            if db_url.drivername != "postgresql+psycopg" and not db_url.drivername.startswith("sqlite"):
                warnings.append("DATABASE_URL should normally start with postgresql+psycopg://")
            if db_url.port == 6543:
                warnings.append(
                    "DATABASE_URL uses port 6543 (transaction pooler). Render is a persistent "
                    "service; Supabase Session Pooler port 5432 is recommended."
                )
            if settings.app_env == "production" and "supabase" in (db_url.host or ""):
                query = dict(db_url.query)
                if query.get("sslmode") != "require":
                    warnings.append("For production Supabase, add ?sslmode=require to DATABASE_URL")
        except Exception:
            warnings.append("DATABASE_URL could not be parsed for deployment checks")

    for item in warnings:
        print("WARNING: " + item)
    for item in problems:
        print("ERROR: " + item)
    if problems:
        return 2

    try:
        engine = create_engine(settings.database_url, pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text("select 1"))
        engine.dispose()
        print("OK: Supabase PostgreSQL connection succeeded.")
    except Exception as exc:
        print(f"ERROR: Database connection failed ({type(exc).__name__}). Check DATABASE_URL and Supabase network access.")
        try:
            # Show WHY (never the password): the driver's own message plus the user/host/port that were used.
            u = make_url(settings.database_url)
            reason = str(getattr(exc, "orig", None) or exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
            if u.password:
                reason = reason.replace(u.password, "***")
            print(f"REASON: {reason[:300]}")
            print(f"USED: user={u.username} host={u.host} port={u.port} database={u.database}")
            low = reason.lower()
            if "tenant or user not found" in low:
                print("HINT: wrong username or region host. The username must be postgres.<project-ref> and the host must be copied from Supabase > Connect > Session pooler.")
            elif "password authentication failed" in low:
                print("HINT: wrong database password. Reset it in Supabase > Project Settings > Database and update DATABASE_URL.")
            elif "could not translate host" in low or "name or service not known" in low:
                print("HINT: the host name is wrong. Copy it again from Supabase > Connect > Session pooler.")
            elif "timeout" in low or "timed out" in low or "network is unreachable" in low:
                print("HINT: cannot reach the host (a direct db.<ref>.supabase.co host is IPv6-only; use the Session pooler host) or the project is paused.")
            elif "ssl" in low:
                print("HINT: add ?sslmode=require to the end of DATABASE_URL.")
        except Exception:
            pass
        return 3

    print("OK: Clerk authentication configuration is present.")
    print("OK: Supabase Storage credentials are present; bucket privacy is checked by ensure_storage.py.")
    print("OK: Authorized application origins: " + ", ".join(settings.origins))
    print("Preflight passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
