import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from app.engines.runner.ranking import RankingThresholds, build_runner_rankings
from app.engines.runner.schemas import (
    DataQuality,
    MarketDataSource,
    RunnerFeatureSnapshot,
)
from app.routes.runner import runner_rankings
from app.services.runner_service import runner_service

IST = ZoneInfo("Asia/Kolkata")


def feature(symbol: str, **updates) -> RunnerFeatureSnapshot:
    at = datetime(2026, 9, 8, 10, 0, tzinfo=IST)
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
        volume_acceleration=1.4,
        turnover=100_000_000,
        ret_5m=0.8,
        ret_from_open=1.2,
        return_z_5m=2.0,
        range_tod_ratio=1.5,
        above_vwap=True,
        pdh_break=False,
        orb15_break_high=False,
        sector_relative_strength=0.5,
        market_return=0.2,
        data_source=MarketDataSource.KITE,
        data_quality=[DataQuality.GOOD],
        freshness_seconds=1,
        feature_version="runner-v1",
    )
    return base.model_copy(update=updates)


def test_ranking_is_cross_sectional_versioned_and_never_entry_ready():
    rankings = build_runner_rankings(
        [
            feature(
                "LEADER",
                rvol_tod_20d=6.0,
                rvol_tod_60d=5.0,
                rvol_1m=8.0,
                rvol_5m=6.0,
                volume_acceleration=4.0,
                ret_5m=2.0,
                return_z_5m=3.0,
                range_tod_ratio=3.0,
                pdh_break=True,
                orb15_break_high=True,
                sector_relative_strength=1.5,
                market_return=1.0,
            ),
            feature("NORMAL", rvol_tod_20d=1.0, rvol_5m=1.0),
            feature("MIDDLE", rvol_tod_20d=2.5, rvol_5m=2.2),
        ],
        score_version="runner-score-v1",
    )

    assert rankings[0]["symbol"] == "LEADER"
    assert rankings[0]["crossSectionPercentile"] == 100.0
    assert rankings[0]["tier"] == "HIGH_QUALITY"
    assert rankings[0]["entryReady"] is False
    assert rankings[0]["scoreVersion"] == "runner-score-v1"
    assert rankings[0]["turnoverCrore"] == 10.0
    assert [row["rank"] for row in rankings] == [1, 2, 3]


def test_ranking_fails_closed_on_core_data_quality_and_liquidity():
    rankings = build_runner_rankings(
        [
            feature("STALE", data_quality=[DataQuality.STALE]),
            feature("NOBASE", rvol_tod_20d=None),
            feature("MISMATCH", data_quality=[DataQuality.PROVIDER_MISMATCH]),
            feature("ILLIQUID", turnover=1_000_000),
            feature("VALID"),
        ]
    )

    assert [row["symbol"] for row in rankings] == ["VALID"]


def test_missing_optional_evidence_is_disclosed_and_cannot_be_high_quality():
    rankings = build_runner_rankings(
        [
            feature(
                "PARTIAL",
                rvol_tod_60d=None,
                rvol_1m=None,
                volume_acceleration=None,
                return_z_5m=None,
                range_tod_ratio=None,
                above_vwap=None,
                sector_relative_strength=None,
            )
        ],
        thresholds=RankingThresholds(
            unusual_score=0,
            candidate_score=0,
            high_quality_score=0,
            candidate_percentile=0,
            high_quality_percentile=0,
        ),
    )

    assert rankings[0]["evidenceCompleteness"] < 0.75
    assert rankings[0]["tier"] != "HIGH_QUALITY"


def test_direction_requires_price_and_vwap_consistency():
    rankings = build_runner_rankings(
        [
            feature("UP", ret_5m=1.0, above_vwap=True),
            feature("CONFLICT", ret_5m=1.0, above_vwap=False),
            feature("DOWN", ret_5m=-1.0, above_vwap=False),
        ]
    )

    directions = {row["symbol"]: row["direction"] for row in rankings}
    assert directions == {"UP": "UP", "CONFLICT": "MIXED", "DOWN": "DOWN"}


def test_limit_does_not_change_rank_order():
    features = [
        feature(f"S{index}", rvol_tod_20d=1 + index, rvol_5m=1 + index / 2)
        for index in range(10)
    ]
    rankings = build_runner_rankings(features, limit=3)

    assert len(rankings) == 3
    assert rankings[0]["runnerScore"] >= rankings[1]["runnerScore"]
    assert rankings[1]["runnerScore"] >= rankings[2]["runnerScore"]


def test_rankings_endpoint_is_bounded_and_research_only():
    previous = runner_service.latest_features
    runner_service.latest_features = {"RELIANCE": feature("RELIANCE")}
    try:
        response = asyncio.run(
            runner_rankings(_admin={"id": "admin"}, universe="nifty100", limit=5)
        )
    finally:
        runner_service.latest_features = previous

    assert response["eligible"] == 1
    assert response["scoreVersion"] == "runner-score-v1"
    assert response["entryReady"] is False
    assert len(response["rankings"]) == 1
