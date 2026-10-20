"""Shared provider budget, concurrency, and retry guard for Arrow and Kite."""

from __future__ import annotations

import asyncio
import logging
import random
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import TypeVar

from fastapi import HTTPException

from app.config import settings
from app.core.request_rate_limiter import request_rate_limiter


logger = logging.getLogger("alpha_radar.provider_gateway")
T = TypeVar("T")


class ProviderBusyError(RuntimeError):
    """The upstream budget is exhausted; callers should serve last-good data."""


def is_retryable_provider_error(exc: Exception) -> bool:
    if isinstance(exc, HTTPException):
        return exc.status_code == 429 or exc.status_code >= 500
    text = str(exc).lower()
    return "timeout" in text or "temporarily unavailable" in text or "connection" in text


class ProviderGateway:
    def __init__(self) -> None:
        self._semaphores = {
            "arrow": asyncio.Semaphore(max(1, settings.ARROW_PROVIDER_CONCURRENCY)),
            "kite": asyncio.Semaphore(max(1, settings.KITE_PROVIDER_CONCURRENCY)),
        }
        self._pacing_locks = {"arrow": asyncio.Lock(), "kite": asyncio.Lock()}
        self._next_allowed_at: dict[str, float] = defaultdict(float)
        self._metrics: dict[str, int] = defaultdict(int)

    async def run(self, provider: str, operation: Callable[[], Awaitable[T]]) -> T:
        provider_key = provider.lower()
        semaphore = self._semaphores.get(provider_key, self._semaphores["kite"])
        limit = settings.ARROW_PROVIDER_REQUESTS_PER_MINUTE if provider_key == "arrow" else settings.KITE_PROVIDER_REQUESTS_PER_MINUTE

        async with semaphore:
            last_error: Exception | None = None
            for attempt in range(settings.PROVIDER_MAX_RETRIES + 1):
                await self._reserve_provider_request(provider_key, limit)
                try:
                    return await operation()
                except Exception as exc:
                    last_error = exc
                    if attempt >= settings.PROVIDER_MAX_RETRIES or not is_retryable_provider_error(exc):
                        self._metrics[f"{provider_key}.failures"] += 1
                        raise
                    self._metrics[f"{provider_key}.retries"] += 1
                    delay = settings.PROVIDER_RETRY_BASE_SECONDS * (2**attempt) + random.uniform(0, 0.15)
                    logger.warning(
                        "%s provider attempt %d/%d failed (%s); retrying in %.2fs",
                        provider_key,
                        attempt + 1,
                        settings.PROVIDER_MAX_RETRIES + 1,
                        exc,
                        delay,
                    )
                    await asyncio.sleep(delay)
            assert last_error is not None
            raise last_error

    async def _reserve_provider_request(self, provider: str, limit: int) -> None:
        """Reserve one real upstream attempt before it is sent.

        Retries count too: otherwise a burst of 429 retries can quietly exceed
        the very provider budget intended to protect the account.
        """
        budget = await request_rate_limiter.allow(
            identity=f"provider:{provider}",
            bucket="upstream",
            limit=limit,
            window_seconds=60,
        )
        if not budget.allowed:
            self._metrics[f"{provider}.budget_exhausted"] += 1
            raise ProviderBusyError(f"{provider} budget exhausted; retry in {budget.retry_after}s")

        interval = (
            settings.ARROW_PROVIDER_MIN_INTERVAL_SECONDS
            if provider == "arrow"
            else settings.KITE_PROVIDER_MIN_INTERVAL_SECONDS
        )
        lock = self._pacing_locks.get(provider, self._pacing_locks["kite"])
        async with lock:
            now = asyncio.get_running_loop().time()
            wait_seconds = max(0.0, self._next_allowed_at[provider] - now)
            if wait_seconds:
                self._metrics[f"{provider}.paced_waits"] += 1
                await asyncio.sleep(wait_seconds)
            self._next_allowed_at[provider] = asyncio.get_running_loop().time() + max(0.0, interval)
        self._metrics[f"{provider}.requests"] += 1

    def metrics(self) -> dict[str, int]:
        return dict(self._metrics)


provider_gateway = ProviderGateway()
