"""Customer-facing signal performance endpoints."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from kiteconnect import KiteConnect

from app.config import settings
from app.core.supabase_client import get_supabase_client
from app.dependencies import get_current_user, get_kite, get_supabase, require_premium
from app.services.signal_validator import (
    HORIZONS,
    check_outcomes_for_horizon,
    get_signal_stats,
)

logger = logging.getLogger("alpha_radar.routes.performance")

router = APIRouter(prefix="/api/performance", tags=["performance"])


def _is_local_request(request: Request) -> bool:
    host = request.headers.get("host", "")
    origin = request.headers.get("origin", "")
    return "localhost" in host or "127.0.0.1" in host or "localhost" in origin or "127.0.0.1" in origin


def _metadata(row: dict) -> dict:
    metadata = row.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _preferred_outcome(row: dict) -> dict | None:
    outcomes = row.get("signal_outcomes") or []
    if not isinstance(outcomes, list):
        return None

    by_horizon = {
        str(outcome.get("horizon")): outcome
        for outcome in outcomes
        if isinstance(outcome, dict)
    }
    return by_horizon.get("1h") or by_horizon.get("eod") or by_horizon.get("next_day_eod") or by_horizon.get("15m")


def _new_role_bucket() -> dict[str, int | float | None]:
    return {"fires": 0, "resolved": 0, "wins": 0, "losses": 0, "flats": 0, "win_rate": None}


def _build_signal_fire_summary(rows: list[dict]) -> dict:
    """Summarize discovery-vs-trade tracking from recent signal fire metadata."""
    by_role: dict[str, dict] = {}
    by_readiness: dict[str, int] = {}
    by_strategy: dict[str, int] = {}

    for row in rows:
        metadata = _metadata(row)
        role = str(metadata.get("tracking_role") or "TRADE_SIGNAL").upper()
        readiness = str(metadata.get("trade_readiness") or "TRADE_READY").upper()
        strategy = str(metadata.get("strategy") or row.get("signal_type") or "UNKNOWN").upper()

        bucket = by_role.setdefault(role, _new_role_bucket())
        bucket["fires"] += 1
        by_readiness[readiness] = by_readiness.get(readiness, 0) + 1
        by_strategy[strategy] = by_strategy.get(strategy, 0) + 1

        outcome = _preferred_outcome(row)
        status = str((outcome or {}).get("status") or "").upper()
        if status in {"WIN", "LOSS", "FLAT"}:
            bucket["resolved"] += 1
            if status == "WIN":
                bucket["wins"] += 1
            elif status == "LOSS":
                bucket["losses"] += 1
            else:
                bucket["flats"] += 1

    for bucket in by_role.values():
        resolved = int(bucket["resolved"])
        wins = int(bucket["wins"])
        bucket["win_rate"] = round(wins / resolved * 100, 1) if resolved else None

    return {
        "total": len(rows),
        "discovery": int(by_role.get("DISCOVERY", {}).get("fires", 0)),
        "trade_signals": int(by_role.get("TRADE_SIGNAL", {}).get("fires", 0)),
        "early_entry_zone": by_readiness.get("EARLY_ENTRY_ZONE", 0),
        "wait_for_pullback": by_readiness.get("WAIT_FOR_PULLBACK", 0),
        "by_role": by_role,
        "by_readiness": by_readiness,
        "by_strategy": by_strategy,
    }


async def require_performance_access(request: Request) -> dict:
    """
    Premium guard for product performance screens.

    This keeps localhost usable even when Supabase is not configured, while
    still blocking anonymous production traffic.
    """
    user = await get_current_user(request)
    if user.get("is_dev"):
        if _is_local_request(request):
            user["is_premium"] = True
            user["is_admin"] = True
            return user
        raise HTTPException(status_code=401, detail="Authentication required")

    try:
        sb = get_supabase_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return await require_premium(request, sb=sb)


@router.get("/signal-stats")
async def performance_signal_stats(
    days: int = Query(15, ge=1, le=90, description="Lookback window in days"),
    user: dict = Depends(require_performance_access),
) -> dict:
    """Per-signal-type and per-engine-family performance for product screens."""
    return {
        "success": True,
        "as_of": datetime.now(settings.TIMEZONE).isoformat(),
        **get_signal_stats(days=days),
    }


@router.get("/signal-fires")
async def performance_signal_fires(
    limit: int = Query(100, ge=1, le=1000),
    symbol: Optional[str] = Query(None),
    signal_type: Optional[str] = Query(None),
    days: int = Query(15, ge=1, le=90),
    user: dict = Depends(require_performance_access),
    sb=Depends(get_supabase),
) -> dict:
    """Recent signal fires and outcomes for the current performance dashboard."""
    cutoff = (
        datetime.now(settings.TIMEZONE) - timedelta(days=days)
    ).isoformat()

    try:
        query = (
            sb.table("signal_fires")
            .select("*, signal_outcomes(horizon, status, return_pct, mfe_pct, mae_pct)")
            .gte("fired_at", cutoff)
            .order("fired_at", desc=True)
            .limit(limit)
        )
        if symbol:
            query = query.eq("symbol", symbol.upper())
        if signal_type:
            query = query.eq("signal_type", signal_type.upper())
        result = query.execute()
    except Exception as exc:
        logger.exception("[performance] signal-fires query failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "success": True,
        "count": len(result.data or []),
        "fires": result.data or [],
        "summary": _build_signal_fire_summary(result.data or []),
    }


@router.post("/run-outcome-check")
async def performance_run_outcome_check(
    horizon: str = Query(..., description="15m | 1h | eod | next_day_eod"),
    user: dict = Depends(require_performance_access),
    kite: KiteConnect = Depends(get_kite),
) -> dict:
    """Manually resolve due outcomes from the Performance tab."""
    if horizon not in HORIZONS:
        raise HTTPException(
            status_code=400,
            detail=f"horizon must be one of {HORIZONS}",
        )
    summary = check_outcomes_for_horizon(horizon, kite)
    return {"success": True, "horizon": horizon, **summary}
