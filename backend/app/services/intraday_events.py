"""Repeat confirmations and backward-compatible daily signal envelopes."""

from copy import deepcopy
from datetime import timedelta
from app.services.intraday_entry_assessment import timestamp


def retracement_events(bars: list[dict], minutes: int, *, short: bool = False) -> list[dict]:
    """Each event consumes its pullback; another event needs a NEW pullback.

    Breakout levels still use every earlier session high/low. Expiry alone does
    not re-arm a trend, and a candle that confirms cannot double as a pullback.
    """
    ordered = sorted(bars, key=lambda bar: bar["bar_start"])
    if len(ordered) < 3:
        return []
    sign = -1 if short else 1
    extreme = "low" if short else "high"
    first = ordered[0]
    session_open = float(first["open"])
    prior_level = float(first[extreme])
    advanced = sign * (float(first["close"]) - session_open) > 0
    retracement = None
    events = []
    for bar in ordered[1:]:
        close, open_ = float(bar["close"]), float(bar["open"])
        if advanced and sign * (close - open_) < 0:
            retracement = bar
        elif retracement and sign * (close - open_) > 0 and sign * (close - prior_level) > 0:
            events.append({
                "timeframe_minutes": minutes,
                "signal_time": bar["bar_start"] + timedelta(minutes=minutes),
                "trigger_price": close,
                "prior_intraday_low" if short else "prior_intraday_high": prior_level,
                "retracement_bar_start": retracement["bar_start"],
            })
            retracement = None
        if sign * (close - session_open) > 0 and sign * (close - open_) > 0:
            advanced = True
        prior_level = min(prior_level, float(bar[extreme])) if short else max(prior_level, float(bar[extreme]))
    return events


def previous_day_events(bars: list[dict], level: float | None, *, short: bool = False) -> list[dict]:
    """Re-arm only after a completed close returns to the other side of PDH/PDL."""
    if not level or level <= 0:
        return []
    armed = True
    events = []
    sign = -1 if short else 1
    for bar in sorted(bars, key=lambda bar: bar["bar_start"]):
        close = float(bar["close"])
        if sign * (close - level) <= 0:
            armed = True
        elif armed:
            events.append({"timeframe_minutes": 0, "signal_time": bar["bar_start"] + timedelta(minutes=5),
                           "trigger_price": close, "previous_day_low" if short else "previous_day_high": level})
            armed = False
    return events


def event_records(envelope: dict) -> list[dict]:
    """Old single-event rows and new envelopes share the existing DB constraint.

    Top-level fields always represent the newest event. Prior events are flat
    immutable records inside metadata, not recursive copies of the envelope.
    """
    current = deepcopy(envelope)
    metadata = current.setdefault("metadata", {})
    prior = metadata.pop("priorEvents", [])
    rows = [row for row in prior if isinstance(row, dict)] + [current]
    unique = {}
    for row in rows:
        at = timestamp(row.get("signal_time"))
        if at is not None:
            # PostgREST returns UTC; detector bars use IST. Dedupe instants,
            # not their textual timezone representation, after every restart.
            row["signal_time"] = at.isoformat()
            unique[row["signal_time"]] = row
    return sorted(unique.values(), key=lambda row: row["signal_time"])


def event_envelope(events: list[dict]) -> dict:
    ordered = sorted(events, key=lambda row: row["signal_time"])
    latest = deepcopy(ordered[-1])
    # Provider database IDs belong to the envelope, not to historical events.
    for field in ("id", "created_at", "updated_at"):
        latest.pop(field, None)
    prior = []
    for event in ordered[:-1]:
        item = deepcopy(event)
        for field in ("id", "created_at", "updated_at"):
            item.pop(field, None)
        item.setdefault("metadata", {}).pop("priorEvents", None)
        prior.append(item)
    latest.setdefault("metadata", {}).update({"priorEvents": prior, "eventFormatVersion": 1})
    return latest
