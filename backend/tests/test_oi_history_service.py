import asyncio
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from app.services import oi_history_service as module
from app.services.oi_history_service import OIHistoryService, build_oi_snapshot_rows


IST = ZoneInfo("Asia/Kolkata")


def _chain(call_oi: int, call_ltp: float, put_oi: int, put_ltp: float) -> dict:
    return {
        "name": "NIFTY",
        "expiry": "20-AUG-2026",
        "spot": 22_015,
        "provider": {"provider": "arrow"},
        "chain": [
            {
                "strike": 22_000,
                "call": {"oi": call_oi, "ltp": call_ltp},
                "put": {"oi": put_oi, "ltp": put_ltp},
            },
            {
                "strike": 22_050,
                "call": {"oi": 800, "ltp": 75},
                "put": {"oi": 900, "ltp": 135},
            },
        ],
    }


def test_builds_overall_and_every_strike_on_five_minute_bucket() -> None:
    rows = build_oi_snapshot_rows(
        "nifty",
        _chain(1_000, 100, 1_200, 110),
        captured_at=datetime(2026, 8, 16, 10, 7, 42, tzinfo=IST),
    )

    assert len(rows) == 3
    assert rows[0]["scope"] == "overall"
    assert rows[0]["call_oi"] == 1_800
    assert rows[0]["put_oi"] == 2_100
    assert rows[0]["bucket_at"].endswith("+00:00")
    assert datetime.fromisoformat(rows[0]["bucket_at"]).astimezone(IST).strftime("%H:%M") == "10:05"
    assert {row["strike_price"] for row in rows[1:]} == {22_000.0, 22_050.0}
    assert all(row["change_label"] == "Baseline" for row in rows)


def test_explains_five_minute_oi_and_premium_change() -> None:
    baseline = build_oi_snapshot_rows(
        "nifty",
        _chain(1_000, 100, 1_200, 110),
        captured_at=datetime(2026, 8, 16, 10, 5, tzinfo=IST),
    )
    rows = build_oi_snapshot_rows(
        "nifty",
        _chain(1_300, 90, 1_700, 120),
        baseline,
        captured_at=datetime(2026, 8, 16, 10, 10, tzinfo=IST),
    )

    overall = rows[0]
    strike = rows[1]
    assert overall["call_oi_change"] == 300
    assert overall["put_oi_change"] == 500
    assert overall["change_direction"] == "BULLISH"
    assert overall["change_label"] == "Support building"
    assert "over five minutes" in overall["change_reason"]
    assert strike["call_action"] == "SHORT_BUILDUP"
    assert strike["put_action"] == "LONG_BUILDUP"
    assert "CE short buildup" in strike["change_reason"]
    assert "PE long buildup" in strike["change_reason"]


def test_database_gate_blocks_trezofin_project(monkeypatch) -> None:
    monkeypatch.setattr(
        module,
        "settings",
        SimpleNamespace(
            SUPABASE_URL="https://yhqnsuoynvifwaipqjzk.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY="configured",
            ALPHA_RADAR_SUPABASE_PROJECT_REF="yhqnsuoynvifwaipqjzk",
            OI_HISTORY_ENABLED=True,
        ),
    )

    status = OIHistoryService().database_status(require_enabled=True)

    assert status["ready"] is False
    assert "blocked" in status["reason"].lower()


def test_database_gate_requires_explicit_alpha_project_match(monkeypatch) -> None:
    monkeypatch.setattr(
        module,
        "settings",
        SimpleNamespace(
            SUPABASE_URL="https://alphaexampleproject.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY="configured",
            ALPHA_RADAR_SUPABASE_PROJECT_REF="differentproject",
            OI_HISTORY_ENABLED=True,
        ),
    )

    status = OIHistoryService().database_status(require_enabled=True)

    assert status["ready"] is False
    assert "repository-approved" in status["reason"]


