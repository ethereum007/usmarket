"""Idempotent, restart-safe Runner time-of-day baseline rebuild orchestration."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from app.config import settings
from app.engines.runner.baselines import baseline_repository, build_symbol_baselines
from app.engines.runner.constants import SESSION_MINUTES
from app.engines.runner.schemas import BaselineStat, MinuteBar
from app.services.runner_feature_store import RunnerFeatureStore

logger = logging.getLogger("alpha_radar.runner.baselines")
IST = ZoneInfo("Asia/Kolkata")

# Keep every PostgREST response comfortably below the project's default
# 1,000-row API cap.  The live feature path only consumes these metrics; the
# remaining baseline metrics stay available for diagnostics and rebuilds.
_BASELINE_QUERY_ROW_LIMIT = 900
_BASELINE_SYMBOL_CHUNK_LIMIT = 250
_CURRENT_SHORT_METRICS = (
    "cumulative_volume",
    "volume_1m",
    "volume_3m",
    "volume_5m",
    "volume_10m",
    "volume_15m",
    "cumulative_turnover",
    "intraday_range",
    "ret_1m",
    "ret_5m",
    "ret_15m",
)
_BASELINE_COLUMNS = (
    "symbol,minute_of_session,lookback_sessions,metric,median,mean,std,"
    "percentiles,as_of_date,baseline_version,sample_count"
)


class RunnerBaselineService:
    def __init__(
        self,
        provider: Any,
        store: RunnerFeatureStore,
        *,
        request_delay_seconds: float = 0.35,
    ) -> None:
        self.provider = provider
        self.store = store
        self.request_delay_seconds = request_delay_seconds
        self.running = False
        self.progress: dict[str, Any] = {}
        self._loaded_minutes: set[int] = set()
        self._load_retry_after: dict[int, float] = {}
        self._load_session_date: date | None = None

    async def load_latest(self, universe: list[str]) -> int:
        """Warm only the current minute slice; later slices are loaded on demand."""
        from app.engines.runner.baselines import minute_of_session

        return await self.load_minute(minute_of_session(datetime.now(IST)), universe)

    async def load_minute(self, minute: int, universe: list[str]) -> int:
        """Load a scalable exact-minute slice (rather than millions of baseline rows)."""
        today = datetime.now(IST).date()
        if self._load_session_date != today:
            self._loaded_minutes.clear()
            self._load_retry_after.clear()
            self._load_session_date = today
        if minute < 0 or minute > 375:
            return 0
        # Acceleration compares current 5m RVOL with the same-time baseline
        # five minutes earlier. Warm that exact prior slice after a restart.
        required = sorted({max(0, minute - 5), minute})
        loaded = 0
        for target_minute in required:
            if target_minute in self._loaded_minutes or monotonic() < (
                self._load_retry_after.get(target_minute, 0.0)
            ):
                continue
            loaded += await self._load_exact_minute(
                target_minute,
                universe,
                prior_only=target_minute != minute,
            )
        return loaded

    async def _load_exact_minute(
        self,
        minute: int,
        universe: list[str],
        *,
        prior_only: bool = False,
    ) -> int:
        try:
            client = self.store._client_factory()
            rows: list[dict[str, Any]] = []
            symbols = list(
                dict.fromkeys(
                    str(symbol).strip().upper()
                    for symbol in universe
                    if str(symbol).strip()
                )
            )

            query_slices = [
                (
                    settings.RUNNER_BASELINE_SHORT_SESSIONS,
                    ("volume_5m",),
                )
            ]
            if not prior_only:
                query_slices = [
                    (
                        settings.RUNNER_BASELINE_SHORT_SESSIONS,
                        _CURRENT_SHORT_METRICS,
                    ),
                    (
                        settings.RUNNER_BASELINE_LONG_SESSIONS,
                        ("cumulative_volume",),
                    ),
                ]

            for lookback, metrics in query_slices:
                chunk_size = min(
                    _BASELINE_SYMBOL_CHUNK_LIMIT,
                    max(1, _BASELINE_QUERY_ROW_LIMIT // len(metrics)),
                )
                for start in range(0, len(symbols), chunk_size):
                    symbol_chunk = symbols[start : start + chunk_size]
                    response = await asyncio.to_thread(
                        lambda chunk=symbol_chunk, lbs=lookback, names=metrics: (
                            client.table("runner_baseline_stats")
                            .select(_BASELINE_COLUMNS)
                            .in_("symbol", chunk)
                            .eq("minute_of_session", minute)
                            .eq("baseline_version", settings.RUNNER_BASELINE_VERSION)
                            .eq("lookback_sessions", lbs)
                            .in_("metric", list(names))
                            .limit(_BASELINE_QUERY_ROW_LIMIT)
                            .execute()
                        )
                    )
                    rows.extend(response.data or [])
            latest: dict[tuple[str, int, int, str, str], BaselineStat] = {}
            for row in rows:
                stat = BaselineStat.model_validate(row)
                key = (
                    stat.symbol,
                    stat.minute_of_session,
                    stat.lookback_sessions,
                    stat.metric,
                    stat.baseline_version,
                )
                latest.setdefault(key, stat)
            baseline_repository.replace_minute(minute, latest.values())
            self._loaded_minutes = {
                loaded
                for loaded in self._loaded_minutes
                if max(0, minute - 5) <= loaded <= minute
            }
            self._loaded_minutes.add(minute)
            self._load_retry_after.pop(minute, None)
            return len(latest)
        except Exception:
            self._load_retry_after[minute] = (
                monotonic() + settings.RUNNER_BASELINE_LOAD_RETRY_SECONDS
            )
            logger.warning(
                "Runner baseline minute=%d warm skipped; persistence unavailable",
                minute,
                exc_info=True,
            )
            return 0

    async def rebuild(
        self,
        symbols: list[str],
        *,
        as_of_date: date | None = None,
        lookbacks: tuple[int, ...] | None = None,
        _run_id: str | None = None,
        _started_at: str | None = None,
        _resume_index: int = 0,
        _initial_failed: int = 0,
        _initial_rows: int = 0,
        _initial_failed_symbols: list[str] | None = None,
    ) -> dict[str, Any]:
        if self.running:
            return {
                "accepted": False,
                "reason": "baseline rebuild already running",
                **self.progress,
            }
        self.running = True
        run_id = _run_id or str(uuid.uuid4())
        started_at = _started_at or datetime.now(IST).isoformat()
        cutoff = as_of_date or datetime.now(IST).date()
        lookbacks = lookbacks or (
            settings.RUNNER_BASELINE_SHORT_SESSIONS,
            settings.RUNNER_BASELINE_LONG_SESSIONS,
        )
        self.progress = {
            "runId": run_id,
            "total": len(symbols),
            "completed": _resume_index,
            "failed": _initial_failed,
            "failedSymbols": list(_initial_failed_symbols or []),
            "asOfDate": cutoff.isoformat(),
            "lookbacks": list(lookbacks),
            "baselineVersion": settings.RUNNER_BASELINE_VERSION,
            "resumed": _resume_index > 0,
            "persistenceFailures": 0,
        }
        await self.store.record_run(
            {
                "run_id": run_id,
                "run_type": "BASELINE_REBUILD",
                "status": "RUNNING",
                "universe": settings.RUNNER_UNIVERSE,
                "started_at": started_at,
                "symbols_processed": _resume_index,
                "symbols_failed": _initial_failed,
                "rows_persisted": _initial_rows,
                "metadata": {**self.progress, "requestedSymbols": symbols},
            }
        )
        # A Nifty 500 rebuild can produce millions of stats. Keep only the
        # persisted count here; the repository already owns the current slice.
        stats_built = _initial_rows
        stats_persisted = _initial_rows
        from app.engines.runner.baselines import minute_of_session
        try:
            calendar_days = max(lookbacks) * 2 + 10
            from_dt = datetime.combine(
                cutoff - timedelta(days=calendar_days), time(9, 15), IST
            )
            # End at the prior date close: today's incomplete session can never enter.
            to_dt = datetime.combine(cutoff - timedelta(days=1), time(15, 30), IST)
            for index, symbol in enumerate(
                symbols[_resume_index:], _resume_index + 1
            ):
                try:
                    raw = await self.provider.get_history(
                        symbol, from_dt, to_dt, "minute"
                    )
                    # History normalization and baseline aggregation are CPU-heavy
                    # for a full 60-session minute series. Keep them away from the
                    # FastAPI event loop so status/feature requests stay responsive
                    # while a broad-universe rebuild is running.
                    sessions = await asyncio.to_thread(
                        _history_to_bars, symbol, raw, cutoff
                    )
                    stats = await asyncio.to_thread(
                        build_symbol_baselines,
                        symbol,
                        sessions,
                        as_of_date=cutoff,
                        lookbacks=lookbacks,
                        baseline_version=settings.RUNNER_BASELINE_VERSION,
                    )
                    if stats:
                        stats_built += len(stats)
                        # Live calculations must continue when Supabase is down.
                        # Populate the current and acceleration-prior slices before
                        # attempting durable storage, and advance the slice as a
                        # long broad-universe rebuild crosses minute boundaries.
                        hot_minute = minute_of_session(datetime.now(IST))
                        if 0 <= hot_minute <= 375:
                            required_minutes = {hot_minute, max(0, hot_minute - 5)}
                            baseline_repository.replace_minute(
                                hot_minute,
                                (
                                    stat
                                    for stat in stats
                                    if stat.minute_of_session in required_minutes
                                ),
                            )
                        try:
                            stats_persisted += await self.store.upsert_baselines(stats)
                        except Exception as persistence_error:
                            self.progress["persistenceFailures"] += 1
                            if self.progress["persistenceFailures"] == 1 or index % 25 == 0:
                                logger.warning(
                                    "Runner baseline persistence unavailable; live hot cache remains active "
                                    "failures=%d error_type=%s",
                                    self.progress["persistenceFailures"],
                                    type(persistence_error).__name__,
                                )
                except Exception:
                    self.progress["failed"] += 1
                    self.progress["failedSymbols"].append(symbol)
                    logger.exception("Runner baseline rebuild failed for %s", symbol)
                self.progress["completed"] = index
                if index % 25 == 0 or index == len(symbols):
                    logger.info(
                        "Runner baseline progress completed=%d total=%d failed=%d",
                        index,
                        len(symbols),
                        self.progress["failed"],
                    )
                    self.progress["statsBuilt"] = stats_built
                    self.progress["statsPersisted"] = stats_persisted
                    await self.store.record_run(
                        {
                            "run_id": run_id,
                            "run_type": "BASELINE_REBUILD",
                            "status": "RUNNING",
                            "universe": settings.RUNNER_UNIVERSE,
                            "started_at": started_at,
                            "symbols_processed": index,
                            "symbols_failed": self.progress["failed"],
                            "rows_persisted": stats_persisted,
                            "metadata": {
                                **self.progress,
                                "requestedSymbols": symbols,
                            },
                        }
                    )
                if self.request_delay_seconds:
                    await asyncio.sleep(self.request_delay_seconds)
            self.progress["statsBuilt"] = stats_built
            self.progress["statsPersisted"] = stats_persisted
            await self.store.record_run(
                {
                    "run_id": run_id,
                    "run_type": "BASELINE_REBUILD",
                    "status": (
                        "COMPLETED_WITH_ERRORS"
                        if self.progress["failed"]
                        or self.progress["persistenceFailures"]
                        else "COMPLETED"
                    ),
                    "universe": settings.RUNNER_UNIVERSE,
                    "started_at": started_at,
                    "completed_at": datetime.now(IST).isoformat(),
                    "symbols_processed": self.progress["completed"],
                    "symbols_failed": self.progress["failed"],
                    "rows_persisted": stats_persisted,
                    "metadata": {**self.progress, "requestedSymbols": symbols},
                }
            )
            return {"accepted": True, **self.progress}
        finally:
            self.running = False

    async def resume_interrupted(self) -> dict[str, Any] | None:
        """Resume the latest durable checkpoint, repeating at most one batch."""
        row = await self.store.get_interrupted_baseline_run()
        if not row:
            return None
        metadata = row.get("metadata") or {}
        symbols = metadata.get("requestedSymbols")
        lookbacks = metadata.get("lookbacks")
        cutoff = metadata.get("asOfDate")
        resumable = (
            isinstance(symbols, list)
            and bool(symbols)
            and bool(cutoff)
            and metadata.get("baselineVersion") == settings.RUNNER_BASELINE_VERSION
            and bool(row.get("run_id"))
            and bool(row.get("started_at"))
        )
        if not resumable:
            logger.warning(
                "Runner baseline run=%s cannot resume: checkpoint metadata incomplete",
                row.get("run_id"),
            )
            if row.get("run_id") and row.get("started_at"):
                await self.store.record_run(
                    {
                        "run_id": row["run_id"],
                        "run_type": "BASELINE_REBUILD",
                        "status": "INTERRUPTED_UNRESUMABLE",
                        "universe": row.get("universe"),
                        "started_at": row["started_at"],
                        "completed_at": datetime.now(IST).isoformat(),
                        "metadata": metadata,
                    }
                )
            return None
        try:
            completed = max(
                0, min(int(row.get("symbols_processed") or 0), len(symbols))
            )
        except (TypeError, ValueError):
            logger.warning(
                "Runner baseline run=%s has an invalid checkpoint index",
                row.get("run_id"),
            )
            return None
        if completed >= len(symbols):
            failed = int(row.get("symbols_failed") or 0)
            await self.store.record_run(
                {
                    "run_id": row["run_id"],
                    "run_type": "BASELINE_REBUILD",
                    "status": "COMPLETED_WITH_ERRORS" if failed else "COMPLETED",
                    "universe": row.get("universe"),
                    "started_at": row["started_at"],
                    "completed_at": datetime.now(IST).isoformat(),
                    "symbols_processed": completed,
                    "symbols_failed": failed,
                    "rows_persisted": int(row.get("rows_persisted") or 0),
                    "metadata": {**metadata, "recoveredCompletion": True},
                }
            )
            return {
                "accepted": True,
                "completed": completed,
                "recoveredCompletion": True,
            }
        logger.info(
            "Resuming Runner baseline run=%s at symbol=%d/%d",
            row.get("run_id"),
            completed + 1,
            len(symbols),
        )
        try:
            return await self.rebuild(
                [str(symbol).upper() for symbol in symbols],
                as_of_date=date.fromisoformat(str(cutoff)),
                lookbacks=tuple(
                    int(value)
                    for value in (
                        lookbacks
                        or (
                            settings.RUNNER_BASELINE_SHORT_SESSIONS,
                            settings.RUNNER_BASELINE_LONG_SESSIONS,
                        )
                    )
                ),
                _run_id=str(row["run_id"]),
                _started_at=str(row["started_at"]),
                _resume_index=completed,
                _initial_failed=int(row.get("symbols_failed") or 0),
                _initial_rows=int(row.get("rows_persisted") or 0),
                _initial_failed_symbols=[
                    str(symbol).upper()
                    for symbol in (
                        metadata.get("failedSymbols", [])
                        if isinstance(metadata.get("failedSymbols", []), list)
                        else []
                    )
                ],
            )
        except (TypeError, ValueError):
            logger.exception(
                "Runner baseline run=%s has invalid checkpoint values",
                row.get("run_id"),
            )
            return None


def _history_to_bars(
    symbol: str, rows: list[Any], cutoff: date
) -> dict[date, list[MinuteBar]]:
    """Normalize provider history deterministically before cumulative calculations."""
    candles: dict[datetime, tuple[float, float, float, float, int]] = {}
    for row in rows:
        parsed = _parse_history_row(row)
        if parsed is None:
            continue
        ts, open_, high, low, close, volume = parsed
        minute_timestamp = ts.replace(second=0, microsecond=0)
        session_minute = (minute_timestamp.hour * 60 + minute_timestamp.minute) - (
            9 * 60 + 15
        )
        if (
            minute_timestamp.date() >= cutoff
            or session_minute < 0
            or session_minute >= SESSION_MINUTES
        ):
            continue
        # Prefer the most complete (largest-volume) duplicate, then a stable
        # OHLC tuple tie-break. Results remain independent of response order.
        candidate = (open_, high, low, close, volume)
        existing = candles.get(minute_timestamp)
        candles[minute_timestamp] = (
            max(existing, candidate, key=lambda value: (value[4], value[:4]))
            if existing is not None
            else candidate
        )

    sessions: dict[date, list[MinuteBar]] = defaultdict(list)
    cumulative_by_day: dict[date, int] = defaultdict(int)
    turnover_by_day: dict[date, float] = defaultdict(float)
    for ts, (open_, high, low, close, volume) in sorted(candles.items()):
        cumulative_by_day[ts.date()] += volume
        traded_value = float(close) * volume
        turnover_by_day[ts.date()] += traded_value
        sessions[ts.date()].append(
            MinuteBar(
                symbol=symbol,
                exchange="NSE",
                minute_timestamp=ts.replace(second=0, microsecond=0),
                open=float(open_),
                high=float(high),
                low=float(low),
                close=float(close),
                volume=volume,
                cumulative_volume=cumulative_by_day[ts.date()],
                traded_value=traded_value,
                cumulative_traded_value=turnover_by_day[ts.date()],
                tick_count=0,
            )
        )
    return sessions


def _parse_history_row(
    row: Any,
) -> tuple[datetime, float, float, float, float, int] | None:
    if isinstance(row, (list, tuple)) and len(row) >= 6:
        ts, open_, high, low, close, volume = row[:6]
    elif isinstance(row, dict):
        ts = row.get("date", row.get("timestamp", row.get("time")))
        open_, high, low, close, volume = (
            row.get("open"),
            row.get("high"),
            row.get("low"),
            row.get("close"),
            row.get("volume", 0),
        )
    else:
        return None
    try:
        if not isinstance(ts, datetime):
            ts = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        ts = ts.replace(tzinfo=IST) if ts.tzinfo is None else ts.astimezone(IST)
        prices = tuple(float(value) for value in (open_, high, low, close))
        normalized_volume = max(0, int(volume or 0))
    except (TypeError, ValueError):
        return None
    if min(prices) <= 0 or prices[1] < prices[2]:
        return None
    return ts, *prices, normalized_volume
