"""Transparent volume-participation shortlist over point-in-time Runner features."""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from app.engines.runner.schemas import DataQuality, RunnerFeatureSnapshot

BLOCKING_QUALITY = {
    DataQuality.STALE,
    DataQuality.PROVIDER_MISMATCH,
    DataQuality.VOLUME_RESET,
    DataQuality.CLOCK_ANOMALY,
}


def build_participation_shortlist(
    features: Iterable[RunnerFeatureSnapshot],
    *,
    limit: int = 5,
    min_rvol_tod: float = 1.5,
    min_rvol_5m: float = 1.5,
    min_acceleration: float = 1.05,
    min_turnover_crore: float = 5.0,
) -> list[dict[str, Any]]:
    """Return only fresh, liquid names with participation entering now.

    This is deliberately not an entry model. The rank is a bounded diagnostic
    blend dominated by volume and exists to collapse hundreds of observations
    into a small research queue while later setup/risk phases remain absent.
    """

    candidates: list[dict[str, Any]] = []
    for feature in features:
        qualities = set(feature.data_quality)
        turnover_crore = (
            feature.turnover / 10_000_000 if feature.turnover is not None else None
        )
        acceleration_confirmed = (
            feature.volume_acceleration is not None
            and feature.volume_acceleration >= min_acceleration
        ) or (feature.rvol_1m is not None and feature.rvol_1m >= min_rvol_5m * 1.25)
        if (
            qualities & BLOCKING_QUALITY
            or feature.rvol_tod_20d is None
            or feature.rvol_tod_20d < min_rvol_tod
            or feature.rvol_5m is None
            or feature.rvol_5m < min_rvol_5m
            or not acceleration_confirmed
            or turnover_crore is None
            or turnover_crore < min_turnover_crore
        ):
            continue

        score = _participation_score(feature)
        direction = _direction(feature)
        reasons = [
            f"{feature.rvol_tod_20d:.1f}x normal cumulative volume for this minute",
            f"{feature.rvol_5m:.1f}x expected volume in the latest 5-minute window",
        ]
        if feature.volume_acceleration is not None:
            reasons.append(
                f"volume participation accelerated {feature.volume_acceleration:.1f}x"
            )
        elif feature.rvol_1m is not None:
            reasons.append(f"latest minute volume expanded to {feature.rvol_1m:.1f}x")
        if feature.distance_vwap_pct is not None:
            side = "above" if feature.distance_vwap_pct >= 0 else "below"
            reasons.append(f"price is {abs(feature.distance_vwap_pct):.2f}% {side} VWAP")

        candidates.append(
            {
                "symbol": feature.symbol,
                "direction": direction,
                "participationScore": round(score, 1),
                "ltp": feature.ltp,
                "rvolTod20d": feature.rvol_tod_20d,
                "rvolTod60d": feature.rvol_tod_60d,
                "rvol1m": feature.rvol_1m,
                "rvol5m": feature.rvol_5m,
                "volumeAcceleration": feature.volume_acceleration,
                "turnoverCrore": turnover_crore,
                "ret1m": feature.ret_1m,
                "ret5m": feature.ret_5m,
                "retFromOpen": feature.ret_from_open,
                "returnZ5m": feature.return_z_5m,
                "rangeTodRatio": feature.range_tod_ratio,
                "aboveVwap": feature.above_vwap,
                "distanceVwapPct": feature.distance_vwap_pct,
                "pdhBreak": feature.pdh_break,
                "orb15BreakHigh": feature.orb15_break_high,
                "orb15BreakLow": feature.orb15_break_low,
                "sector": feature.sector,
                "sectorRelativeStrength": feature.sector_relative_strength,
                "freshnessSeconds": feature.freshness_seconds,
                "dataSource": feature.data_source.value,
                "dataQuality": [quality.value for quality in feature.data_quality],
                "reasons": reasons,
            }
        )

    candidates.sort(
        key=lambda row: (row["participationScore"], row["rvolTod20d"]),
        reverse=True,
    )
    return [dict(candidate, rank=index) for index, candidate in enumerate(candidates[:limit], 1)]


def _participation_score(feature: RunnerFeatureSnapshot) -> float:
    def contribution(value: float | None, cap: float, weight: float) -> float:
        if value is None or value <= 0:
            return 0.0
        # Log compression stops one extreme print from overwhelming every other
        # dimension while preserving monotonic ordering.
        return weight * min(1.0, math.log1p(value) / math.log1p(cap))

    return (
        contribution(feature.rvol_tod_20d, 6.0, 40.0)
        + contribution(feature.rvol_5m, 6.0, 30.0)
        + contribution(feature.volume_acceleration, 3.0, 15.0)
        + contribution(
            abs(feature.return_z_5m)
            if feature.return_z_5m is not None
            else None,
            3.0,
            8.0,
        )
        + contribution(feature.range_tod_ratio, 3.0, 7.0)
    )


def _direction(feature: RunnerFeatureSnapshot) -> str:
    move = feature.ret_5m if feature.ret_5m is not None else feature.ret_from_open
    if move is None:
        return "MIXED"
    if move > 0 and feature.above_vwap is not False:
        return "UP"
    if move < 0 and feature.above_vwap is not True:
        return "DOWN"
    return "MIXED"
