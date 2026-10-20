"""Runner lifecycle, live state, cadence and provider validation orchestration."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter, deque
from datetime import date, datetime, time
from threading import RLock
from time import perf_counter
from typing import Any
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.caches.stock_universes import resolve_universe
from app.config import settings
from app.core.scheduler import get_scheduler, start_scheduler
from app.engines.runner.baselines import baseline_repository
from app.engines.runner.context import derive_market_context, runner_context
from app.engines.runner.features import calculate_features
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.providers import (
    ArrowProvider,
    KiteProvider,
    MarketDataProvider,
    normalize_quote,
)
from app.engines.runner.schemas import (
    DataQuality,
    MarketDataSource,
    NormalizedMarketTick,
    RunnerFeatureSnapshot,
)
from app.services.runner_baseline_service import RunnerBaselineService
from app.services.runner_context_service import RunnerDailyContextService
from app.services.runner_feature_store import RunnerFeatureStore

logger = logging.getLogger("alpha_radar.runner")
IST = ZoneInfo("Asia/Kolkata")
BENCHMARK_SYMBOL = "NIFTY 50"


class MarketStateStore:
    def __init__(self) -> None:
        self._states: dict[str, NormalizedMarketTick] = {}
        self._lock = RLock()

    def update(self, tick: NormalizedMarketTick) -> bool:
        with self._lock:
            current = self._states.get(tick.symbol)
            if current and tick.exchange_timestamp < current.exchange_timestamp:
                tick.data_quality = list(
                    dict.fromkeys([*tick.data_quality, DataQuality.CLOCK_ANOMALY])
                )
                return False
            self._states[tick.symbol] = tick.model_copy(deep=True)
            return True

    def get(self, symbol: str) -> NormalizedMarketTick | None:
        with self._lock:
            tick = self._states.get(symbol.upper())
            return tick.model_copy(deep=True) if tick else None

    def all(self) -> list[NormalizedMarketTick]:
        with self._lock:
            return [tick.model_copy(deep=True) for tick in self._states.values()]

    def clear(self) -> None:
        with self._lock:
            self._states.clear()


class RunnerService:
    def __init__(
        self,
        provider: MarketDataProvider | None = None,
        secondary_provider: MarketDataProvider | None = None,
        store: RunnerFeatureStore | None = None,
    ) -> None:
        self.enabled = settings.RUNNER_ENGINE_ENABLED
        self.universe_name = settings.RUNNER_UNIVERSE
        self.universe = resolve_universe(settings.RUNNER_UNIVERSE)
        self._universe_set = set(self.universe)
        self.state = MarketStateStore()
        self.bars = MinuteBarBuilder()
        self.store = store or RunnerFeatureStore()
        self.provider = provider
        self.secondary_provider = secondary_provider
        self.provider_ready = False
        self.active_data_source: MarketDataSource | None = None
        self.last_provider_data_at: datetime | None = None
        self.last_provider_source_timestamp: datetime | None = None
        self.last_kite_stream_data_at: datetime | None = None
        self.last_provider_error_at: datetime | None = None
        self.last_provider_error_type: str | None = None
        self.baseline_service: RunnerBaselineService | None = None
        self.daily_context_service: RunnerDailyContextService | None = None
        self.latest_features: dict[str, RunnerFeatureSnapshot] = {}
        self.running = False
        self.started_at: datetime | None = None
        self.latest_feature_time: datetime | None = None
        self.metrics = Counter()
        self.processing_latency_ms = 0.0
        self._token_symbols: dict[int, str] = {}
        self._benchmark_tick: NormalizedMarketTick | None = None
        self._evaluate_lock = asyncio.Lock()
        self._history_job_lock = asyncio.Lock()
        self._session_date: date | None = None
        self._crosscheck_cursor = 0
        self._quality_event_times: dict[tuple[str, DataQuality], datetime] = {}
        self._pending_quality_events: deque[dict[str, Any]] = deque(maxlen=1000)
        self._quality_lock = RLock()
        self._baseline_task: asyncio.Task[dict[str, Any] | None] | None = None
        self._context_task: asyncio.Task[dict[str, Any]] | None = None
        self._live_run_id: str | None = None
        self._last_run_checkpoint: datetime | None = None
        self._last_missing_state_hydration: datetime | None = None

    async def start(self) -> None:
        if not self.enabled or self.running:
            return
        self.started_at = datetime.now(IST)
        self._configure_providers()
        if self.provider is None:
            logger.warning(
                "Runner enabled but primary provider is unavailable; engine remains fail-closed"
            )
            return
        self.baseline_service = RunnerBaselineService(self.provider, self.store)
        self.daily_context_service = RunnerDailyContextService(
            self.provider,
            runner_context,
            request_delay_seconds=settings.RUNNER_HISTORY_REQUEST_DELAY_SECONDS,
        )
        await self.baseline_service.load_latest(self.universe)
        if self.provider.name == MarketDataSource.KITE:
            self.provider_ready = await self._start_kite_stream()
        else:
            # Arrow is configured, but not live until the first quote batch succeeds.
            self.provider_ready = False
        self._register_jobs()
        self.running = True
        self._live_run_id = str(uuid.uuid4())
        await self._record_live_run("RUNNING")
        if settings.RUNNER_DAILY_CONTEXT_ENABLED:
            self._context_task = asyncio.create_task(
                self.warm_daily_context(), name="runner-daily-context-warm"
            )
        self._baseline_task = asyncio.create_task(
            self._resume_baselines_after_context(), name="runner-baseline-resume"
        )
        logger.info(
            "Runner started provider=%s universe=%s symbols=%d feature=%s",
            self.provider.name,
            settings.RUNNER_UNIVERSE,
            len(self.universe),
            settings.RUNNER_FEATURE_VERSION,
        )

    def _configure_providers(self) -> None:
        if self.provider is not None:
            return
        from app.core.kite_client import kite_state

        primary = settings.RUNNER_PRIMARY_PROVIDER
        if primary == "arrow":
            self.provider = ArrowProvider()
            self.secondary_provider = (
                KiteProvider(kite_state.kite) if kite_state.is_connected else None
            )
        elif kite_state.is_connected:
            self.provider = KiteProvider(kite_state.kite)
            self.secondary_provider = ArrowProvider() if settings.ARROW_APP_ID else None

    async def _start_kite_stream(self) -> bool:
        from app.caches import instrument_cache
        from app.core.kite_client import kite_state

        try:
            if not instrument_cache.size():
                await asyncio.to_thread(
                    instrument_cache.load_instruments, kite_state.kite
                )
            tokens = instrument_cache.get_all_tokens()
            self._token_symbols = {
                token: symbol
                for symbol, token in tokens.items()
                if symbol in self._universe_set
            }
            benchmark_token = tokens.get(BENCHMARK_SYMBOL)
            if benchmark_token is not None:
                self._token_symbols[benchmark_token] = BENCHMARK_SYMBOL
            self.provider.subscribe(
                [*self.universe, BENCHMARK_SYMBOL], self._on_kite_ticks
            )
            return True
        except Exception as exc:  # noqa: BLE001 - provider SDK failures stay isolated
            self._mark_provider_error(exc)
            logger.warning(
                "Runner Kite stream startup failed error_type=%s; engine remains isolated",
                type(exc).__name__,
            )
            return False

    def _on_kite_ticks(self, raw_ticks: list[dict[str, Any]]) -> None:
        from app.core.websocket_hub import ws_hub

        received = datetime.now(IST)
        benchmark_raw: dict[str, Any] | None = None
        accepted = 0
        for raw in raw_ticks:
            raw_symbol = raw.get("tradingsymbol") or self._token_symbols.get(
                raw.get("instrument_token")
            )
            if raw_symbol == BENCHMARK_SYMBOL:
                benchmark_raw = raw
                continue
            symbol = raw_symbol
            if not symbol:
                continue
            try:
                accepted += int(self.ingest(
                    normalize_quote(
                        symbol, raw, MarketDataSource.KITE, received_at=received
                    )
                ))
            except (TypeError, ValueError):
                self.metrics["normalization_errors"] += 1
        if benchmark_raw is not None:
            try:
                self._benchmark_tick = normalize_quote(
                    BENCHMARK_SYMBOL,
                    benchmark_raw,
                    MarketDataSource.KITE,
                    received_at=received,
                )
                self._mark_provider_data(self._benchmark_tick)
                accepted += 1
            except (TypeError, ValueError):
                self.metrics["normalization_errors"] += 1
        if accepted:
            self.last_kite_stream_data_at = received
        ws_hub.broadcast_ticks(raw_ticks)

    def ingest(self, tick: NormalizedMarketTick) -> bool:
        if tick.symbol not in self._universe_set:
            return False
        exchange_time = tick.exchange_timestamp
        exchange_time = (
            exchange_time.replace(tzinfo=IST)
            if exchange_time.tzinfo is None
            else exchange_time.astimezone(IST)
        )
        received_time = tick.received_timestamp
        received_time = (
            received_time.replace(tzinfo=IST)
            if received_time.tzinfo is None
            else received_time.astimezone(IST)
        )
        tick = tick.model_copy(
            update={
                "exchange_timestamp": exchange_time,
                "received_timestamp": received_time,
            }
        )
        if (
            DataQuality.CLOCK_ANOMALY in tick.data_quality
            and exchange_time > received_time
        ):
            self.metrics["future_ticks_ignored"] += 1
            self._queue_quality_event(tick, DataQuality.CLOCK_ANOMALY)
            return False
        tick_session = exchange_time.date()
        if self._session_date is not None and tick_session < self._session_date:
            self.metrics["prior_session_ticks_ignored"] += 1
            return False
        if self._session_date != tick_session:
            self._begin_session(tick_session)
        if not self.state.update(tick):
            self.metrics["clock_anomalies"] += 1
            self._queue_quality_event(tick, DataQuality.CLOCK_ANOMALY)
            return False
        completed = self.bars.update(tick)
        self._mark_provider_data(tick)
        self.metrics["ticks_processed"] += 1
        self.metrics["bars_completed"] += len(completed)
        return True

    def _mark_provider_data(self, tick: NormalizedMarketTick) -> None:
        now = datetime.now(IST)
        self.provider_ready = True
        self.active_data_source = tick.source_provider
        self.last_provider_data_at = now
        source_timestamp = tick.exchange_timestamp.astimezone(IST)
        if (
            self.last_provider_source_timestamp is None
            or source_timestamp > self.last_provider_source_timestamp
        ):
            self.last_provider_source_timestamp = source_timestamp

    def _mark_provider_error(self, error: Exception) -> None:
        self.provider_ready = False
        self.last_provider_error_at = datetime.now(IST)
        # Class name is useful operationally and cannot contain credentials or payloads.
        self.last_provider_error_type = type(error).__name__
        self.metrics["provider_errors"] += 1

    def _provider_live(self, now: datetime | None = None) -> bool:
        current = now or datetime.now(IST)
        if (
            not self.provider_ready
            or self.last_provider_data_at is None
            or self.last_provider_source_timestamp is None
        ):
            return False
        receipt_age = (current - self.last_provider_data_at).total_seconds()
        source_age = (current - self.last_provider_source_timestamp).total_seconds()
        limit = settings.RUNNER_PROVIDER_LIVENESS_SECONDS
        return (
            0 <= receipt_age <= limit
            and 0 <= source_age <= limit
        )

    def _kite_stream_live(self, now: datetime | None = None) -> bool:
        if self.last_kite_stream_data_at is None:
            return False
        current = now or datetime.now(IST)
        age = (current - self.last_kite_stream_data_at).total_seconds()
        return 0 <= age <= settings.RUNNER_PROVIDER_LIVENESS_SECONDS

    async def _ingest_broad_snapshot(
        self,
        provider: MarketDataProvider,
        symbols: list[str] | None = None,
    ) -> tuple[int, Exception | None]:
        """Poll one provider in batches and ingest its normalized live snapshot."""
        requested_symbols = symbols or self.universe
        try:
            quotes = await provider.get_quotes(
                list(dict.fromkeys([*requested_symbols, BENCHMARK_SYMBOL]))
            )
        except Exception as exc:  # noqa: BLE001 - provider failures stay isolated
            self.metrics[f"{provider.name.value.lower()}_snapshot_errors"] += 1
            logger.warning(
                "Runner %s broad quote refresh failed error_type=%s",
                provider.name.value,
                type(exc).__name__,
            )
            return 0, exc

        benchmark = quotes.get(BENCHMARK_SYMBOL)
        accepted = sum(
            self.ingest(tick)
            for symbol, tick in quotes.items()
            if symbol != BENCHMARK_SYMBOL
        )
        if benchmark is not None:
            self._benchmark_tick = benchmark
            self._mark_provider_data(benchmark)
        if not quotes:
            self.metrics["empty_provider_batches"] += 1
        elif accepted:
            self.metrics[f"{provider.name.value.lower()}_snapshot_refreshes"] += 1
        return accepted, None

    async def _hydrate_missing_states(self) -> None:
        """Seed stream-silent symbols without letting one bad instrument poison a batch."""
        now = datetime.now(IST)
        if self._last_missing_state_hydration is not None:
            elapsed = (now - self._last_missing_state_hydration).total_seconds()
            if elapsed < max(30, settings.RUNNER_PROVIDER_LIVENESS_SECONDS):
                return
        self._last_missing_state_hydration = now
        missing = [symbol for symbol in self.universe if self.state.get(symbol) is None]
        if not missing or self.provider is None:
            return

        accepted, error = await self._ingest_broad_snapshot(self.provider, missing)
        self.metrics["missing_state_hydrated"] += accepted
        if error is not None:
            # Some providers reject a complete quote batch because one instrument
            # is stale or invalid. The missing set is small, so isolate only after
            # batch failure and retry no more than once per liveness window.
            for symbol in missing:
                accepted, _ = await self._ingest_broad_snapshot(self.provider, [symbol])
                self.metrics["missing_state_hydrated"] += accepted

        unresolved = [symbol for symbol in missing if self.state.get(symbol) is None]
        if unresolved and self.secondary_provider is not None:
            accepted, _ = await self._ingest_broad_snapshot(
                self.secondary_provider, unresolved
            )
            self.metrics["secondary_missing_state_hydrated"] += accepted

    def _begin_session(self, session_date: date) -> None:
        """Discard prior-session live state before accepting the first new tick."""
        self.state.clear()
        self.bars.reset(session_date)
        self.latest_features.clear()
        self.latest_feature_time = None
        if (
            self._benchmark_tick is not None
            and self._benchmark_tick.exchange_timestamp.astimezone(IST).date()
            != session_date
        ):
            self._benchmark_tick = None
        with self._quality_lock:
            self._quality_event_times.clear()
            self._pending_quality_events.clear()
        self._session_date = session_date
        self._last_missing_state_hydration = None
        logger.info("Runner live state reset for session=%s", session_date)

    async def evaluate(self) -> list[RunnerFeatureSnapshot]:
        if not self.running or self.provider is None or self._evaluate_lock.locked():
            return []
        from app.core.session_cache import is_market_hours

        if not is_market_hours():
            return []
        async with self._evaluate_lock:
            started = perf_counter()
            from app.engines.runner.baselines import minute_of_session

            if self.baseline_service:
                await self.baseline_service.load_minute(
                    minute_of_session(datetime.now(IST)), self.universe
                )
            snapshot_providers: list[MarketDataProvider] = []
            if self.provider.name == MarketDataSource.ARROW:
                snapshot_providers.append(self.provider)
            elif not self._kite_stream_live():
                # A silent WebSocket must not leave the broad engine empty. Kite
                # REST remains the cheapest fallback; Arrow follows when configured.
                snapshot_providers.append(self.provider)
                if self.secondary_provider is not None:
                    snapshot_providers.append(self.secondary_provider)

            # Kite emits changed instruments, not an initial image for every new
            # subscription. Hydrate symbols that have not emitted a stream tick
            # (for example, a stock locked at a circuit) with one batched quote.
            if self.provider.name == MarketDataSource.KITE and self._kite_stream_live():
                await self._hydrate_missing_states()

            last_error: Exception | None = None
            for snapshot_provider in snapshot_providers:
                accepted, error = await self._ingest_broad_snapshot(snapshot_provider)
                last_error = error or last_error
                if accepted:
                    break
            if snapshot_providers and not self._provider_live() and last_error:
                self._mark_provider_error(last_error)
            live_ticks = self.state.all()
            runner_context.set_market(
                derive_market_context(
                    live_ticks,
                    benchmark=self._benchmark_tick,
                    as_of=datetime.now(IST),
                    stale_after_seconds=settings.RUNNER_STALE_AFTER_SECONDS,
                    minimum_symbols=min(
                        settings.RUNNER_MARKET_CONTEXT_MIN_SYMBOLS,
                        len(self.universe),
                    ),
                )
            )
            snapshots: list[RunnerFeatureSnapshot] = []
            to_persist: list[RunnerFeatureSnapshot] = []
            for tick in live_ticks:
                try:
                    snapshot = calculate_features(
                        tick,
                        self.bars,
                        baseline_repository,
                        runner_context,
                        short_lookback=settings.RUNNER_BASELINE_SHORT_SESSIONS,
                        long_lookback=settings.RUNNER_BASELINE_LONG_SESSIONS,
                        feature_version=settings.RUNNER_FEATURE_VERSION,
                        stale_after_seconds=settings.RUNNER_STALE_AFTER_SECONDS,
                    )
                    previous = self.latest_features.get(tick.symbol)
                    if (
                        previous
                        and previous.minute_timestamp < snapshot.minute_timestamp
                    ):
                        to_persist.append(previous)
                    self.latest_features[tick.symbol] = snapshot
                    snapshots.append(snapshot)
                except Exception:
                    self.metrics["feature_errors"] += 1
                    logger.debug(
                        "Runner feature calculation failed for %s",
                        tick.symbol,
                        exc_info=True,
                    )
            if to_persist and settings.RUNNER_PERSIST_MINUTE_FEATURES:
                await self.store.upsert_features(to_persist)
            await self._record_snapshot_quality_events(snapshots)
            if settings.RUNNER_PROVIDER_CROSSCHECK_ENABLED:
                await self.crosscheck()
            self.metrics["features_calculated"] += len(snapshots)
            self.metrics["feature_rows_persisted"] = self.store.rows_persisted
            self.latest_feature_time = (
                datetime.now(IST) if snapshots else self.latest_feature_time
            )
            self.processing_latency_ms = round((perf_counter() - started) * 1000, 2)
            if (
                self._last_run_checkpoint is None
                or (datetime.now(IST) - self._last_run_checkpoint).total_seconds()
                >= settings.RUNNER_RUN_HEARTBEAT_SECONDS
            ):
                await self._record_live_run("RUNNING")
            return snapshots

    def _quality_event_allowed(
        self, symbol: str, quality: DataQuality, now: datetime
    ) -> bool:
        with self._quality_lock:
            key = (symbol, quality)
            previous = self._quality_event_times.get(key)
            if previous and (
                now - previous
            ).total_seconds() < settings.RUNNER_QUALITY_EVENT_COOLDOWN_SECONDS:
                return False
            self._quality_event_times[key] = now
            return True

    def _queue_quality_event(
        self, tick: NormalizedMarketTick, quality: DataQuality
    ) -> None:
        now = datetime.now(IST)
        if not self._quality_event_allowed(tick.symbol, quality, now):
            return
        with self._quality_lock:
            self._pending_quality_events.append(
                {
                    "event_timestamp": now.isoformat(),
                    "session_date": now.date().isoformat(),
                    "symbol": tick.symbol,
                    "quality_state": quality.value,
                    "primary_provider": tick.source_provider.value,
                    "details": {
                        "source_timestamp": tick.exchange_timestamp.isoformat(),
                        "received_timestamp": tick.received_timestamp.isoformat(),
                    },
                }
            )

    async def _record_snapshot_quality_events(
        self, snapshots: list[RunnerFeatureSnapshot]
    ) -> int:
        """Persist actionable quality incidents without writing every refresh."""
        now = datetime.now(IST)
        with self._quality_lock:
            events = list(self._pending_quality_events)
            self._pending_quality_events.clear()
        actionable = {
            DataQuality.STALE,
            DataQuality.VOLUME_RESET,
            DataQuality.CLOCK_ANOMALY,
        }
        for snapshot in snapshots:
            for quality in actionable.intersection(snapshot.data_quality):
                if not self._quality_event_allowed(snapshot.symbol, quality, now):
                    continue
                events.append(
                    {
                        "event_timestamp": now.isoformat(),
                        "session_date": snapshot.session_date.isoformat(),
                        "symbol": snapshot.symbol,
                        "quality_state": quality.value,
                        "primary_provider": snapshot.data_source.value,
                        "details": {
                            "source_timestamp": snapshot.source_timestamp.isoformat(),
                            "processing_timestamp": snapshot.processing_timestamp.isoformat(),
                            "freshness_seconds": snapshot.freshness_seconds,
                        },
                    }
                )
        persisted = await self._persist_quality_events(events)
        self.metrics["quality_events_persisted"] += persisted
        return persisted

    async def _persist_quality_events(self, events: list[dict[str, Any]]) -> int:
        persisted = await self.store.record_quality_events(events)
        if events and persisted == 0:
            with self._quality_lock:
                self._pending_quality_events.extend(events)
            self.metrics["quality_event_persistence_failures"] += 1
        return persisted

    async def crosscheck(self) -> list[dict[str, Any]]:
        if not self.secondary_provider:
            return []
        available = sorted(self.latest_features)
        sample_size = min(
            settings.RUNNER_PROVIDER_CROSSCHECK_SAMPLE_SIZE, len(available)
        )
        symbols = (
            [
                available[(self._crosscheck_cursor + offset) % len(available)]
                for offset in range(sample_size)
            ]
            if available
            else []
        )
        if available:
            self._crosscheck_cursor = (
                self._crosscheck_cursor + sample_size
            ) % len(available)
        if not symbols:
            return []
        try:
            secondary = await self.secondary_provider.get_quotes(symbols)
        except Exception:
            self.metrics["secondary_provider_errors"] += 1
            logger.warning("Runner provider crosscheck unavailable", exc_info=True)
            return []
        events = []
        for symbol in symbols:
            primary = self.state.get(symbol)
            other = secondary.get(symbol)
            if not primary or not other:
                continue
            ltp_bps = (
                abs(primary.ltp - other.ltp) / primary.ltp * 10_000
                if primary.ltp
                else 0
            )
            volume_divergence = abs(
                (primary.cumulative_volume or 0) - (other.cumulative_volume or 0)
            )
            timestamp_divergence = abs(
                (primary.exchange_timestamp - other.exchange_timestamp).total_seconds()
            )
            ohlc_divergence = {
                field: abs(
                    (getattr(primary, field) or 0) - (getattr(other, field) or 0)
                )
                for field in ("day_open", "day_high", "day_low", "previous_close")
            }
            ohlc_bps = {
                field: (
                    abs(getattr(primary, field) - getattr(other, field))
                    / getattr(primary, field)
                    * 10_000
                    if getattr(primary, field) not in (None, 0)
                    and getattr(other, field) is not None
                    else None
                )
                for field in ("day_open", "day_high", "day_low", "previous_close")
            }
            if (
                ltp_bps > settings.RUNNER_PROVIDER_LTP_TOLERANCE_BPS
                or volume_divergence
                > max(1000, int((primary.cumulative_volume or 0) * 0.05))
                or timestamp_divergence > settings.RUNNER_STALE_AFTER_SECONDS
                or any(
                    value > settings.RUNNER_PROVIDER_LTP_TOLERANCE_BPS
                    for value in ohlc_bps.values()
                    if value is not None
                )
            ):
                now = datetime.now(IST)
                should_record = self._quality_event_allowed(
                    symbol, DataQuality.PROVIDER_MISMATCH, now
                )
                self.metrics["provider_mismatch_count"] += 1
                if should_record:
                    events.append(
                        {
                            "event_timestamp": now.isoformat(),
                            "session_date": now.date().isoformat(),
                            "symbol": symbol,
                            "quality_state": DataQuality.PROVIDER_MISMATCH.value,
                            "primary_provider": primary.source_provider.value,
                            "secondary_provider": other.source_provider.value,
                            "details": {
                                "ltp_bps": round(ltp_bps, 2),
                                "volume_divergence": volume_divergence,
                                "timestamp_divergence_seconds": timestamp_divergence,
                                "ohlc_absolute_divergence": ohlc_divergence,
                                "ohlc_bps": ohlc_bps,
                            },
                        }
                    )
                feature = self.latest_features.get(symbol)
                if (
                    feature
                    and DataQuality.PROVIDER_MISMATCH not in feature.data_quality
                ):
                    feature.data_quality.append(DataQuality.PROVIDER_MISMATCH)
                    if DataQuality.GOOD in feature.data_quality:
                        feature.data_quality.remove(DataQuality.GOOD)
        await self._persist_quality_events(events)
        return events

    def _register_jobs(self) -> None:
        sched = get_scheduler()
        sched.add_job(
            self.evaluate,
            IntervalTrigger(
                seconds=max(5, settings.RUNNER_BROAD_REFRESH_SECONDS), timezone=IST
            ),
            id="runner_feature_refresh",
            name="Runner broad feature refresh",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        if settings.RUNNER_BASELINE_AUTO_UPDATE:
            sched.add_job(
                self.rebuild_baselines_after_close,
                CronTrigger(hour=16, minute=30, day_of_week="mon-fri", timezone=IST),
                id="runner_baseline_eod",
                name="Runner incremental EOD baselines",
                replace_existing=True,
                max_instances=1,
                coalesce=True,
            )
        if settings.RUNNER_DAILY_CONTEXT_ENABLED:
            sched.add_job(
                self.warm_daily_context,
                CronTrigger(hour=8, minute=35, day_of_week="mon-fri", timezone=IST),
                id="runner_daily_context",
                name="Runner daily ATR and high context",
                replace_existing=True,
                max_instances=1,
                coalesce=True,
            )
        if settings.RUNNER_PERSIST_MINUTE_FEATURES:
            sched.add_job(
                self.flush_completed_session,
                CronTrigger(hour=15, minute=31, day_of_week="mon-fri", timezone=IST),
                id="runner_feature_close_flush",
                name="Runner completed-session feature flush",
                replace_existing=True,
                max_instances=1,
                coalesce=True,
            )
        start_scheduler()

    async def warm_daily_context(
        self,
        symbols: list[str] | None = None,
        *,
        as_of_date: date | None = None,
    ) -> dict[str, Any]:
        """Warm prior-session ATR and 20/50-day highs for live feature joins."""
        if not settings.RUNNER_DAILY_CONTEXT_ENABLED:
            return {"accepted": False, "reason": "daily context disabled"}
        if not self.daily_context_service:
            return {"accepted": False, "reason": "Runner provider unavailable"}
        async with self._history_job_lock:
            return await self.daily_context_service.warm(
                symbols or self.universe, as_of_date=as_of_date
            )

    def launch_daily_context_warm(self, symbols: list[str]) -> dict[str, Any]:
        """Start one protected context warm and retain it for status/shutdown."""
        if not settings.RUNNER_DAILY_CONTEXT_ENABLED:
            return {"accepted": False, "reason": "daily context disabled"}
        if not self.daily_context_service:
            return {"accepted": False, "reason": "Runner provider unavailable"}
        if self.daily_context_service.running or (
            self._context_task is not None and not self._context_task.done()
        ):
            return {
                "accepted": False,
                "reason": "daily context warm already running",
                **self.daily_context_service.progress,
            }
        self._context_task = asyncio.create_task(
            self.warm_daily_context(symbols), name="runner-daily-context-warm"
        )
        return {"accepted": True, "symbols": len(symbols)}

    async def _resume_baselines_after_context(self) -> dict[str, Any] | None:
        """Serialize provider history jobs so startup cannot burst its rate limit."""
        if self._context_task:
            try:
                await self._context_task
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Runner daily context startup warm failed")
        if self.baseline_service:
            async with self._history_job_lock:
                resumed = await self.baseline_service.resume_interrupted()
                if resumed is not None:
                    return resumed
                from app.engines.runner.baselines import minute_of_session

                hot_minute = minute_of_session(datetime.now(IST))
                missing = [
                    symbol
                    for symbol in self.universe
                    if baseline_repository.get(
                        symbol,
                        hot_minute,
                        settings.RUNNER_BASELINE_SHORT_SESSIONS,
                        "cumulative_volume",
                    )
                    is None
                ]
                if settings.RUNNER_BASELINE_BOOTSTRAP_ENABLED and missing:
                    logger.info(
                        "Runner baseline coverage incomplete; bootstrapping missing symbols=%d",
                        len(missing),
                    )
                    return await self.baseline_service.rebuild(missing)
        return None

    async def flush_completed_session(
        self, *, as_of: datetime | None = None
    ) -> int:
        """Persist the last completed feature minute when no rollover tick arrives."""
        if not settings.RUNNER_PERSIST_MINUTE_FEATURES:
            return 0
        now = (as_of or datetime.now(IST)).astimezone(IST)
        session_close = datetime.combine(now.date(), time(15, 30), IST)
        completion_boundary = min(now.replace(second=0, microsecond=0), session_close)
        rows = [
            feature
            for feature in self.latest_features.values()
            if feature.session_date == now.date()
            and feature.minute_timestamp < completion_boundary
        ]
        persisted = await self.store.upsert_features(rows)
        self.metrics["feature_rows_persisted"] = self.store.rows_persisted
        if rows:
            logger.info(
                "Runner close flush eligible=%d persisted=%d", len(rows), persisted
            )
        return persisted

    async def rebuild_baselines(
        self, symbols: list[str] | None = None
    ) -> dict[str, Any]:
        if not self.baseline_service:
            return {"accepted": False, "reason": "Runner provider unavailable"}
        async with self._history_job_lock:
            return await self.baseline_service.rebuild(symbols or self.universe)

    def launch_baseline_rebuild(self, symbols: list[str]) -> dict[str, Any]:
        """Start one tracked admin rebuild without a check/create race."""
        if not self.baseline_service:
            return {"accepted": False, "reason": "Runner provider unavailable"}
        if (
            self.baseline_service.running
            or self._baseline_task is not None
            and not self._baseline_task.done()
        ):
            return {
                "accepted": False,
                "reason": "baseline rebuild already running",
                **self.baseline_service.progress,
            }
        self._baseline_task = asyncio.create_task(
            self.rebuild_baselines(symbols), name="runner-baseline-rebuild"
        )
        return {"accepted": True, "symbols": len(symbols)}

    async def rebuild_baselines_after_close(self) -> dict[str, Any]:
        """Include today's now-completed session in the baseline for the next day."""
        from datetime import timedelta

        if not self.baseline_service:
            return {"accepted": False, "reason": "Runner provider unavailable"}
        async with self._history_job_lock:
            return await self.baseline_service.rebuild(
                self.universe,
                as_of_date=datetime.now(IST).date() + timedelta(days=1),
            )

    async def _record_live_run(self, status: str) -> bool:
        """Persist a low-frequency live lifecycle checkpoint without secrets."""
        if not self._live_run_id or not self.started_at:
            return False
        now = datetime.now(IST)
        completed = status != "RUNNING"
        row = {
            "run_id": self._live_run_id,
            "run_type": "LIVE_SESSION",
            "status": status,
            "universe": self.universe_name,
            "started_at": self.started_at.isoformat(),
            "completed_at": now.isoformat() if completed else None,
            "symbols_processed": len(self.state.all()),
            "symbols_failed": int(self.metrics.get("feature_errors", 0)),
            "rows_persisted": self.store.rows_persisted,
            "metadata": {
                "provider": self.provider.name.value if self.provider else None,
                "providerReady": self.provider_ready,
                "providerLive": self._provider_live(now),
                "featureVersion": settings.RUNNER_FEATURE_VERSION,
                "symbolsConfigured": len(self.universe),
                "latestFeatureTime": self.latest_feature_time.isoformat()
                if self.latest_feature_time
                else None,
                "metrics": dict(self.metrics),
            },
        }
        recorded = await self.store.record_run(row)
        self._last_run_checkpoint = now
        if not recorded:
            self.metrics["run_persistence_failures"] += 1
        return recorded

    async def stop(self) -> None:
        if not self.running:
            return
        if settings.RUNNER_PERSIST_MINUTE_FEATURES:
            await self.store.upsert_features([])  # retry completed-minute rows only
        if self._baseline_task and not self._baseline_task.done():
            self._baseline_task.cancel()
            try:
                await self._baseline_task
            except asyncio.CancelledError:
                pass
        if self._context_task and not self._context_task.done():
            self._context_task.cancel()
            try:
                await self._context_task
            except asyncio.CancelledError:
                pass
        if self.provider and self.provider.name == MarketDataSource.KITE:
            from app.core.kite_ticker import stop_ticker

            stop_ticker()
        await self._record_live_run("COMPLETED")
        self.running = False

    def status(self) -> dict[str, Any]:
        now = datetime.now(IST)
        provider_data_age = (
            max(0.0, (now - self.last_provider_data_at).total_seconds())
            if self.last_provider_data_at
            else None
        )
        provider_source_age = (
            max(0.0, (now - self.last_provider_source_timestamp).total_seconds())
            if self.last_provider_source_timestamp
            else None
        )
        quality = Counter(
            q.value
            for feature in self.latest_features.values()
            for q in feature.data_quality
        )
        current_states = self.state.all()
        stale = sum(
            1
            for tick in current_states
            if (now - tick.exchange_timestamp).total_seconds()
            > settings.RUNNER_STALE_AFTER_SECONDS
        )
        live_symbols = {tick.symbol for tick in current_states}
        return {
            "enabled": self.enabled,
            "running": self.running,
            "provider": self.provider.name.value if self.provider else None,
            "activeProvider": self.active_data_source.value
            if self.active_data_source
            else None,
            "providerReady": self.provider_ready,
            "providerLive": self._provider_live(now),
            "kiteStreamLive": self._kite_stream_live(now)
            if self.provider and self.provider.name == MarketDataSource.KITE
            else None,
            "providerDataAgeSeconds": round(provider_data_age, 2)
            if provider_data_age is not None
            else None,
            "providerSourceAgeSeconds": round(provider_source_age, 2)
            if provider_source_age is not None
            else None,
            "lastProviderDataAt": self.last_provider_data_at.isoformat()
            if self.last_provider_data_at
            else None,
            "lastProviderSourceTimestamp": self.last_provider_source_timestamp.isoformat()
            if self.last_provider_source_timestamp
            else None,
            "lastProviderErrorAt": self.last_provider_error_at.isoformat()
            if self.last_provider_error_at
            else None,
            "lastProviderErrorType": self.last_provider_error_type,
            "universe": settings.RUNNER_UNIVERSE,
            "symbolsMonitored": len(current_states),
            "symbolsConfigured": len(self.universe),
            "missingLiveSymbols": [
                symbol for symbol in self.universe if symbol not in live_symbols
            ],
            "baselineCoverage": {
                str(
                    settings.RUNNER_BASELINE_SHORT_SESSIONS
                ): baseline_repository.coverage(
                    self.universe, settings.RUNNER_BASELINE_SHORT_SESSIONS
                ),
                str(
                    settings.RUNNER_BASELINE_LONG_SESSIONS
                ): baseline_repository.coverage(
                    self.universe, settings.RUNNER_BASELINE_LONG_SESSIONS
                ),
            },
            "latestFeatureTime": self.latest_feature_time.isoformat()
            if self.latest_feature_time
            else None,
            "staleCount": stale,
            "dataQuality": dict(quality),
            "featureVersion": settings.RUNNER_FEATURE_VERSION,
            "scoreVersion": settings.RUNNER_SCORE_VERSION,
            "processingLatencyMs": self.processing_latency_ms,
            "marketContext": runner_context.market_diagnostics(),
            "metrics": dict(self.metrics),
            "persistenceRetryRows": self.store.retry_rows,
            "persistenceRetryRowsDropped": getattr(
                self.store, "retry_rows_dropped", 0
            ),
            "baselineJob": self.baseline_service.progress
            if self.baseline_service
            else None,
            "baselineTaskActive": bool(
                self._baseline_task and not self._baseline_task.done()
            ),
            "dailyContextCoverage": runner_context.daily_structure_coverage(
                self.universe, as_of_date=now.date()
            ),
            "dailyContextJob": self.daily_context_service.progress
            if self.daily_context_service
            else None,
            "dailyContextTaskActive": bool(
                self._context_task and not self._context_task.done()
            ),
            "liveRunId": self._live_run_id,
            "lastRunCheckpoint": self._last_run_checkpoint.isoformat()
            if self._last_run_checkpoint
            else None,
        }


runner_service = RunnerService()
