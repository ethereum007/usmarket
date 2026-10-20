"""Validate provider session evidence; never infer holidays from weekdays."""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
VERSION = "us-provider-sessions-v1"
FINALIZATION_MINUTES = 30


def calendar_rows(calendar: list[dict]) -> list[dict]:
    if not isinstance(calendar, list):
        raise ValueError("Invalid US provider calendar")
    rows = {}
    for row in calendar:
        try:
            day = date.fromisoformat(row["date"])
            close = time.fromisoformat(row["close"])
            if day.isoformat() != row["date"] or close.tzinfo is not None or day.weekday() >= 5:
                raise ValueError()
            normalized = {"date": day.isoformat(), "close": close.isoformat()}
            if "open" in row:
                opening = time.fromisoformat(row["open"])
                if opening.tzinfo is not None or opening >= close:
                    raise ValueError()
                normalized["open"] = opening.isoformat()
            # Regular equity session evidence must not cross a DST transition hour.
            if not time(9, 30) < close <= time(16):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise ValueError("Invalid US provider calendar session") from None
        if normalized["date"] in rows and rows[normalized["date"]] != normalized:
            raise ValueError("Conflicting US provider calendar sessions")
        rows[normalized["date"]] = normalized
    return [rows[key] for key in sorted(rows)]


def completed_calendar(calendar: list[dict], now: datetime) -> list[dict]:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    completed = []
    for row in calendar_rows(calendar):
        close = datetime.fromisoformat(row["date"] + "T" + row["close"]).replace(tzinfo=NY)
        finalized = close + timedelta(minutes=FINALIZATION_MINUTES)
        if finalized <= now:
            completed.append({**row, "close_at": close.isoformat(),
                              "finalized_at": finalized.astimezone(timezone.utc).isoformat()})
    return completed


def missing_sessions(bars: list[dict], sessions: list[str]) -> list[str]:
    """No claim about pre-listing coverage before the first observed bar."""
    if not bars:
        return []
    observed = {bar["date"] for bar in bars}
    first = min(observed)
    return [session for session in sessions if session >= first and session not in observed]
