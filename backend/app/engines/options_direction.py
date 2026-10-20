"""Options direction regime engine.

The goal of this first pass is deliberately narrow: classify index direction
from the live option-chain snapshot without making a trade recommendation.
"""

from __future__ import annotations

import math
from datetime import datetime, time as dt_time
from typing import Any


Direction = str


def _norm_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _norm_pdf(value: float) -> float:
    return math.exp(-0.5 * value * value) / math.sqrt(2.0 * math.pi)


def _parse_expiry(expiry: Any) -> datetime | None:
    if isinstance(expiry, datetime):
        return expiry
    if not expiry:
        return None

    raw = str(expiry)
    for fmt in ("%Y-%m-%d", "%a %b %d %Y", "%d %b %Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            parsed = datetime.strptime(raw, fmt)
            return datetime.combine(parsed.date(), dt_time(hour=15, minute=30))
        except ValueError:
            continue
    return None


def _years_to_expiry(expiry: Any, now: datetime | None = None) -> tuple[float, float]:
    now = now or datetime.now()
    expiry_dt = _parse_expiry(expiry)
    if not expiry_dt:
        return 1.0 / 365.0, 1.0

    seconds = max((expiry_dt - now).total_seconds(), 60 * 30)
    days = seconds / 86400.0
    return days / 365.0, days


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _leg(row: dict[str, Any], key: str) -> dict[str, Any]:
    leg = row.get(key)
    return leg if isinstance(leg, dict) else {}


def _option_greeks(
    *,
    spot: float,
    strike: float,
    iv_pct: float,
    years: float,
    option_type: str,
    risk_free_rate: float = 0.06,
) -> dict[str, float]:
    if spot <= 0 or strike <= 0 or iv_pct <= 0 or years <= 0:
        return {"delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0}

    sigma = iv_pct / 100.0
    sqrt_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (risk_free_rate + 0.5 * sigma * sigma) * years) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    pdf = _norm_pdf(d1)

    if option_type == "CE":
        delta = _norm_cdf(d1)
        theta = (
            -(spot * pdf * sigma) / (2.0 * sqrt_t)
            - risk_free_rate * strike * math.exp(-risk_free_rate * years) * _norm_cdf(d2)
        ) / 365.0
    else:
        delta = _norm_cdf(d1) - 1.0
        theta = (
            -(spot * pdf * sigma) / (2.0 * sqrt_t)
            + risk_free_rate * strike * math.exp(-risk_free_rate * years) * _norm_cdf(-d2)
        ) / 365.0

    gamma = pdf / (spot * sigma * sqrt_t)
    vega = spot * pdf * sqrt_t / 100.0

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "vega": round(vega, 2),
        "theta": round(theta, 2),
    }


def _reading(score: float, *, strong: float = 1.4, weak: float = 0.5) -> Direction:
    if score >= strong:
        return "BULLISH"
    if score <= -strong:
        return "BEARISH"
    if abs(score) <= weak:
        return "SIDEWAYS"
    return "NO_VIEW"


def _tone_for_direction(direction: Direction) -> str:
    if direction == "BULLISH":
        return "profit"
    if direction == "BEARISH":
        return "loss"
    if direction == "SIDEWAYS":
        return "warning"
    return "muted"


def _component(key: str, label: str, reading: Direction, score: float, value: str, detail: str) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "reading": reading,
        "score": round(score, 2),
        "value": value,
        "detail": detail,
        "tone": _tone_for_direction(reading),
    }


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


def _weighted_near_atm_rows(chain: list[dict[str, Any]], spot: float, strike_step: float) -> list[dict[str, Any]]:
    band = max(strike_step * 2.0, spot * 0.01)
    rows = [row for row in chain if abs(_safe_float(row.get("strike")) - spot) <= band]
    if rows:
        return rows
    return sorted(chain, key=lambda row: abs(_safe_float(row.get("strike")) - spot))[:5]


