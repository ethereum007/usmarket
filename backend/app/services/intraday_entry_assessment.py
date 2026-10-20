"""Explainable Intraday entry checks, independent of Radar ranking.

The fixed 2R target is a planning reference, not a forecast. These rules have
not been calibrated to a win probability and never place an order.
"""

import math
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
POLICY = {"maxSignalAgeMinutes": 15, "maxQuoteAgeSeconds": 180,
          "maxCandleLagSeconds": 360, "maxEntryDistanceR": 0.5,
          "minRemainingRewardRisk": 1.5, "referenceTargetR": 2.0}


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def timestamp(value):
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000 if value > 10_000_000_000 else value, IST)
        result = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.astimezone(IST) if result.tzinfo else result.replace(tzinfo=IST)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def complete_session(bars: list[dict], now: datetime) -> bool:
    """Require every completed 5-minute bucket from the open through now."""
    start = datetime.combine(now.date(), time(9, 15), IST)
    end = min(now, datetime.combine(now.date(), time(15, 30), IST))
    count = max(0, int((end - start).total_seconds() // 300))
    stamps = {timestamp(row.get("bar_start")) for row in bars}
    return count > 0 and all(start + timedelta(minutes=5 * i) in stamps for i in range(count))


def assess_entry(signal: dict, meta: dict, bars: list[dict], now: datetime,
                 *, market_open: bool, feed_healthy: bool = True) -> dict:
    short = signal.get("direction") == "SHORT"
    sign = -1 if short else 1
    signal_at = timestamp(signal.get("signalTime"))
    trigger = number(signal.get("triggerPrice"))
    level = number(signal.get("breakoutLevel"))
    ltp = number(meta.get("ltp"))
    quote_at = timestamp((meta.get("freshness") or {}).get("exchangeTimestamp"))
    radar_at = timestamp(meta.get("radarAsOf"))
    timeframe = int(signal.get("timeframeMinutes") or 5)
    valid_bars = sorted(
        (row for row in bars if timestamp(row.get("bar_start")) is not None
         and timestamp(row["bar_start"]).date() == now.date()
         and timestamp(row["bar_start"]) + timedelta(minutes=5) <= now),
        key=lambda row: timestamp(row["bar_start"]),
    )
    latest_end = timestamp(valid_bars[-1]["bar_start"]) + timedelta(minutes=5) if valid_bars else None
    age = (now - signal_at).total_seconds() / 60 if signal_at else None
    confirmation = [row for row in valid_bars if signal_at
                    and signal_at - timedelta(minutes=timeframe) <= timestamp(row["bar_start"]) < signal_at]
    confirmed = bool(signal_at and signal_at.date() == now.date() and signal_at <= now
                     and trigger and level and sign * (trigger - level) > 0
                     and len(confirmation) == timeframe // 5
                     and abs(float(confirmation[-1]["close"]) - trigger) < 0.011)
    retracement_at = timestamp(signal.get("retracementBarStart"))
    stop_bars = [row for row in valid_bars if retracement_at and signal_at
                 and retracement_at <= timestamp(row["bar_start"]) < min(retracement_at + timedelta(minutes=timeframe), signal_at)]
    stop_bars = stop_bars or confirmation
    stop = target = risk = remaining_rr = distance_r = distance_pct = None
    if confirmed and stop_bars:
        buffer = max(trigger * 0.001, 0.05)
        stop = (max(float(row["high"]) for row in stop_bars) + buffer if short
                else min(float(row["low"]) for row in stop_bars) - buffer)
        risk = sign * (trigger - stop)
        if risk > 0:
            target = trigger + sign * POLICY["referenceTargetR"] * risk
            # A known opposing previous-session level limits the planning target.
            obstacle = number(meta.get("pdl" if short else "pdh"))
            if obstacle and 0 < sign * (obstacle - trigger) < sign * (target - trigger):
                target = obstacle
            if ltp and sign * (ltp - stop) > 0:
                remaining_rr = sign * (target - ltp) / (sign * (ltp - stop))
                distance_r = sign * (ltp - trigger) / risk
                distance_pct = sign * (ltp - trigger) / trigger * 100
    after = [row for row in valid_bars if signal_at and timestamp(row["bar_start"]) >= signal_at]
    stop_hit = bool(stop is not None and (
        any((float(row["high"]) >= stop if short else float(row["low"]) <= stop) for row in after)
        or (ltp and sign * (ltp - stop) <= 0)))
    level_failed = bool(level and (
        any(sign * (float(row["close"]) - level) <= 0 for row in after)
        or (ltp and sign * (ltp - level) <= 0)))
    target_hit = bool(target is not None and (
        any((float(row["low"]) <= target if short else float(row["high"]) >= target) for row in after)
        or (ltp and sign * (ltp - target) >= 0)))
    fresh = bool(feed_healthy and ltp and ltp > 0 and quote_at and radar_at and latest_end
                 and quote_at.date() == now.date() and radar_at.date() == now.date()
                 and 0 <= (now - quote_at).total_seconds() <= POLICY["maxQuoteAgeSeconds"]
                 and 0 <= (now - radar_at).total_seconds() <= POLICY["maxQuoteAgeSeconds"]
                 and 0 <= (now - latest_end).total_seconds() <= POLICY["maxCandleLagSeconds"])
    context_ok = bool(not meta.get("dataWarnings") and all(
        (number(meta.get(key)) or 0) > 0 for key in ("vwap", "pdh", "pdl")))
    direction_ok = meta.get("bias") == ("SHORT" if short else "LONG") and not meta.get("monitorOnly")
    vwap = number(meta.get("vwap"))
    vwap_ok = bool(vwap and ltp and sign * (ltp - vwap) > 0)
    checks = [
        {"label": "Fresh quote and Radar context", "passed": fresh},
        {"label": "Complete session candles", "passed": complete_session(valid_bars, now)},
        {"label": "Completed-candle confirmation", "passed": confirmed},
        {"label": "Daily levels and VWAP available", "passed": context_ok},
        {"label": "Current direction and VWAP agree", "passed": bool(direction_ok and vwap_ok)},
        {"label": "Signal no older than 15 minutes", "passed": age is not None and 0 <= age <= POLICY["maxSignalAgeMinutes"]},
        {"label": "No stop touch or failed level since confirmation", "passed": not stop_hit and not level_failed and confirmed},
        {"label": "Entry no more than 0.5R beyond confirmation", "passed": distance_r is not None and distance_r <= POLICY["maxEntryDistanceR"]},
        {"label": "At least 1.5R remains to reference target", "passed": target is not None and target > 0 and remaining_rr is not None and remaining_rr >= POLICY["minRemainingRewardRisk"]},
    ]
    if not market_open:
        status, reason = "MARKET_CLOSED", "Session closed; levels are for review."
    elif not fresh or not context_ok or not checks[1]["passed"] or not confirmed:
        status, reason = "DATA_CHECK", "Wait for fresh data, complete candles and daily context."
    elif stop_hit or level_failed:
        status, reason = "INVALIDATED", "The stop was touched or price failed the confirmed level."
    elif target_hit:
        status, reason = "TARGET_REACHED", "The reference target was already reached; wait for a new setup."
    elif age is None or age > POLICY["maxSignalAgeMinutes"]:
        status, reason = "EXPIRED", "Confirmation is older than 15 minutes; wait for a new setup."
    elif distance_r is not None and distance_r > POLICY["maxEntryDistanceR"]:
        status, reason = "EXTENDED", "Price is more than 0.5R beyond confirmation."
    elif not all(item["passed"] for item in checks):
        status, reason = "WAIT", "Direction, VWAP or remaining reward/risk needs confirmation."
    else:
        status, reason = "CHECKS_PASSED", "Entry checks pass; review the chart and execution costs."
    def rounded(value):
        return round(value, 2) if value is not None else None
    return {
        "status": status, "reason": reason, "checks": checks,
        "asOf": now.isoformat(), "signalAgeMinutes": rounded(age),
        "quoteAsOf": quote_at.isoformat() if quote_at else None,
        "entry": rounded(ltp), "confirmationPrice": rounded(trigger),
        "stop": rounded(stop), "referenceTarget": rounded(target),
        "remainingRewardRisk": rounded(remaining_rr), "entryDistanceR": rounded(distance_r),
        "entryDistancePct": rounded(distance_pct),
        "targetBasis": "2R from confirmation, limited by a known opposing previous-day level. A planning reference, not a price forecast.",
        "policyVersion": "intraday-entry-v1", "policy": POLICY,
    }
