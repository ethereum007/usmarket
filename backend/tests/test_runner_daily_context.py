import asyncio
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.engines.runner.baselines import BaselineRepository
from app.engines.runner.context import RunnerContextStore
from app.engines.runner.features import calculate_features
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import (
    DataQuality,
    MarketDataSource,
    NormalizedMarketTick,
)
from app.services.runner_context_service import (
    RunnerDailyContextService,
    build_daily_structure,
)

IST = ZoneInfo("Asia/Kolkata")


def _daily_rows(count: int, start: date = date(2026, 5, 1)) -> list[dict]:
    return [
        {
            "date": start + timedelta(days=index),
            "open": 100 + index,
            "high": 102 + index,
            "low": 99 + index,
            "close": 101 + index,
            "volume": 1_000 + index,
        }
        for index in range(count)
    ]


def test_daily_structure_excludes_current_session_and_is_deterministic():
    cutoff = date(2026, 7, 1)
    rows = _daily_rows(55)
    rows.extend(
        [
            # A lower-volume duplicate must not replace the completed candle.
            {**rows[-1], "high": 999, "volume": 1},
            # Today's eventual high must never enter today's live context.
            {
                "date": cutoff,
                "open": 200,
                "high": 1_000,
                "low": 190,
                "close": 900,
                "volume": 9_000_000,
            },
        ]
    )
    first = build_daily_structure("test", rows, as_of_date=cutoff)
    second = build_daily_structure("test", list(reversed(rows)), as_of_date=cutoff)

    assert first == second
    assert first.symbol == "TEST"
    assert first.sample_count == 55
    assert first.high_20d == 156
    assert first.high_50d == 156
    assert first.atr14 == pytest.approx(3.0)


def test_daily_structure_accepts_arrow_arrays_and_rejects_bad_ohlc():
    cutoff = date(2026, 8, 2)
    rows = [
        [f"2026-07-{day:02d}T15:30:00+05:30", 100, 103, 99, 102, 1000]
        for day in range(1, 21)
    ]
    rows.append(["2026-07-21T15:30:00+05:30", 100, 90, 99, 101, 1000])

    context = build_daily_structure("TEST", rows, as_of_date=cutoff)

    assert context.sample_count == 20
    assert context.high_20d == 103
    assert context.high_50d is None


def test_context_warm_merges_with_existing_scanner_scores():
    cutoff = date(2026, 7, 1)

    class Provider:
        async def get_history(self, symbol, from_dt, to_dt, interval):
            assert interval == "day"
            assert to_dt.date() < cutoff
            return _daily_rows(55)

    store = RunnerContextStore()
    store.set_slow_features("TEST", {"abnormal_score": 81.0})
    service = RunnerDailyContextService(Provider(), store, request_delay_seconds=0)

    result = asyncio.run(service.warm(["TEST", "TEST"], as_of_date=cutoff))
    joined = store.get("TEST")

    assert result["accepted"] is True
    assert result["total"] == 1
    assert result["loaded"] == 1
    assert joined["abnormal_score"] == 81.0
    assert joined["daily_structure_as_of"] == cutoff
    assert joined["atr14"] == pytest.approx(3.0)
    assert store.daily_structure_coverage(["TEST"], as_of_date=cutoff) == {
        "loaded": 1,
        "atr14": 1,
        "high20d": 1,
        "high50d": 1,
    }
    assert store.daily_structure_coverage(
        ["TEST"], as_of_date=cutoff + timedelta(days=1)
    )["loaded"] == 0


def test_feature_uses_only_context_built_for_its_session():
    at = datetime(2026, 8, 4, 9, 15, tzinfo=IST)
    tick = NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=110,
        day_open=108,
        day_high=111,
        day_low=107,
        previous_close=100,
        cumulative_volume=100,
        source_provider=MarketDataSource.KITE,
    )
    bars = MinuteBarBuilder()
    bars.update(tick)
    context = RunnerContextStore()
    context.update_slow_features(
        "TEST",
        {
            "daily_structure_as_of": at.date(),
            "atr14": 5.0,
            "high_20d": 109.0,
            "high_50d": 120.0,
        },
    )
    current = calculate_features(
        tick,
        bars,
        BaselineRepository(),
        context,
        processing_timestamp=at,
    )
    assert current.atr_normalized_move == 2.0
    assert current.at_20d_high is True
    assert current.at_50d_high is False
    assert DataQuality.MISSING_HISTORY not in current.data_quality

    context.update_slow_features("TEST", {"daily_structure_as_of": at.date() - timedelta(days=1)})
    stale = calculate_features(
        tick,
        bars,
        BaselineRepository(),
        context,
        processing_timestamp=at,
    )
    assert stale.atr_normalized_move is None
    assert stale.distance_20d_high_pct is None
    assert DataQuality.MISSING_HISTORY in stale.data_quality
