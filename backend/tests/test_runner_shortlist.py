from datetime import datetime
from zoneinfo import ZoneInfo

from app.engines.runner.schemas import (
    DataQuality,
    MarketDataSource,
    RunnerFeatureSnapshot,
)
from app.engines.runner.shortlist import build_participation_shortlist

IST = ZoneInfo("Asia/Kolkata")


def feature(symbol: str, **updates) -> RunnerFeatureSnapshot:
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    base = RunnerFeatureSnapshot(
        timestamp=at,
        source_timestamp=at,
        processing_timestamp=at,
        session_date=at.date(),
        minute_timestamp=at,
        minute_of_session=45,
        symbol=symbol,
        exchange="NSE",
        ltp=100,
        rvol_tod_20d=2.0,
        rvol_tod_60d=1.8,
        rvol_1m=2.0,
        rvol_5m=2.0,
        volume_acceleration=1.2,
        turnover=100_000_000,
        ret_5m=0.5,
        return_z_5m=2.0,
        range_tod_ratio=1.5,
        above_vwap=True,
        data_source=MarketDataSource.KITE,
        data_quality=[DataQuality.GOOD],
        freshness_seconds=1,
        feature_version="runner-v1",
    )
    return base.model_copy(update=updates)


def test_shortlist_returns_only_strict_volume_participation():
    result = build_participation_shortlist(
        [
            feature("IGNITION", rvol_tod_20d=6.0, rvol_5m=4.0),
            feature("NORMAL", rvol_tod_20d=1.1),
            feature("ILLIQUID", turnover=1_000_000),
            feature("STALE", data_quality=[DataQuality.STALE]),
        ]
    )

    assert [row["symbol"] for row in result] == ["IGNITION"]
    assert result[0]["rank"] == 1
    assert result[0]["direction"] == "UP"
    assert "6.0x normal cumulative volume" in result[0]["reasons"][0]


def test_shortlist_is_bounded_and_ranked_by_participation():
    result = build_participation_shortlist(
        [
            feature(f"STOCK{index}", rvol_tod_20d=2 + index, rvol_5m=2 + index / 2)
            for index in range(8)
        ],
        limit=3,
    )

    assert len(result) == 3
    assert [row["rank"] for row in result] == [1, 2, 3]
    assert result[0]["participationScore"] >= result[-1]["participationScore"]


def test_latest_minute_spike_can_confirm_when_acceleration_is_unavailable():
    result = build_participation_shortlist(
        [feature("EARLY", volume_acceleration=None, rvol_1m=3.0)]
    )

    assert [row["symbol"] for row in result] == ["EARLY"]
