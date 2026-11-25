"""Process-local overload protection. No request body buffering or untrusted IP headers.

Use a shared edge limiter for a multi-instance deployment; this is the last line
of defence protecting each worker and its database pool.
"""
from __future__ import annotations

from collections import OrderedDict
from math import ceil
from threading import Lock
from time import monotonic

from starlette.responses import JSONResponse


class TokenBuckets:
    def __init__(self, max_keys: int = 4096, clock=monotonic):
        self.max_keys = max_keys
        self.clock = clock
        self.buckets = OrderedDict()
        self.lock = Lock()

    def take(self, key: str, per_minute: int, burst: int) -> int:
        """Zero = allowed; otherwise Retry-After in seconds."""
        with self.lock:
            now = self.clock()
            tokens, last = self.buckets.pop(key, (float(burst), now))
            tokens = min(burst, tokens + max(0, now - last) * per_minute / 60)
            wait = 0 if tokens >= 1 else max(1, ceil((1 - tokens) * 60 / per_minute))
            self.buckets[key] = (tokens - (not wait), now)
            while len(self.buckets) > self.max_keys:
                self.buckets.popitem(last=False)
            return wait


class TrafficGuard:
    def __init__(self, app, *, max_active: int = 20, ip_per_minute: int = 600,
                 ip_burst: int = 100, global_per_minute: int = 1800, global_burst: int = 150):
        self.app = app
        self.max_active = max_active
        self.ip_per_minute = ip_per_minute
        self.ip_burst = ip_burst
        self.global_per_minute = global_per_minute
        self.global_burst = global_burst
        self.by_ip = TokenBuckets()
        self.total = TokenBuckets(max_keys=1)
        self.active = 0
        self.active_reads = 0
        self.read_limit = max(1, max_active - max(1, max_active // 5))

    async def __call__(self, scope, receive, send):
        if (scope['type'] != 'http' or not scope.get('path', '').startswith('/api/')
                or scope.get('method') == 'OPTIONS'):
            return await self.app(scope, receive, send)
        # ASGI client address only; configure trusted proxy handling in Uvicorn at the edge.
        peer = (scope.get('client') or ('unknown', 0))[0]
        wait = self.by_ip.take(peer, self.ip_per_minute, self.ip_burst)
        if not wait:
            wait = self.total.take('all', self.global_per_minute, self.global_burst)
        if wait:
            response = JSONResponse({'detail': 'Too many requests. Please try again shortly.'},
                                    status_code=429, headers={'Retry-After': str(wait), 'Cache-Control': 'no-store'})
            return await response(scope, receive, send)
        # No await between the check and increment: one ASGI event loop per worker.
        # Do not cancel an in-progress write to make room for another request.
        read = scope.get('method') in {'GET', 'HEAD'}
        if self.active >= self.max_active or (read and self.active_reads >= self.read_limit):
            response = JSONResponse({'detail': 'The server is busy. Please try again shortly.'},
                                    status_code=503, headers={'Retry-After': '3', 'Cache-Control': 'no-store', 'X-Solar91-Overload': '1'})
            return await response(scope, receive, send)
        self.active += 1
        if read:
            self.active_reads += 1
        try:
            await self.app(scope, receive, send)
        finally:
            self.active -= 1
            if read:
                self.active_reads -= 1
