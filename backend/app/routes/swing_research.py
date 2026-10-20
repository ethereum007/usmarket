"""Saved swing research, bounded refresh jobs and tenant-owned plans."""
from datetime import date
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies import get_current_user, get_optional_kite, require_premium
from app.services import swing_repository as repo
from app.services import swing_research as research

router = APIRouter(prefix="/research", tags=["swing research"])
Universe = Literal["nifty50", "nifty100", "nifty200", "nifty500", "smallcap", "microcap"]


class RefreshRequest(BaseModel):
    universe: Universe = "nifty50"


class PlanRequest(BaseModel):
    expected_revision: int = Field(default=0, ge=0)
    package_id: str = Field(min_length=64, max_length=64)
    setup_version: str = Field(min_length=64, max_length=64)
    trigger: float = Field(gt=0, allow_inf_nan=False)
    stop: float = Field(gt=0, allow_inf_nan=False)
    expiry: date
    exit_policy: str = Field(min_length=5, max_length=1000)
    notes: str = Field(default="", max_length=10000)
    state: Literal["draft", "planned", "cancelled", "invalidated", "expired"] = "draft"
    capital: float = Field(gt=0, allow_inf_nan=False)
    risk_pct: float = Field(gt=0, le=5, allow_inf_nan=False)
    allocation_cap_pct: float = Field(gt=0, le=100, allow_inf_nan=False)
    earnings_state: Literal["unknown", "checked_no_event", "event_nearby"] = "unknown"


@router.get("/package")
def latest(universe: Universe = "nifty50", user: dict = Depends(get_current_user)):
    final = repo.latest_package(universe)
    latest_attempt = repo.latest_package(universe, final_only=False)
    return {"success": True, "package": final or latest_attempt, "last_attempt": latest_attempt,
            "has_final": final is not None}


@router.get("/packages/{package_id}")
def package(package_id: str, user: dict = Depends(get_current_user)):
    data = repo.get_package(package_id)
    if data is None:
        raise HTTPException(404, "Research package not found")
    return {"success": True, "package": data}


@router.get("/history")
def history(universe: Universe = "nifty50", user: dict = Depends(get_current_user)):
    return {"success": True, "sessions": repo.package_sessions(universe),
            "basis": "Latest final revision per actually published session; no inferred past scans"}


@router.post("/refresh")
def start_refresh(payload: RefreshRequest, tasks: BackgroundTasks,
                  kite=Depends(get_optional_kite), user: dict = Depends(require_premium)):
    if kite is None:
        raise HTTPException(503, "Historical provider is unavailable; saved packages remain accessible")
    from app.caches.stock_universes import resolve_universe
    symbols = sorted(set(resolve_universe(payload.universe, limit=500)))
    if not symbols:
        raise HTTPException(422, "Configured universe has no symbols")
    job = {"id": str(uuid4()), "owner": user["id"], "universe": payload.universe,
           "state": "queued", "created_at": repo.now_iso(), "completed": 0, "total": len(symbols) + 1}
    try:
        repo.create_job(job)
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    tasks.add_task(research.refresh, job, kite, symbols)
    return {"success": True, "job": {k: v for k, v in job.items() if k != "owner"}}


@router.get("/jobs/{job_id}")
def job_status(job_id: str, user: dict = Depends(require_premium)):
    job = repo.get_job(job_id, user["id"])
    if job is None:
        raise HTTPException(404, "Refresh job not found")
    return {"success": True, "job": {k: v for k, v in job.items() if k != "owner"}}


@router.get("/plans")
def plans(user: dict = Depends(require_premium)):
    return {"success": True, "plans": repo.list_plans(user["id"])}


@router.post("/plans/{plan_id}")
def save_plan(plan_id: str, payload: PlanRequest, user: dict = Depends(require_premium)):
    try:
        from uuid import UUID
        UUID(plan_id)
    except ValueError:
        raise HTTPException(422, "Plan ID must be a UUID")
    package = repo.get_package(payload.package_id)
    if package is None:
        raise HTTPException(404, "Source research package not found")
    setup = next((s for s in package["setups"] if s["setup_version"] == payload.setup_version), None)
    if setup is None:
        raise HTTPException(422, "Setup version does not belong to source package")
    direction = setup["signal"]
    if (direction == "BULL" and payload.stop >= payload.trigger) or (direction == "BEAR" and payload.stop <= payload.trigger):
        raise HTTPException(422, "Stop must invalidate the selected direction")
    if payload.expiry.isoformat() < package["session"]:
        raise HTTPException(422, "Expiry cannot precede the source session")
    from datetime import datetime
    if payload.state == "planned" and payload.expiry < datetime.now(settings.TIMEZONE).date():
        raise HTTPException(422, "An active plan cannot already be expired")
    risk_per_share = abs(payload.trigger - payload.stop)
    risk_qty = int(payload.capital * payload.risk_pct / 100 / risk_per_share)
    allocation_qty = int(payload.capital * payload.allocation_cap_pct / 100 / payload.trigger)
    values = payload.model_dump(mode="json", exclude={"expected_revision"})
    values.update(symbol=setup["symbol"], direction=direction, setup_id=setup["setup_id"],
                  source_snapshot_id=setup["source_snapshot_id"], session=package["session"],
                  quantity=min(risk_qty, allocation_qty), sizing_policy="min(stop risk, allocation cap); liquidity/gap stress unverified",
                  event_risk="User checked; no provider validation" if payload.earnings_state != "unknown" else "Unknown: check earnings before entry",
                  execution_readiness="PLANNING_ONLY", alert_state="not_armed", filled=False)
    try:
        saved = repo.save_plan(user["id"], plan_id, payload.expected_revision, values)
    except PermissionError:
        raise HTTPException(404, "Plan not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    return {"success": True, "plan": saved}


@router.get("/plans/{plan_id}")
def plan_revision(plan_id: str, revision: int = Query(..., ge=1), user: dict = Depends(require_premium)):
    plan = repo.get_plan(user["id"], plan_id, revision)
    if plan is None:
        raise HTTPException(404, "Plan revision not found")
    latest = next((p for p in repo.list_plans(user["id"]) if p["id"] == plan_id), plan)
    return {"success": True, "plan": plan, "latest": latest}
