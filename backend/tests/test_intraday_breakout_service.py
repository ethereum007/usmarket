import asyncio
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.services import intraday_breakout_service as module
from app.routes import intraday as intraday_route
from app.services.intraday_breakout_service import (
    IntradayBreakoutService,
    aggregate_bars,
    can_evaluate_session,
    detect_previous_day_high_break,
    detect_previous_day_low_break,
    detect_retracement_breakdown,
    detect_retracement_breakout,
)

IST = ZoneInfo("Asia/Kolkata")


def bar(minute, open_, high, low, close, volume=100):
    return {
        "bar_start": datetime(2026, 9, 21, 9, minute, tzinfo=IST),
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
    }


def test_five_minute_breakout_requires_advance_red_retracement_and_close():
    rows = [
        bar(15, 100, 102.5, 99.8, 102),
        bar(20, 102, 102.2, 100.8, 101),
        bar(25, 101, 103.3, 100.9, 103),
    ]

    signal = detect_retracement_breakout(rows, 5)

    assert signal is not None
    assert signal["trigger_price"] == 103
    assert signal["prior_intraday_high"] == 102.5
    assert signal["retracement_bar_start"] == rows[1]["bar_start"]
    assert signal["signal_time"] == rows[2]["bar_start"] + timedelta(minutes=5)


def test_breakout_does_not_fire_on_a_wick_or_without_red_retracement():
    wick_only = [
        bar(15, 100, 102, 99.8, 101.5),
        bar(20, 101.5, 101.8, 100.5, 101),
        bar(25, 101, 103, 100.8, 101.8),
    ]
    no_pullback = [
        bar(15, 100, 101, 99.8, 100.8),
        bar(20, 100.8, 102, 100.7, 101.8),
        bar(25, 101.8, 103, 101.7, 102.8),
    ]

    assert detect_retracement_breakout(wick_only, 5) is None
    assert detect_retracement_breakout(no_pullback, 5) is None


def test_five_minute_breakdown_requires_decline_green_retracement_and_close():
    rows = [
        bar(15, 100, 100.2, 97.5, 98),
        bar(20, 98, 99.2, 97.8, 99),
        bar(25, 99, 99.1, 96.7, 97),
    ]
    signal = detect_retracement_breakdown(rows, 5)
    assert signal is not None
    assert signal["trigger_price"] == 97
    assert signal["prior_intraday_low"] == 97.5
    assert signal["retracement_bar_start"] == rows[1]["bar_start"]


def test_breakdown_rejects_wick_and_missing_green_retracement():
    wick_only = [bar(15, 100, 100.2, 98, 98.5), bar(20, 98.5, 99.5, 98.2, 99), bar(25, 99, 99.1, 97, 98.2)]
    no_retracement = [bar(15, 100, 100.2, 98, 98.5), bar(20, 98.5, 98.6, 97.5, 98), bar(25, 98, 98.1, 96.5, 97)]
    assert detect_retracement_breakdown(wick_only, 5) is None
    assert detect_retracement_breakdown(no_retracement, 5) is None


def test_fifteen_minute_candles_are_derived_from_three_five_minute_rows():
    rows = [
        bar(15, 100, 102, 99, 101, 10),
        bar(20, 101, 103, 100, 102, 20),
        bar(25, 102, 104, 101, 103, 30),
        bar(30, 103, 105, 102, 104, 40),
        bar(35, 104, 106, 103, 105, 50),
    ]

    aggregated = aggregate_bars(rows, 15, require_source_bars=3)

    assert len(aggregated) == 1
    assert aggregated[0]["bar_start"].minute == 15
    assert aggregated[0]["open"] == 100
    assert aggregated[0]["high"] == 104
    assert aggregated[0]["low"] == 99
    assert aggregated[0]["close"] == 103
    assert aggregated[0]["volume"] == 60


