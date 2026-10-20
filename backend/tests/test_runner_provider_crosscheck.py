import asyncio
from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.config import settings
from app.engines.runner.baselines import BaselineRepository
from app.engines.runner.context import RunnerContextStore
from app.engines.runner.features import calculate_features
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import (
    DataQuality,
    MarketDataSource,
    NormalizedMarketTick,
)
from app.services.runner_service import RunnerService

IST = ZoneInfo("Asia/Kolkata")


class SecondaryProvider:
    name = MarketDataSource.ARROW

    def __init__(self, tick):
        self.tick = tick

    async def get_quotes(self, symbols):
        return {self.tick.symbol: self.tick}


class SnapshotProvider:
    def __init__(self, name, ticks=None, error=None):
        self.name = name
        self.ticks = ticks or []
        self.error = error
        self.calls = 0

    async def get_quotes(self, symbols):
        self.calls += 1
        if self.error:
            raise self.error
        return {tick.symbol: tick for tick in self.ticks}


class Store:
    def __init__(self):
        self.events = []
        self.runs = []
        self.rows_persisted = 0

    async def record_quality_events(self, rows):
        self.events.extend(rows)
        return len(rows)

    async def upsert_features(self, rows):
        self.persisted = list(rows)
        self.rows_persisted += len(self.persisted)
        return len(self.persisted)

    async def record_run(self, row):
        self.runs.append(row)
        return True

    @property
    def retry_rows(self):
        return 0


class RecoveringQualityStore(Store):
    def __init__(self):
        super().__init__()
        self.fail = True

    async def record_quality_events(self, rows):
        if self.fail:
            self.fail = False
            return 0
        return await super().record_quality_events(rows)


def test_sampled_provider_divergence_marks_feature_fail_closed():
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    primary = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=100_000,
        source_provider=MarketDataSource.KITE,
    )
    secondary = primary.model_copy(
        update={"ltp": 110, "source_provider": MarketDataSource.ARROW}
    )
    store = Store()
    service = RunnerService(
        provider=SecondaryProvider(primary),
        secondary_provider=SecondaryProvider(secondary),
        store=store,
    )
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}
    service.state.update(primary)
    bars = MinuteBarBuilder()
    bars.update(primary)
    service.latest_features["RELIANCE"] = calculate_features(
        primary,
        bars,
        BaselineRepository(),
        RunnerContextStore(),
        processing_timestamp=at,
    )

    events = asyncio.run(service.crosscheck())

    assert len(events) == 1
    assert events[0]["quality_state"] == DataQuality.PROVIDER_MISMATCH.value
    assert (
        DataQuality.PROVIDER_MISMATCH
        in service.latest_features["RELIANCE"].data_quality
    )


def test_repeated_provider_divergence_is_event_cooldown_limited():
    at = datetime.now(IST)
    primary = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=100_000,
        source_provider=MarketDataSource.KITE,
    )
    secondary = primary.model_copy(
        update={"ltp": 110, "source_provider": MarketDataSource.ARROW}
    )
    store = Store()
    service = RunnerService(
        provider=SecondaryProvider(primary),
        secondary_provider=SecondaryProvider(secondary),
        store=store,
    )
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}
    service.state.update(primary)
    bars = MinuteBarBuilder()
    bars.update(primary)
    service.latest_features["RELIANCE"] = calculate_features(
        primary, bars, BaselineRepository(), RunnerContextStore()
    )

    assert len(asyncio.run(service.crosscheck())) == 1
    assert asyncio.run(service.crosscheck()) == []
    assert len(store.events) == 1


def test_new_session_clears_old_market_and_feature_state():
    first_day = datetime(2026, 8, 4, 15, 29, tzinfo=IST)
    next_day = datetime(2026, 8, 5, 9, 15, tzinfo=IST)
    service = RunnerService(provider=SecondaryProvider(None), store=Store())
    service.universe = ["RELIANCE", "TCS"]
    service._universe_set = set(service.universe)
    first = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=first_day,
        received_timestamp=first_day,
        ltp=100,
        source_provider=MarketDataSource.KITE,
    )
    service.ingest(first)
    service.latest_features["RELIANCE"] = calculate_features(
        first, service.bars, BaselineRepository(), RunnerContextStore()
    )
    second = first.model_copy(
        update={
            "symbol": "TCS",
            "exchange_timestamp": next_day,
            "received_timestamp": next_day,
        }
    )

    service.ingest(second)

    assert service.state.get("RELIANCE") is None
    assert service.state.get("TCS") is not None
    assert service.latest_features == {}
    assert service.bars.session_date == next_day.date()

    service.ingest(first)
    assert service.state.get("RELIANCE") is None
    assert service.metrics["prior_session_ticks_ignored"] == 1


