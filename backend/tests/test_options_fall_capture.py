from datetime import datetime

from app.engines.options_direction import compute_options_direction
from app.engines.options_fall_capture import build_options_fall_capture


def _leg(oi: int, oi_change: int, iv: float = 14.0) -> dict:
    return {
        "oi": oi,
        "oiChange": oi_change,
        "volume": 10_000,
        "ltp": 100,
        "iv": iv,
        "bidQty": 1_000,
        "askQty": 1_000,
    }


def _bearish_snapshot(*, spot: float = 23850, prev_close: float = 24080) -> dict:
    strikes = [23600, 23650, 23700, 23750, 23800, 23850, 23900, 23950, 24000, 24050, 24100, 24150, 24200]
    chain = []
    for strike in strikes:
        near_wall = 23800 <= strike <= 24100
        call_change = 520_000 if strike == 24000 else 260_000 if near_wall else 40_000
        put_change = 180_000 if strike in {23900, 24000} else 70_000 if near_wall else 20_000
        chain.append(
            {
                "strike": strike,
                "call": _leg(1_300_000 if strike == 24000 else 420_000, call_change),
                "put": _leg(980_000 if strike == 24000 else 360_000, put_change),
            }
        )

    data = {
        "index": "nifty",
        "name": "NIFTY",
        "spot": spot,
        "prevClose": prev_close,
        "expiry": "2026-06-23",
        "strikeStep": 50,
        "chain": chain,
        "analytics": {
            "pcr": 0.83,
            "maxPainStrike": 24000,
            "totalCallOI": 8_500_000,
            "totalPutOI": 7_100_000,
            "support": [24000, 23500, 23000],
            "resistance": [24000, 24500, 24100],
            "atmIV": 14.0,
        },
        "provider": {"provider": "arrow"},
    }
    data["direction"] = compute_options_direction(data, now=datetime(2026, 6, 23, 12, 0))
    return data


def test_fall_capture_flags_breakdown_below_max_pain_and_call_wall():
    signal = build_options_fall_capture(_bearish_snapshot())

    assert signal["state"] == "FALL_ACTIVE"
    assert signal["bias"] == "SHORT_BIAS"
    assert signal["score"] >= 70
    assert signal["levels"]["breakdown"] == 24000
    assert signal["levels"]["confirmation"] == 23900
    assert signal["levels"]["invalidation"] == 24000
    assert "24,000" in signal["trigger"]
    assert "23,900" in signal["confirmation"]


def test_fall_capture_still_warns_when_chain_prev_close_is_stale():
    data = _bearish_snapshot(spot=23950, prev_close=23950)
    data["direction"] = compute_options_direction(data, now=datetime(2026, 6, 23, 12, 0))

    signal = build_options_fall_capture(data)

    assert signal["state"] in {"FALL_ACTIVE", "FALL_STARTING"}
    assert any("stale" in warning.lower() for warning in signal["warnings"])
    assert signal["levels"]["breakdown"] == 24000