def test_aggregation_ignores_post_market_ticks():
    rows = [
        bar(15, 100, 101, 99, 100.5),
        {
            "bar_start": datetime(2026, 9, 21, 16, 40, tzinfo=IST),
            "open": 105,
            "high": 106,
            "low": 104,
            "close": 105.5,
            "volume": 10,
        },
    ]

    aggregated = aggregate_bars(rows, 5)

    assert len(aggregated) == 1
    assert aggregated[0]["bar_start"].time().hour == 9


def test_previous_day_high_tag_uses_first_completed_close_above_level():
    rows = [
        bar(15, 100, 102, 99, 101),
        bar(20, 101, 104, 100, 103.5),
        bar(25, 103.5, 105, 103, 104.5),
    ]

    signal = detect_previous_day_high_break(rows, 103)

    assert signal is not None
    assert signal["trigger_price"] == 103.5
    assert signal["signal_time"] == rows[1]["bar_start"] + timedelta(minutes=5)


def test_previous_day_low_tag_uses_first_completed_close_below_level():
    rows = [bar(15, 100, 101, 98.5, 99), bar(20, 99, 99.2, 96, 97), bar(25, 97, 98, 95, 96)]
    signal = detect_previous_day_low_break(rows, 98)
    assert signal is not None
    assert signal["trigger_price"] == 97
    assert signal["signal_time"] == rows[1]["bar_start"] + timedelta(minutes=5)


def test_only_current_bullish_radar_candidates_are_tracked(monkeypatch):
    monkeypatch.setattr(
        module,
        "load_session",
        lambda _key: {
            "data": {
                "candidates": [
                    {"symbol": "BULL2", "bias": "LONG", "score": 55, "volRatio": 2},
                    {"symbol": "SHORT", "bias": "SHORT", "score": 99, "volRatio": 5},
                    {"symbol": "BULL1", "bias": "LONG", "score": 80, "volRatio": 1},
                ]
            }
        },
    )
    service = IntradayBreakoutService(client_factory=lambda: None)

    assert [row["symbol"] for row in service._bullish_candidates()] == [
        "BULL1",
        "BULL2",
    ]


def test_candidate_ranking_tolerates_non_numeric_market_fields(monkeypatch):
    monkeypatch.setattr(
        module,
        "load_session",
        lambda _key: {
            "data": {
                "candidates": [
                    {"symbol": "GOOD", "bias": "LONG", "score": 70, "volRatio": 2},
                    {"symbol": "PARTIAL", "bias": "LONG", "score": "—", "volRatio": "n/a"},
                ]
            }
        },
    )
    service = IntradayBreakoutService(client_factory=lambda: None)

    assert [row["symbol"] for row in service._bullish_candidates()] == [
        "GOOD",
        "PARTIAL",
    ]


def test_refresh_handles_empty_candidate_bar_bucket(monkeypatch):
    service = IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = datetime.now(IST).date()
    service._bars = {"EMPTY": {}}

    async def candidates(_now):
        return [{"symbol": "EMPTY", "bias": "LONG", "score": 80}]

    monkeypatch.setattr(module, "can_evaluate_session", lambda _now: True)
    monkeypatch.setattr(service, "_tracked_candidates", candidates)
    monkeypatch.setattr(service, "_needs_history_sync", lambda _symbol, _now: True)
    monkeypatch.setattr(service, "_hydrate_symbol", lambda _symbol, _now: asyncio.sleep(0))
    monkeypatch.setattr(service, "_merge_runner_bars", lambda _symbol, _now: [])

    result = asyncio.run(service.refresh())

    assert result["status"] == "NO_SIGNALS"
    assert result["stale"] is False
    assert result["dataQuality"]["lastError"] is None


