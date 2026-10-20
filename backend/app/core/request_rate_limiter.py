"""Redis-backed, identity-aware application request limiting."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from app.core.shared_store import shared_store


def request_identity(request: Request) -> str:
    """Bucket by the client address resolved by Uvicorn's trusted proxy layer.

    Authentication has not run in this middleware. JWT payloads and raw
    forwarded headers are user-controlled and must not choose a rate bucket.
    """
    return f"client:{request.client.host if request.client else 'unknown'}"


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after: int


class RequestRateLimiter:
    async def allow(self, *, identity: str, bucket: str, limit: int, window_seconds: int) -> RateLimitResult:
        key = f"alpha:rate-limit:{bucket}:{identity}"
        count, remaining = await shared_store.increment_window(key, ttl_seconds=window_seconds)
        return RateLimitResult(allowed=count <= limit, retry_after=remaining)


request_rate_limiter = RequestRateLimiter()
