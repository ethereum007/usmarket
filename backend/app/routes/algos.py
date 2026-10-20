"""
Paper algo strategy registry and validation watch storage.

This route deliberately stops at paper tracking. It does not place broker orders
or expose live execution controls.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from threading import Lock
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Request
from pydantic import BaseModel, Field

from app.config import settings
from app.core.supabase_client import get_supabase_client
from app.dependencies import get_current_user, require_premium

logger = logging.getLogger("alpha_radar.routes.algos")

router = APIRouter(prefix="/api/algos", tags=["algos"])

ALGO_PAPER_WATCHES_FILE = settings.DATA_DIR / "algo_paper_watches.json"
MAX_PAPER_WATCHES_PER_USER = 250
_algo_lock = Lock()


class PaperWatchBody(BaseModel):
    id: Optional[str] = None
    strategyId: str = Field(..., min_length=1, max_length=64)
    strategyName: str = Field(..., min_length=1, max_length=96)
    side: Literal["BUY", "SELL"]
    quantity: int = Field(..., gt=0)
    entry: float = Field(..., gt=0)
    stop: float = Field(..., ge=0)
    target: float = Field(..., gt=0)
    exposure: float = Field(..., ge=0)
    maxLoss: float = Field(..., ge=0)
    riskReward: float = Field(..., ge=0)
    source: str = Field("algo-lab", min_length=1, max_length=64)
    payload: Optional[dict[str, Any]] = None


class PaperWatchOutcomeBody(BaseModel):
    outcome: Literal["WIN", "LOSS", "SKIP"]
    exit: Optional[float] = Field(None, ge=0)
    realizedR: Optional[float] = None
    note: Optional[str] = Field(None, max_length=280)


STRATEGY_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "orb-vwap",
        "name": "Opening Range + VWAP",
        "family": "Intraday",
        "timeframe": "9:15-10:45 IST",
        "mode": "paper",
        "readiness": "Ready for paper",
        "universe": "Nifty 50, Nifty 100, high-liquidity F&O stocks",
        "edge": "First clean expansion after the opening range with VWAP acceptance.",
        "promotionCriteria": {
            "minPaperFires": 75,
            "minWinRatePct": 52,
            "minAvgR": 0.25,
            "maxSampleDrawdownR": 6,
        },
        "riskGuards": ["No market orders", "Max 2 trades per symbol", "Auto-flat before close"],
    },
    {
        "id": "pdh-cpr",
        "name": "PDH/PDL + CPR Drive",
        "family": "Intraday",
        "timeframe": "9:30-14:30 IST",
        "mode": "paper",
        "readiness": "Ready for paper",
        "universe": "Index leaders and liquid cash names",
        "edge": "Directional continuation when prior-day levels and CPR regime agree.",
        "promotionCriteria": {
            "minPaperFires": 75,
            "minWinRatePct": 53,
            "minAvgR": 0.3,
            "maxSampleDrawdownR": 6,
        },
        "riskGuards": ["Retest entry preferred", "Skip range-bound index", "Stop must be level-based"],
    },
    {
        "id": "oi-shift",
        "name": "OI Shift Directional",
        "family": "Options",
        "timeframe": "9:45-15:00 IST",
        "mode": "paper",
        "readiness": "Needs live depth",
        "universe": "NIFTY, BANKNIFTY, FINNIFTY",
        "edge": "Directional bias when OI change, PCR slope, spot, and max-pain drift align.",
        "promotionCriteria": {
            "minPaperFires": 100,
            "minWinRatePct": 55,
            "minAvgR": 0.35,
            "maxSampleDrawdownR": 5,
        },
        "riskGuards": ["Index only", "No naked selling", "Manual order preview required"],
    },
    {
        "id": "vp-reclaim",
        "name": "Volume Profile Reclaim",
        "family": "Intraday",
        "timeframe": "10:00-14:45 IST",
        "mode": "paper",
        "readiness": "Ready for paper",
        "universe": "Liquid cash and F&O names",
        "edge": "Trade from value-area acceptance instead of chasing extended candles.",
        "promotionCriteria": {
            "minPaperFires": 75,
            "minWinRatePct": 52,
            "minAvgR": 0.25,
            "maxSampleDrawdownR": 6,
        },
        "riskGuards": ["Wait for close above level", "First reclaim only", "Spread cap required"],
    },
    {
        "id": "abnormal-swing",
        "name": "Abnormal Momentum Swing",
        "family": "Swing",
        "timeframe": "1-10 sessions",
        "mode": "paper",
        "readiness": "Research mode",
        "universe": "Liquid NSE/BSE small, mid, and large caps",
        "edge": "Unusual price-volume-delivery behavior filtered for liquidity and surveillance risk.",
        "promotionCriteria": {
            "minPaperFires": 100,
            "minWinRatePct": 50,
            "minAvgR": 0.45,
            "maxSampleDrawdownR": 8,
        },
        "riskGuards": ["No circuit stacks", "No ASM/GSM/trade-to-trade", "Gap-risk sizing haircut"],
    },
    {
        "id": "sector-basket",
        "name": "Sector Rotation Basket",
        "family": "Basket",
        "timeframe": "2-20 sessions",
        "mode": "paper",
        "readiness": "Research mode",
        "universe": "Sector leaders and liquid ETFs where available",
        "edge": "Buy strength when sector breadth, RRG rotation, and leader momentum agree.",
        "promotionCriteria": {
            "minPaperFires": 50,
            "minWinRatePct": 50,
            "minAvgR": 0.35,
            "maxSampleDrawdownR": 6,
        },
        "riskGuards": ["Equal-risk basket", "Cap single-sector exposure", "Weekly rebalance only"],
    },
]


def _now_iso() -> str:
    return datetime.now(settings.TIMEZONE).isoformat()


def _is_local_request(request: Request) -> bool:
    host = request.headers.get("host", "")
    origin = request.headers.get("origin", "")
    return "localhost" in host or "127.0.0.1" in host or "localhost" in origin or "127.0.0.1" in origin


def _user_key(user: dict[str, Any]) -> str:
    return str(user.get("id") or user.get("email") or "anonymous")


def _strategy_ids() -> set[str]:
    return {str(strategy["id"]) for strategy in STRATEGY_REGISTRY}


def _strategy_by_id(strategy_id: str) -> dict[str, Any] | None:
    return next((strategy for strategy in STRATEGY_REGISTRY if strategy["id"] == strategy_id), None)


async def require_algo_access(request: Request) -> dict[str, Any]:
    """
    Premium guard for algo research screens.

    Localhost remains usable for development. Production guest access is blocked
    because paper watches are user-specific and eventually feed broker previews.
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


