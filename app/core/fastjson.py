"""Fast JSON responses for large plain-data payloads (sign-in state, the PM work-order list).

FastAPI passes a returned dict/list through ``jsonable_encoder``, which walks every nested value in Python before
``json.dumps`` runs; for ~15,000 PM work orders that walk took longer than building the rows (1.5 s vs 0.13 s for
the dump itself, measured locally). These payloads are already plain JSON apart from the odd date/UUID/Decimal, so
``json.dumps`` with a ``default`` hook produces the same JSON. Anything it cannot encode (e.g. non-string dict keys)
falls back to the standard FastAPI path, so the output never changes.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response


def _default(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, Decimal):  # same rule as FastAPI's decimal_encoder
        return int(value) if value.as_tuple().exponent >= 0 else float(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (set, frozenset)):
        return list(value)
    raise TypeError(f"not JSON serializable: {type(value).__name__}")


def json_response(content: Any, *, status_code: int = 200, headers: dict[str, str] | None = None) -> Response:
    try:
        body = json.dumps(content, default=_default, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        return JSONResponse(jsonable_encoder(content), status_code=status_code, headers=headers)
    return Response(content=body, status_code=status_code, media_type="application/json", headers=headers)
