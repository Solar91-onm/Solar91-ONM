"""GZip for text responses only.

Photos (JPEG/WebP/PNG), PDFs and spreadsheets (.xlsx is a ZIP) are already compressed: gzipping them again costs
CPU on the small Render instance and saves almost nothing, so they are sent as they are. Level 6 instead of
Starlette's default 9: on the synthetic 5x data, level 9 made sign-in/PM/issue JSON only 3–8% smaller for 2–2.7x the
compression CPU (scripts/benchmark_json.py and docs/PERFORMANCE_OPTIMIZATION_REPORT.md).
"""
from __future__ import annotations

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import Message, Receive, Scope, Send

PRECOMPRESSED_TYPES = (
    "image/", "video/", "audio/", "font/woff", "application/pdf", "application/zip", "application/gzip",
    "application/vnd.openxmlformats-officedocument.",
)


class _TextOnlyGZipResponder(GZipResponder):
    async def send_with_compression(self, message: Message) -> None:
        await super().send_with_compression(message)
        if message["type"] == "http.response.start":
            content_type = Headers(raw=message["headers"]).get("content-type", "")
            if content_type.startswith(PRECOMPRESSED_TYPES) and not content_type.startswith("image/svg"):
                self.content_type_is_excluded = True  # body messages then pass straight through


class TextGZipMiddleware(GZipMiddleware):
    def __init__(self, app, minimum_size: int = 1000, compresslevel: int = 6) -> None:
        super().__init__(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and "gzip" in Headers(scope=scope).get("Accept-Encoding", ""):
            await _TextOnlyGZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)(scope, receive, send)
            return
        await super().__call__(scope, receive, send)
