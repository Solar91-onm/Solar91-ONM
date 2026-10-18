from __future__ import annotations

import asyncio

from app.core.database import engine
from app.main import app


def test_test_client_lifespan_does_not_dispose_shared_engine(monkeypatch):
    disposed = []
    monkeypatch.setattr(engine, "dispose", lambda: disposed.append(True))

    async def run_lifespan():
        async with app.router.lifespan_context(app):
            pass

    asyncio.run(run_lifespan())

    assert disposed == []