def _empty_store() -> dict[str, list[dict[str, Any]]]:
    return {"paperWatches": []}


def _load_store() -> dict[str, list[dict[str, Any]]]:
    if not ALGO_PAPER_WATCHES_FILE.exists():
        return _empty_store()
    try:
        data = json.loads(ALGO_PAPER_WATCHES_FILE.read_text(encoding="utf-8"))
        watches = data.get("paperWatches")
        if isinstance(watches, list):
            return {"paperWatches": [item for item in watches if isinstance(item, dict)]}
    except Exception:
        logger.exception("Failed to load algo paper watches")
    return _empty_store()


def _save_store(data: dict[str, list[dict[str, Any]]]) -> None:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = ALGO_PAPER_WATCHES_FILE.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp_path.replace(ALGO_PAPER_WATCHES_FILE)


def _visible_watches(data: dict[str, list[dict[str, Any]]], user: dict[str, Any]) -> list[dict[str, Any]]:
    owner = _user_key(user)
    return [
        watch
        for watch in data.get("paperWatches", [])
        if watch.get("userId") == owner
    ]


def _paper_watch_id(user: dict[str, Any], strategy_id: str) -> str:
    raw = f"paper:{_user_key(user)}:{strategy_id}:{int(time.time() * 1000)}"
    return "".join(ch if ch.isalnum() or ch in {":", "-", "_"} else "-" for ch in raw)


def _store_summary(watches: list[dict[str, Any]]) -> dict[str, Any]:
    strategy_counts: dict[str, int] = {}
    total_risk = 0.0
    total_exposure = 0.0
    for watch in watches:
        strategy_id = str(watch.get("strategyId") or "unknown")
        strategy_counts[strategy_id] = strategy_counts.get(strategy_id, 0) + 1
        total_risk += float(watch.get("maxLoss") or 0)
        total_exposure += float(watch.get("exposure") or 0)
    return {
        "total": len(watches),
        "byStrategy": strategy_counts,
        "totalMaxLoss": round(total_risk, 2),
        "totalExposure": round(total_exposure, 2),
    }


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _compute_realized_r(watch: dict[str, Any], exit_price: float) -> float:
    entry = _to_float(watch.get("entry"))
    stop = _to_float(watch.get("stop"))
    side = str(watch.get("side") or "BUY").upper()
    risk = abs(entry - stop)
    if entry <= 0 or risk <= 0:
        raise HTTPException(status_code=400, detail="Cannot compute R: watch has invalid entry/stop")
    if side == "SELL":
        return round((entry - exit_price) / risk, 3)
    return round((exit_price - entry) / risk, 3)


