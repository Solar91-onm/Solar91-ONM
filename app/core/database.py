from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
if settings.database_url.startswith("sqlite"):
    engine = create_engine(
        settings.database_url,
        pool_pre_ping=True,
        connect_args={"check_same_thread": False},
    )
else:
    # Render runs FastAPI as a persistent service, so keep a small SQLAlchemy
    # connection pool. Supabase Session Pooler (port 5432) is the recommended
    # connection mode for this deployment model.
    url = make_url(settings.database_url)
    connect_args: dict[str, object] = {}
    # Defensive compatibility if somebody accidentally supplies Supabase's
    # transaction pooler (6543), which does not support prepared statements.
    if url.port == 6543:
        connect_args["prepare_threshold"] = None

    # Idle-aware health check (see observability.install_connection_health) instead of pinging before every request.
    idle_aware_ping = settings.db_pool_pre_ping and settings.db_ping_idle_seconds > 0
    engine = create_engine(
        settings.database_url,
        pool_pre_ping=settings.db_pool_pre_ping and not idle_aware_ping,
        pool_timeout=settings.db_pool_timeout_seconds,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_recycle=settings.db_pool_recycle_seconds,
        connect_args=connect_args,
    )
    if idle_aware_ping:
        from app.core.observability import install_connection_health

        install_connection_health(engine, settings.db_ping_idle_seconds)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    class_=Session,
)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def release_connection(db: Session) -> None:
    """Return the pooled connection before slow non-database work (Storage uploads/downloads, image encoding).

    Ends the current read transaction only; loaded objects stay usable (expire_on_commit=False) and the session
    checks a connection out again on its next query. Pending writes are never committed here.
    """
    if not (db.new or db.dirty or db.deleted):
        db.commit()
