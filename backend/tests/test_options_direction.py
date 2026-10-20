from datetime import datetime

from app.engines.options_direction import compute_options_direction


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


def _snapshot(
    *,
    spot: float = 24080,
    prev_close: float = 24000,
    pcr: float = 1.25,
    ce_change: int = 10_000,
    pe_change: int = 80_000,
    call_iv: float = 14.0,
    put_iv: float = 14.5,
) -> dict:
    strikes = [23900, 23950, 24000, 24050, 24100, 24150, 24200]
    chain = []
    for strike in strikes:
        near_atm = abs(strike - spot) <= 100
        chain.append(
            {
                "strike": strike,
                "call": _leg(120_000, ce_change if near_atm else 0, call_iv),
                "put": _leg(130_000, pe_change if near_atm else 0, put_iv),
            }
        )

    return {
        "index": "nifty",
        "name": "NIFTY",
        "spot": spot,
        "prevClose": prev_close,
        "expiry": "2026-06-25",
        "strikeStep": 50,
        "chain": chain,
        "analytics": {
            "pcr": pcr,
            "maxPainStrike": 24000,
            "totalCallOI": 840_000,
            "totalPutOI": 910_000,
            "support": [24000, 23950, 23900],
            "resistance": [24200, 24150, 24100],
            "atmIV": (call_iv + put_iv) / 2,
        },
    }


def test_options_direction_turns_bullish_when_price_and_put_writing_align():
    result = compute_options_direction(
        _snapshot(),
        now=datetime(2026, 6, 21, 10, 30),
    )

    assert result["direction"] == "BULLISH"
    assert result["confidence"] >= 60
    assert result["greeks"]["callDelta"] > 0
    assert result["greeks"]["putDelta"] < 0


def test_options_direction_turns_bearish_when_price_and_call_writing_align():
    result = compute_options_direction(
        _snapshot(
            spot=23900,
            prev_close=24000,
            pcr=0.72,
            ce_change=90_000,
            pe_change=5_000,
            call_iv=15.5,
            put_iv=18.5,
        ),
        now=datetime(2026, 6, 21, 10, 30),
    )

    assert result["direction"] == "BEARISH"
    assert result["score"] < 0


def test_options_direction_returns_no_view_when_price_and_oi_conflict():
    result = compute_options_direction(
        _snapshot(
            spot=24100,
            prev_close=24000,
            pcr=0.7,
            ce_change=90_000,
            pe_change=5_000,
        ),
        now=datetime(2026, 6, 21, 10, 30),
    )

    assert result["direction"] == "NO_VIEW"
    assert result["warnings"]
