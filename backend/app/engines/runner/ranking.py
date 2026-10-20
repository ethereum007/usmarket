"""Cross-sectional Runner ranking over point-in-time feature snapshots.

This is a research ranking, not an entry model. It deliberately produces no
order side, stop, target, sizing, or ENTRY_READY state.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from app.engines.runner.schemas import DataQuality, RunnerFeatureSnapshot

BLOCKING_QUALITY = {
    DataQuality.STALE,
    DataQuality.MISSING_BASELINE,
    DataQuality.PROVIDER_MISMATCH,
    DataQuality.VOLUME_RESET,
    DataQuality.CLOCK_ANOMALY,
}


@dataclass(frozen=True)
class RankingThresholds:
    unusual_score: float = 55.0
    candidate_score: float = 70.0
    high_quality_score: float = 82.0
    candidate_percentile: float = 80.0
    high_quality_percentile: float = 95.0
    min_turnover_crore: float = 5.0


def build_runner_rankings(
    features: Iterable[RunnerFeatureSnapshot],
    *,
    limit: int = 10,
    score_version: str = "runner-score-v1",
    thresholds: RankingThresholds | None = None,
) -> list[dict[str, Any]]:
    """Rank eligible features against the live cross-section.

    Absolute component scores are combined with the percentile of that score in
    the current universe. Missing optional evidence contributes nothing and is
    disclosed through evidence completeness; missing core TOD evidence blocks
    ranking entirely.
    """

    config = thresholds or RankingThresholds()
    scored: list[tuple[RunnerFeatureSnapshot, dict[str, float], float, float]] = []
    for feature in features:
        if not _eligible(feature, config):
            continue
        components, completeness = _component_scores(feature)
        absolute = sum(components.values())
        scored.append((feature, components, absolute, completeness))

    if not scored:
        return []

    ordered_scores = sorted(row[2] for row in scored)
    rows: list[dict[str, Any]] = []
    for feature, components, absolute, completeness in scored:
        percentile = _percentile_rank(absolute, ordered_scores)
        final_score = min(100.0, absolute * 0.75 + percentile * 0.25)
        direction = _direction(feature)
        tier = _tier(
            final_score,
            percentile,
            completeness,
            direction,
            config,
        )
        rows.append(
            {
                "symbol": feature.symbol,
                "direction": direction,
                "runnerScore": round(final_score, 1),
                "absoluteScore": round(absolute, 1),
                "crossSectionPercentile": round(percentile, 1),
                "tier": tier,
                "rank": 0,
                "evidenceCompleteness": round(completeness, 2),
                "components": {
                    name: round(value, 1) for name, value in components.items()
                },
                "ltp": feature.ltp,
                "rvolTod20d": feature.rvol_tod_20d,
                "rvolTod60d": feature.rvol_tod_60d,
                "rvol1m": feature.rvol_1m,
                "rvol5m": feature.rvol_5m,
                "volumeAcceleration": feature.volume_acceleration,
                "turnoverCrore": round((feature.turnover or 0.0) / 10_000_000, 2),
                "ret5m": feature.ret_5m,
                "retFromOpen": feature.ret_from_open,
                "rangeTodRatio": feature.range_tod_ratio,
                "aboveVwap": feature.above_vwap,
                "pdhBreak": feature.pdh_break,
                "pdlBreak": feature.pdl_break,
                "sector": feature.sector,
                "sectorRelativeStrength": feature.sector_relative_strength,
                "freshnessSeconds": feature.freshness_seconds,
                "dataSource": feature.data_source.value,
                "dataQuality": [quality.value for quality in feature.data_quality],
                "scoreVersion": score_version,
                "entryReady": False,
                "reasons": _reasons(feature, components, percentile),
            }
        )

    rows.sort(
        key=lambda row: (
            row["runnerScore"],
            row["crossSectionPercentile"],
            row["rvolTod20d"],
            row["symbol"],
        ),
        reverse=True,
    )
    for index, row in enumerate(rows, 1):
        row["rank"] = index
    return rows[:limit]


def _eligible(feature: RunnerFeatureSnapshot, config: RankingThresholds) -> bool:
    qualities = set(feature.data_quality)
    turnover_crore = (
        feature.turnover / 10_000_000 if feature.turnover is not None else None
    )
    return not (
        qualities & BLOCKING_QUALITY
        or feature.rvol_tod_20d is None
        or feature.rvol_5m is None
        or turnover_crore is None
        or turnover_crore < config.min_turnover_crore
    )


def _component_scores(
    feature: RunnerFeatureSnapshot,
) -> tuple[dict[str, float], float]:
    evidence = [
        feature.rvol_tod_20d,
        feature.rvol_tod_60d,
        feature.rvol_1m,
        feature.rvol_5m,
        feature.volume_acceleration,
        feature.return_z_5m,
        feature.range_tod_ratio,
        feature.above_vwap,
        feature.sector_relative_strength,
    ]
    completeness = sum(value is not None for value in evidence) / len(evidence)
    direction = _direction(feature)

    participation = (
        _bounded_log(feature.rvol_tod_20d, 6.0, 22.0)
        + _bounded_log(feature.rvol_tod_60d, 5.0, 8.0)
        + _bounded_log(feature.rvol_5m, 6.0, 10.0)
    )
    velocity = _bounded_log(feature.rvol_1m, 8.0, 10.0) + _bounded_log(
        feature.volume_acceleration, 4.0, 10.0
    )
    price = _bounded_linear(_abs(feature.return_z_5m), 3.0, 8.0) + _bounded_linear(
        _abs(feature.ret_5m), 2.0, 7.0
    )
    range_score = _bounded_log(feature.range_tod_ratio, 3.0, 10.0)
    structure = _structure_score(feature, direction)
    context = _context_score(feature, direction)
    return (
        {
            "participation": participation,
            "velocity": velocity,
            "price": price,
            "range": range_score,
            "structure": structure,
            "context": context,
        },
        completeness,
    )


def _bounded_log(value: float | None, cap: float, weight: float) -> float:
    if value is None or value <= 0:
        return 0.0
    return weight * min(1.0, math.log1p(value) / math.log1p(cap))


def _bounded_linear(value: float | None, cap: float, weight: float) -> float:
    if value is None or value <= 0:
        return 0.0
    return weight * min(1.0, value / cap)


def _abs(value: float | None) -> float | None:
    return abs(value) if value is not None else None


def _structure_score(feature: RunnerFeatureSnapshot, direction: str) -> float:
    if direction == "UP":
        return min(
            10.0,
            (4.0 if feature.above_vwap is True else 0.0)
            + (3.0 if feature.pdh_break is True else 0.0)
            + (3.0 if feature.orb15_break_high is True else 0.0),
        )
    if direction == "DOWN":
        return min(
            10.0,
            (4.0 if feature.above_vwap is False else 0.0)
            + (3.0 if feature.pdl_break is True else 0.0)
            + (3.0 if feature.orb15_break_low is True else 0.0),
        )
    return 0.0


def _context_score(feature: RunnerFeatureSnapshot, direction: str) -> float:
    score = 0.0
    relative = feature.sector_relative_strength
    if relative is not None:
        aligned = (direction == "UP" and relative > 0) or (
            direction == "DOWN" and relative < 0
        )
        if aligned:
            score += _bounded_linear(abs(relative), 1.5, 6.0)
    market = feature.market_return
    if market is not None:
        aligned = (direction == "UP" and market > 0) or (
            direction == "DOWN" and market < 0
        )
        if aligned:
            score += _bounded_linear(abs(market), 1.0, 4.0)
    return min(10.0, score)


def _percentile_rank(score: float, ordered_scores: list[float]) -> float:
    if len(ordered_scores) == 1:
        return 100.0
    below_or_equal = sum(value <= score for value in ordered_scores)
    return 100.0 * (below_or_equal - 1) / (len(ordered_scores) - 1)


def _tier(
    score: float,
    percentile: float,
    completeness: float,
    direction: str,
    config: RankingThresholds,
) -> str:
    if (
        score >= config.high_quality_score
        and percentile >= config.high_quality_percentile
        and completeness >= 0.75
        and direction != "MIXED"
    ):
        return "HIGH_QUALITY"
    if (
        score >= config.candidate_score
        and percentile >= config.candidate_percentile
        and direction != "MIXED"
    ):
        return "RUNNER_CANDIDATE"
    if score >= config.unusual_score:
        return "STATISTICALLY_UNUSUAL"
    return "OBSERVE"


def _direction(feature: RunnerFeatureSnapshot) -> str:
    move = feature.ret_5m if feature.ret_5m is not None else feature.ret_from_open
    if move is None or move == 0:
        return "MIXED"
    if move > 0 and feature.above_vwap is not False:
        return "UP"
    if move < 0 and feature.above_vwap is not True:
        return "DOWN"
    return "MIXED"


def _reasons(
    feature: RunnerFeatureSnapshot,
    components: dict[str, float],
    percentile: float,
) -> list[str]:
    reasons = [
        f"top {max(1, round(100 - percentile))}% of the eligible live cross-section",
        f"{feature.rvol_tod_20d:.1f}x normal cumulative volume at this minute",
        f"{feature.rvol_5m:.1f}x expected volume in the latest 5-minute window",
    ]
    strongest = max(components, key=components.get)
    reasons.append(f"strongest score component: {strongest}")
    return reasons