def test_one_bad_symbol_does_not_freeze_the_intraday_snapshot(monkeypatch):
    service = IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = datetime.now(IST).date()

    async def candidates(_now):
        return [
            {"symbol": "BAD", "bias": "LONG", "score": 90},
            {"symbol": "GOOD", "bias": "LONG", "score": 80},
        ]

    def merge(symbol, _now):
        if symbol == "BAD":
            raise ValueError("malformed provider candle")
        return []

    monkeypatch.setattr(module, "can_evaluate_session", lambda _now: True)
    monkeypatch.setattr(service, "_tracked_candidates", candidates)
    monkeypatch.setattr(service, "_needs_history_sync", lambda _symbol, _now: False)
    monkeypatch.setattr(service, "_merge_runner_bars", merge)

    result = asyncio.run(service.refresh())

    assert result["status"] == "NO_SIGNALS"
    assert result["stale"] is False
    assert result["dataQuality"]["skippedSymbolCount"] == 1
    assert result["dataQuality"]["skippedSymbols"] == ["BAD"]


def test_fno_bearish_candidates_are_prioritized_and_cash_shorts_are_excluded(monkeypatch):
    monkeypatch.setattr(module, "load_session", lambda _key: {"data": {"candidates": [
        {"symbol": "LONG1", "bias": "LONG", "score": 90},
        {"symbol": "FNO1", "bias": "SHORT", "score": 70},
        {"symbol": "CASHSHORT", "bias": "SHORT", "score": 99},
        {"symbol": "FNO1", "bias": "SHORT", "score": 60},
    ]}})
    service = IntradayBreakoutService(client_factory=lambda: None)
    service._fno_symbols = {"FNO1"}
    service._fno_loaded_at = datetime.now(IST)
    rows = asyncio.run(service._tracked_candidates(datetime.now(IST)))
    assert [row["symbol"] for row in rows] == ["FNO1", "LONG1"]


def test_broad_nifty500_snapshot_is_used_instead_of_last_legacy_core_snapshot(monkeypatch):
    sessions = {
        "intraday_radar_broad_nifty500": {"data": {"candidates": [
            {"symbol": "SMALLMID", "bias": "LONG", "score": 85},
            {"symbol": "FNO500", "bias": "SHORT", "score": 75},
        ]}},
        "intraday_radar": {"data": {"candidates": [
            {"symbol": "COREONLY", "bias": "LONG", "score": 99},
        ]}},
    }
    monkeypatch.setattr(module, "load_session", lambda key: sessions.get(key))
    service = IntradayBreakoutService(client_factory=lambda: None)
    service._fno_symbols = {"FNO500"}
    service._fno_loaded_at = datetime.now(IST)
    rows = asyncio.run(service._tracked_candidates(datetime.now(IST)))
    assert [row["symbol"] for row in rows] == ["FNO500", "SMALLMID"]


def test_same_day_post_market_history_can_be_evaluated():
    assert can_evaluate_session(datetime(2026, 9, 21, 19, 0, tzinfo=IST))
    assert not can_evaluate_session(datetime(2026, 9, 21, 8, 45, tzinfo=IST))
    assert not can_evaluate_session(datetime(2026, 9, 20, 19, 0, tzinfo=IST))


def test_refresh_serves_last_snapshot_when_a_live_dependency_fails(monkeypatch):
    service = IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = datetime.now(IST).date()

    async def fail_candidates(_now):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(module, "can_evaluate_session", lambda _now: True)
    monkeypatch.setattr(service, "_tracked_candidates", fail_candidates)

    result = asyncio.run(service.refresh())

    assert result["success"] is True
    assert result["status"] == "DEGRADED"
    assert result["stale"] is True
    assert result["generatedAt"] is None
    assert result["dataQuality"]["lastError"] == "RuntimeError: provider unavailable"
    assert result["dataQuality"]["lastFailedAt"] is not None
    assert service._last_refreshed_at is None