def test_close_flush_persists_only_completed_session_minute():
    at = datetime(2026, 8, 4, 15, 29, 30, tzinfo=IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        source_provider=MarketDataSource.KITE,
    )
    store = Store()
    service = RunnerService(provider=SecondaryProvider(tick), store=store)
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}
    service.ingest(tick)
    service.latest_features["RELIANCE"] = calculate_features(
        tick, service.bars, BaselineRepository(), RunnerContextStore()
    )

    persisted = asyncio.run(
        service.flush_completed_session(
            as_of=datetime(2026, 8, 4, 15, 31, tzinfo=IST)
        )
    )

    assert persisted == 1
    assert store.persisted[0].minute_timestamp.hour == 15
    assert store.persisted[0].minute_timestamp.minute == 29


def test_ohlc_only_divergence_is_a_provider_mismatch():
    at = datetime.now(IST)
    primary = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        day_open=100,
        day_high=101,
        day_low=99,
        previous_close=100,
        cumulative_volume=100_000,
        source_provider=MarketDataSource.KITE,
    )
    secondary = primary.model_copy(
        update={"day_open": 102, "source_provider": MarketDataSource.ARROW}
    )
    store = Store()
    service = RunnerService(
        provider=SecondaryProvider(primary),
        secondary_provider=SecondaryProvider(secondary),
        store=store,
    )
    service.state.update(primary)
    builder = MinuteBarBuilder()
    builder.update(primary)
    service.latest_features["RELIANCE"] = calculate_features(
        primary,
        builder,
        BaselineRepository(),
        RunnerContextStore(),
    )

    events = asyncio.run(service.crosscheck())

    assert len(events) == 1
    assert events[0]["details"]["ohlc_bps"]["day_open"] == 200


def test_stale_quality_event_is_persisted_once_per_cooldown():
    at = datetime.now(IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        source_provider=MarketDataSource.KITE,
    )
    builder = MinuteBarBuilder()
    builder.update(tick)
    snapshot = calculate_features(
        tick, builder, BaselineRepository(), RunnerContextStore()
    ).model_copy(update={"data_quality": [DataQuality.STALE]})
    store = Store()
    service = RunnerService(provider=SecondaryProvider(tick), store=store)

    assert asyncio.run(service._record_snapshot_quality_events([snapshot])) == 1
    assert asyncio.run(service._record_snapshot_quality_events([snapshot])) == 0
    assert [event["quality_state"] for event in store.events] == ["STALE"]


def test_out_of_order_tick_is_rejected_and_quality_event_is_queued():
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    current = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        source_provider=MarketDataSource.KITE,
    )
    older = current.model_copy(
        update={"exchange_timestamp": at.replace(minute=59, hour=9), "ltp": 90}
    )
    store = Store()
    service = RunnerService(provider=SecondaryProvider(current), store=store)
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}
    service.ingest(current)
    service.ingest(older)

    assert service.state.get("RELIANCE").ltp == 100
    assert service.metrics["clock_anomalies"] == 1
    assert asyncio.run(service._record_snapshot_quality_events([])) == 1
    assert store.events[0]["quality_state"] == "CLOCK_ANOMALY"


def test_quality_event_is_retried_after_persistence_failure():
    at = datetime.now(IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        source_provider=MarketDataSource.KITE,
    )
    builder = MinuteBarBuilder()
    builder.update(tick)
    snapshot = calculate_features(
        tick, builder, BaselineRepository(), RunnerContextStore()
    ).model_copy(update={"data_quality": [DataQuality.STALE]})
    store = RecoveringQualityStore()
    service = RunnerService(provider=SecondaryProvider(tick), store=store)

    assert asyncio.run(service._record_snapshot_quality_events([snapshot])) == 0
    assert service.metrics["quality_event_persistence_failures"] == 1
    assert asyncio.run(service._record_snapshot_quality_events([])) == 1
    assert store.events[0]["quality_state"] == "STALE"


