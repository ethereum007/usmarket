from datetime import datetime
from dataclasses import replace
from unittest.mock import patch

import pandas as pd

from app.config import settings
from app.routes import scanner
from app.services.scanner_service import _merge_live_daily_candle


def test_unknown_lifecycle_is_not_invented():
    signal = scanner._normalize_swing_signal({"symbol": "TEST", "strength": 99, "quality": "A+", "rr": 2.2})
    assert signal["lifecycle_state"] == "UNKNOWN"
    assert signal["setup_phase"] == "UNKNOWN"
    assert scanner._swing_phase(signal) == "UNKNOWN"


def test_queue_uses_primary_thesis_even_when_other_votes_disagree():
    primary = {"symbol": "TEST", "strategy": "50D_BO", "signal": "BULL", "strength": 90,
               "lifecycle_state": "READY", "setup_phase": "CONFIRMED_CLOSE", "rr": 2.2,
               "entry_price": 100, "stop_loss": 95, "risk_pct": 5}
    other = {**primary, "strategy": "EARLY_MOMENTUM", "signal": "BEAR", "strength": 60,
             "lifecycle_state": "FORMING", "entry_price": 90, "stop_loss": 100}
    with patch.object(scanner, "_swing_signal_score", side_effect=lambda s: s["strength"]):
        row = scanner._build_swing_radar([primary, other, {**other, "strategy": "REVERSAL"}])["rows"][0]
    assert row["direction"] == "LONG"
    assert row["phase"] == scanner._swing_phase(primary)
    assert row["entry"] == 100 and row["stop"] == 95
    assert row["action"] == "WAIT_CONFLICT"


def test_stale_closed_session_and_unstamped_quotes_do_not_create_bars():
    df = pd.DataFrame([{"date": "2026-10-16", "open": 100, "high": 105, "low": 99, "close": 104, "volume": 1000}])
    quote = {"last_price": 110, "ohlc": {"open": 106, "high": 111, "low": 105}, "volume": 2000}
    for now, timestamp in [
        (datetime(2026, 10, 18, 12, tzinfo=settings.TIMEZONE), "2026-10-16T15:30:00+05:30"),
        (datetime(2026, 10, 19, 8, tzinfo=settings.TIMEZONE), "2026-10-19T08:00:00+05:30"),
        (datetime(2026, 10, 19, 16, tzinfo=settings.TIMEZONE), "2026-10-19T16:00:00+05:30"),
        (datetime(2026, 10, 19, 10, tzinfo=settings.TIMEZONE), "2026-10-16T15:30:00+05:30"),
        (datetime(2026, 10, 19, 10, tzinfo=settings.TIMEZONE), None),
    ]:
        pd.testing.assert_frame_equal(_merge_live_daily_candle(df, {**quote, "timestamp": timestamp}, now), df)


def test_configured_holiday_cannot_create_bar():
    df = pd.DataFrame([{"date": "2026-10-16", "close": 104}])
    now = datetime(2026, 10, 19, 10, tzinfo=settings.TIMEZONE)
    quote = {"last_price": 110, "ohlc": {"open": 106}, "timestamp": now}
    with patch("app.services.scanner_service.settings", replace(settings, MARKET_HOLIDAYS=("2026-10-19",))):
        pd.testing.assert_frame_equal(_merge_live_daily_candle(df, quote, now), df)


def test_strict_warm_scope_excludes_unrelated_watch_symbols():
    payload = scanner.SwingWarmRequest(universe="nifty50", scope_mode="strict", limit=50)
    with patch("app.caches.stock_universes.resolve_universe", return_value=["AAA", "BBB"]):
        assert scanner._warm_swing_symbols(payload) == ["AAA", "BBB"]
        assert scanner._warm_swing_quote_symbols(payload) == ["AAA", "BBB"]
