from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.engines.runner.baselines import BaselineRepository, minute_of_session
from app.engines.runner.context import RunnerContextStore
from app.engines.runner.features import calculate_features
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import (
    BaselineStat,
    DataQuality,
    MarketDataSource,
    NormalizedMarketTick,
)

IST = ZoneInfo("Asia/Kolkata")


def _build(volumes):
    builder, repo = MinuteBarBuilder(), BaselineRepository()
    start = datetime(2026, 8, 4, 9, 15, tzinfo=IST)
    cumulative = 0
    latest = None
    for index, volume in enumerate(volumes):
        cumulative += volume
        at = start + timedelta(minutes=index)
        latest = NormalizedMarketTick(
            symbol="TEST",
            exchange="NSE",
            exchange_timestamp=at,
            received_timestamp=at,
            ltp=100 + index / 10,
            day_open=100,
            day_high=102,
            day_low=99,
            previous_close=99,
            cumulative_volume=cumulative,
            source_provider=MarketDataSource.KITE,
        )
        builder.update(latest)
    minute = minute_of_session(latest.exchange_timestamp)
    for m in {minute, max(0, minute - 5)}:
        for window in (1, 3, 5, 10, 15):
            repo.put_many(
                [
                    BaselineStat(
                        symbol="TEST",
                        minute_of_session=m,
                        lookback_sessions=20,
                        metric=f"volume_{window}m",
                        median=100 * window,
                        mean=100 * window,
                        std=10,
                        as_of_date=date(2026, 8, 4),
                        baseline_version="v1",
                        sample_count=20,
                    )
                ]
            )
        repo.put_many(
            [
                BaselineStat(
                    symbol="TEST",
                    minute_of_session=m,
                    lookback_sessions=20,
                    metric="cumulative_volume",
                    median=1000,
                    mean=1000,
                    std=100,
                    as_of_date=date(2026, 8, 4),
                    baseline_version="v1",
                    sample_count=20,
                )
            ]
        )
    return calculate_features(
        latest,
        builder,
        repo,
        RunnerContextStore(),
        processing_timestamp=latest.exchange_timestamp,
    )


def test_volume_acceleration_stable_ignition_and_low_volume():
    stable = _build([100] * 11)
    ignition = _build([100] * 6 + [300] * 5)
    low = _build([10] * 11)
    assert stable.volume_acceleration == 1.0
    assert ignition.volume_acceleration == 3.0
    assert low.volume_acceleration == 1.0
    assert ignition.rvol_5m == 3.0
    assert low.rvol_5m == 0.1


def test_stale_data_quality_and_no_fake_values():
    feature = _build([100] * 11)
    tick_time = feature.source_timestamp
    # Recalculate well after source time.
    builder = MinuteBarBuilder()
    tick = NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=tick_time,
        received_timestamp=tick_time,
        ltp=100,
        cumulative_volume=100,
        source_provider=MarketDataSource.KITE,
    )
    builder.update(tick)
    stale = calculate_features(
        tick,
        builder,
        BaselineRepository(),
        RunnerContextStore(),
        processing_timestamp=tick_time + timedelta(seconds=31),
    )
    assert DataQuality.STALE in stale.data_quality
    assert stale.vwap is None
    assert stale.spread_bps is None
