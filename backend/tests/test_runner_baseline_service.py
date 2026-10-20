import asyncio
from datetime import date, datetime
from time import sleep
from zoneinfo import ZoneInfo

from app.config import settings
from app.engines.runner.baselines import baseline_repository
from app.engines.runner.schemas import BaselineStat
from app.routes.runner import runner_baseline, runner_latest_features
from app.engines.runner.schemas import MarketDataSource, RunnerFeatureSnapshot
from app.services.runner_baseline_service import RunnerBaselineService, _history_to_bars
from app.services.runner_service import RunnerService, runner_service

IST = ZoneInfo("Asia/Kolkata")


class Provider:
    def __init__(self):
        self.calls = []

    async def get_history(self, symbol, from_dt, to_dt, interval):
        self.calls.append(symbol)
        rows = []
        for day, volume in [(date(2026, 8, 3), 100), (date(2026, 8, 4), 9_999)]:
            rows.append(
                {
                    "date": datetime(2026, day.month, day.day, 9, 15, tzinfo=IST),
                    "open": 100,
                    "high": 101,
                    "low": 99,
                    "close": 100,
                    "volume": volume,
                }
            )
        return rows


class Store:
    def __init__(self):
        self.keys = set()
        self.runs = []
        self.stats = []
        self.interrupted = None

    async def upsert_baselines(self, stats):
        self.stats = list(stats)
        for stat in self.stats:
            self.keys.add(
                (
                    stat.symbol,
                    stat.minute_of_session,
                    stat.lookback_sessions,
                    stat.metric,
                    stat.as_of_date,
                    stat.baseline_version,
                )
            )
        return len(self.stats)

    async def record_run(self, row):
        self.runs.append(row)

    async def get_interrupted_baseline_run(self):
        return self.interrupted


class BaselineLoadQuery:
    def __init__(self, owner):
        self.owner = owner
        self.columns = None
        self.equal_filters = {}
        self.in_filters = {}
        self.row_limit = None

    def select(self, columns):
        self.columns = columns
        return self

    def eq(self, field, value):
        self.equal_filters[field] = value
        return self

    def in_(self, field, values):
        self.in_filters[field] = list(values)
        return self

    def limit(self, value):
        self.row_limit = value
        return self

    def execute(self):
        call = {
            "columns": self.columns,
            "equal": self.equal_filters,
            "in": self.in_filters,
            "limit": self.row_limit,
        }
        self.owner.calls.append(call)
        rows = []
        for symbol in self.in_filters["symbol"]:
            for metric in self.in_filters["metric"]:
                rows.append(
                    {
                        "symbol": symbol,
                        "minute_of_session": self.equal_filters["minute_of_session"],
                        "lookback_sessions": self.equal_filters["lookback_sessions"],
                        "metric": metric,
                        "median": 100.0,
                        "mean": 110.0,
                        "std": 10.0,
                        "percentiles": {"p90": 125.0},
                        "as_of_date": "2026-08-04",
                        "baseline_version": self.equal_filters["baseline_version"],
                        "sample_count": 20,
                    }
                )
        return type("Response", (), {"data": rows})()


class BaselineLoadClient:
    def __init__(self):
        self.calls = []

    def table(self, name):
        assert name == "runner_baseline_stats"
        return BaselineLoadQuery(self)


class BaselineLoadStore(Store):
    def __init__(self):
        super().__init__()
        self.client = BaselineLoadClient()

    def _client_factory(self):
        return self.client


def test_live_baseline_load_uses_bounded_indexed_slices_only():
    baseline_repository.clear()
    store = BaselineLoadStore()
    service = RunnerBaselineService(Provider(), store, request_delay_seconds=0)

    loaded = asyncio.run(service.load_minute(10, ["aaa", "BBB", "aaa"]))

    assert loaded == 26
    assert len(store.client.calls) == 3
    assert all(call["columns"] != "*" for call in store.client.calls)
    assert all(call["limit"] == 900 for call in store.client.calls)
    assert all(call["in"]["symbol"] == ["AAA", "BBB"] for call in store.client.calls)
    assert all(
        len(call["in"]["symbol"]) * len(call["in"]["metric"]) <= call["limit"]
        for call in store.client.calls
    )
    prior = next(
        call for call in store.client.calls if call["equal"]["minute_of_session"] == 5
    )
    assert prior["in"]["metric"] == ["volume_5m"]
    current = [
        call for call in store.client.calls if call["equal"]["minute_of_session"] == 10
    ]
    assert sorted(len(call["in"]["metric"]) for call in current) == [1, 11]
    assert baseline_repository.get("AAA", 5, 20, "volume_5m") is not None
    assert baseline_repository.get("AAA", 10, 20, "ret_15m") is not None
    assert baseline_repository.get("AAA", 10, 60, "cumulative_volume") is not None
    baseline_repository.clear()


