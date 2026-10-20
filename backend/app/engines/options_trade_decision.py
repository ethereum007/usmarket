"""Options trade decision layer.

This sits above the direction engine and turns the Greeks/OI read into a
conservative trader workflow: TRADE, WAIT, HOLD, or EXIT. It is intentionally
not an order recommendation; it gives triggers, invalidation, and reliability.
"""

from __future__ import annotations

from typing import Any


DecisionAction = str


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _format_level(value: float | None) -> str:
    if value is None:
        return "-"
    if abs(value - round(value)) < 0.01:
        return f"{round(value):,}"
    return f"{value:,.2f}"


def _format_pct(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:+.2f}%"


def _levels(analytics: dict[str, Any], key: str) -> list[float]:
    raw = analytics.get(key) or []
    values: list[float] = []
    if isinstance(raw, list):
        for item in raw:
            value = _safe_float(item)
            if value > 0 and value not in values:
                values.append(value)
    return values


def _nearest_above(levels: list[float], spot: float) -> float | None:
    above = [level for level in levels if level >= spot]
    return min(above) if above else (max(levels) if levels else None)


def _nearest_below(levels: list[float], spot: float) -> float | None:
    below = [level for level in levels if level <= spot]
    return max(below) if below else (min(levels) if levels else None)


def _next_above(levels: list[float], spot: float, current: float | None) -> float | None:
    above = sorted(level for level in levels if level > (current or spot))
    return above[0] if above else None


def _next_below(levels: list[float], spot: float, current: float | None) -> float | None:
    below = sorted((level for level in levels if level < (current or spot)), reverse=True)
    return below[0] if below else None


def _component(direction: dict[str, Any], key: str) -> dict[str, Any]:
    for item in direction.get("components") or []:
        if item.get("key") == key:
            return item
    return {}


def _is_reading(direction: dict[str, Any], key: str, reading: str) -> bool:
    return _component(direction, key).get("reading") == reading


def _truthy_check(label: str, ok: bool, detail: str) -> dict[str, Any]:
    return {"label": label, "ok": bool(ok), "detail": detail}


def _reliability(
    snapshot: dict[str, Any],
    *,
    cached: bool,
    stale: bool,
    market_open: bool,
    warning: str | None,
) -> dict[str, Any]:
    provider = snapshot.get("provider") or {}
    provider_name = str(provider.get("provider") or "unknown")
    fallback = bool(provider.get("fallback"))

    score = 100
    reasons: list[str] = []
    if not market_open:
        score -= 20
        reasons.append("Market is closed")
    if cached:
        score -= 25
        reasons.append("Cached snapshot")
    if stale:
        score -= 30
        reasons.append("Stale fallback")
    if fallback:
        score -= 15
        reasons.append("Provider fallback")
    if provider_name == "unknown":
        score -= 10
        reasons.append("Provider not tagged")
    if warning:
        score -= 10
        reasons.append(str(warning)[:120])

    score = max(0, min(100, score))
    if stale:
        status = "STALE"
    elif cached:
        status = "CACHED"
    elif not market_open:
        status = "CLOSED"
    else:
        status = "LIVE"

    return {
        "status": status,
        "score": score,
        "provider": provider_name,
        "fallback": fallback,
        "tradeable": market_open and not cached and not stale and score >= 70,
        "reasons": reasons,
    }


