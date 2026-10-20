"""Small dependency-free statistical primitives for hot Runner paths."""

from __future__ import annotations

import math
from collections.abc import Iterable
from itertools import pairwise
from statistics import mean, median, pstdev


def finite(values: Iterable[float | int | None]) -> list[float]:
    return [float(v) for v in values if v is not None and math.isfinite(float(v))]


def describe(
    values: Iterable[float | int | None],
) -> dict[str, float | int | dict[str, float] | None]:
    xs = sorted(finite(values))
    if not xs:
        return {
            "median": None,
            "mean": None,
            "std": None,
            "percentiles": {},
            "sample_count": 0,
        }
    return {
        "median": median(xs),
        "mean": mean(xs),
        "std": pstdev(xs) if len(xs) > 1 else 0.0,
        "percentiles": {
            "p10": percentile(xs, 10),
            "p25": percentile(xs, 25),
            "p75": percentile(xs, 75),
            "p90": percentile(xs, 90),
            "p95": percentile(xs, 95),
        },
        "sample_count": len(xs),
    }


def percentile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        raise ValueError("percentile requires observations")
    pos = (len(sorted_values) - 1) * pct / 100
    lower = math.floor(pos)
    upper = math.ceil(pos)
    if lower == upper:
        return sorted_values[lower]
    weight = pos - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def safe_ratio(actual: float | None, expected: float | None) -> float | None:
    if actual is None or expected is None or float(expected) <= 0:
        return None
    return float(actual) / float(expected)


def zscore(
    value: float | None, center: float | None, std: float | None
) -> float | None:
    if value is None or center is None or std is None or std <= 0:
        return None
    return (value - center) / std


def pct_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or previous == 0:
        return None
    return (current / previous - 1.0) * 100.0


def approximate_percentile(
    value: float | None, median_value: float | None, quantiles: dict[str, float] | None
) -> float | None:
    """Interpolate a percentile rank from stored robust quantile anchors."""
    if value is None or median_value is None or not quantiles:
        return None
    points = sorted(
        [
            (float(quantiles[key]), pct)
            for key, pct in (
                ("p10", 10),
                ("p25", 25),
                ("p75", 75),
                ("p90", 90),
                ("p95", 95),
            )
            if key in quantiles
        ]
        + [(float(median_value), 50)]
    )
    if not points:
        return None
    if value <= points[0][0]:
        return 5.0
    if value >= points[-1][0]:
        return 97.5
    for (left_value, left_pct), (right_value, right_pct) in pairwise(points):
        if left_value <= value <= right_value:
            if right_value == left_value:
                return float(max(left_pct, right_pct))
            weight = (value - left_value) / (right_value - left_value)
            return left_pct + weight * (right_pct - left_pct)
    return None
