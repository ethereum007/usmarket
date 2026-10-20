"""Batched, failure-tolerant persistence for Runner features and diagnostics."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Iterable
from typing import Any

from app.config import settings
from app.core.supabase_client import get_supabase_client
from app.engines.runner.schemas import BaselineStat, RunnerFeatureSnapshot

logger = logging.getLogger("alpha_radar.runner.store")


def _row(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=False)


class RunnerFeatureStore:
    """Uses bulk upserts; failures queue one bounded retry batch and never stop live state."""

    def __init__(
        self,
        client_factory=get_supabase_client,
        max_retry_rows: int = 10_000,
        feature_batch_size: int = 100,
    ) -> None:
        self._client_factory = client_factory
        self._retry: deque[dict[str, Any]] = deque(maxlen=max_retry_rows)
        self._feature_batch_size = max(1, feature_batch_size)
        self.rows_persisted = 0
        self.persistence_failures = 0
        self.retry_rows_dropped = 0

    async def upsert_features(self, snapshots: Iterable[RunnerFeatureSnapshot]) -> int:
        rows = [*_drain(self._retry), *(_row(snapshot) for snapshot in snapshots)]
        if not rows:
            return 0
        persisted = 0
        for idx in range(0, len(rows), self._feature_batch_size):
            batch = rows[idx : idx + self._feature_batch_size]
            try:
                await asyncio.to_thread(
                    lambda b=batch: (
                        self._client_factory()
                        .table("runner_minute_features")
                        .upsert(
                            b,
                            on_conflict="session_date,symbol,minute_timestamp,feature_version",
                        )
                        .execute()
                    )
                )
                persisted += len(batch)
            except Exception:
                self.persistence_failures += 1
                pending = rows[idx:]
                capacity = self._retry.maxlen or len(pending)
                self.retry_rows_dropped += max(0, len(pending) - capacity)
                self._retry.extend(pending)
                logger.exception(
                    "Runner feature batch persistence failed; persisted=%d queued=%d "
                    "dropped_total=%d",
                    persisted,
                    len(self._retry),
                    self.retry_rows_dropped,
                )
                break
        self.rows_persisted += persisted
        return persisted

    async def upsert_baselines(
        self, stats: Iterable[BaselineStat], batch_size: int = 1000
    ) -> int:
        rows = [_row(stat) for stat in stats]
        persisted = 0
        for idx in range(0, len(rows), batch_size):
            batch = rows[idx : idx + batch_size]
            await asyncio.to_thread(
                lambda b=batch: (
                    self._client_factory()
                    .table("runner_baseline_stats")
                    .upsert(
                        b,
                        on_conflict="symbol,minute_of_session,lookback_sessions,metric,baseline_version",
                    )
                    .execute()
                )
            )
            persisted += len(batch)
        return persisted

    async def record_quality_events(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0
        try:
            await asyncio.to_thread(
                lambda: (
                    self._client_factory()
                    .table("runner_data_quality_events")
                    .insert(rows)
                    .execute()
                )
            )
            return len(rows)
        except Exception:
            logger.exception("Runner quality-event persistence failed")
            return 0

    async def record_run(self, row: dict[str, Any]) -> bool:
        try:
            await asyncio.to_thread(
                lambda: (
                    self._client_factory()
                    .table("runner_engine_runs")
                    .upsert(row, on_conflict="run_id")
                    .execute()
                )
            )
            return True
        except Exception:
            logger.exception("Runner engine-run persistence failed")
            return False

    async def get_interrupted_baseline_run(self) -> dict[str, Any] | None:
        """Return the newest checkpoint left RUNNING by an interrupted process."""
        try:
            response = await asyncio.to_thread(
                lambda: (
                    self._client_factory()
                    .table("runner_engine_runs")
                    .select("*")
                    .eq("run_type", "BASELINE_REBUILD")
                    .eq("status", "RUNNING")
                    .order("started_at", desc=True)
                    .limit(1)
                    .execute()
                )
            )
            rows = response.data or []
            return rows[0] if rows else None
        except Exception:
            logger.warning(
                "Runner interrupted-run lookup unavailable", exc_info=True
            )
            return None

    async def get_baseline_diagnostics(
        self, symbol: str, minute: int
    ) -> list[BaselineStat] | None:
        """Read one bounded symbol/minute baseline slice for admin diagnostics."""
        try:
            response = await asyncio.to_thread(
                lambda: (
                    self._client_factory()
                    .table("runner_baseline_stats")
                    .select("*")
                    .eq("symbol", symbol.upper())
                    .eq("minute_of_session", minute)
                    .eq("baseline_version", settings.RUNNER_BASELINE_VERSION)
                    .order("lookback_sessions")
                    .order("metric")
                    .limit(100)
                    .execute()
                )
            )
            return [BaselineStat.model_validate(row) for row in response.data or []]
        except Exception:
            logger.warning(
                "Runner baseline diagnostic lookup failed symbol=%s minute=%d",
                symbol,
                minute,
                exc_info=True,
            )
            return None

    @property
    def retry_rows(self) -> int:
        return len(self._retry)


def _drain(queue: deque[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = list(queue)
    queue.clear()
    return rows
