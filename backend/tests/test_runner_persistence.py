import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from app.engines.runner.baselines import BaselineRepository
from app.engines.runner.context import RunnerContextStore
from app.engines.runner.features import calculate_features
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import MarketDataSource, NormalizedMarketTick
from app.services.runner_feature_store import RunnerFeatureStore

IST = ZoneInfo("Asia/Kolkata")


class Query:
    def __init__(self, owner):
        self.owner = owner

    def upsert(self, rows, on_conflict=None):
        self.owner.calls.append((rows, on_conflict))
        return self

    def select(self, *_args):
        return self

    def eq(self, *_args):
        self.owner.query_filters.append(_args)
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        return type("Response", (), {"data": self.owner.response_data})()


class Client:
    def __init__(self):
        self.calls = []
        self.response_data = []
        self.query_filters = []

    def table(self, _name):
        return Query(self)


class FailingQuery(Query):
    def execute(self):
        raise RuntimeError("database unavailable")


class FailingClient(Client):
    def table(self, _name):
        return FailingQuery(self)


def test_feature_upsert_is_batched_and_idempotency_key_is_explicit():
    client = Client()
    store = RunnerFeatureStore(client_factory=lambda: client)
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10,
        source_provider=MarketDataSource.KITE,
    )
    builder = MinuteBarBuilder()
    builder.update(tick)
    snapshot = calculate_features(
        tick,
        builder,
        BaselineRepository(),
        RunnerContextStore(),
        processing_timestamp=at,
    )
    assert asyncio.run(store.upsert_features([snapshot, snapshot])) == 2
    assert len(client.calls) == 1
    assert client.calls[0][1] == "session_date,symbol,minute_timestamp,feature_version"


def test_feature_upsert_splits_large_payloads_into_bounded_batches():
    client = Client()
    store = RunnerFeatureStore(client_factory=lambda: client, feature_batch_size=100)
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        cumulative_volume=10,
        source_provider=MarketDataSource.KITE,
    )
    builder = MinuteBarBuilder()
    builder.update(tick)
    snapshot = calculate_features(
        tick,
        builder,
        BaselineRepository(),
        RunnerContextStore(),
        processing_timestamp=at,
    )

    assert asyncio.run(store.upsert_features([snapshot] * 205)) == 205
    assert [len(rows) for rows, _conflict in client.calls] == [100, 100, 5]


def test_retry_queue_is_bounded_and_reports_dropped_rows():
    client = FailingClient()
    store = RunnerFeatureStore(client_factory=lambda: client, max_retry_rows=1)
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = NormalizedMarketTick(
        symbol="TEST",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=100,
        source_provider=MarketDataSource.KITE,
    )
    builder = MinuteBarBuilder()
    builder.update(tick)
    snapshot = calculate_features(
        tick, builder, BaselineRepository(), RunnerContextStore(), processing_timestamp=at
    )

    assert asyncio.run(store.upsert_features([snapshot, snapshot])) == 0
    assert store.retry_rows == 1
    assert store.retry_rows_dropped == 1


def test_interrupted_baseline_checkpoint_lookup_returns_latest_row():
    client = Client()
    client.response_data = [{"run_id": "checkpoint", "status": "RUNNING"}]
    store = RunnerFeatureStore(client_factory=lambda: client)

    row = asyncio.run(store.get_interrupted_baseline_run())

    assert row == {"run_id": "checkpoint", "status": "RUNNING"}


def test_engine_run_persistence_reports_success_and_failure():
    row = {
        "run_id": "c4a33758-da85-464c-b576-90a4b74af62b",
        "run_type": "LIVE_SESSION",
        "status": "RUNNING",
        "started_at": "2026-08-04T09:15:00+05:30",
    }
    successful = RunnerFeatureStore(client_factory=lambda: Client())
    failing = RunnerFeatureStore(client_factory=lambda: FailingClient())

    assert asyncio.run(successful.record_run(row)) is True
    assert asyncio.run(failing.record_run(row)) is False


def test_baseline_diagnostic_lookup_is_bounded_to_symbol_minute_and_version():
    client = Client()
    client.response_data = [
        {
            "symbol": "RELIANCE",
            "minute_of_session": 17,
            "lookback_sessions": 20,
            "metric": "cumulative_volume",
            "median": 200_000,
            "mean": 210_000,
            "std": 25_000,
            "percentiles": {"p90": 250_000},
            "as_of_date": "2026-08-04",
            "baseline_version": "runner-baseline-v1",
            "sample_count": 20,
        }
    ]
    store = RunnerFeatureStore(client_factory=lambda: client)

    rows = asyncio.run(store.get_baseline_diagnostics("reliance", 17))

    assert len(rows) == 1
    assert rows[0].median == 200_000
    assert ("symbol", "RELIANCE") in client.query_filters
    assert ("minute_of_session", 17) in client.query_filters
