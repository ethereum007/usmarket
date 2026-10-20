"""Owner-isolated, immutable US plan revisions; research only, never execution."""
from datetime import date, datetime, timezone
from decimal import Decimal
import sqlite3
import os
from typing import Callable, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.routes.us_research import read_package
from app.services import swing_repository as repo
from app.services.us_research import NY
from app.us_auth import require_us_user

router = APIRouter(prefix="/api/us/plans", tags=["US plans"])


class SizingFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trigger: float = Field(ge=0.0001, le=1_000_000, allow_inf_nan=False)
    stop: float = Field(ge=0.0001, le=1_000_000, allow_inf_nan=False)
    capital: float = Field(ge=1, le=1_000_000_000_000, allow_inf_nan=False)
    risk_pct: float = Field(gt=0, le=5, allow_inf_nan=False)
    allocation_cap_pct: float = Field(gt=0, le=100, allow_inf_nan=False)


class SizingPreview(SizingFields):
    direction: Literal["BULL", "BEAR"]


def calculate_sizing(payload: SizingFields, direction: str):
    if (direction == "BULL" and payload.stop >= payload.trigger) or (direction == "BEAR" and payload.stop <= payload.trigger):
        raise HTTPException(422, "Stop must invalidate the selected direction")
    trigger, stop, capital, risk, allocation = map(Decimal, map(str, (
        payload.trigger, payload.stop, payload.capital, payload.risk_pct, payload.allocation_cap_pct)))
    risk_budget, allocation_budget = capital*risk/100, capital*allocation/100
    risk_per_share = abs(trigger-stop)
    quantity = min(int(risk_budget/risk_per_share), int(allocation_budget/trigger))
    if quantity > 9007199254740991:
        raise HTTPException(422, "Whole-share quantity exceeds supported display precision")
    return {'quantity':quantity, 'currency':'USD', 'direction':direction,
            'risk_budget_usd':float(risk_budget), 'allocation_budget_usd':float(allocation_budget),
            'risk_per_share_usd':float(risk_per_share), 'planning_notional_usd':float(quantity*trigger),
            'stop_risk_usd':float(quantity*risk_per_share),
            'state':'zero_capacity' if quantity == 0 else 'whole_shares',
            'execution_readiness':'PLANNING_ONLY', 'filled':False}


@router.post("/sizing-preview")
def sizing_preview(payload: SizingPreview, user: dict = Depends(require_us_user)):
    return {'success':True, 'sizing':calculate_sizing(payload,payload.direction)}


class PlanRequest(SizingFields):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(default=0, ge=0)
    package_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    setup_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    expiry: date
    exit_policy: str = Field(min_length=5, max_length=1000)
    notes: str = Field(default="", max_length=10000)
    state: Literal["draft", "planned", "cancelled", "invalidated", "expired"] = "draft"


def store(operation: Callable, *args, access_token=None, **kwargs):
    """Dedicated US file; never silently fall back to the inherited database."""
    mode = os.environ.get('US_PLAN_STORE', 'sqlite')
    if mode == 'supabase':
        from app.services.us_remote_plans import execute
        return execute(operation, args, access_token)
    if mode != 'sqlite':
        raise HTTPException(503, 'US plan storage is not configured')
    try:
        return operation(*args, database_path=settings.DATA_DIR / "us-plans.sqlite3", **kwargs)
    except PermissionError:
        raise HTTPException(404, "Plan not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except (sqlite3.Error, OSError):
        raise HTTPException(503, "US plan storage is unavailable; no save was confirmed")


@router.get("")
def plans(user: dict = Depends(require_us_user)):
    return {"success": True, "plans": store(repo.list_plans, user["id"], access_token=user.get("_access_token"))}


@router.get("/export")
def export_plans(user: dict = Depends(require_us_user)):
    revisions = store(repo.export_plan_revisions, user["id"], access_token=user.get("_access_token"))
    return JSONResponse({
        'schema_version': 1, 'market': 'US', 'currency': 'USD',
        'exported_at': datetime.now(timezone.utc).isoformat(),
        'plan_revisions': revisions, 'revision_count': len(revisions),
        'scope': 'Private plan history only. Research packages are not included. No restore is confirmed.',
    }, headers={'Content-Disposition': 'attachment; filename="usmarket-plan-history.json"',
                'Cache-Control': 'private, no-store', 'Vary': 'Authorization'})


@router.get("/{plan_id}")
def revision(plan_id: UUID, revision: int = Query(..., ge=1), user: dict = Depends(require_us_user)):
    saved = store(repo.get_plan, user["id"], str(plan_id), revision, access_token=user.get("_access_token"))
    if saved is None:
        raise HTTPException(404, "Plan revision not found")
    return {"success": True, "plan": saved}


@router.post("/{plan_id}")
def save(plan_id: UUID, payload: PlanRequest, user: dict = Depends(require_us_user)):
    package = read_package(payload.package_id)
    if package.get("state") != "final" or package.get("currency") != "USD":
        raise HTTPException(422, "A US plan requires final USD research")
    setup = next((row for row in package.get("setups", []) if row.get("setup_version") == payload.setup_version), None)
    if setup is None:
        raise HTTPException(422, "Setup version does not belong to source package")
    if not all(setup.get(key) for key in ("setup_id", "source_snapshot_id", "symbol")):
        raise HTTPException(409, "Source setup is missing evidence identity")
    direction = setup.get("signal")
    if direction not in {"BULL", "BEAR"}:
        raise HTTPException(422, "Unsupported research direction")
    sizing = calculate_sizing(payload, direction)
    try:
        source_date = date.fromisoformat(package["session"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(409, "Source package has no valid session")
    if payload.expiry < source_date:
        raise HTTPException(422, "Expiry cannot precede the source session")
    if payload.state == "planned" and payload.expiry < datetime.now(NY).date():
        raise HTTPException(422, "An active plan cannot already be expired in New York")
    values = payload.model_dump(mode="json", exclude={"expected_revision"})
    values.update(
        market="US", currency="USD", timezone="America/New_York",
        symbol=setup["symbol"], direction=direction, setup_id=setup["setup_id"],
        provider_asset_id=setup.get("provider_asset_id"),
        source_snapshot_id=setup["source_snapshot_id"], session=package["session"],
        quantity=sizing["quantity"], sizing=sizing,
        sizing_policy="Whole shares; min(stop risk, allocation cap). Gaps, slippage, fees and liquidity unverified.",
        event_risk="Unknown: earnings and catalysts are not provider-verified",
        execution_readiness="PLANNING_ONLY", alert_state="not_armed", filled=False,
        short_constraints="Borrow availability and short-sale constraints unverified" if direction == "BEAR" else None,
    )
    saved = store(
        repo.save_plan, user["id"], str(plan_id), payload.expected_revision, values,
        access_token=user.get("_access_token"), updated_at=datetime.now(timezone.utc).isoformat(),
        immutable_fields=("setup_id", "package_id", "setup_version", "source_snapshot_id", "symbol", "direction", "provider_asset_id"),
    )
    return {"success": True, "plan": saved}
