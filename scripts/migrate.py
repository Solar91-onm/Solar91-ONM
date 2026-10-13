from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sqlalchemy import create_engine
from app.core.config import get_settings

settings = get_settings()
engine = create_engine(settings.database_url, pool_pre_ping=True)
root = ROOT / "database" / "migrations"

with engine.begin() as conn:
    # Use the raw psycopg connection: SQLAlchemy's exec_driver_sql makes psycopg
    # treat "%I" inside format(...) in migration 004 as a query placeholder and fail.
    raw = conn.connection.driver_connection
    for path in sorted(root.glob("*.sql")):
        print(f"Applying {path.name}...")
        raw.execute(path.read_text(encoding="utf-8"))
print("Migrations complete.")