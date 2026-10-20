from dataclasses import replace
from datetime import datetime
from unittest.mock import patch, AsyncMock
from uuid import uuid4

import pandas as pd
import pytest
from fastapi import HTTPException

from app.config import settings
from app.services import swing_repository as repo
from app.services import swing_research as research
from app.routes.swing_research import PlanRequest, save_plan, plans, plan_revision


@pytest.fixture
def store(tmp_path):
    with patch.object(repo, "settings", replace(settings, DATA_DIR=tmp_path)):
        yield


def bars(count=300, start=100, step=1):
    return [{"date": day.strftime("%Y-%m-%d"), "open": start+i*step, "high": start+i*step+1,
             "low": start+i*step-1, "close": start+i*step, "volume": 1000}
            for i, day in enumerate(pd.bdate_range("2024-01-01", periods=count))]


def test_actual_ema_returns_extremes_and_unknown_short_history():
    history = bars()
    f = research.features(history, history, history[-1]["date"])
    assert f["return5"] == pytest.approx((399/394-1)*100)
    assert f["ema20"] == pytest.approx(pd.Series([r["close"] for r in history]).ewm(span=20, adjust=False).mean().iloc[-1])
    assert f["rs20"] == pytest.approx(0)
    assert f["high252"] == 400
    short = research.features(history[-10:], history, history[-1]["date"])
    assert short["ema20"] is None and short["return20"] is None and short["high252"] is None
    gap = research.features(history[:-3] + history[-2:], history, history[-1]["date"])
    assert gap["return5"] is None


def test_breadth_denominators_do_not_turn_unknown_into_zero():
    history = bars()
    known = research.features(history, history, history[-1]["date"])
    short = research.features(history[-5:], history, history[-1]["date"])
    result = research.breadth({"A": known, "IPO": short, "MISSING": {"available": False}}, 3)
    assert result["requested"] == 3 and result["available"] == 2
    assert result["gauges"][1] == {"label": "20 EMA", "eligible": 1, "above": 1, "value": 100}
    assert research.breadth({}, 3)["gauges"][0]["value"] is None


def test_only_valid_completed_provider_bars_are_saved():
    raw = [{**bars(1)[0], "date": day} for day in ["2026-10-16", "2026-10-18", "2026-10-19"]]
    now = datetime(2026, 10, 19, 12, tzinfo=settings.TIMEZONE)
    assert [b["date"] for b in research.completed_bars(raw, now)] == ["2026-10-16"]
    assert research.completed_bars([{**raw[0], "close": float("nan")}], now) == []


def test_partial_package_cannot_replace_last_final_and_source_is_immutable(store):
    base = {"universe": "nifty50", "session": "2026-10-16", "state": "final", "source_bars": {"A": bars(1)}}
    saved = repo.publish(base)
    assert repo.publish({**base, "computed_at": "later"})["id"] == saved["id"]
    repo.publish({**base, "state": "partial", "session": "2026-10-19"})
    assert repo.latest_package("nifty50")["id"] == saved["id"]
    assert repo.latest_package("nifty50", False)["state"] == "partial"
    assert len(repo.package_sessions("nifty50")) == 1
    assert repo.package_sessions("nifty50")[0]["id"] == saved["id"]
    repo.save_bars("A", [{**bars(1)[0], "close": 999}])
    assert repo.get_package(saved["id"])["source_bars"]["A"][0]["close"] == 100


def test_private_plans_are_versioned_isolated_and_conflict_checked(store):
    plan_id = str(uuid4())
    first = repo.save_plan("alice", plan_id, 0, {"setup_id": "one", "notes": "private"})
    assert first["revision"] == 1
    assert repo.list_plans("bob") == []
    with pytest.raises(PermissionError):
        repo.save_plan("bob", plan_id, 0, {"setup_id": "one"})
    with pytest.raises(ValueError):
        repo.save_plan("alice", plan_id, 0, {"setup_id": "one"})
    with pytest.raises(ValueError):
        repo.save_plan("alice", plan_id, 1, {"setup_id": "different"})
    second = repo.save_plan("alice", plan_id, 1, {"setup_id": "one", "notes": "revised"})
    assert second["revision"] == 2 and len(repo.list_plans("alice")) == 1


def test_plan_api_validates_source_direction_and_stop_based_allocation(store):
    setup = {"setup_id": "setup", "setup_version": "a"*64, "source_snapshot_id": "snapshot", "symbol": "TEST", "signal": "BULL"}
    package = repo.publish({"universe": "nifty50", "session": "2026-10-16", "state": "final", "setups": [setup]})
    payload = PlanRequest(package_id=package["id"], setup_version="a"*64, trigger=100, stop=95,
                          expiry="2030-01-01", exit_policy="Review support after five sessions", capital=100000,
                          risk_pct=1, allocation_cap_pct=10)
    result = save_plan(str(uuid4()), payload, {"id": "alice"})["plan"]
    assert result["quantity"] == 100 and result["revision"] == 1 and result["filled"] is False
    save_plan(result["id"], payload.model_copy(update={"expected_revision": 1, "notes": "revised"}), {"id": "alice"})
    archived = plan_revision(result["id"], 1, {"id": "alice"})
    assert archived["plan"]["notes"] == "" and archived["latest"]["notes"] == "revised"
    with pytest.raises(HTTPException) as denied:
        plan_revision(result["id"], 1, {"id": "bob"})
    assert denied.value.status_code == 404
    assert plans({"id": "bob"})["plans"] == []
    with pytest.raises(HTTPException) as exc:
        save_plan(str(uuid4()), payload.model_copy(update={"stop": 101}), {"id": "alice"})
    assert exc.value.status_code == 422


def test_refresh_lock_prevents_competing_provider_jobs(store):
    job = {"id": str(uuid4()), "owner": "alice", "state": "queued"}
    repo.create_job(job)
    with pytest.raises(ValueError):
        repo.create_job({**job, "id": str(uuid4()), "owner": "bob"})
    assert repo.get_job(job["id"], "bob") is None


def test_provider_outage_keeps_final_and_records_partial_attempt(store):
    import asyncio
    history = bars()
    repo.save_bars("NIFTY 500", history)
    repo.save_bars("TEST", history)
    final = repo.publish(research.build_package("nifty50", ["TEST"], {"TEST": history}, history))
    job = {"id": str(uuid4()), "owner": "alice", "universe": "nifty50", "state": "queued"}
    with patch("app.services.scanner_service._resolve_tokens", return_value={"NIFTY 500": 1, "TEST": 2}), \
         patch("app.services.scanner_service._fetch_historical", new=AsyncMock(side_effect=RuntimeError("provider offline"))), \
         patch("app.services.swing_research.asyncio.sleep", new=AsyncMock()):
        asyncio.run(research.refresh(job, object(), ["TEST"]))
    assert repo.latest_package("nifty50")["id"] == final["id"]
    assert repo.latest_package("nifty50", False)["state"] == "partial"
    assert repo.get_job(job["id"], "alice")["package_state"] == "partial"


def test_missing_benchmark_never_becomes_absolute_return_relative_strength():
    from app.engines.cpr.swing_detector import scan_swing_spectrum
    history = bars()
    prior = history[-2]["close"]
    history[-1].update(open=prior * 1.01, high=prior * 1.08, low=prior * 1.005, close=prior * 1.07, volume=3500)
    stock = pd.DataFrame(history)
    signals = scan_swing_spectrum(stock, "TEST")
    assert signals
    assert all(s.benchmark_rs_20 is None and s.benchmark_rs_60 is None for s in signals)
