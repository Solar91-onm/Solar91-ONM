"""The fast JSON path must produce exactly what FastAPI's jsonable_encoder + JSONResponse would."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from fastapi.encoders import jsonable_encoder

from app.core.fastjson import json_response


def test_fast_path_matches_fastapi_encoding():
    sample = {
        "tasks": [{"id": "WO-1", "due": date(2026, 10, 25), "at": datetime(2026, 10, 25, 9, 30, tzinfo=timezone(timedelta(hours=5, minutes=30))),
                   "naive": datetime(2026, 1, 2, 3, 4, 5), "t": time(6, 0), "db_id": uuid.UUID(int=7), "qty": Decimal("12"), "hrs": Decimal("1.25"),
                   "tags": ("a", "b"), "nested": {"ok": True, "none": None, "unicode": "₹ ✓"}}],
        "count": 1,
    }
    response = json_response(sample, headers={"X-Test": "1"})
    assert response.media_type == "application/json" and response.headers["X-Test"] == "1"
    assert json.loads(response.body) == jsonable_encoder(sample)


def test_values_json_cannot_encode_fall_back_to_the_standard_path():
    sample = {uuid.UUID(int=1): "uuid key", "nan": float("nan")}
    try:
        json_response(sample)
    except ValueError:
        pass  # NaN is refused by the standard JSONResponse too (allow_nan=False)
    keyed = json_response({uuid.UUID(int=1): "uuid key"})
    assert json.loads(keyed.body) == {str(uuid.UUID(int=1)): "uuid key"}
