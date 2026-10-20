"""Shared, server-side snapshots for high-traffic market feeds.

Browser requests read these snapshots only. Refreshes happen in one bounded
background worker on the existing API process, which keeps a growing audience
from multiplying Arrow/Kite calls.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.config import settings
from app.core.session_cache import is_market_hours, load_session, save_session
from app.core.shared_store import shared_store
from app.services.provider_gateway import ProviderBusyError, provider_gateway


logger = logging.getLogger("alpha_radar.market_snapshots")


@dataclass(frozen=True)
class SnapshotTarget:
    name: str
    interval_seconds: int
    body: dict[str, Any]


class MarketSnapshotService:
    _ACTIVE_KEY = "alpha:market:paid-active"

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._task_lock = asyncio.Lock()
        self._metrics: dict[str, int] = defaultdict(int)

    async def start(self) -> None:
        await shared_store.connect()

    async def stop(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        self._tasks.clear()
        await shared_store.close()

    async def mark_paid_activity(self, user_id: str) -> None:
        """Keep refreshes alive only while an authenticated premium user is active."""
        clean_id = str(user_id or "").strip()
        if not clean_id:
            return
        await shared_store.set_text(
            self._ACTIVE_KEY,
            clean_id,
            ttl_seconds=settings.MARKET_ACTIVE_TTL_SECONDS,
        )

    async def has_paid_activity(self) -> bool:
        return bool(await shared_store.get_text(self._ACTIVE_KEY))

    async def read_intraday(self, body: dict[str, Any]) -> dict[str, Any] | None:
        signature = self.intraday_signature(body)
        record = await shared_store.get_json(self._snapshot_key(signature))
        if record is None:
            record = self._load_disk_record(signature)
        if record is None:
            self._metrics["cache_misses"] += 1
            return None
        response = self._decorate(record)
        self._metrics["cache_hits"] += 1
        if response.get("isStale"):
            self._metrics["stale_served"] += 1
        return response

    async def queue_intraday(self, body: dict[str, Any], *, interval_seconds: int | None = None) -> bool:
        signature = self.intraday_signature(body)
        interval = interval_seconds or self._interval_for_body(body)
        async with self._task_lock:
            existing = self._tasks.get(signature)
            if existing and not existing.done():
                self._metrics["refresh_deduplicated"] += 1
                return False
            lease_token = secrets.token_hex(16)
            acquired = await shared_store.set_if_absent(
                self._refresh_lock_key(signature),
                lease_token,
                ttl_seconds=max(interval * 2, 90),
            )
            if not acquired:
                self._metrics["refresh_deduplicated"] += 1
                return False
            task = asyncio.create_task(self._refresh_intraday(signature, body, interval, lease_token))
            self._tasks[signature] = task
            self._metrics["refresh_queued"] += 1
            task.add_done_callback(lambda _: self._tasks.pop(signature, None))
            return True

    async def request_manual_rescan(self, *, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        signature = self.intraday_signature(body)
        cooldown_key = f"alpha:market:rescan:{user_id}:{signature}"
        allowed = await shared_store.set_if_absent(
            cooldown_key,
            "1",
            ttl_seconds=settings.MARKET_MANUAL_RESCAN_COOLDOWN_SECONDS,
        )
        if not allowed:
            retry_after = await shared_store.ttl(cooldown_key) or settings.MARKET_MANUAL_RESCAN_COOLDOWN_SECONDS
            return {
                "success": True,
                "accepted": False,
                "refreshQueued": False,
                "retryAfterSeconds": retry_after,
                "message": f"A shared refresh is already available shortly. Try again in {retry_after}s.",
            }

        await self.mark_paid_activity(user_id)
        queued = await self.queue_intraday(body)
        return {
            "success": True,
            "accepted": True,
            "refreshQueued": queued,
            "retryAfterSeconds": settings.MARKET_MANUAL_RESCAN_COOLDOWN_SECONDS,
            "message": (
                "Shared market refresh queued. Your screen will update from the last good snapshot."
                if queued
                else "A shared market refresh is already in progress. Your screen will update from the last good snapshot."
            ),
        }

    async def refresh_due_snapshots(self) -> dict[str, Any]:
        """Run every few seconds; only queues feeds whose 30/60s slot is due."""
        if not is_market_hours() or not await self.has_paid_activity():
            return {"active": False, "queued": []}

        queued: list[str] = []
        for target in self._scheduled_targets():
            cached = await self.read_intraday(target.body)
            age = self._snapshot_age_seconds(cached)
            if cached is None or age is None or age >= target.interval_seconds:
                if await self.queue_intraday(target.body, interval_seconds=target.interval_seconds):
                    queued.append(target.name)
        return {"active": True, "queued": queued}

    async def status(self) -> dict[str, Any]:
        active = await self.has_paid_activity()
        rows = []
        for target in self._scheduled_targets():
            cached = await self.read_intraday(target.body)
            rows.append({
                "name": target.name,
                "intervalSeconds": target.interval_seconds,
                "available": cached is not None,
                "ageSeconds": self._snapshot_age_seconds(cached),
                "nextRefreshAt": cached.get("nextRefreshAt") if cached else None,
                "isStale": bool(cached.get("isStale")) if cached else True,
            })
        return {
            "success": True,
            "paidAudienceActive": active,
            "redisConnected": shared_store.available,
            "metrics": {
                **dict(self._metrics),
                "cacheHitRate": self._cache_hit_rate(),
                "provider": provider_gateway.metrics(),
            },
            "snapshots": rows,
        }

    async def _refresh_intraday(
        self, signature: str, body: dict[str, Any], interval_seconds: int, lease_token: str
    ) -> None:
        try:
            from app.core.kite_client import kite_state
            from app.routes.intraday import build_live_intraday_radar

            async def build() -> dict[str, Any]:
                return await build_live_intraday_radar(
                    body, kite_state.kite if kite_state.is_connected else None
                )

            if str(body.get("quoteProvider") or "arrow_first").lower() == "kite":
                if not kite_state.is_connected:
                    raise ProviderBusyError("Kite is not connected")
                data = await provider_gateway.run("kite", build)
            else:
                # Arrow requests are counted at each HTTP call by the Arrow
                # client. A Kite session is optional for Arrow-first scans.
                data = await build()
            generated_at = time.time()
            record = {
                "data": data,
                "generatedAt": datetime.fromtimestamp(generated_at, tz=settings.TIMEZONE).isoformat(),
                "generatedAtEpoch": generated_at,
                "intervalSeconds": interval_seconds,
            }
            await shared_store.set_json(
                self._snapshot_key(signature),
                record,
                ttl_seconds=settings.MARKET_SNAPSHOT_RETENTION_SECONDS,
            )
            save_session(self._session_key(signature), record)
            # Preserve the existing replay endpoint for customers and recovery.
            if data.get("candidates"):
                save_session("intraday_radar", data)
                target_name = next(
                    (target.name for target in self._scheduled_targets() if self.intraday_signature(target.body) == signature),
                    None,
                )
                if target_name:
                    save_session(f"intraday_radar_{target_name.replace('-', '_')}", data)
            logger.info(
                "Shared market snapshot refreshed: %s (%d candidates, %ss)",
                signature,
                len(data.get("candidates") or []),
                interval_seconds,
            )
            self._metrics["refresh_success"] += 1
        except ProviderBusyError as exc:
            self._metrics["refresh_deferred"] += 1
            logger.info("Shared market refresh deferred: %s", exc)
        except Exception:
            self._metrics["refresh_failures"] += 1
            logger.exception("Shared market refresh failed for %s", signature)
        finally:
            await shared_store.delete_if_value(self._refresh_lock_key(signature), lease_token)

    def intraday_signature(self, body: dict[str, Any]) -> str:
        normalized = {
            "symbols": sorted({str(symbol).strip().upper() for symbol in body.get("symbols", []) if str(symbol).strip()}),
            "minTradedValueLakh": float(body.get("minTradedValueLakh") or 0),
            "quoteProvider": str(body.get("quoteProvider") or "arrow_first").lower(),
        }
        raw = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]

    def _scheduled_targets(self) -> tuple[SnapshotTarget, ...]:
        from app.caches.stock_universes import resolve_universe

        return (
            SnapshotTarget(
                name="core-nifty100",
                interval_seconds=settings.MARKET_CORE_REFRESH_SECONDS,
                body={
                    "symbols": resolve_universe("nifty100"),
                    "minTradedValueLakh": 0,
                    "useCache": True,
                    "quoteProvider": "arrow_first",
                },
            ),
            SnapshotTarget(
                name="broad-nifty500",
                interval_seconds=settings.MARKET_BROAD_REFRESH_SECONDS,
                body={
                    "symbols": resolve_universe("nifty500"),
                    "minTradedValueLakh": 0,
                    "useCache": True,
                    "quoteProvider": "arrow_first",
                },
            ),
        )

    def _decorate(self, record: dict[str, Any]) -> dict[str, Any]:
        data = copy.deepcopy(record.get("data") or {})
        generated_at = float(record.get("generatedAtEpoch") or 0)
        interval = int(record.get("intervalSeconds") or settings.MARKET_BROAD_REFRESH_SECONDS)
        age = max(0, round(time.time() - generated_at)) if generated_at else None
        is_stale = age is None or age > interval * 2
        data.update({
            "cached": True,
            "generatedAt": record.get("generatedAt"),
            "nextRefreshAt": datetime.fromtimestamp(generated_at + interval, tz=settings.TIMEZONE).isoformat() if generated_at else None,
            "freshness": {
                "status": "stale" if is_stale else "fresh",
                "ageSeconds": age,
                "source": "shared_snapshot",
            },
            "isStale": is_stale,
            "refreshIntervalSeconds": interval,
        })
        if generated_at:
            data["timestamp"] = int(generated_at * 1000)
        return data

    def _load_disk_record(self, signature: str) -> dict[str, Any] | None:
        persisted = load_session(self._session_key(signature))
        if not persisted:
            return None
        record = persisted.get("data")
        return record if isinstance(record, dict) and isinstance(record.get("data"), dict) else None

    def _interval_for_body(self, body: dict[str, Any]) -> int:
        symbols = body.get("symbols") or []
        return settings.MARKET_CORE_REFRESH_SECONDS if len(symbols) <= 100 else settings.MARKET_BROAD_REFRESH_SECONDS

    @staticmethod
    def _snapshot_age_seconds(cached: dict[str, Any] | None) -> int | None:
        if not cached:
            return None
        freshness = cached.get("freshness") or {}
        value = freshness.get("ageSeconds")
        return int(value) if isinstance(value, (int, float)) else None

    def _cache_hit_rate(self) -> float:
        hits = self._metrics["cache_hits"]
        misses = self._metrics["cache_misses"]
        total = hits + misses
        return round(hits / total, 4) if total else 0.0

    @staticmethod
    def _snapshot_key(signature: str) -> str:
        return f"alpha:market:snapshot:{signature}"

    @staticmethod
    def _refresh_lock_key(signature: str) -> str:
        return f"alpha:market:refresh-lock:{signature}"

    @staticmethod
    def _session_key(signature: str) -> str:
        return f"market_intraday_{signature}"


market_snapshot_service = MarketSnapshotService()
