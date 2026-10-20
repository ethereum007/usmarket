"""Small Redis-first shared state store with a safe single-process fallback.

The production deployment uses a local Redis process on the same EC2 instance.
The in-memory fallback keeps local development and a temporary Redis outage from
turning market-data protection into an application outage. It is intentionally
not a scaling substitute: ``available`` exposes whether Redis is active.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from app.config import settings

try:  # Keep test/dev imports usable before Redis is installed.
    from redis.asyncio import Redis, from_url
except ImportError:  # pragma: no cover - exercised in bare local environments
    Redis = Any  # type: ignore[misc,assignment]
    from_url = None


logger = logging.getLogger("alpha_radar.shared_store")

_INCREMENT_WINDOW_SCRIPT = """
local count = redis.call('INCR', KEYS[1])
local remaining = redis.call('TTL', KEYS[1])
if count == 1 or remaining < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  remaining = redis.call('TTL', KEYS[1])
end
return {count, remaining}
"""

_DELETE_IF_VALUE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


class SharedStore:
    """JSON, locks, and counters backed by local Redis when available."""

    def __init__(self) -> None:
        self._client: Redis | None = None
        self._fallback: dict[str, tuple[str, float | None]] = {}
        self._lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._last_connect_attempt = 0.0
        self._warned_unconfigured = False

    @property
    def available(self) -> bool:
        return self._client is not None

    async def connect(self, *, force: bool = False) -> None:
        """Best-effort Redis connection with bounded retry after an outage.

        Redis is intentionally optional during local development, but a process
        that starts while Redis is restarting must recover without a PM2 restart.
        """
        if self._client is not None:
            return
        if not settings.REDIS_URL or from_url is None:
            if not self._warned_unconfigured:
                logger.warning("Redis is unavailable; using single-process fallback state")
                self._warned_unconfigured = True
            return

        now = time.monotonic()
        if not force and now - self._last_connect_attempt < settings.REDIS_RECONNECT_SECONDS:
            return

        async with self._connect_lock:
            if self._client is not None:
                return
            now = time.monotonic()
            if not force and now - self._last_connect_attempt < settings.REDIS_RECONNECT_SECONDS:
                return
            self._last_connect_attempt = now
            client: Redis | None = None
            try:
                client = from_url(
                    settings.REDIS_URL,
                    encoding="utf-8",
                    decode_responses=True,
                    socket_connect_timeout=settings.REDIS_CONNECT_TIMEOUT_SECONDS,
                    socket_timeout=settings.REDIS_CONNECT_TIMEOUT_SECONDS,
                )
                await client.ping()
                self._client = client
                logger.info("Connected to local Redis for shared market state")
            except Exception as exc:
                if client is not None:
                    try:
                        await client.aclose()
                    except Exception:
                        pass
                logger.warning("Redis unavailable (%s); using single-process fallback state", exc)

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:
                logger.debug("Redis close failed", exc_info=True)
        self._client = None

    async def _drop_failed_client(self) -> None:
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                logger.debug("Redis cleanup after a failed operation failed", exc_info=True)

    async def get_text(self, key: str) -> str | None:
        await self.connect()
        if self._client is not None:
            try:
                return await self._client.get(key)
            except Exception:
                logger.warning("Redis read failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            self._purge_expired_locked()
            value = self._fallback.get(key)
            return value[0] if value else None

    async def set_text(self, key: str, value: str, *, ttl_seconds: int | None = None) -> None:
        await self.connect()
        if self._client is not None:
            try:
                await self._client.set(key, value, ex=ttl_seconds)
                return
            except Exception:
                logger.warning("Redis write failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            expires_at = time.time() + ttl_seconds if ttl_seconds else None
            self._fallback[key] = (value, expires_at)

    async def set_if_absent(self, key: str, value: str, *, ttl_seconds: int) -> bool:
        await self.connect()
        if self._client is not None:
            try:
                return bool(await self._client.set(key, value, ex=ttl_seconds, nx=True))
            except Exception:
                logger.warning("Redis lock write failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            self._purge_expired_locked()
            if key in self._fallback:
                return False
            self._fallback[key] = (value, time.time() + ttl_seconds)
            return True

    async def delete(self, key: str) -> None:
        await self.connect()
        if self._client is not None:
            try:
                await self._client.delete(key)
                return
            except Exception:
                logger.warning("Redis delete failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            self._fallback.pop(key, None)

    async def delete_if_value(self, key: str, value: str) -> bool:
        """Release a lease only while it still belongs to this worker."""
        await self.connect()
        if self._client is not None:
            try:
                return bool(await self._client.eval(_DELETE_IF_VALUE_SCRIPT, 1, key, value))
            except Exception:
                logger.warning("Redis conditional delete failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            self._purge_expired_locked()
            current = self._fallback.get(key)
            if current is None or current[0] != value:
                return False
            self._fallback.pop(key, None)
            return True

    async def ttl(self, key: str) -> int | None:
        await self.connect()
        if self._client is not None:
            try:
                value = await self._client.ttl(key)
                return int(value) if value >= 0 else None
            except Exception:
                logger.warning("Redis TTL read failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            self._purge_expired_locked()
            value = self._fallback.get(key)
            if not value or value[1] is None:
                return None
            return max(0, int(value[1] - time.time()))

    async def increment_window(self, key: str, *, ttl_seconds: int) -> tuple[int, int]:
        """Increment a fixed-window counter and return ``(count, seconds_left)``."""
        await self.connect()
        if self._client is not None:
            try:
                count, remaining = await self._client.eval(
                    _INCREMENT_WINDOW_SCRIPT, 1, key, ttl_seconds
                )
                return int(count), max(1, int(remaining))
            except Exception:
                logger.warning("Redis counter failed; using fallback state", exc_info=True)
                await self._drop_failed_client()
        async with self._lock:
            self._purge_expired_locked()
            raw, expires_at = self._fallback.get(key, ("0", None))
            count = int(raw) + 1
            expiry = expires_at or (time.time() + ttl_seconds)
            self._fallback[key] = (str(count), expiry)
            return count, max(1, int(expiry - time.time()))

    async def get_json(self, key: str) -> dict[str, Any] | None:
        raw = await self.get_text(key)
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring invalid JSON in shared store key %s", key)
            return None
        return data if isinstance(data, dict) else None

    async def set_json(self, key: str, value: dict[str, Any], *, ttl_seconds: int | None = None) -> None:
        await self.set_text(key, json.dumps(value, default=str, separators=(",", ":")), ttl_seconds=ttl_seconds)

    def _purge_expired_locked(self) -> None:
        now = time.time()
        for key, (_, expires_at) in list(self._fallback.items()):
            if expires_at is not None and expires_at <= now:
                self._fallback.pop(key, None)


shared_store = SharedStore()
