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

    engine = create_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_recycle=settings.db_pool_recycle_seconds,
        connect_args=connect_args,
    )

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