def test_future_clock_anomaly_tick_is_rejected_before_live_state():
    received = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=received.replace(second=10),
        received_timestamp=received,
        ltp=100,
        source_provider=MarketDataSource.ARROW,
        data_quality=[DataQuality.CLOCK_ANOMALY],
    )
    store = Store()
    service = RunnerService(provider=SecondaryProvider(tick), store=store)
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}

    service.ingest(tick)

    assert service.state.get("RELIANCE") is None
    assert service.metrics["future_ticks_ignored"] == 1
    assert asyncio.run(service._record_snapshot_quality_events([])) == 1


def test_provider_liveness_requires_recent_accepted_data_and_sanitizes_errors():
    at = datetime.now(IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        previous_close=99,
        source_provider=MarketDataSource.KITE,
    )
    service = RunnerService(provider=SecondaryProvider(tick), store=Store())
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}

    assert service._provider_live(at) is False
    assert service.ingest(tick) is True
    assert service._provider_live(service.last_provider_data_at) is True
    assert (
        service._provider_live(
            service.last_provider_data_at
            + timedelta(seconds=settings.RUNNER_PROVIDER_LIVENESS_SECONDS + 1)
        )
        is False
    )

    service._mark_provider_error(RuntimeError("secret broker payload"))
    status = service.status()
    assert status["providerReady"] is False
    assert status["providerLive"] is False
    assert status["lastProviderErrorType"] == "RuntimeError"
    assert "secret broker payload" not in str(status)

    stale = tick.model_copy(
        update={"exchange_timestamp": at - timedelta(seconds=60)}
    )
    stale_service = RunnerService(provider=SecondaryProvider(stale), store=Store())
    stale_service.universe = ["RELIANCE"]
    stale_service._universe_set = {"RELIANCE"}
    assert stale_service.ingest(stale) is True
    assert stale_service.provider_ready is True
    assert stale_service._provider_live(stale_service.last_provider_data_at) is False

    future = tick.model_copy(
        update={"exchange_timestamp": at + timedelta(seconds=5)}
    )
    future_service = RunnerService(provider=SecondaryProvider(future), store=Store())
    future_service._mark_provider_data(future)
    assert future_service._provider_live(future_service.last_provider_data_at) is False


def test_broad_snapshot_ingests_secondary_provider_after_primary_failure():
    at = datetime.now(IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10_000,
        source_provider=MarketDataSource.ARROW,
    )
    primary = SnapshotProvider(MarketDataSource.KITE, error=RuntimeError("down"))
    secondary = SnapshotProvider(MarketDataSource.ARROW, ticks=[tick])
    service = RunnerService(
        provider=primary, secondary_provider=secondary, store=Store()
    )
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}
    service.running = True

    with patch("app.core.session_cache.is_market_hours", return_value=True):
        snapshots = asyncio.run(service.evaluate())

    assert primary.calls == 1
    assert secondary.calls == 1
    assert len(snapshots) == 1
    assert service.state.get("RELIANCE").source_provider == MarketDataSource.ARROW
    assert service.status()["activeProvider"] == "ARROW"


def test_live_kite_stream_suppresses_snapshot_polling():
    at = datetime.now(IST)
    tick = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10_000,
        source_provider=MarketDataSource.KITE,
    )
    primary = SnapshotProvider(MarketDataSource.KITE, ticks=[tick])
    service = RunnerService(provider=primary, store=Store())
    service.universe = ["RELIANCE"]
    service._universe_set = {"RELIANCE"}
    service.running = True
    service.ingest(tick)
    service.last_kite_stream_data_at = at

    with patch("app.core.session_cache.is_market_hours", return_value=True):
        snapshots = asyncio.run(service.evaluate())

    assert primary.calls == 0
    assert len(snapshots) == 1


