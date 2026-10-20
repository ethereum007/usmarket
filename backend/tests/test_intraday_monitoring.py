import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app.services import intraday_breakout_service as breakout
from app.services import intraday_monitoring as monitoring
from app.services import intraday_radar_service as radar
from app.services.intraday_entry_assessment import assess_entry, complete_session

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 9, 24, 9, 31, tzinfo=IST)


def example(short=False):
    rows = [
        {"bar_start": NOW.replace(minute=15), "open": 100, "high": 102.5, "low": 99.8, "close": 102, "volume": 100},
        {"bar_start": NOW.replace(minute=20), "open": 102, "high": 102.2, "low": 100.8, "close": 101, "volume": 100},
        {"bar_start": NOW.replace(minute=25), "open": 101, "high": 103.3, "low": 100.9, "close": 103, "volume": 100},
    ]
    signal = {"type": "FIVE_MIN_BREAKOUT", "direction": "LONG", "signalTime": NOW.replace(minute=30).isoformat(),
              "timeframeMinutes": 5, "triggerPrice": 103, "breakoutLevel": 102.5,
              "retracementBarStart": rows[1]["bar_start"].isoformat()}
    meta = {"symbol": "TEST", "bias": "LONG", "score": 88, "ltp": 103.05, "vwap": 101,
            "pdh": 102.5, "pdl": 97, "dataWarnings": [], "radarAsOf": NOW.isoformat(),
            "freshness": {"exchangeTimestamp": NOW.isoformat()}}
    if short:
        for row in rows:
            row.update(open=200-row["open"], high=200-row["low"], low=200-row["high"], close=200-row["close"])
        signal.update(type="FIVE_MIN_BREAKDOWN", direction="SHORT", triggerPrice=97, breakoutLevel=97.5)
        meta.update(bias="SHORT", ltp=96.95, vwap=99, pdh=103, pdl=97.5)
    return signal, meta, rows


@pytest.mark.parametrize("short", [False, True])
def test_fresh_confirmed_entry_has_direction_correct_plan(short):
    signal, meta, rows = example(short)
    result = assess_entry(signal, meta, rows, NOW, market_open=True)
    assert result["status"] == "CHECKS_PASSED"
    assert all(check["passed"] for check in result["checks"])
    assert result["remainingRewardRisk"] > 1.5
    if short:
        assert result["referenceTarget"] < result["entry"] < result["stop"]
    else:
        assert result["stop"] < result["entry"] < result["referenceTarget"]


@pytest.mark.parametrize("field", ["quote", "radar", "history", "context", "future_quote", "feed"])
def test_high_score_cannot_override_bad_data(field):
    signal, meta, rows = example()
    meta["score"] = 100
    if field == "quote": meta["freshness"]["exchangeTimestamp"] = (NOW-timedelta(minutes=4)).isoformat()
    if field == "radar": meta["radarAsOf"] = (NOW-timedelta(days=1)).isoformat()
    if field == "history": rows.pop(0)
    if field == "context": meta["dataWarnings"] = ["Missing daily context"]
    if field == "future_quote": meta["freshness"]["exchangeTimestamp"] = (NOW+timedelta(minutes=1)).isoformat()
    result = assess_entry(signal, meta, rows, NOW, market_open=True, feed_healthy=field != "feed")
    assert result["status"] == "DATA_CHECK"


@pytest.mark.parametrize("short", [False, True])
def test_failed_level_stays_invalid_after_price_recovers(short):
    signal, meta, rows = example(short)
    later = NOW.replace(minute=36)
    rows.append({"bar_start": NOW.replace(minute=30), "open": 103, "high": 103.1, "low": 102.3, "close": 102.4} if not short
                else {"bar_start": NOW.replace(minute=30), "open": 97, "high": 97.7, "low": 96.9, "close": 97.6})
    meta["freshness"]["exchangeTimestamp"] = later.isoformat()
    meta["radarAsOf"] = later.isoformat()
    assert assess_entry(signal, meta, rows, later, market_open=True)["status"] == "INVALIDATED"


@pytest.mark.parametrize("short", [False, True])
def test_extension_and_reward_risk_block_late_entries(short):
    signal, meta, rows = example(short)
    meta["ltp"] = 95.5 if short else 104.5
    assert assess_entry(signal, meta, rows, NOW, market_open=True)["status"] == "EXTENDED"
    meta["ltp"] = 96.5 if short else 103.5
    result = assess_entry(signal, meta, rows, NOW, market_open=True)
    assert result["status"] == "WAIT"
    assert result["remainingRewardRisk"] < 1.5


def test_expired_closed_and_missing_confirmation_are_not_entry_ready():
    signal, meta, rows = example()
    later = NOW.replace(minute=46)
    for minute in (30, 35, 40):
        rows.append({"bar_start": NOW.replace(minute=minute), "open": 103, "high": 103.2, "low": 102.9, "close": 103.1})
    meta["freshness"]["exchangeTimestamp"] = later.isoformat()
    meta["radarAsOf"] = later.isoformat()
    assert assess_entry(signal, meta, rows, later, market_open=True)["status"] == "EXPIRED"
    assert assess_entry(signal, meta, rows, later, market_open=False)["status"] == "MARKET_CLOSED"
    signal["triggerPrice"] = 105
    assert assess_entry(signal, meta, rows, later, market_open=True)["status"] == "DATA_CHECK"


