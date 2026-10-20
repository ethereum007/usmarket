"""Multi-horizon NIFTY fear-pressure index.

The index is intentionally transparent: every score is a weighted blend of
observable market data and is returned with its component breakdown.  A high
score means more fear; a low score means more greed/risk appetite.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class Horizon:
    key: str
    label: str
    periods: int
    trend_periods: int
    peak_periods: int
    return_scale: float
    trend_scale: float
    vix_change_scale: float
    comparison_label: str


HORIZONS = (
    Horizon("daily", "Daily", 1, 20, 20, 1.5, 3.0, 8.0, "yesterday"),
    Horizon("weekly", "Weekly", 5, 40, 60, 4.0, 6.0, 15.0, "last week"),
    Horizon("monthly", "Monthly", 21, 63, 126, 8.0, 10.0, 25.0, "last month"),
)


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _return_pct(values: Sequence[float], periods: int, offset: int = 0) -> float:
    end = len(values) - 1 - offset
    start = end - periods
    if start < 0 or end < 0 or not values[start]:
        raise ValueError("Not enough price history for pulse index")
    return ((float(values[end]) / float(values[start])) - 1.0) * 100.0


def _fear_from_directional(value: float, scale: float) -> float:
    """Map a bullish positive value below 50 and a bearish value above 50."""
    return _clamp(50.0 - (value / scale) * 25.0)


def classify_score(score: float) -> tuple[str, str, str]:
    if score < 20:
        return "Extreme Greed", "extreme-greed", "Risk appetite is stretched. Stay selective."
    if score < 35:
        return "Greed", "greed", "Buyers are in control, but avoid chasing extended moves."
    if score < 50:
        return "Neutral", "neutral", "Positioning is balanced; wait for confirmation."
    if score < 65:
        return "Fear", "fear", "Risk appetite is weakening. Protect entries and size carefully."
    return "Extreme Fear", "extreme-fear", "Panic conditions can create selective opportunities."


def _score_at(
    nifty: Sequence[float],
    nifty500: Sequence[float],
    vix: Sequence[float],
    horizon: Horizon,
    offset: int = 0,
) -> tuple[float, list[dict]]:
    end = len(nifty) - 1 - offset
    if end < horizon.trend_periods:
        raise ValueError("Not enough NIFTY history for pulse index")
    if len(nifty500) - 1 - offset - horizon.periods < 0:
        raise ValueError("Not enough NIFTY 500 history for pulse index")
    if len(vix) - 1 - offset - horizon.periods < 0:
        raise ValueError("Not enough VIX history for pulse index")

    nifty_return = _return_pct(nifty, horizon.periods, offset)
    momentum_fear = _fear_from_directional(nifty_return, horizon.return_scale)

    trend_start = end - horizon.trend_periods + 1
    trend_window = [float(v) for v in nifty[trend_start : end + 1]]
    trend_average = sum(trend_window) / len(trend_window)
    trend_gap = ((float(nifty[end]) / trend_average) - 1.0) * 100.0
    trend_fear = _fear_from_directional(trend_gap, horizon.trend_scale)

    vix_end = len(vix) - 1 - offset
    current_vix = float(vix[vix_end])
    vix_return = _return_pct(vix, horizon.periods, offset)
    vix_level_fear = _clamp(((current_vix - 10.0) / 25.0) * 100.0)
    vix_change_fear = _clamp(50.0 + (vix_return / horizon.vix_change_scale) * 25.0)
    volatility_fear = (vix_level_fear * 0.75) + (vix_change_fear * 0.25)

    broad_return = _return_pct(nifty500, horizon.periods, offset)
    market_strength_fear = _fear_from_directional(broad_return, horizon.return_scale)

    peak_start = max(0, end - horizon.peak_periods + 1)
    recent_peak = max(float(v) for v in nifty[peak_start : end + 1])
    drawdown_pct = ((recent_peak - float(nifty[end])) / recent_peak) * 100.0 if recent_peak else 0.0
    drawdown_limit = {"daily": 6.0, "weekly": 12.0, "monthly": 20.0}[horizon.key]
    drawdown_fear = _clamp((drawdown_pct / drawdown_limit) * 100.0)

    raw_components = (
        ("NIFTY momentum", momentum_fear, 0.30, nifty_return, "%"),
        ("Trend position", trend_fear, 0.20, trend_gap, "% vs average"),
        ("India VIX", volatility_fear, 0.25, current_vix, "VIX"),
        ("Broad-market strength", market_strength_fear, 0.15, broad_return, "%"),
        ("Drawdown pressure", drawdown_fear, 0.10, drawdown_pct, "% from peak"),
    )
    score = sum(component_score * weight for _, component_score, weight, _, _ in raw_components)
    components = [
        {
            "name": name,
            "score": round(component_score, 1),
            "weight": int(weight * 100),
            "value": round(value, 2),
            "unit": unit,
        }
        for name, component_score, weight, value, unit in raw_components
    ]
    return round(_clamp(score), 1), components


def calculate_nifty_pulse(
    nifty_closes: Sequence[float],
    nifty500_closes: Sequence[float],
    vix_closes: Sequence[float],
) -> dict[str, dict]:
    """Return daily, weekly and monthly pulse scores plus prior-period comparisons."""
    output: dict[str, dict] = {}
    for horizon in HORIZONS:
        score, components = _score_at(nifty_closes, nifty500_closes, vix_closes, horizon)
        previous_score, _ = _score_at(
            nifty_closes,
            nifty500_closes,
            vix_closes,
            horizon,
            offset=horizon.periods,
        )
        label, zone, description = classify_score(score)
        delta = round(score - previous_score, 1)
        if abs(delta) < 0.05:
            comparison = f"Unchanged vs {horizon.comparison_label}"
        else:
            direction = "more fear" if delta > 0 else "less fear"
            comparison = f"{abs(delta):.1f} pts {direction} vs {horizon.comparison_label}"

        output[horizon.key] = {
            "key": horizon.key,
            "label": horizon.label,
            "score": score,
            "zone": zone,
            "sentiment": label,
            "description": description,
            "previousScore": previous_score,
            "change": delta,
            "comparison": comparison,
            "components": components,
        }
    return output