def test_failed_refresh_rolls_back_partial_state_and_returns_last_good_snapshot(monkeypatch):
    service = IntradayBreakoutService(client_factory=lambda: None)
    now = datetime.now(IST)
    start = datetime.combine(now.date(), datetime.min.time(), IST).replace(hour=9, minute=15)
    service._session_date = now.date()
    service._last_refreshed_at = now - timedelta(minutes=2)
    service._candidate_meta = {"OLD": {"symbol": "OLD", "bias": "LONG", "score": 88}}
    service._bars = {"OLD": {start: {**bar(15, 100, 102, 99, 101), "bar_start": start}}}
    service._signals = {("OLD", "PREVIOUS_DAY_HIGH_BREAK"): {
        "signal_type": "PREVIOUS_DAY_HIGH_BREAK",
        "timeframe_minutes": 0,
        "signal_time": (start + timedelta(minutes=5)).isoformat(),
        "trigger_price": 101,
        "previous_day_high": 100,
    }}
    good = service._record_good_snapshot(service._snapshot_unlocked(service._last_refreshed_at))
    good_generated_at = good["generatedAt"]

    async def new_candidates(_now):
        return [{"symbol": "NEW", "bias": "SHORT", "score": 99}]

    async def fail_after_mutation(symbol, _now):
        service._bars[symbol] = {start: {**bar(15, 50, 51, 48, 49), "bar_start": start}}
        raise RuntimeError("history source failed")

    monkeypatch.setattr(module, "can_evaluate_session", lambda _now: True)
    monkeypatch.setattr(service, "_tracked_candidates", new_candidates)
    monkeypatch.setattr(service, "_hydrate_symbol", fail_after_mutation)

    result = asyncio.run(service.refresh())

    assert result["status"] == "DEGRADED"
    assert result["stale"] is True
    assert result["generatedAt"] == good_generated_at
    assert [row["symbol"] for row in result["candidates"]] == ["OLD"]
    assert result["candidates"][0]["direction"] == "LONG"
    assert result["dataQuality"]["latestCandleAt"] == start.isoformat()
    assert result["dataQuality"]["lastError"] == "RuntimeError: history source failed"
    assert set(service._candidate_meta) == {"OLD"}
    assert set(service._bars) == {"OLD"}
    assert service._last_refreshed_at.isoformat() == good_generated_at


def test_serializer_failure_preserves_prior_success_timestamp(monkeypatch):
    service = IntradayBreakoutService(client_factory=lambda: None)
    now = datetime.now(IST)
    prior_success = now - timedelta(minutes=3)
    service._session_date = now.date()
    service._last_refreshed_at = prior_success
    service._last_good_snapshot = {
        "success": True,
        "status": "NO_SIGNALS",
        "sessionDate": now.date().isoformat(),
        "timestamp": int(prior_success.timestamp() * 1000),
        "generatedAt": prior_success.isoformat(),
        "marketHours": True,
        "summary": {},
        "candidates": [],
        "dataQuality": {"stale": False},
        "method": {},
        "stale": False,
    }

    async def no_candidates(_now):
        return []

    monkeypatch.setattr(module, "can_evaluate_session", lambda _now: True)
    monkeypatch.setattr(service, "_tracked_candidates", no_candidates)
    monkeypatch.setattr(
        service,
        "_snapshot_unlocked",
        lambda _now: (_ for _ in ()).throw(RuntimeError("serializer failed")),
    )

    result = asyncio.run(service.refresh())

    assert result["status"] == "DEGRADED"
    assert result["generatedAt"] == prior_success.isoformat()
    assert result["dataQuality"]["lastError"] == "RuntimeError: serializer failed"
    assert service._last_refreshed_at == prior_success