def compute_options_direction(snapshot: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Return a direction-only regime for an index option-chain snapshot."""
    chain = snapshot.get("chain") or []
    spot = _safe_float(snapshot.get("spot"))
    prev_close = _safe_float(snapshot.get("prevClose"))
    analytics = snapshot.get("analytics") or {}
    strike_step = _safe_float(snapshot.get("strikeStep"), 50.0) or 50.0

    if not chain or spot <= 0:
        return {
            "direction": "NO_VIEW",
            "confidence": 0,
            "score": 0,
            "summary": "Direction unavailable because the option chain snapshot is empty.",
            "components": [],
            "greeks": {},
            "levels": {},
            "warnings": ["Missing option-chain data"],
        }

    years, days = _years_to_expiry(snapshot.get("expiry"), now)
    sorted_chain = sorted(chain, key=lambda row: _safe_float(row.get("strike")))
    atm_row = min(sorted_chain, key=lambda row: abs(_safe_float(row.get("strike")) - spot))
    atm_strike = _safe_float(atm_row.get("strike"))
    call = _leg(atm_row, "call")
    put = _leg(atm_row, "put")
    call_iv = _safe_float(call.get("iv"))
    put_iv = _safe_float(put.get("iv"))
    atm_iv = _safe_float(analytics.get("atmIV")) or ((call_iv + put_iv) / 2.0 if call_iv or put_iv else 0.0)

    call_greeks = _option_greeks(
        spot=spot,
        strike=atm_strike,
        iv_pct=call_iv or atm_iv,
        years=years,
        option_type="CE",
    )
    put_greeks = _option_greeks(
        spot=spot,
        strike=atm_strike,
        iv_pct=put_iv or atm_iv,
        years=years,
        option_type="PE",
    )

    change = spot - prev_close if prev_close > 0 else 0.0
    change_pct = (change / prev_close) * 100.0 if prev_close > 0 else 0.0
    if change_pct >= 0.6:
        price_score = 2.0
    elif change_pct >= 0.25:
        price_score = 1.0
    elif change_pct <= -0.6:
        price_score = -2.0
    elif change_pct <= -0.25:
        price_score = -1.0
    else:
        price_score = 0.0

    near_rows = _weighted_near_atm_rows(sorted_chain, spot, strike_step)
    ce_change = sum(_safe_float(_leg(row, "call").get("oiChange")) for row in near_rows)
    pe_change = sum(_safe_float(_leg(row, "put").get("oiChange")) for row in near_rows)
    oi_denominator = max(abs(ce_change) + abs(pe_change), 1.0)
    oi_score = max(-2.5, min(2.5, ((pe_change - ce_change) / oi_denominator) * 2.5))

    pcr = _safe_float(analytics.get("pcr"))
    if pcr >= 1.35:
        pcr_score = 1.5
    elif pcr >= 1.1:
        pcr_score = 0.75
    elif pcr <= 0.65 and pcr > 0:
        pcr_score = -1.5
    elif pcr <= 0.9 and pcr > 0:
        pcr_score = -0.75
    else:
        pcr_score = 0.0

    iv_skew = put_iv - call_iv
    if iv_skew >= 2.0:
        vega_score = -1.0
    elif iv_skew <= -2.0:
        vega_score = 1.0
    else:
        vega_score = 0.0

    max_pain = _safe_float(analytics.get("maxPainStrike"))
    max_pain_distance = spot - max_pain if max_pain else 0.0
    if max_pain and max_pain_distance >= strike_step:
        positioning_score = 0.8
    elif max_pain and max_pain_distance <= -strike_step:
        positioning_score = -0.8
    else:
        positioning_score = 0.0

    gamma_pressure = (call_greeks["gamma"] + abs(put_greeks["gamma"])) * spot
    theta_pressure = abs(call_greeks["theta"]) + abs(put_greeks["theta"])
    gamma_reading = "SIDEWAYS" if gamma_pressure >= 0.18 and abs(change_pct) < 0.5 else "NO_VIEW"
    theta_reading = "SIDEWAYS" if days <= 3 and theta_pressure > 0 else "NO_VIEW"

    score = price_score + oi_score + pcr_score + vega_score + positioning_score
    conflict = (
        (price_score >= 1.0 and oi_score <= -1.0)
        or (price_score <= -1.0 and oi_score >= 1.0)
        or (pcr_score >= 1.0 and oi_score <= -1.0)
        or (pcr_score <= -1.0 and oi_score >= 1.0)
    )
    if gamma_reading == "SIDEWAYS" and abs(score) < 3.0:
        score *= 0.75

    if conflict:
        direction = "NO_VIEW"
    elif score >= 2.4:
        direction = "BULLISH"
    elif score <= -2.4:
        direction = "BEARISH"
    elif abs(score) <= 0.9:
        direction = "SIDEWAYS"
    else:
        direction = "NO_VIEW"

    directional_components = [
        score
        for score in (price_score, oi_score, pcr_score, vega_score, positioning_score)
        if abs(score) >= 0.5
    ]
    alignment = 0.0
    if directional_components:
        aligned = [value for value in directional_components if value * score > 0]
        alignment = len(aligned) / len(directional_components)
    confidence = min(92, int(40 + abs(score) * 9 + alignment * 25))
    if conflict:
        confidence = min(confidence, 48)
    if direction in {"SIDEWAYS", "NO_VIEW"}:
        confidence = min(confidence, 62)

    components = [
        _component(
            "price",
            "Price",
            _reading(price_score, strong=1.0, weak=0.2),
            price_score,
            f"{change_pct:+.2f}%",
            "Spot move versus previous close.",
        ),
        _component(
            "oi",
            "OI Pressure",
            _reading(oi_score, strong=1.0, weak=0.35),
            oi_score,
            f"PE { _format_oi(pe_change) } / CE { _format_oi(ce_change) }",
            "Near-ATM put writing supports upside; call writing caps upside.",
        ),
        _component(
            "pcr",
            "PCR",
            _reading(pcr_score, strong=1.0, weak=0.4),
            pcr_score,
            f"{pcr:.2f}" if pcr else "-",
            "OI-based put/call positioning for the full chain.",
        ),
        _component(
            "vega",
            "Vega/IV Skew",
            _reading(vega_score, strong=0.9, weak=0.25),
            vega_score,
            f"{iv_skew:+.1f} IV pts" if call_iv or put_iv else "-",
            "Put IV premium points to fear; call IV premium points to upside demand.",
        ),
        _component(
            "positioning",
            "Positioning",
            _reading(positioning_score, strong=0.7, weak=0.25),
            positioning_score,
            f"{max_pain_distance:+.0f} vs max pain" if max_pain else "-",
            "Spot location versus max pain and major OI walls.",
        ),
        _component(
            "gamma",
            "Gamma",
            gamma_reading,
            0.0,
            f"{gamma_pressure:.2f}",
            "High near-ATM gamma with weak price movement often means chop/pinning.",
        ),
        _component(
            "theta",
            "Theta",
            theta_reading,
            0.0,
            f"{days:.1f}d",
            "Near-expiry decay favors range behaviour unless price breaks cleanly.",
        ),
    ]

    warnings: list[str] = []
    if conflict:
        warnings.append("Directional inputs are conflicting; treat this as no-view until price or OI resolves.")
    if not call_iv and not put_iv:
        warnings.append("ATM IV is missing; Greeks are approximated from available chain data.")

    if direction == "BULLISH":
        summary = "Directional bias is bullish because price and option positioning lean upward."
    elif direction == "BEARISH":
        summary = "Directional bias is bearish because price and option positioning lean downward."
    elif direction == "SIDEWAYS":
        summary = "Directional read is sideways; option positioning is not giving a clean trend."
    else:
        summary = "No clean directional edge yet; wait for price and options positioning to align."

    return {
        "direction": direction,
        "confidence": confidence,
        "score": round(score, 2),
        "summary": summary,
        "components": components,
        "greeks": {
            "atmStrike": atm_strike,
            "daysToExpiry": round(days, 2),
            "callDelta": call_greeks["delta"],
            "putDelta": put_greeks["delta"],
            "gamma": round((call_greeks["gamma"] + abs(put_greeks["gamma"])) / 2.0, 6),
            "vega": round((call_greeks["vega"] + put_greeks["vega"]) / 2.0, 2),
            "theta": round(call_greeks["theta"] + put_greeks["theta"], 2),
            "callIv": call_iv or None,
            "putIv": put_iv or None,
        },
        "levels": {
            "support": analytics.get("support") or [],
            "resistance": analytics.get("resistance") or [],
            "maxPain": max_pain or None,
            "maxPainDistance": round(max_pain_distance, 2) if max_pain else None,
        },
        "warnings": warnings,
    }
