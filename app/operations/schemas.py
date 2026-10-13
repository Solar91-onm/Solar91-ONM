from typing import Any
from pydantic import BaseModel, Field

class StateSyncRequest(BaseModel):
    revision: int | None = None
    collection_revisions: dict[str, int] | None = None
    state: dict[str, Any] = Field(default_factory=dict)
