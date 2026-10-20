"""Index fall-capture engine for options snapshots.

This layer answers a narrower question than the full direction engine:
"Are we seeing a live downside breakdown that traders should notice now?"
It deliberately outputs context, trigger levels, and risk flags, not an order.
"""

from __future__ import annotations

import math
from typing import Any


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _format_level(value: float | None) -> str:
    if value is None or value <= 0:
        return "-"
    if abs(value - round(value)) < 0.01:
        return f"{round(value):,}"
    return f"{value:,.2f}"


def _format_oi(value: float) -> str:
    sign = "-" if value < 0 else ""
    abs_value = abs(value)
    if abs_value >= 10_000_000:
        return f"{sign}{abs_value / 10_000_000:.1f}Cr"
    if abs_value >= 100_000:
        return f"{sign}{abs_value / 100_000:.1f}L"
    if abs_value >= 1_000:
        return f"{sign}{abs_value / 1_000:.1f}K"
    return f"{sign}{abs_value:.0f}"


def _leg(row: dict[str, Any], key: str) -> dict[str, Any]:
    value = row.get(key)
    return value if isinstance(value, dict) else {}


def _unique_levels(raw: Any) -> list[float]:
    values: list[float] = []
    if not isinstance(raw, list):
        return values
    for item in raw:
        value = _safe_float(item)
        if value > 0 and value not in values:
            values.append(value)
    return values


def _nearest_above(levels: list[float], spot: float) -> float | None:
    above = [level for level in levels if level >= spot]
    return min(above) if above else None


def _nearest_below(levels: list[float], spot: float) -> float | None:
    below = [level for level in levels if level <= spot]
    return max(below) if below else None


def _round_down(value: float, step: float) -> float:
    if step <= 0:
        return value
    return math.floor(value / step) * step


def _round_up(value: float, step: float) -> float:
    if step <= 0:
        return value
    return math.ceil(value / step) * step


def _check(label: str, ok: bool, detail: str) -> dict[str, Any]:
    return {"label": label, "ok": bool(ok), "detail": detail}


def _near_rows(
    chain: list[dict[str, Any]],
    *,
    spot: float,
    anchor: float,
    strike_step: float,
) -> list[dict[str, Any]]:
    lower = min(spot, anchor) - strike_step * 2.0
    upper = max(spot, anchor) + strike_step * 2.0
    rows = [
        row
        for row in chain
        if lower <= _safe_float(row.get("strike")) <= upper
    ]
    if rows:
        return rows
    return sorted(chain, key=lambda row: abs(_safe_float(row.get("strike")) - spot))[:7]


