import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app.services import intraday_breakout_service as module
from app.services.intraday_events import event_envelope, event_records, previous_day_events, retracement_events

IST = ZoneInfo("Asia/Kolkata")
START = datetime(2026, 9, 24, 9, 15, tzinfo=IST)


def bars(short=False, minutes=5):
    values = [(100, 102.5, 99.8, 102), (102, 102.2, 100.8, 101),
              (101, 103.3, 100.9, 103), (103, 104.3, 102.9, 104),
              (104, 104.2, 103, 103.4), (103.4, 105.5, 103.2, 105),
              (105, 106.5, 104.9, 106)]
    return [{"bar_start": START+timedelta(minutes=minutes*i), "open": 200-o if short else o,
             "high": 200-l if short else h, "low": 200-h if short else l,
             "close": 200-c if short else c, "volume": 100} for i, (o, h, l, c) in enumerate(values)]


@pytest.mark.parametrize("short", [False, True])
@pytest.mark.parametrize("minutes", [5, 15])
def test_new_pullback_required_for_each_repeat(short, minutes):
    rows = bars(short, minutes)
    events = retracement_events(rows, minutes, short=short)
    assert len(events) == 2
    assert [event["signal_time"] for event in events] == [START+timedelta(minutes=minutes*3), START+timedelta(minutes=minutes*6)]
    assert [event["retracement_bar_start"] for event in events] == [rows[1]["bar_start"], rows[4]["bar_start"]]
    assert len(retracement_events(rows[:4], minutes, short=short)) == 1  # continuation is not a setup


@pytest.mark.parametrize("short", [False, True])
def test_previous_day_level_requires_real_recross(short):
    closes = [99, 101, 102, 103, 100, 101, 102]
    rows = [{"bar_start": START+timedelta(minutes=5*i), "close": 200-close if short else close} for i, close in enumerate(closes)]
    events = previous_day_events(rows, 100, short=short)
    assert [event["signal_time"] for event in events] == [START+timedelta(minutes=10), START+timedelta(minutes=30)]


def service_with(rows):
    service = module.IntradayBreakoutService(client_factory=lambda: None)
    service._session_date = START.date()
    service._bars["TEST"] = {row["bar_start"]: row for row in rows}
    service._candidate_meta["TEST"] = {"symbol": "TEST", "bias": "LONG", "score": 88, "pdh": 102.5, "pdl": 98}
    return service


def test_envelope_keeps_original_context_and_latest_candidate_separate(monkeypatch):
    monkeypatch.setattr(module, "is_market_hours", lambda: True)
    service = service_with(bars()[:3])
    service._detect_symbol_signals("TEST")
    first = deepcopy(event_records(service._signals[("TEST", "FIVE_MIN_BREAKOUT")])[0])
    service._bars["TEST"] = {row["bar_start"]: row for row in bars()}
    service._candidate_meta["TEST"]["score"] = 55
    changed = service._detect_symbol_signals("TEST")
    assert len(changed) == 1
    saved = service._signals[("TEST", "FIVE_MIN_BREAKOUT")]
    events = event_records(saved)
    assert len(events) == 2
    assert events[0] == first
    assert events[1]["radar_score"] == 55
    assert "priorEvents" not in saved["metadata"]["priorEvents"][0]["metadata"]
    assert service._detect_symbol_signals("TEST") == []
    candidate = service._snapshot_unlocked(START+timedelta(minutes=36))["candidates"][0]
    latest = next(row for row in candidate["signals"] if row["type"] == "FIVE_MIN_BREAKOUT")
    assert latest["eventNumber"] == 2
    earlier = next(row for row in candidate["events"] if row["type"] == "FIVE_MIN_BREAKOUT" and row["eventNumber"] == 1)
    assert earlier["entryAssessment"]["status"] == "SUPERSEDED"
    assert earlier["eventId"] != latest["eventId"]
    assert len([row for row in candidate["signals"] if row["type"] == "FIVE_MIN_BREAKOUT"]) == 1


