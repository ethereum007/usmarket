from datetime import datetime, timezone
from unittest.mock import patch

import pandas as pd
import pytest

from app.services.us_sessions import calendar_rows, completed_calendar
from app.services.us_research import research_package, save_package


@pytest.mark.parametrize("day,close,before,after", [
    ("2026-03-06", "16:00", "2026-03-06T21:29:59+00:00", "2026-03-06T21:30:00+00:00"),
    ("2026-03-09", "16:00", "2026-03-09T20:29:59+00:00", "2026-03-09T20:30:00+00:00"),
    ("2026-10-30", "16:00", "2026-10-30T20:29:59+00:00", "2026-10-30T20:30:00+00:00"),
    ("2026-11-02", "16:00", "2026-11-02T21:29:59+00:00", "2026-11-02T21:30:00+00:00"),
    ("2026-11-27", "13:00", "2026-11-27T18:29:59+00:00", "2026-11-27T18:30:00+00:00"),
])
def test_provider_close_buffer_dst_and_early_close(day, close, before, after):
    rows = [{"date": day, "open": "09:30", "close": close}]
    assert completed_calendar(rows, datetime.fromisoformat(before)) == []
    final = completed_calendar(rows, datetime.fromisoformat(after))
    assert final[0]["date"] == day
    assert final[0]["finalized_at"] == after


@pytest.mark.parametrize("calendar", [None, {}, [None], [{"date": "2026-07-01"}],
    [{"date": "2026-07-01", "close": "25:00"}],
    [{"date": "20260701", "close": "16:00"}],
    [{"date": "2026-07-04", "close": "16:00"}],
    [{"date": "2026-07-01", "close": "16:00+00:00"}],
    [{"date": "2026-07-01", "close": "09:00"}],
    [{"date": "2026-07-01", "open": "16:00", "close": "13:00"}],
    [{"date": "2026-07-01", "close": "16:00"}, {"date": "2026-07-01", "close": "13:00"}],
])
def test_malformed_or_conflicting_calendar_fails_closed(calendar):
    with pytest.raises(ValueError, match="US provider calendar"):
        completed_calendar(calendar, datetime(2026, 7, 2, tzinfo=timezone.utc))


def test_naive_clock_rejected():
    with pytest.raises(ValueError, match="Timezone-aware"):
        completed_calendar([], datetime(2026, 7, 2))


def test_identical_duplicates_and_calendar_order_are_normalized():
    rows = [{"date": "2026-07-02", "close": "13:00"}, {"date": "2026-07-01", "close": "16:00"}]
    assert calendar_rows(rows + rows) == calendar_rows(list(reversed(rows)))


def evidence():
    # Synthetic provider calendar; no claim this is actual exchange history.
    days = [day.date().isoformat() for day in pd.bdate_range("2026-01-05", periods=45)]
    calendar = [{"date": day, "open": "09:30", "close": "16:00"} for day in days]
    bars = [{"t": day + "T05:00:00Z", "o": 100 + i, "h": 102 + i, "l": 99 + i, "c": 101 + i, "v": 1000} for i, day in enumerate(days)]
    now = datetime(2026, 7, 2, tzinfo=timezone.utc)
    return days, calendar, bars, now


@pytest.mark.parametrize("index", [0, 20, -1])
def test_missing_benchmark_leading_middle_or_latest_session_blocks_publication(index):
    _, calendar, bars, now = evidence()
    benchmark = list(bars)
    benchmark.pop(index)
    with pytest.raises(ValueError, match="Benchmark"):
        research_package(["AAPL"], {"SPY": benchmark, "AAPL": bars}, calendar, now)


def test_stock_gap_withholds_detector_and_partial_preserves_last_final(tmp_path):
    days, calendar, bars, now = evidence()
    with patch("app.services.swing_research.scan_swing_spectrum", return_value=[]) as detector:
        final = research_package(["AAPL"], {"SPY": bars, "AAPL": bars}, calendar, now)
        assert detector.call_count == 1
        save_package(final, tmp_path)
        detector.reset_mock()
        partial = research_package(["AAPL"], {"SPY": bars, "AAPL": bars[:20] + bars[21:]}, calendar, now)
        detector.assert_not_called()
    assert partial["state"] == "partial"
    assert partial["features"]["AAPL"]["available"]  # Latest price exists, history is still incomplete.
    assert partial["history_gaps"] == {"AAPL": [days[20]]}
    assert partial["features"]["AAPL"]["rs60"] is None
    assert "AAPL" in partial["setup_exclusions"]
    save_package(partial, tmp_path)
    import json
    pointer = json.loads((tmp_path / (final["universe"] + "-latest-final.json")).read_text())
    assert pointer["id"] == final["id"]


def test_provider_holiday_absence_and_short_listing_are_not_fabricated_gaps():
    days, calendar, bars, now = evidence()
    # Provider omits this day; neither benchmark nor stock should invent a bar for it.
    calendar.pop(20)
    bars.pop(20)
    with patch("app.services.swing_research.scan_swing_spectrum", return_value=[]):
        result = research_package(["IPO"], {"SPY": bars, "IPO": bars[-10:]}, calendar, now)
    assert result["state"] == "final" and result["history_gaps"] == {}
    assert result["features"]["IPO"]["ema20"] is None
    assert days[20] not in [row["date"] for row in result["session_calendar"]["sessions"]]


def test_calendar_identity_is_canonical_and_close_corrections_create_new_lineage():
    _, calendar, bars, now = evidence()
    with patch("app.services.swing_research.scan_swing_spectrum", return_value=[]):
        first = research_package(["AAPL"], {"SPY": bars, "AAPL": bars}, calendar, now)
        reordered = research_package(["AAPL"], {"SPY": bars, "AAPL": bars}, list(reversed(calendar)) + calendar, now)
        calendar[-1] = {**calendar[-1], "close": "13:00"}
        corrected = research_package(["AAPL"], {"SPY": bars, "AAPL": bars}, calendar, now)
    assert first["session_calendar"]["id"] == reordered["session_calendar"]["id"]
    assert first["id"] == reordered["id"]
    assert first["session_calendar"]["id"] != corrected["session_calendar"]["id"]
    assert first["id"] != corrected["id"]