def _max_drawdown_r(closed_watches: list[dict[str, Any]]) -> float:
    peak = 0.0
    equity = 0.0
    max_drawdown = 0.0
    ordered = sorted(closed_watches, key=lambda item: item.get("closedAt") or item.get("updatedAt") or "")
    for watch in ordered:
        equity += _to_float(watch.get("realizedR"))
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
    return round(max_drawdown, 3)


def _strategy_performance(strategy: dict[str, Any], watches: list[dict[str, Any]]) -> dict[str, Any]:
    strategy_id = str(strategy["id"])
    strategy_watches = [watch for watch in watches if watch.get("strategyId") == strategy_id]
    closed = [
        watch
        for watch in strategy_watches
        if watch.get("status") in {"CLOSED", "SKIPPED"} and watch.get("outcome")
    ]
    resolved = [watch for watch in closed if watch.get("outcome") != "SKIP"]
    wins = len([watch for watch in resolved if _to_float(watch.get("realizedR")) > 0])
    losses = len([watch for watch in resolved if _to_float(watch.get("realizedR")) <= 0])
    total_r = round(sum(_to_float(watch.get("realizedR")) for watch in resolved), 3)
    avg_r = round(total_r / len(resolved), 3) if resolved else 0.0
    win_rate = round((wins / len(resolved)) * 100, 1) if resolved else 0.0
    max_drawdown = _max_drawdown_r(resolved)
    criteria = strategy.get("promotionCriteria") or {}
    promotion_checks = {
        "paperFires": len(resolved) >= int(criteria.get("minPaperFires") or 0),
        "winRate": win_rate >= float(criteria.get("minWinRatePct") or 0),
        "avgR": avg_r >= float(criteria.get("minAvgR") or 0),
        "drawdown": max_drawdown <= float(criteria.get("maxSampleDrawdownR") or 0),
    }
    return {
        "strategyId": strategy_id,
        "strategyName": strategy["name"],
        "paperWatches": len(strategy_watches),
        "resolved": len(resolved),
        "skipped": len([watch for watch in closed if watch.get("outcome") == "SKIP"]),
        "wins": wins,
        "losses": losses,
        "winRatePct": win_rate,
        "avgR": avg_r,
        "totalR": total_r,
        "maxDrawdownR": max_drawdown,
        "promotionChecks": promotion_checks,
        "promotionReady": all(promotion_checks.values()) if promotion_checks else False,
        "promotionCriteria": criteria,
    }


@router.get("/strategies")
async def list_algo_strategies(user: dict = Depends(require_algo_access)) -> dict:
    """Return the paper strategy registry used by Algo Lab."""
    return {
        "success": True,
        "count": len(STRATEGY_REGISTRY),
        "strategies": STRATEGY_REGISTRY,
    }


@router.get("/paper-watches")
async def list_paper_watches(user: dict = Depends(require_algo_access)) -> dict:
    """Return paper watches for the current trader."""
    with _algo_lock:
        watches = _visible_watches(_load_store(), user)
    watches.sort(key=lambda item: item.get("updatedAt") or item.get("createdAt") or "", reverse=True)
    return {
        "success": True,
        "count": len(watches),
        "summary": _store_summary(watches),
        "paperWatches": watches,
    }


@router.post("/paper-watches")
async def create_paper_watch(body: PaperWatchBody, user: dict = Depends(require_algo_access)) -> dict:
    """Persist one paper algo watch for validation. No broker order is created."""
    strategy_id = body.strategyId.strip()
    if strategy_id not in _strategy_ids():
        raise HTTPException(status_code=400, detail=f"Unknown strategyId: {strategy_id}")
    if body.maxLoss <= 0:
        raise HTTPException(status_code=400, detail="maxLoss must be positive")
    if body.riskReward < 1:
        raise HTTPException(status_code=400, detail="riskReward must be at least 1.0 for paper tracking")

    now = _now_iso()
    incoming = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    incoming.update(
        {
            "id": body.id or _paper_watch_id(user, strategy_id),
            "strategyId": strategy_id,
            "strategyName": body.strategyName.strip(),
            "side": body.side.upper(),
            "status": "WATCHING",
            "userId": _user_key(user),
            "userEmail": user.get("email"),
            "createdAt": now,
            "updatedAt": now,
            "executionAllowed": False,
            "brokerOrderCreated": False,
        }
    )

    with _algo_lock:
        data = _load_store()
        watches = data.get("paperWatches", [])
        user_watch_count = len([watch for watch in watches if watch.get("userId") == incoming["userId"]])
        if user_watch_count >= MAX_PAPER_WATCHES_PER_USER:
            raise HTTPException(status_code=429, detail="Paper watch limit reached")
        watches.append(incoming)
        data["paperWatches"] = watches
        _save_store(data)
        visible = _visible_watches(data, user)

    return {
        "success": True,
        "paperWatch": incoming,
        "count": len(visible),
        "summary": _store_summary(visible),
    }


