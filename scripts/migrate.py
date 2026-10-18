"""Initialise an EMPTY Solar91 database by applying database/migrations in order.

Usage (DATABASE_URL must point at the intended Supabase project):
  python scripts/migrate.py --check   # read-only: report which core tables exist; changes nothing
  python scripts/migrate.py           # apply all migrations, only if the database has no Solar91 tables

The historical migration set contains data-changing statements and has no ledger, so this script refuses to run
against a database that already has Solar91 tables. For a populated database, apply only the approved missing
migration(s) as described in docs/RENDER_DEPLOYMENT_RUNBOOK.md ("Database migration safety").
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import make_url

CORE_TABLES = ("users", "plants", "issues", "om_tasks")


def existing_core_tables(conn) -> list[str]:
    inspector = inspect(conn)
    return [name for name in CORE_TABLES if inspector.has_table(name)]


def main(argv: list[str]) -> int:
    from app.core.config import get_settings

    settings = get_settings()
    url = make_url(settings.database_url)
    print(f"Database: user={url.username} host={url.host} port={url.port} database={url.database}")
    engine = create_engine(settings.database_url, pool_pre_ping=True)
    with engine.connect() as conn:
        present = existing_core_tables(conn)
    print("Solar91 core tables present: " + (", ".join(present) if present else "none"))
    if "--check" in argv:
        print("Check only; nothing was changed.")
        return 0
    if present:
        print("REFUSED: this database already has Solar91 tables. Apply only the approved missing migration(s) "
              "as described in docs/RENDER_DEPLOYMENT_RUNBOOK.md. Nothing was changed.")
        return 2
    root = ROOT / "database" / "migrations"
    with engine.begin() as conn:  # one transaction: all migrations apply, or none do
        # Use the raw psycopg connection: SQLAlchemy's exec_driver_sql makes psycopg
        # treat "%I" inside format(...) in migration 004 as a query placeholder and fail.
        raw = conn.connection.driver_connection
        for path in sorted(root.glob("*.sql")):
            print(f"Applying {path.name}...")
            raw.execute(path.read_text(encoding="utf-8"))
    print("Migrations complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