def test_chart_returns_full_session_and_individual_confirmation_times():
    service = IntradayBreakoutService(client_factory=lambda: None)
    session_date = datetime.now(IST).date()
    start = datetime.combine(session_date, datetime.min.time(), IST).replace(hour=9, minute=15)
    service._session_date = session_date
    service._last_refreshed_at = datetime.now(IST)
    service._bars["TEST"] = {
        start: {**bar(15, 100, 102, 99, 101), "bar_start": start},
        start + timedelta(minutes=5): {**bar(20, 101, 103, 100, 102), "bar_start": start + timedelta(minutes=5)},
        start + timedelta(minutes=10): {**bar(25, 102, 104, 101, 103), "bar_start": start + timedelta(minutes=10)},
    }
    service._candidate_meta["TEST"] = {"pdh": 102.5}
    signal_time = start + timedelta(minutes=15)
    service._signals[("TEST", "FIVE_MIN_BREAKOUT")] = {
        "signal_type": "FIVE_MIN_BREAKOUT",
        "timeframe_minutes": 5,
        "signal_time": signal_time.isoformat(),
        "trigger_price": 103,
        "previous_day_high": 102.5,
    }

    result = asyncio.run(service.chart("TEST", 15))

    assert result["timeframeMinutes"] == 15
    assert result["previousDayHigh"] == 102.5
    assert len(result["candles"]) == 1
    assert result["candles"][0]["open"] == 100
    assert result["candles"][0]["close"] == 103
    assert result["signals"][0]["signalTime"] == signal_time.isoformat()
    assert result["signals"][0]["breakoutLevel"] == 103
    assert result["signals"][0]["highReturnPct"] == 0.97
    assert result["signals"][0]["closeReturnPct"] == 0.0


def test_signal_metrics_use_breakout_level_for_high_and_close_returns():
    service = IntradayBreakoutService(client_factory=lambda: None)
    start = datetime(2026, 9, 21, 9, 15, tzinfo=IST)
    rows = [
        {**bar(15, 100, 102, 99, 101), "bar_start": start},
        {**bar(20, 101, 103, 100, 102), "bar_start": start + timedelta(minutes=5)},
        {**bar(25, 102, 106, 101, 105), "bar_start": start + timedelta(minutes=10)},
        {**bar(30, 105, 110, 104, 108), "bar_start": start + timedelta(minutes=15)},
    ]
    signal = {
        "signal_type": "FIVE_MIN_BREAKOUT",
        "timeframe_minutes": 5,
        "signal_time": (start + timedelta(minutes=15)).isoformat(),
        "trigger_price": 105,
        "prior_intraday_high": 103,
    }

    result = service._signal_payload(signal, rows)

    assert result["breakoutLevel"] == 103
    assert result["highAfterBreakout"] == 110
    assert result["sessionClose"] == 108
    assert result["highReturnPct"] == 6.8
    assert result["closeReturnPct"] == 4.85


def test_bearish_signal_metrics_use_low_and_direction_correct_returns():
    service = IntradayBreakoutService(client_factory=lambda: None)
    start = datetime(2026, 9, 21, 9, 15, tzinfo=IST)
    rows = [
        {**bar(15, 100, 101, 98, 99), "bar_start": start},
        {**bar(20, 99, 100, 97, 98), "bar_start": start + timedelta(minutes=5)},
        {**bar(25, 98, 99, 94, 95), "bar_start": start + timedelta(minutes=10)},
    ]
    signal = {
        "signal_type": "FIVE_MIN_BREAKDOWN", "timeframe_minutes": 5,
        "signal_time": (start + timedelta(minutes=15)).isoformat(),
        "trigger_price": 95, "prior_intraday_low": 97,
    }
    result = service._signal_payload(signal, rows)
    assert result["direction"] == "SHORT"
    assert result["breakoutLevel"] == 97
    assert result["lowAfterBreakout"] == 94
    assert result["bestReturnPct"] == 3.09
    assert result["closeReturnPct"] == 2.06


def test_chart_route_accepts_numeric_query_timeframe(monkeypatch):
    async def fake_chart(symbol, timeframe):
        return {"symbol": symbol, "timeframeMinutes": timeframe}

    monkeypatch.setattr(intraday_route.intraday_breakout_service, "chart", fake_chart)
    result = asyncio.run(intraday_route.intraday_breakout_chart("tega", 5, {}))

    assert result == {"symbol": "TEGA", "timeframeMinutes": 5}