@router.post("/paper-watches/{watch_id}/outcome")
async def record_paper_watch_outcome(
    body: PaperWatchOutcomeBody,
    watch_id: str = PathParam(..., min_length=1, max_length=220),
    user: dict = Depends(require_algo_access),
) -> dict:
    """Close or skip one paper watch and store realized R for promotion checks."""
    owner = _user_key(user)
    now = _now_iso()
    with _algo_lock:
        data = _load_store()
        watches = data.get("paperWatches", [])
        index = next(
            (idx for idx, watch in enumerate(watches) if watch.get("id") == watch_id and watch.get("userId") == owner),
            None,
        )
        if index is None:
            raise HTTPException(status_code=404, detail="Paper watch not found")

        watch = dict(watches[index])
        if body.outcome == "SKIP":
            realized_r = 0.0
            exit_price = body.exit
            status = "SKIPPED"
        else:
            if body.realizedR is None and body.exit is None:
                raise HTTPException(status_code=400, detail="exit or realizedR is required for WIN/LOSS")
            exit_price = body.exit
            realized_r = round(float(body.realizedR), 3) if body.realizedR is not None else _compute_realized_r(watch, float(exit_price))
            if body.outcome == "WIN" and realized_r <= 0:
                raise HTTPException(status_code=400, detail="WIN outcome must have positive realizedR")
            if body.outcome == "LOSS" and realized_r >= 0:
                raise HTTPException(status_code=400, detail="LOSS outcome must have negative realizedR")
            status = "CLOSED"

        watch.update(
            {
                "status": status,
                "outcome": body.outcome,
                "exit": exit_price,
                "realizedR": realized_r,
                "outcomeNote": (body.note or "").strip(),
                "closedAt": now,
                "updatedAt": now,
                "executionAllowed": False,
                "brokerOrderCreated": False,
            }
        )
        watches[index] = watch
        data["paperWatches"] = watches
        _save_store(data)
        visible = _visible_watches(data, user)

    strategy_meta = _strategy_by_id(str(watch.get("strategyId"))) or {
        "id": str(watch.get("strategyId") or "unknown"),
        "name": str(watch.get("strategyName") or "Unknown Strategy"),
        "promotionCriteria": {},
    }
    return {
        "success": True,
        "paperWatch": watch,
        "summary": _store_summary(visible),
        "performance": _strategy_performance(strategy_meta, visible),
    }


@router.get("/performance")
async def algo_performance(user: dict = Depends(require_algo_access)) -> dict:
    """Aggregate paper-watch outcomes by algo strategy."""
    with _algo_lock:
        watches = _visible_watches(_load_store(), user)
    strategies = [_strategy_performance(strategy, watches) for strategy in STRATEGY_REGISTRY]
    resolved = sum(item["resolved"] for item in strategies)
    wins = sum(item["wins"] for item in strategies)
    total_r = round(sum(item["totalR"] for item in strategies), 3)
    return {
        "success": True,
        "asOf": _now_iso(),
        "summary": {
            "paperWatches": len(watches),
            "resolved": resolved,
            "winRatePct": round((wins / resolved) * 100, 1) if resolved else 0.0,
            "totalR": total_r,
            "promotionReady": len([item for item in strategies if item["promotionReady"]]),
        },
        "strategies": strategies,
    }


@router.delete("/paper-watches/{watch_id}")
async def delete_paper_watch(
    watch_id: str = PathParam(..., min_length=1, max_length=220),
    user: dict = Depends(require_algo_access),
) -> dict:
    """Delete one paper watch owned by the current trader."""
    owner = _user_key(user)
    with _algo_lock:
        data = _load_store()
        watches = data.get("paperWatches", [])
        match = next((watch for watch in watches if watch.get("id") == watch_id), None)
        if not match or match.get("userId") != owner:
            raise HTTPException(status_code=404, detail="Paper watch not found")
        data["paperWatches"] = [watch for watch in watches if watch.get("id") != watch_id]
        _save_store(data)
        visible = _visible_watches(data, user)

    return {
        "success": True,
        "deleted": watch_id,
        "count": len(visible),
        "summary": _store_summary(visible),
    }
