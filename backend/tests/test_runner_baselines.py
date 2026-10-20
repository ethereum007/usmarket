from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.engines.runner.baselines import BaselineRepository, build_symbol_baselines
from app.engines.runner.context import RunnerContextStore
from app.engines.runner.features import calculate_features
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import (
    BaselineStat,
    DataQuality,
    MarketDataSource,
    MinuteBar,
    NormalizedMarketTick,
)

IST = ZoneInfo("Asia/Kolkata")


def bar(day, minute, volume, close=100, cumulative=None):
    ts = datetime.combine(day, datetime.min.time(), IST).replace(
        hour=9, minute=15
    ) + timedelta(minutes=minute)
    return MinuteBar(
        symbol="TEST",
        exchange="NSE",
        minute_timestamp=ts,
        open=100,
        high=max(100, close),
        low=min(100, close),
        close=close,
        volume=volume,
        cumulative_volume=cumulative,
    )


def test_baseline_excludes_current_session_and_uses_same_minute():
    current = date(2026, 8, 4)
    sessions = {
        date(2026, 8, 1): [bar(date(2026, 8, 1), 17, 200_000, cumulative=200_000)],
        date(2026, 8, 2): [bar(date(2026, 8, 2), 17, 200_000, cumulative=200_000)],
        current: [bar(current, 17, 9_000_000, cumulative=9_000_000)],
    }
    stats = build_symbol_baselines(
        "TEST", sessions, as_of_date=current, lookbacks=(20,)
    )
    cum = next(
        s
        for s in stats
        if s.minute_of_session == 17 and s.metric == "cumulative_volume"
    )
    assert cum.median == 200_000
    assert cum.sample_count == 2
    assert cum.as_of_date == current


def test_rvol_tod_six_x_and_missing_or_zero_baseline_is_null():
    repo = BaselineRepository()
    at = datetime(2026, 8, 4, 9, 32, tzinfo=IST)
    repo.put_many(
        [
            BaselineStat(
                symbol="TEST",
                minute_of_session=17,
                lookback_sessions=20,
                metric="cumulative_volume",
                median=200_000,
                mean=210_000,
                std=20_000,
                as_of_date=at.date(),
                baseline_version="v1",
                sample_count=20,
            ),
            BaselineStat(
                symbol="TEST",
                minute_of_session=17,
                lookback_sessions=60,
                metric="cumulative_volume",
                median=0,
                mean=0,
                std=0,
                as_of_date=at.date(),
                baseline_version="v1",
                sample_count=60,
            ),
        ]
    )
    builder = MinuteBarBuilder()
    live = NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=101,
        day_open=100,
        day_high=102,
        day_low=99,
        previous_close=100,
        cumulative_volume=1_200_000,
        source_provider=MarketDataSource.KITE,
    )
    builder.update(live)
    feature = calculate_features(
        live, builder, repo, RunnerContextStore(), processing_timestamp=at
    )
    assert feature.rvol_tod_20d == 6.0
    assert feature.rvol_tod_z_20d == pytest.approx(49.5)
    assert feature.rvol_tod_60d is None
    assert DataQuality.MISSING_BASELINE not in feature.data_quality

    empty = calculate_features(
        live,
        builder,
        BaselineRepository(),
        RunnerContextStore(),
        processing_timestamp=at,
    )
    assert empty.rvol_tod_20d is None
    assert DataQuality.MISSING_BASELINE in empty.data_quality


def test_future_dated_baseline_is_rejected():
    repo = BaselineRepository()
    at = datetime(2026, 8, 4, 9, 32, tzinfo=IST)
    repo.put_many(
        [
            BaselineStat(
                symbol="TEST",
                minute_of_session=17,
                lookback_sessions=20,
                metric="cumulative_volume",
                median=10,
                mean=10,
                std=1,
                as_of_date=date(2026, 8, 5),
                baseline_version="v1",
                sample_count=20,
            )
        ]
    )
    builder = MinuteBarBuilder()
    live = live_tick(at, 101, 100)
    builder.update(live)
    feature = calculate_features(
        live, builder, repo, RunnerContextStore(), processing_timestamp=at
    )
    assert feature.rvol_tod_20d is None
    assert DataQuality.MISSING_BASELINE in feature.data_quality


def test_range_tod_and_historical_return_zscore_only():
    repo = BaselineRepository()
    at = datetime(2026, 8, 4, 9, 32, tzinfo=IST)
    for metric, median, mean, std in [
        ("cumulative_volume", 100, 100, 10),
        ("intraday_range", 2, 2, 0.5),
        ("ret_1m", 0, 0, 0.25),
    ]:
        repo.put_many(
            [
                BaselineStat(
                    symbol="TEST",
                    minute_of_session=17,
                    lookback_sessions=20,
                    metric=metric,
                    median=median,
                    mean=mean,
                    std=std,
                    as_of_date=at.date(),
                    baseline_version="v1",
                    sample_count=20,
                )
            ]
        )
    builder = MinuteBarBuilder()
    prior = live_tick(at - timedelta(minutes=1), 100, 50)
    live = live_tick(at, 101, 100)
    builder.update(prior)
    builder.update(live)
    feature = calculate_features(
        live, builder, repo, RunnerContextStore(), processing_timestamp=at
    )
    assert feature.range_tod_ratio == 2.0
    assert feature.return_z_1m == pytest.approx(4.0)


def test_hot_baseline_repository_replaces_prior_minute_slice():
    repo = BaselineRepository()
    first = BaselineStat(
        symbol="TEST",
        minute_of_session=1,
        lookback_sessions=20,
        metric="cumulative_volume",
        median=100,
        mean=100,
        std=0,
        as_of_date=date(2026, 8, 4),
        baseline_version="runner-baseline-v1",
        sample_count=20,
    )
    second = first.model_copy(update={"minute_of_session": 7, "median": 200})
    repo.replace_minute(1, [first])
    repo.replace_minute(7, [second])

    assert repo.get("TEST", 1, 20, "cumulative_volume") is None
    assert repo.get("TEST", 7, 20, "cumulative_volume").median == 200


def live_tick(at, price, volume):
    return NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=price,
        day_open=100,
        day_high=103,
        day_low=99,
        previous_close=100,
        cumulative_volume=volume,
        source_provider=MarketDataSource.KITE,
    )