def test_database_gate_accepts_only_matching_alpha_project(monkeypatch) -> None:
    monkeypatch.setattr(
        module,
        "settings",
        SimpleNamespace(
            SUPABASE_URL="https://xphrxbmvavrbqgmldbak.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY="configured",
            ALPHA_RADAR_SUPABASE_PROJECT_REF="xphrxbmvavrbqgmldbak",
            OI_HISTORY_ENABLED=True,
        ),
    )

    status = OIHistoryService().database_status(require_enabled=True)

    assert status == {
        "ready": True,
        "reason": None,
        "projectRef": "xphrxbmvavrbqgmldbak",
    }


def test_history_rows_keep_only_latest_ist_session(monkeypatch) -> None:
    monkeypatch.setattr(module, "settings", SimpleNamespace(TIMEZONE=IST))
    rows = [
        {"bucket_at": "2026-09-20T09:30:00+00:00", "scope": "overall"},
        {"bucket_at": "2026-09-21T03:45:00+00:00", "scope": "overall"},
        {"bucket_at": "2026-09-21T04:00:00+00:00", "scope": "strike"},
    ]

    filtered, session_date = module._latest_session_rows(rows)

    assert session_date == "2026-09-21"
    assert len(filtered) == 2
    assert {row["bucket_at"] for row in filtered} == {
        "2026-09-21T03:45:00+00:00",
        "2026-09-21T04:00:00+00:00",
    }


def test_history_falls_back_to_latest_stored_expiry(monkeypatch) -> None:
    monkeypatch.setattr(
        module,
        "settings",
        SimpleNamespace(
            TIMEZONE=IST,
            OI_HISTORY_REDIS_SNAPSHOTS=96,
            OI_HISTORY_ENABLED=True,
            OI_HISTORY_INTERVAL_MINUTES=5,
        ),
    )
    service = OIHistoryService()
    monkeypatch.setattr(service, "database_status", lambda: {"ready": True})

    queried_expiries: list[str] = []

    def query_rows(index_key: str, expiry: str, strike: float | None, limit: int) -> list[dict]:
        queried_expiries.append(expiry)
        if expiry == "2026-09-29":
            return []
        return [{"bucket_at": "2026-09-21T10:00:00+00:00", "scope": "overall"}]

    monkeypatch.setattr(service, "_query_history_rows", query_rows)
    monkeypatch.setattr(
        service,
        "_query_latest_history_rows",
        lambda index_key, strike, limit: (
            [{"bucket_at": "2026-09-21T10:00:00+00:00", "scope": "overall"}],
            "2026-09-22",
        ),
    )

    response = asyncio.run(service.history("nifty", "2026-09-29", strike=23_400, limit=96))

    assert queried_expiries == ["2026-09-29"]
    assert response["requestedExpiry"] == "2026-09-29"
    assert response["expiry"] == "2026-09-22"
    assert response["storage"] == "supabase"
    assert len(response["snapshots"]) == 1


def test_latest_history_rows_resolve_expiry_and_strike(monkeypatch) -> None:
    overall = [
        {"bucket_at": "2026-09-21T10:00:00+00:00", "expiry": "2026-09-22", "scope": "overall"},
        {"bucket_at": "2026-09-21T09:55:00+00:00", "expiry": "2026-09-22", "scope": "overall"},
    ]
    strike = [
        {
            "bucket_at": "2026-09-21T10:00:00+00:00",
            "expiry": "2026-09-22",
            "scope": "strike",
            "strike_price": 23_400,
        }
    ]

    class Query:
        def __init__(self) -> None:
            self.filters: dict[str, object] = {}

        def select(self, *_args, **_kwargs):
            return self

        def eq(self, key, value):
            self.filters[key] = value
            return self

        def order(self, *_args, **_kwargs):
            return self

        def limit(self, *_args, **_kwargs):
            return self

        def execute(self):
            rows = strike if self.filters.get("scope") == "strike" else overall
            return SimpleNamespace(data=rows)

    class Client:
        def table(self, _name):
            return Query()

    monkeypatch.setattr("app.core.supabase_client.get_supabase_client", lambda: Client())

    rows, expiry = OIHistoryService()._query_latest_history_rows("nifty", 23_400, 96)

    assert expiry == "2026-09-22"
    assert rows == [*overall, *strike]