def test_baseline_rebuild_is_rerun_safe_and_excludes_incomplete_current_day():
    store = Store()
    service = RunnerBaselineService(Provider(), store, request_delay_seconds=0)
    first = asyncio.run(
        service.rebuild(["TEST"], as_of_date=date(2026, 8, 4), lookbacks=(20,))
    )
    key_count = len(store.keys)
    second = asyncio.run(
        service.rebuild(["TEST"], as_of_date=date(2026, 8, 4), lookbacks=(20,))
    )
    assert first["failed"] == second["failed"] == 0
    assert len(store.keys) == key_count
    # The giant current-day volume was excluded; sample count is the prior session only.
    stat = next(
        stat
        for stat in store.stats
        if stat.minute_of_session == 0
        and stat.lookback_sessions == 20
        and stat.metric == "cumulative_volume"
    )
    assert stat.median == 100
    assert stat.sample_count == 1
    assert any(
        run["status"] == "RUNNING" and run.get("symbols_processed") == 1
        for run in store.runs
    )


def test_baseline_rebuild_keeps_live_hot_cache_when_persistence_fails(monkeypatch):
    class FailingStore(Store):
        async def upsert_baselines(self, stats):
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        "app.engines.runner.baselines.minute_of_session", lambda _value: 0
    )
    baseline_repository.clear()
    service = RunnerBaselineService(Provider(), FailingStore(), request_delay_seconds=0)

    result = asyncio.run(
        service.rebuild(["TEST"], as_of_date=date(2026, 8, 4), lookbacks=(20,))
    )

    assert result["failed"] == 0
    assert result["persistenceFailures"] == 1
    assert result["statsPersisted"] == 0
    assert baseline_repository.get("TEST", 0, 20, "cumulative_volume") is not None
    baseline_repository.clear()


def test_baseline_aggregation_does_not_block_the_event_loop(monkeypatch):
    def slow_build(*_args, **_kwargs):
        sleep(0.1)
        return []

    monkeypatch.setattr(
        "app.services.runner_baseline_service.build_symbol_baselines", slow_build
    )

    async def scenario():
        service = RunnerBaselineService(Provider(), Store(), request_delay_seconds=0)
        rebuild = asyncio.create_task(
            service.rebuild(
                ["TEST"], as_of_date=date(2026, 8, 4), lookbacks=(20,)
            )
        )
        await asyncio.sleep(0.02)
        yielded_while_aggregation_was_running = not rebuild.done()
        await rebuild
        return yielded_while_aggregation_was_running

    assert asyncio.run(scenario()) is True


def test_runner_routes_are_mounted_without_public_trade_endpoint():
    from app.main import app

    paths = set(app.openapi()["paths"])
    assert "/api/runner/status" in paths
    assert "/api/runner/latest" in paths
    assert "/api/runner/shortlist" in paths
    assert "/api/runner/rankings" in paths
    assert "/api/runner/features/{symbol}" in paths
    assert "/api/runner/baselines/rebuild" in paths
    assert "/api/runner/context/rebuild" in paths
    assert not any("trade" in path and path.startswith("/api/runner") for path in paths)


def test_latest_features_is_bounded_sorted_and_preserves_missing_values():
    def feature(symbol, rvol):
        timestamp = datetime(2026, 8, 4, 9, 32, tzinfo=IST)
        return RunnerFeatureSnapshot(
            timestamp=timestamp,
            source_timestamp=timestamp,
            processing_timestamp=timestamp,
            session_date=timestamp.date(),
            minute_timestamp=timestamp.replace(second=0),
            minute_of_session=17,
            symbol=symbol,
            exchange="NSE",
            ltp=100,
            rvol_tod_20d=rvol,
            data_source=MarketDataSource.ARROW,
            data_quality=[],
            freshness_seconds=1,
            feature_version="runner-v1",
        )

    original = runner_service.latest_features
    runner_service.latest_features = {
        "MISSING": feature("MISSING", None),
        "NORMAL": feature("NORMAL", 1.2),
        "IGNITION": feature("IGNITION", 6.0),
    }
    try:
        response = asyncio.run(
            runner_latest_features({}, limit=2, sort_by="rvol_tod_20d")
        )
    finally:
        runner_service.latest_features = original

    assert response["total"] == 3
    assert response["returned"] == 2
    assert [row["symbol"] for row in response["features"]] == [
        "IGNITION",
        "NORMAL",
    ]