def test_live_kite_stream_hydrates_symbols_without_a_stream_tick():
    at = datetime.now(IST)
    streamed = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10_000,
        source_provider=MarketDataSource.KITE,
    )
    silent = streamed.model_copy(
        update={"symbol": "MTARTECH", "ltp": 7_349, "cumulative_volume": 222_417}
    )
    primary = SnapshotProvider(MarketDataSource.KITE, ticks=[silent])
    service = RunnerService(provider=primary, store=Store())
    service.universe = ["RELIANCE", "MTARTECH"]
    service._universe_set = set(service.universe)
    service.running = True
    service.ingest(streamed)
    service.last_kite_stream_data_at = at

    with patch("app.core.session_cache.is_market_hours", return_value=True):
        snapshots = asyncio.run(service.evaluate())

    assert primary.calls == 1
    assert service.state.get("MTARTECH") is not None
    assert {snapshot.symbol for snapshot in snapshots} == {"RELIANCE", "MTARTECH"}
    assert service.metrics["missing_state_hydrated"] == 1


def test_missing_state_hydration_isolates_a_poisoned_quote_batch():
    at = datetime.now(IST)
    streamed = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10_000,
        source_provider=MarketDataSource.KITE,
    )
    silent = streamed.model_copy(update={"symbol": "MTARTECH", "ltp": 7_349})

    class PoisonedBatchProvider(SnapshotProvider):
        async def get_quotes(self, symbols):
            self.calls += 1
            if len(symbols) > 2:
                raise RuntimeError("invalid instrument in batch")
            return {"MTARTECH": silent} if "MTARTECH" in symbols else {}

    primary = PoisonedBatchProvider(MarketDataSource.KITE)
    service = RunnerService(provider=primary, store=Store())
    service.universe = ["RELIANCE", "MTARTECH", "INVALID"]
    service._universe_set = set(service.universe)
    service.running = True
    service.ingest(streamed)
    service.last_kite_stream_data_at = at

    with patch("app.core.session_cache.is_market_hours", return_value=True):
        snapshots = asyncio.run(service.evaluate())

    assert primary.calls == 3
    assert {snapshot.symbol for snapshot in snapshots} == {"RELIANCE", "MTARTECH"}
    assert service.status()["missingLiveSymbols"] == ["INVALID"]


def test_missing_kite_state_falls_back_to_secondary_provider():
    at = datetime.now(IST)
    streamed = NormalizedMarketTick(
        symbol="RELIANCE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10_000,
        source_provider=MarketDataSource.KITE,
    )
    arrow_tick = streamed.model_copy(
        update={
            "symbol": "MTARTECH",
            "ltp": 7_349,
            "source_provider": MarketDataSource.ARROW,
        }
    )
    primary = SnapshotProvider(MarketDataSource.KITE)
    secondary = SnapshotProvider(MarketDataSource.ARROW, ticks=[arrow_tick])
    service = RunnerService(
        provider=primary, secondary_provider=secondary, store=Store()
    )
    service.universe = ["RELIANCE", "MTARTECH"]
    service._universe_set = set(service.universe)
    service.running = True
    service.ingest(streamed)
    service.last_kite_stream_data_at = at

    with patch("app.core.session_cache.is_market_hours", return_value=True):
        snapshots = asyncio.run(service.evaluate())

    assert primary.calls == 1
    assert secondary.calls == 1
    assert {snapshot.symbol for snapshot in snapshots} == {"RELIANCE", "MTARTECH"}
    assert service.state.get("MTARTECH").source_provider == MarketDataSource.ARROW
    assert service.metrics["secondary_missing_state_hydrated"] == 1


def test_live_session_run_checkpoints_reuse_one_durable_run_id():
    async def scenario():
        store = Store()
        service = RunnerService(provider=SecondaryProvider(None), store=store)
        service.universe = ["RELIANCE"]
        service.universe_name = "nifty50"
        service.started_at = datetime.now(IST)
        service._live_run_id = "c4a33758-da85-464c-b576-90a4b74af62b"
        assert await service._record_live_run("RUNNING") is True
        assert await service._record_live_run("COMPLETED") is True
        return service, store

    service, store = asyncio.run(scenario())

    assert len(store.runs) == 2
    assert {row["run_id"] for row in store.runs} == {service._live_run_id}
    assert store.runs[0]["status"] == "RUNNING"
    assert store.runs[0]["completed_at"] is None
    assert store.runs[1]["status"] == "COMPLETED"
    assert store.runs[1]["completed_at"] is not None
    assert store.runs[1]["metadata"]["featureVersion"] == settings.RUNNER_FEATURE_VERSION
