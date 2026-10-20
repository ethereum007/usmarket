"""Intraday-only coverage and explanations; shared Radar scoring stays unchanged."""

from copy import deepcopy
from typing import Any

from app.caches.stock_universes import resolve_universe
from app.core.session_cache import save_session

MONITOR_SESSION_KEY = "intraday_monitor_nifty500"


def score_breakdown(row: dict, inputs: dict) -> dict | None:
    if row.get("bias") not in {"LONG", "SHORT"} or not inputs:
        return None
    momentum = min(abs(inputs["changePct"]) * 8, 24)
    volume = min(max(inputs["volRatio"] - 0.7, 0) * 14, 22)
    range_points = min(max(inputs["rFactor"] - 0.6, 0) * 12, 18)
    raw = inputs["setupPoints"] + momentum + volume + range_points
    parts = [
        ("Directional setups", inputs["setupPoints"]),
        ("Price momentum", momentum),
        ("Volume participation", volume),
        ("Range expansion", range_points),
        ("Rounding and base cap", inputs["baseScore"] - raw),
        ("Market adjustment (after cap)", row["score"] - inputs["baseScore"]),
    ]
    return {
        "total": row["score"],
        "components": [{"label": label, "points": round(points, 4)} for label, points in parts],
        "setups": row.get("setups", []),
        "inputs": {key: round(inputs[key], 4) for key in ("changePct", "volRatio", "rFactor")},
        "note": "Rule-based ranking, not a win probability. Volume compares with a full-day average; daily range may use cached previous-session range.",
    }


def publish_universe(symbols: list[str], candidates: list[dict], context: dict,
                     response: dict, quotes: dict[str, Any]) -> None:
    """Retain the untruncated Nifty 500 scan without a second provider request.

    A smaller/custom scan cannot replace the broad monitoring universe. This is
    a separate cache: existing response limits, scores and quality stay intact.
    """
    expected = {s.strip().upper() for s in resolve_universe("nifty500")}
    if not expected or set(symbols) != expected:
        return
    rows = []
    for row in candidates:
        item = deepcopy(row)
        item["scoreBreakdown"] = score_breakdown(row, context.get(row["symbol"], {}))
        item["radarAsOf"] = response["timestamp"]
        rows.append(item)
    quoted = sum(bool((quotes.get(f"NSE:{s}") or {}).get("last_price")) for s in symbols)
    save_session(MONITOR_SESSION_KEY, {
        "candidates": rows,
        "timestamp": response["timestamp"],
        "marketRegime": response["marketRegime"],
        "coverage": {"universe": "Nifty 500", "requested": len(symbols), "quoted": quoted,
                     "missingQuotes": len(symbols) - quoted, "ranked": len(rows), "fullScan": True},
    })