def test_complete_candles_require_open_and_no_gaps():
    _, _, rows = example()
    assert complete_session(rows, NOW)
    assert not complete_session(rows[1:], NOW)
    assert not complete_session([rows[0], rows[2]], NOW)


def test_untruncated_universe_retains_names_beyond_old_limits(monkeypatch):
    rows = [{"symbol": f"LONG{i}", "bias": "LONG", "score": 90-i/10} for i in range(110)]
    rows += [{"symbol": f"SHORT{i}", "bias": "SHORT", "score": 60-i/10} for i in range(40)]
    rows += [{"symbol": "CASHSHORT", "bias": "SHORT", "score": 100}, {"symbol": "NEUTRAL", "bias": "NEUTRAL"}]
    sessions = {monitoring.MONITOR_SESSION_KEY: {"timestamp": NOW.isoformat(), "data": {"timestamp": NOW.isoformat(), "candidates": rows, "coverage": {"requested": 500, "quoted": 499, "fullScan": True}}},
                "intraday_radar": {"data": {"candidates": rows[:80]}}}
    monkeypatch.setattr(breakout, "load_session", lambda key: sessions.get(key))
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = NOW.date()
    service._fno_symbols = {f"SHORT{i}" for i in range(40)}
    service._fno_loaded_at = NOW
    selected = asyncio.run(service._tracked_candidates(NOW))
    assert len(selected) == 150
    assert "LONG109" in {row["symbol"] for row in selected}
    assert "SHORT39" in {row["symbol"] for row in selected}
    assert service._coverage["excludedCashShorts"] == 1
    assert service._coverage["fullScan"] is True


def test_prior_day_source_is_rejected_for_both_directions(monkeypatch):
    monkeypatch.setattr(breakout, "load_session", lambda key: {"timestamp": (NOW-timedelta(days=1)).isoformat(), "data": {"candidates": [{"symbol": "SHORT", "bias": "SHORT"}]}})
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = NOW.date()
    service._fno_symbols = {"SHORT"}; service._fno_loaded_at = NOW
    assert asyncio.run(service._tracked_candidates(NOW)) == []


def test_publish_preserves_shared_response_and_complete_score_explanation(monkeypatch):
    symbols = [f"S{i}" for i in range(120)]
    monkeypatch.setattr(monitoring, "resolve_universe", lambda key: symbols)
    saved = {}
    monkeypatch.setattr(monitoring, "save_session", lambda key, value: saved.update({key: value}))
    monkeypatch.setattr(radar, "_ensure_daily_stats", lambda *args, **kwargs: {})
    monkeypatch.setattr(radar, "_log_actionable_radar_fires", lambda *args: None)
    monkeypatch.setattr(radar, "_orb_status", lambda *args: {})
    monkeypatch.setattr(radar, "_sector_for", lambda *args: "Other")
    monkeypatch.setattr(radar, "_stats_cache", {s: {"avg_volume": 1000, "avg_range": 2, "pdh": 101, "pdl": 97} for s in symbols})
    quote = {"last_price": 102.37, "ohlc": {"open": 100, "high": 103, "low": 99, "close": 100}, "volume": 1843, "average_price": 100.3, "timestamp": NOW.isoformat()}
    quotes = {f"NSE:{s}": deepcopy(quote) for s in symbols}
    context = {}
    original = radar._build_candidate("S0", quote, radar._stats_cache["S0"])
    captured = radar._build_candidate("S0", quote, radar._stats_cache["S0"], score_context=context)
    assert original == captured
    response = radar.build_intraday_radar(None, symbols, use_cache=False, quote_map=quotes)
    assert len(response["candidates"]) == 80
    assert len(response["actionable"]) <= 30
    assert "scoreBreakdown" not in response["candidates"][0]
    full = saved[monitoring.MONITOR_SESSION_KEY]
    assert len(full["candidates"]) == 120
    assert full["coverage"]["quoted"] == 120
    breakdown = full["candidates"][0]["scoreBreakdown"]
    assert sum(part["points"] for part in breakdown["components"]) == pytest.approx(breakdown["total"], abs=0.001)
    assert full["candidates"][0]["score"] == response["candidates"][0]["score"]
    saved.clear()
    monitoring.publish_universe(symbols[:80], [], {}, response, quotes)
    assert saved == {}  # Smaller scans cannot overwrite Intraday's universe.