def test_interrupted_baseline_rebuild_resumes_after_checkpoint():
    provider = Provider()
    store = Store()
    store.interrupted = {
        "run_id": "49b0fa13-006a-4a72-9289-88a8ea308736",
        "run_type": "BASELINE_REBUILD",
        "status": "RUNNING",
        "universe": "nifty500",
        "started_at": "2026-08-04T10:00:00+05:30",
        "symbols_processed": 1,
        "symbols_failed": 0,
        "rows_persisted": 7,
        "metadata": {
            "requestedSymbols": ["FIRST", "SECOND", "THIRD"],
            "lookbacks": [20],
            "asOfDate": "2026-08-04",
            "baselineVersion": settings.RUNNER_BASELINE_VERSION,
        },
    }
    service = RunnerBaselineService(provider, store, request_delay_seconds=0)

    result = asyncio.run(service.resume_interrupted())

    assert provider.calls == ["SECOND", "THIRD"]
    assert result["resumed"] is True
    assert result["completed"] == 3
    assert result["statsBuilt"] > 7
    assert store.runs[-1]["run_id"] == store.interrupted["run_id"]
    assert store.runs[-1]["status"] == "COMPLETED"


def test_admin_baseline_launch_is_race_safe():
    async def scenario():
        provider = Provider()
        store = Store()
        runner = RunnerService(provider=provider, store=store)
        runner.baseline_service = RunnerBaselineService(
            provider, store, request_delay_seconds=0
        )

        first = runner.launch_baseline_rebuild(["FIRST"])
        second = runner.launch_baseline_rebuild(["SECOND"])
        await runner._baseline_task
        return first, second, provider.calls

    first, second, calls = asyncio.run(scenario())
    assert first == {"accepted": True, "symbols": 1}
    assert second["accepted"] is False
    assert calls == ["FIRST"]


def test_fully_checkpointed_interrupted_run_is_finalized_without_refetch():
    provider = Provider()
    store = Store()
    store.interrupted = {
        "run_id": "c4a33758-da85-464c-b576-90a4b74af62b",
        "status": "RUNNING",
        "universe": "nifty500",
        "started_at": "2026-08-04T10:00:00+05:30",
        "symbols_processed": 1,
        "symbols_failed": 0,
        "rows_persisted": 100,
        "metadata": {
            "requestedSymbols": ["FIRST"],
            "lookbacks": [20],
            "asOfDate": "2026-08-04",
            "baselineVersion": settings.RUNNER_BASELINE_VERSION,
        },
    }
    service = RunnerBaselineService(provider, store, request_delay_seconds=0)

    result = asyncio.run(service.resume_interrupted())

    assert provider.calls == []
    assert result["recoveredCompletion"] is True
    assert store.runs[-1]["status"] == "COMPLETED"
    assert store.runs[-1]["metadata"]["recoveredCompletion"] is True


def test_baseline_endpoint_reads_requested_minute_from_feature_store():
    class DiagnosticStore:
        async def get_baseline_diagnostics(self, symbol, minute):
            assert symbol == "RELIANCE"
            assert minute == 17
            return [
                BaselineStat(
                    symbol=symbol,
                    minute_of_session=minute,
                    lookback_sessions=20,
                    metric="cumulative_volume",
                    median=200_000,
                    mean=210_000,
                    std=25_000,
                    as_of_date=date(2026, 8, 4),
                    baseline_version=settings.RUNNER_BASELINE_VERSION,
                    sample_count=20,
                )
            ]

    original = runner_service.store
    runner_service.store = DiagnosticStore()
    try:
        response = asyncio.run(runner_baseline("reliance", {}, minute=17))
    finally:
        runner_service.store = original

    assert response["source"] == "DATABASE"
    assert response["minuteOfSession"] == 17
    assert response["count"] == 1
    assert response["baselines"][0]["median"] == 200_000


def test_history_normalization_is_sorted_deduplicated_and_session_bounded():
    day = date(2026, 8, 3)
    rows = [
        [datetime(2026, 8, 3, 9, 16, tzinfo=IST), 101, 102, 100, 101, 200],
        [datetime(2026, 8, 3, 9, 15, tzinfo=IST), 100, 101, 99, 100, 100],
        # The larger-volume duplicate is selected deterministically.
        [datetime(2026, 8, 3, 9, 16, tzinfo=IST), 101, 103, 100, 102, 250],
        [datetime(2026, 8, 3, 15, 30, tzinfo=IST), 102, 103, 101, 102, 999],
        {"date": "not-a-date", "open": 1, "high": 1, "low": 1, "close": 1},
    ]

    sessions = _history_to_bars("TEST", rows, cutoff=date(2026, 8, 4))

    bars = sessions[day]
    assert [bar.minute_timestamp.minute for bar in bars] == [15, 16]
    assert [bar.volume for bar in bars] == [100, 250]
    assert [bar.cumulative_volume for bar in bars] == [100, 350]
    assert bars[-1].close == 102
    reversed_bars = _history_to_bars(
        "TEST", list(reversed(rows)), cutoff=date(2026, 8, 4)
    )[day]
    assert [bar.model_dump() for bar in reversed_bars] == [
        bar.model_dump() for bar in bars
    ]