def build_options_trade_decision(
    snapshot: dict[str, Any],
    *,
    cached: bool = False,
    stale: bool = False,
    market_open: bool = True,
    warning: str | None = None,
) -> dict[str, Any]:
    """Build a conservative index options decision card from a chain snapshot."""
    direction = snapshot.get("direction") or {}
    analytics = snapshot.get("analytics") or {}
    greeks = direction.get("greeks") or {}
    levels = direction.get("levels") or {}

    spot = _safe_float(snapshot.get("spot"))
    prev_close = _safe_float(snapshot.get("prevClose"))
    strike_step = _safe_float(snapshot.get("strikeStep"), 50.0) or 50.0
    change_pct = ((spot - prev_close) / prev_close * 100.0) if spot and prev_close else None

    direction_label = str(direction.get("direction") or "NO_VIEW")
    confidence = _safe_int(direction.get("confidence"))
    score = _safe_float(direction.get("score"))
    pcr = _safe_float(analytics.get("pcr"))
    max_pain = _safe_float(levels.get("maxPain") or analytics.get("maxPainStrike"))
    days_to_expiry = _safe_float(greeks.get("daysToExpiry"))

    supports = _levels(analytics, "support") or _levels(levels, "support")
    resistances = _levels(analytics, "resistance") or _levels(levels, "resistance")
    nearest_support = _nearest_below(supports, spot)
    nearest_resistance = _nearest_above(resistances, spot)
    next_resistance = _next_above(resistances, spot, nearest_resistance)
    next_support = _next_below(supports, spot, nearest_support)

    reliability = _reliability(
        snapshot,
        cached=cached,
        stale=stale,
        market_open=market_open,
        warning=warning,
    )

    price_bullish = _is_reading(direction, "price", "BULLISH")
    price_bearish = _is_reading(direction, "price", "BEARISH")
    oi_bullish = _is_reading(direction, "oi", "BULLISH")
    oi_bearish = _is_reading(direction, "oi", "BEARISH")
    pcr_bullish = _is_reading(direction, "pcr", "BULLISH")
    pcr_bearish = _is_reading(direction, "pcr", "BEARISH")
    pin_risk = (
        days_to_expiry <= 1.5
        and max_pain > 0
        and abs(spot - max_pain) <= max(strike_step * 1.25, spot * 0.004)
    )

    bullish_confirmed = direction_label == "BULLISH" and confidence >= 72 and price_bullish and (oi_bullish or pcr_bullish)
    bearish_confirmed = direction_label == "BEARISH" and confidence >= 72 and price_bearish and (oi_bearish or pcr_bearish)
    directional_confirmed = (bullish_confirmed or bearish_confirmed) and not pin_risk

    action: DecisionAction = "WAIT"
    bias = "NONE"
    quality = "NO_TRADE"
    mode = "NO_VIEW"
    summary = "Wait. The option chain is not giving a clean tradable edge yet."

    if direction_label == "BULLISH":
        bias = "LONG"
        mode = "WAIT_FOR_BREAKOUT"
        summary = "Bullish bias is forming, but wait for price and OI confirmation before acting."
    elif direction_label == "BEARISH":
        bias = "SHORT"
        mode = "WAIT_FOR_BREAKDOWN"
        summary = "Bearish bias is forming, but wait for price and OI confirmation before acting."
    elif direction_label == "SIDEWAYS":
        bias = "RANGE"
        mode = "RANGE_OR_EXPIRY_PIN"
        summary = "Wait. Direction is sideways and the chain favors range or pin behavior."

    if not reliability["tradeable"]:
        mode = "STALE_OR_CLOSED_DATA"
        summary = "Wait. Use these levels as a map only because the snapshot is not fresh enough for execution."
    elif pin_risk:
        mode = "EXPIRY_PIN_RISK"
        summary = "Wait. Expiry-day gamma and max-pain proximity increase chop/pin risk."
    elif directional_confirmed:
        action = "TRADE"
        quality = "A" if confidence >= 82 else "B"
        mode = "DIRECTIONAL_CONFIRMATION"
        summary = (
            "Long trade candidate: price, OI, and sentiment are aligned."
            if bullish_confirmed
            else "Short trade candidate: price, OI, and sentiment are aligned."
        )
    elif direction_label in {"BULLISH", "BEARISH"} and confidence >= 60:
        quality = "C"

    if action != "TRADE" and quality != "C":
        quality = "NO_TRADE"

    if bias == "LONG":
        entry_trigger = (
            f"5-min close above {_format_level(nearest_resistance)} with PE OI build-up intact."
            if nearest_resistance
            else "5-min upside close with PE OI build-up intact."
        )
        invalidation = (
            f"Long view weakens below {_format_level(nearest_support)} or if near-ATM OI flips bearish."
            if nearest_support
            else "Long view weakens if near-ATM OI flips bearish."
        )
        targets = [level for level in (nearest_resistance, next_resistance, max_pain if max_pain > spot else None) if level]
    elif bias == "SHORT":
        entry_trigger = (
            f"5-min close below {_format_level(nearest_support)} with CE OI build-up intact."
            if nearest_support
            else "5-min downside close with CE OI build-up intact."
        )
        invalidation = (
            f"Short view weakens above {_format_level(nearest_resistance)} or if near-ATM OI flips bullish."
            if nearest_resistance
            else "Short view weakens if near-ATM OI flips bullish."
        )
        targets = [level for level in (nearest_support, next_support, max_pain if 0 < max_pain < spot else None) if level]
    else:
        entry_trigger = (
            f"No directional entry until price accepts above {_format_level(nearest_resistance)} or below {_format_level(nearest_support)}."
            if nearest_resistance and nearest_support
            else "No directional entry until price and OI resolve."
        )
        invalidation = "Range view invalidates once price closes outside the main OI wall with OI following."
        targets = [level for level in (nearest_support, max_pain if max_pain else None, nearest_resistance) if level]

    timeframe = (
        "Expiry-day read: use 5-minute confirmation and reassess quickly."
        if days_to_expiry <= 1.5
        else "Intraday read: use 5-15 minute confirmation before entry."
    )

    risk_notes: list[str] = []
    if pin_risk:
        risk_notes.append("Spot is close to max pain; breakout failures can be fast.")
    if pcr and (pcr < 0.75 or pcr > 1.3):
        risk_notes.append(f"PCR is stretched at {pcr:.2f}; avoid chasing late entries.")
    if reliability["status"] != "LIVE":
        risk_notes.append("Fresh broker data is required before treating this as executable.")
    if direction.get("warnings"):
        risk_notes.extend(str(item) for item in direction.get("warnings", [])[:2])

    hold_level = nearest_support if bias == "LONG" else nearest_resistance if bias == "SHORT" else max_pain
    exit_level = nearest_support if bias == "LONG" else nearest_resistance if bias == "SHORT" else None

    return {
        "action": action,
        "bias": bias,
        "quality": quality,
        "mode": mode,
        "confidence": min(100, max(0, confidence if reliability["tradeable"] else min(confidence, reliability["score"]))),
        "score": round(score, 2),
        "summary": summary,
        "entryTrigger": entry_trigger,
        "invalidation": invalidation,
        "targets": [_format_level(level) for level in targets[:3]],
        "timeframe": timeframe,
        "spotContext": {
            "spot": spot,
            "changePct": round(change_pct, 2) if change_pct is not None else None,
            "maxPain": max_pain or None,
            "nearestSupport": nearest_support,
            "nearestResistance": nearest_resistance,
        },
        "reliability": reliability,
        "checks": [
            _truthy_check("Fresh data", reliability["tradeable"], f"{reliability['status']} via {reliability['provider']}"),
            _truthy_check("Direction aligned", direction_label in {"BULLISH", "BEARISH"}, direction_label.replace("_", " ")),
            _truthy_check("Price confirms", price_bullish or price_bearish, _format_pct(change_pct)),
            _truthy_check("OI confirms", oi_bullish or oi_bearish or pcr_bullish or pcr_bearish, f"PCR {pcr:.2f}" if pcr else "PCR -"),
            _truthy_check("Pin risk clear", not pin_risk, f"DTE {days_to_expiry:.1f}, max pain {_format_level(max_pain) if max_pain else '-'}"),
        ],
        "riskNotes": risk_notes,
        "positionPlan": {
            "available": False,
            "holdCondition": (
                f"Hold existing {bias.lower()} bias only while price respects {_format_level(hold_level)} and OI stays aligned."
                if hold_level and bias in {"LONG", "SHORT"}
                else "Hold only when price and OI remain aligned."
            ),
            "exitCondition": (
                f"Exit or reduce if price closes beyond {_format_level(exit_level)} against the bias."
                if exit_level and bias in {"LONG", "SHORT"}
                else "Exit if the range breaks against your position or OI flips."
            ),
            "note": "Broker positions are not connected yet, so HOLD/EXIT is a manual checklist for now.",
        },
    }