def test_direction_survives_radar_flip_and_removal(monkeypatch):
    monkeypatch.setattr(breakout, "is_market_hours", lambda: True)
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = NOW.date()
    service._signals[("TEST", "FIVE_MIN_BREAKDOWN")] = {"signal_type": "FIVE_MIN_BREAKDOWN", "signal_time": NOW.isoformat(), "trigger_price": 97, "prior_intraday_low": 97.5, "radar_score": 75}
    service._candidate_meta["TEST"] = {"bias": "LONG", "score": 99}
    assert service._snapshot_unlocked(NOW)["candidates"][0]["direction"] == "SHORT"
    service._candidate_meta.clear()
    candidate = service._snapshot_unlocked(NOW)["candidates"][0]
    assert candidate["direction"] == "SHORT"
    assert candidate["signals"][0]["entryAssessment"]["status"] == "DATA_CHECK"


def test_degraded_snapshot_removes_positive_entry_status(monkeypatch):
    monkeypatch.setattr(breakout, "is_market_hours", lambda: True)
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    service._last_good_snapshot = {"candidates": [{"signals": [{"entryAssessment": {"status": "CHECKS_PASSED"}}]}]}
    result = service._degraded_snapshot(NOW)
    assert result["candidates"][0]["signals"][0]["entryAssessment"]["status"] == "DATA_CHECK"


@pytest.mark.parametrize("short", [False, True])
def test_return_excludes_confirmation_candle_extremes(short):
    signal, _, rows = example(short)
    rows[-1]["low" if short else "high"] = 80 if short else 120
    row = {"signal_type": signal["type"], "signal_time": signal["signalTime"], "timeframe_minutes": 5,
           "trigger_price": signal["triggerPrice"], "prior_intraday_low" if short else "prior_intraday_high": signal["breakoutLevel"]}
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    result = service._signal_payload(row, rows)
    assert result["postConfirmationBestReturnPct"] == 0
    assert result["postConfirmationCloseReturnPct"] == 0


def test_session_pagination_restores_all_rows_even_with_lower_server_cap():
    data = [{"symbol": f"S{i}"} for i in range(7)]
    requests = []
    class Query:
        def table(self, name): return self
        def select(self, fields): return self
        def eq(self, column, value): return self
        def order(self, column): return self
        def range(self, start, end):
            self.start, self.end = start, end
            requests.append((start, end))
            return self
        def execute(self): return SimpleNamespace(data=data[self.start:min(self.end+1, self.start+2)])
    assert breakout._session_rows(Query(), "intraday_candles", NOW.date(), ("symbol",), page_size=3) == data
    assert requests == [(0, 2), (2, 4), (4, 6), (6, 8), (7, 9)]


def test_saved_detection_score_is_not_rewritten_by_later_radar_updates():
    _, meta, rows = example()
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = NOW.date()
    service._candidate_meta["TEST"] = meta
    service._bars["TEST"] = {row["bar_start"]: row for row in rows}
    service._detect_symbol_signals("TEST")
    saved = deepcopy(service._signals[("TEST", "FIVE_MIN_BREAKOUT")])
    service._candidate_meta["TEST"]["score"] = 12
    assert service._detect_symbol_signals("TEST") == []
    assert service._signals[("TEST", "FIVE_MIN_BREAKOUT")] == saved
    assert saved["metadata"]["radarContext"]["score"] == 88
    assert saved["metadata"]["detectedAt"]


def test_partial_stream_candles_cannot_confirm_a_breakout(monkeypatch):
    from app.engines.runner.schemas import MinuteBar
    minute = NOW.replace(minute=25)
    rows = [MinuteBar(symbol="TEST", exchange="NSE", minute_timestamp=minute,
                      open=100, high=110, low=99, close=109)]
    monkeypatch.setattr(breakout.runner_service.bars, "bars", lambda *args, **kwargs: rows)
    service = breakout.IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = NOW.date()
    assert service._merge_runner_bars("TEST", NOW) == []
    for offset in range(1, 5):
        rows.append(rows[0].model_copy(update={"minute_timestamp": minute+timedelta(minutes=offset)}))
    assert len(service._merge_runner_bars("TEST", NOW)) == 1


def test_fifteen_minute_confirmation_requires_all_three_five_minute_bars():
    signal, meta, rows = example()
    signal.update(timeframeMinutes=15, type="FIFTEEN_MIN_BREAKOUT", retracementBarStart=None)
    assert assess_entry(signal, meta, rows, NOW, market_open=True)["status"] == "CHECKS_PASSED"
    assert assess_entry(signal, meta, rows[1:], NOW, market_open=True)["status"] == "DATA_CHECK"


@pytest.mark.parametrize("short", [False, True])
def test_target_touch_remains_recorded_after_price_returns(short):
    signal, meta, rows = example(short)
    later = NOW.replace(minute=36)
    rows.append({"bar_start": NOW.replace(minute=30), "open": 103, "high": 110, "low": 102.9, "close": 103.1} if not short
                else {"bar_start": NOW.replace(minute=30), "open": 97, "high": 97.1, "low": 90, "close": 96.9})
    meta["freshness"]["exchangeTimestamp"] = later.isoformat()
    meta["radarAsOf"] = later.isoformat()
    assert assess_entry(signal, meta, rows, later, market_open=True)["status"] == "TARGET_REACHED"