def test_utc_database_roundtrip_does_not_duplicate_ist_confirmation():
    service = service_with(bars())
    service._detect_symbol_signals("TEST")
    for row in service._signals.values():
        row["signal_time"] = datetime.fromisoformat(row["signal_time"]).astimezone(timezone.utc).isoformat()
        for event in row["metadata"]["priorEvents"]:
            event["signal_time"] = datetime.fromisoformat(event["signal_time"]).astimezone(timezone.utc).isoformat()
    assert service._detect_symbol_signals("TEST") == []
    assert len(event_records(service._signals[("TEST", "FIVE_MIN_BREAKOUT")])) == 2


class MemoryDatabase:
    def __init__(self):
        self.tables = {"intraday_breakout_signals": [], "intraday_candles": []}
        self.fail_next = False
        self.writes = []

    def table(self, name):
        database = self
        class Query:
            start = 0
            end = 499
            payload = None
            def select(self, _fields): return self
            def eq(self, _column, _value): return self
            def order(self, _column): return self
            def range(self, start, end): self.start, self.end = start, end; return self
            def upsert(self, rows, on_conflict):
                assert on_conflict == "session_date,symbol,signal_type"
                self.payload = deepcopy(rows)
                return self
            def execute(self):
                if self.payload is not None:
                    if database.fail_next:
                        database.fail_next = False
                        raise RuntimeError("temporary save failure")
                    database.writes.append(self.payload)
                    existing = {(row["symbol"], row["signal_type"]): row for row in database.tables[name]}
                    existing.update({(row["symbol"], row["signal_type"]): row for row in self.payload})
                    database.tables[name] = list(existing.values())
                return SimpleNamespace(data=deepcopy(database.tables[name][self.start:self.end+1]))
        return Query()


def test_persistence_and_restart_restore_every_confirmation():
    database = MemoryDatabase()
    service = service_with(bars())
    service._client_factory = lambda: database
    changed = service._detect_symbol_signals("TEST")
    assert asyncio.run(service._persist_signals(changed)) is True
    restored = module.IntradayBreakoutService(client_factory=lambda: database)
    restored._session_date = START.date()
    asyncio.run(restored._load_session(START.date()))
    restored._bars = deepcopy(service._bars)
    restored._candidate_meta = deepcopy(service._candidate_meta)
    assert restored._detect_symbol_signals("TEST") == []
    assert len(event_records(restored._signals[("TEST", "FIVE_MIN_BREAKOUT")])) == 2


def test_failed_save_is_retried_without_new_market_event(monkeypatch):
    database = MemoryDatabase()
    database.fail_next = True
    service = service_with(bars())
    service._client_factory = lambda: database
    now = START+timedelta(minutes=36)
    class ClockMeta(type):
        def __instancecheck__(cls, instance): return isinstance(instance, datetime)
    class Clock(datetime, metaclass=ClockMeta):
        @classmethod
        def now(cls, tz=None): return now
    async def candidates(_now): return list(service._candidate_meta.values())
    monkeypatch.setattr(module, "datetime", Clock)
    monkeypatch.setattr(module, "is_market_hours", lambda: True)
    monkeypatch.setattr(service, "_tracked_candidates", candidates)
    monkeypatch.setattr(service, "_needs_history_sync", lambda *_args: False)
    monkeypatch.setattr(service, "_merge_runner_bars", lambda *_args: [])
    first = asyncio.run(service.refresh())
    assert first["dataQuality"]["pendingSignalWrites"] > 0
    second = asyncio.run(service.refresh())
    assert second["dataQuality"]["pendingSignalWrites"] == 0
    assert database.writes


def test_legacy_single_event_remains_readable():
    legacy = {"signal_time": START.isoformat(), "metadata": {"direction": "LONG"}, "radar_score": 71}
    assert event_records(legacy) == [legacy]
    envelope = event_envelope([legacy, {**legacy, "signal_time": (START+timedelta(minutes=30)).isoformat()}])
    assert len(event_records(envelope)) == 2
