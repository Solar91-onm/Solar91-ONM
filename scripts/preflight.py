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
    if bad(settings.supabase_anon_key):
        problems.append("SUPABASE_ANON_KEY is missing or still contains a placeholder")
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
        return 3

    print("OK: Supabase Auth public configuration is present.")
    print("OK: Supabase Storage credentials are present; bucket privacy is checked by ensure_storage.py.")
    print("OK: Authorized application origins: " + ", ".join(settings.origins))
    print("Preflight passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
