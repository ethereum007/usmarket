"""Owner-isolated, immutable US plan revisions; research only, never execution."""
from datetime import date, datetime, timezone
from decimal import Decimal
import sqlite3
from typing import Callable, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.routes.us_research import read_package
from app.services import swing_repository as repo
from app.services.us_research import NY
from app.us_auth import require_us_user

router = APIRouter(prefix="/api/us/plans", tags=["US plans"])


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(default=0, ge=0)
    package_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    setup_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    trigger: float = Field(ge=0.0001, le=1_000_000, allow_inf_nan=False)
    stop: float = Field(ge=0.0001, le=1_000_000, allow_inf_nan=False)
    expiry: date
    exit_policy: str = Field(min_length=5, max_length=1000)
    notes: str = Field(default="", max_length=10000)
    state: Literal["draft", "planned", "cancelled", "invalidated", "expired"] = "draft"
    capital: float = Field(ge=1, le=1_000_000_000_000, allow_inf_nan=False)
    risk_pct: float = Field(gt=0, le=5, allow_inf_nan=False)
    allocation_cap_pct: float = Field(gt=0, le=100, allow_inf_nan=False)


def store(operation: Callable, *args, **kwargs):
    """Dedicated US file; never silently fall back to the inherited database."""
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
    return {"success": True, "plans": store(repo.list_plans, user["id"])}


@router.get("/{plan_id}")
def revision(plan_id: UUID, revision: int = Query(..., ge=1), user: dict = Depends(require_us_user)):
    saved = store(repo.get_plan, user["id"], str(plan_id), revision)
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
    if (direction == "BULL" and payload.stop >= payload.trigger) or (direction == "BEAR" and payload.stop <= payload.trigger):
        raise HTTPException(422, "Stop must invalidate the selected direction")
    try:
        source_date = date.fromisoformat(package["session"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(409, "Source package has no valid session")
    if payload.expiry < source_date:
        raise HTTPException(422, "Expiry cannot precede the source session")
    if payload.state == "planned" and payload.expiry < datetime.now(NY).date():
        raise HTTPException(422, "An active plan cannot already be expired in New York")
    # Decimal arithmetic avoids binary float truncation at whole-share boundaries.
    trigger, stop, capital, risk, allocation = map(Decimal, map(str, (
        payload.trigger, payload.stop, payload.capital, payload.risk_pct, payload.allocation_cap_pct)))
    risk_qty = int(capital * risk / 100 / abs(trigger - stop))
    allocation_qty = int(capital * allocation / 100 / trigger)
    values = payload.model_dump(mode="json", exclude={"expected_revision"})
    values.update(
        market="US", currency="USD", timezone="America/New_York",
        symbol=setup["symbol"], direction=direction, setup_id=setup["setup_id"],
        provider_asset_id=setup.get("provider_asset_id"),
        source_snapshot_id=setup["source_snapshot_id"], session=package["session"],
        quantity=min(risk_qty, allocation_qty),
        sizing_policy="Whole shares; min(stop risk, allocation cap). Gaps, slippage, fees and liquidity unverified.",
        event_risk="Unknown: earnings and catalysts are not provider-verified",
        execution_readiness="PLANNING_ONLY", alert_state="not_armed", filled=False,
        short_constraints="Borrow availability and short-sale constraints unverified" if direction == "BEAR" else None,
    )
    saved = store(
        repo.save_plan, user["id"], str(plan_id), payload.expected_revision, values,
        updated_at=datetime.now(timezone.utc).isoformat(),
        immutable_fields=("setup_id", "package_id", "setup_version", "source_snapshot_id", "symbol", "direction", "provider_asset_id"),
    )
    return {"success": True, "plan": saved}