def build_options_fall_capture(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Detect a bearish index breakdown from price location and OI pressure."""
    chain = sorted(snapshot.get("chain") or [], key=lambda row: _safe_float(row.get("strike")))
    spot = _safe_float(snapshot.get("spot"))
    prev_close = _safe_float(snapshot.get("prevClose"))
    analytics = snapshot.get("analytics") or {}
    direction = snapshot.get("direction") or {}
    strike_step = _safe_float(snapshot.get("strikeStep"), 50.0) or 50.0

    if not chain or spot <= 0:
        return {
            "state": "NO_DATA",
            "bias": "NO_VIEW",
            "score": 0,
            "confidence": 0,
            "summary": "Fall capture is unavailable because the option chain is empty.",
            "levels": {},
            "metrics": {},
            "checks": [_check("Chain data", False, "Missing option-chain rows")],
            "warnings": ["Missing option-chain data"],
        }

    max_pain = _safe_float(analytics.get("maxPainStrike"))
    supports = _unique_levels(analytics.get("support"))
    resistances = _unique_levels(analytics.get("resistance"))
    levels_for_resistance = sorted({*resistances, *([max_pain] if max_pain > 0 else [])})

    nearest_resistance = _nearest_above(levels_for_resistance, spot)
    if nearest_resistance is None:
        nearest_resistance = max_pain if max_pain > 0 else _round_up(spot, strike_step)

    breakdown_level = nearest_resistance
    if max_pain > 0 and spot < max_pain:
        breakdown_level = max_pain

    confirmation_level = _round_down(breakdown_level - strike_step * 2.0, strike_step)
    continuation_level = _round_down(confirmation_level - strike_step * 2.0, strike_step)
    immediate_floor = _round_down(spot, strike_step)
    nearby_support = _nearest_below(supports, spot)
    next_support = nearby_support if nearby_support and nearby_support < spot else continuation_level

    change = spot - prev_close if prev_close > 0 else 0.0
    change_pct = (change / prev_close * 100.0) if prev_close > 0 else 0.0
    price_drop_pts = max(0.0, -change)
    price_context_stale = prev_close <= 0 or abs(prev_close - spot) < 0.01

    rows = _near_rows(chain, spot=spot, anchor=breakdown_level, strike_step=strike_step)
    ce_build = sum(max(_safe_float(_leg(row, "call").get("oiChange")), 0.0) for row in rows)
    pe_build = sum(max(_safe_float(_leg(row, "put").get("oiChange")), 0.0) for row in rows)
    ce_oi = sum(max(_safe_float(_leg(row, "call").get("oi")), 0.0) for row in rows)
    pe_oi = sum(max(_safe_float(_leg(row, "put").get("oi")), 0.0) for row in rows)
    build_ratio = ce_build / max(pe_build, 1.0)
    oi_ratio = ce_oi / max(pe_oi, 1.0)

    pcr = _safe_float(analytics.get("pcr"))
    direction_label = str(direction.get("direction") or "NO_VIEW")
    direction_confidence = _safe_float(direction.get("confidence"))

    score = 0.0
    if price_context_stale:
        score += 5
    elif price_drop_pts >= strike_step * 4:
        score += 35
    elif price_drop_pts >= strike_step * 2:
        score += 28
    elif price_drop_pts >= strike_step:
        score += 18
    elif change_pct <= -0.25:
        score += 12

    below_breakdown = spot < breakdown_level
    below_confirmation = spot < confirmation_level
    if below_breakdown:
        score += 18
    if below_confirmation:
        score += 14
    if max_pain > 0 and spot < max_pain:
        score += 12

    if build_ratio >= 2.0:
        score += 24
    elif build_ratio >= 1.35:
        score += 16
    elif build_ratio >= 1.05:
        score += 8

    if oi_ratio >= 1.25:
        score += 8

    if pcr and pcr < 0.85:
        score += 12
    elif pcr and pcr < 1.0:
        score += 8

    if direction_label == "BEARISH":
        score += 12
        if direction_confidence >= 70:
            score += 8
    elif direction_label == "BULLISH":
        score -= 18

    score = max(0, min(100, round(score)))

    if score >= 70 and below_breakdown:
        state = "FALL_ACTIVE"
        bias = "SHORT_BIAS"
        summary = "Downside breakdown is active: price is below the key OI wall and call writing is capping rebounds."
    elif score >= 55 and (below_breakdown or abs(spot - breakdown_level) <= strike_step * 0.5):
        state = "FALL_STARTING"
        bias = "SHORT_WATCH"
        summary = "Fall risk is building: watch the breakdown wall closely and require a clean lower close."
    elif score >= 42:
        state = "WATCH_BREAKDOWN"
        bias = "WATCH"
        summary = "Bearish pressure is visible, but price has not given a clean breakdown yet."
    else:
        state = "WAIT"
        bias = "NO_VIEW"
        summary = "No clean downside capture yet; wait for price to break an OI wall with CE build-up."

    chase_distance = max(0.0, breakdown_level - spot)
    chase_risk = state == "FALL_ACTIVE" and chase_distance >= strike_step * 3.0

    if state == "FALL_ACTIVE":
        trigger = f"Fall triggered below {_format_level(breakdown_level)}."
        confirmation = (
            f"Breakdown confirmed below {_format_level(confirmation_level)}."
            if spot < confirmation_level
            else f"Fresh confirmation below {_format_level(confirmation_level)}."
        )
        invalidation = f"Bearish view weakens above {_format_level(breakdown_level)}."
    elif state in {"FALL_STARTING", "WATCH_BREAKDOWN"}:
        trigger = f"Alert if NIFTY accepts below {_format_level(breakdown_level)}."
        confirmation = f"Confirm only below {_format_level(confirmation_level)} with CE OI still building."
        invalidation = f"Bearish watch cancels above {_format_level(nearest_resistance)}."
    else:
        trigger = f"No fall trade until price loses {_format_level(breakdown_level)}."
        confirmation = f"Confirm below {_format_level(confirmation_level)}."
        invalidation = "Stay neutral until price and OI align."

    warnings: list[str] = []
    if price_context_stale:
        warnings.append("Previous close from the chain is stale/equal to spot; fall capture is leaning more on OI walls.")
    if chase_risk:
        warnings.append("Move is already extended from the breakdown wall; avoid chasing without a pullback or fresh continuation.")

    return {
        "state": state,
        "bias": bias,
        "score": score,
        "confidence": min(94, max(20, int(score * 0.85 + (direction_confidence * 0.15 if direction_confidence else 0)))),
        "summary": summary,
        "trigger": trigger,
        "confirmation": confirmation,
        "invalidation": invalidation,
        "timeframe": "Use 5-minute acceptance for trigger and 15-minute structure for follow-through.",
        "chaseRisk": chase_risk,
        "levels": {
            "spot": round(spot, 2),
            "breakdown": breakdown_level,
            "confirmation": confirmation_level,
            "continuation": continuation_level,
            "invalidation": breakdown_level,
            "immediateFloor": immediate_floor,
            "nextSupport": next_support,
        },
        "metrics": {
            "changePts": round(change, 2) if prev_close > 0 else None,
            "changePct": round(change_pct, 2) if prev_close > 0 else None,
            "pcr": pcr or None,
            "ceBuild": ce_build,
            "peBuild": pe_build,
            "ceBuildText": _format_oi(ce_build),
            "peBuildText": _format_oi(pe_build),
            "cePeBuildRatio": round(build_ratio, 2),
            "cePeOiRatio": round(oi_ratio, 2),
            "maxPain": max_pain or None,
        },
        "checks": [
            _check("Below OI wall", below_breakdown, f"Spot {_format_level(spot)} vs wall {_format_level(breakdown_level)}"),
            _check("Breakdown confirmed", below_confirmation, f"Confirmation below {_format_level(confirmation_level)}"),
            _check("CE build-up", build_ratio >= 1.35, f"CE { _format_oi(ce_build) } vs PE { _format_oi(pe_build) }"),
            _check("PCR below 1", bool(pcr and pcr < 1.0), f"PCR {pcr:.2f}" if pcr else "PCR -"),
            _check("Direction aligned", direction_label == "BEARISH", direction_label.replace("_", " ")),
        ],
        "warnings": warnings,
    }
