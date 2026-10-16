from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.core.models import HandoverItem, Issue, OMTask, Plant, WashingDailyReport
from scripts.generate_scale_fixture import seed_synthetic_data


def test_synthetic_scale_fixture_populates_related_operational_records():
    with SessionLocal() as db:
        counts = seed_synthetic_data(db, scale=1, prefix="TST")

        assert counts["plants"] == 5
        assert db.scalar(select(func.count()).select_from(Plant)) == 5
        assert db.scalar(select(func.count()).select_from(Issue)) == 100
        assert db.scalar(select(func.count()).select_from(OMTask)) == 75
        assert db.scalar(select(func.count()).select_from(WashingDailyReport)) == 40
        assert db.scalar(select(func.count()).select_from(HandoverItem)) == 15
        assert counts["issues"] == 100
        assert counts["pm_tasks"] == 75
        assert counts["washing_reports"] == 40
