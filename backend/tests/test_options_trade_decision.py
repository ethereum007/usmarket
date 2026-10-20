from datetime import datetime

from app.engines.options_direction import compute_options_direction
from app.engines.options_trade_decision import build_options_trade_decision


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
    spot: float = 24180,
    prev_close: float = 24000,
    pcr: float = 1.28,
    ce_change: int = 5_000,
    pe_change: int = 120_000,
    expiry: str = "2026-06-25",
) -> dict:
    strikes = [23900, 23950, 24000, 24050, 24100, 24150, 24200, 24250, 24300]
    chain = []
    for strike in strikes:
        near_atm = abs(strike - spot) <= 100
        chain.append(
            {
                "strike": strike,
                "call": _leg(120_000, ce_change if near_atm else 0),
                "put": _leg(140_000, pe_change if near_atm else 0),
            }
        )

    data = {
        "index": "nifty",
        "name": "NIFTY",
        "spot": spot,
        "prevClose": prev_close,
        "expiry": expiry,
        "strikeStep": 50,
        "chain": chain,
        "analytics": {
            "pcr": pcr,
            "maxPainStrike": 24000,
            "totalCallOI": 1_080_000,
            "totalPutOI": 1_250_000,
            "support": [24100, 24050, 24000],
            "resistance": [24200, 24250, 24300],
            "atmIV": 14.0,
        },
        "provider": {"provider": "arrow"},
    }
    data["direction"] = compute_options_direction(data, now=datetime(2026, 6, 21, 10, 30))
    return data


def test_trade_decision_waits_on_cached_data_even_when_direction_is_bullish():
    decision = build_options_trade_decision(
        _snapshot(),
        cached=True,
        stale=True,
        market_open=True,
        warning="Live feed unavailable",
    )

    assert decision["action"] == "WAIT"
    assert decision["quality"] == "NO_TRADE"
    assert decision["reliability"]["tradeable"] is False
    assert decision["mode"] == "STALE_OR_CLOSED_DATA"


def test_trade_decision_promotes_aligned_fresh_direction_to_trade_candidate():
    decision = build_options_trade_decision(
        _snapshot(),
        cached=False,
        stale=False,
        market_open=True,
    )

    assert decision["action"] == "TRADE"
    assert decision["bias"] == "LONG"
    assert decision["quality"] in {"A", "B"}
    assert "5-min close above" in decision["entryTrigger"]


def test_trade_decision_blocks_expiry_pin_even_with_directional_inputs():
    data = _snapshot(spot=24010, prev_close=23840, expiry="2026-06-21")
    data["direction"] = compute_options_direction(data, now=datetime(2026, 6, 21, 10, 30))

    decision = build_options_trade_decision(
        data,
        cached=False,
        stale=False,
        market_open=True,
    )

    assert decision["action"] == "WAIT"
    assert decision["mode"] in {"EXPIRY_PIN_RISK", "WAIT_FOR_BREAKOUT", "RANGE_OR_EXPIRY_PIN"}
    assert any("max pain" in note.lower() or "expiry" in decision["timeframe"].lower() for note in decision["riskNotes"])
