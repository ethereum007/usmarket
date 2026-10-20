"""
Read-only status for last-good market snapshots.

This route does not fetch live market data. It only inspects session cache files
so the frontend can explain whether it is showing live, previous-session, or
offline data without adding latency to trader pages.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from kiteconnect import KiteConnect
from pydantic import BaseModel, Field

from app.config import settings
from app.core.kite_client import kite_state
from app.core.session_cache import load_session
from app.core.supabase_client import get_supabase_client
from app.dependencies import get_current_user, get_optional_kite, require_premium

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])
logger = logging.getLogger("alpha_radar.snapshots")


SNAPSHOT_KEYS: tuple[tuple[str, str, str], ...] = (
    ("indices", "Indices", "Market"),
    ("quote_sectors", "Sector Quotes", "Market"),
    ("hot_cold_indices", "Hot/Cold Indices", "Market"),
    ("breadth", "Market Breadth", "Market"),
    ("top_movers", "Top Movers", "Market"),
    ("pulse", "Pulse", "Intraday"),
    ("intraday_radar", "Intraday Radar", "Intraday"),
    ("abnormal_live", "Abnormal Moves", "Surveillance"),
    ("live_signals", "Live Signals", "Signals"),
    ("orb_signals", "ORB Signals", "Signals"),
    ("52w_bounce", "52W Bounce", "Swing"),
    ("swing_spectrum", "Swing Spectrum", "Swing"),
    ("sector_momentum", "Sector Momentum", "Swing"),
)

SNAPSHOT_ALIASES: dict[str, tuple[str, ...]] = {
    "abnormal_live": ("abnormal_radar_live",),
}

SNAPSHOT_SOURCES: dict[str, dict[str, Any]] = {
    "indices": {
        "method": "GET",
        "endpoint": "/api/quotes/indices",
        "page": "/pulse",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Pulse or Markets after broker login to refresh index context.",
    },
    "quote_sectors": {
        "method": "GET",
        "endpoint": "/api/quotes/sectors",
        "page": "/pulse",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Pulse/sector heatmap to refresh sector quotes.",
    },
    "hot_cold_indices": {
        "method": "GET",
        "endpoint": "/api/hot-cold-indices",
        "page": "/pulse",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Pulse after broker login to refresh hot/cold sector indices.",
    },
    "breadth": {
        "method": "GET",
        "endpoint": "/api/breadth",
        "page": "/pulse",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Pulse to refresh market breadth.",
    },
    "top_movers": {
        "method": "GET",
        "endpoint": "/api/top-movers",
        "page": "/pulse",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Pulse to refresh gainers, losers, and active names.",
    },
    "pulse": {
        "method": "POST",
        "endpoint": "/api/pulse",
        "page": "/pulse",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Pulse with a loaded universe to refresh the main pulse snapshot.",
    },
    "intraday_radar": {
        "method": "POST",
        "endpoint": "/api/intraday/radar",
        "page": "/radar",
        "requiresPremium": False,
        "requiresBroker": True,
        "hint": "Open Radar and run N50/N100/N200/N500/SC250/Micro to seed intraday replay.",
    },
    "abnormal_live": {
        "method": "POST",
        "endpoint": "/api/abnormal/radar",
        "page": "/trade-ideas?tab=abnormal",
        "requiresPremium": True,
        "requiresBroker": True,
        "hint": "Open Abnormal Moves after broker login; live scans save only when scorable rows exist.",
    },
    "live_signals": {
        "method": "GET",
        "endpoint": "/api/signals/live-signals",
        "page": "/trade-ideas?tab=signals",
        "requiresPremium": False,
        "requiresBroker": False,
        "hint": "Open Live Signals after trackers have fired PDH/PDL events.",
    },
    "orb_signals": {
        "method": "GET",
        "endpoint": "/api/signals/orb-signals",
        "page": "/trade-ideas?tab=signals",
        "requiresPremium": True,
        "requiresBroker": False,
        "hint": "Open Live Signals after ORB ranges are loaded around 09:31/09:46.",
    },
    "52w_bounce": {
        "method": "GET",
        "endpoint": "/api/52w-bounce",
        "page": "/trade-ideas?tab=swing",
        "requiresPremium": True,
        "requiresBroker": True,
        "hint": "Open Swing/52W Bounce after broker login to seed bounce replay.",
    },
    "swing_spectrum": {
        "method": "POST",
        "endpoint": "/api/scanner/swing/warm",
        "page": "/trade-ideas?tab=swing",
        "requiresPremium": True,
        "requiresBroker": True,
        "hint": "Warm Swing Replay or run Swing Radar after broker login to seed the scan result.",
    },
    "sector_momentum": {
        "method": "GET",
        "endpoint": "/api/sector-momentum",
        "page": "/trade-ideas?tab=swing",
        "requiresPremium": True,
        "requiresBroker": True,
        "hint": "Open Swing/Sector Momentum after broker login to seed the sector snapshot.",
    },
}

SNAPSHOT_SEED_PRIORITY: dict[str, int] = {
    "indices": 10,
    "top_movers": 20,
    "breadth": 30,
    "intraday_radar": 40,
    "pulse": 50,
    "quote_sectors": 60,
    "hot_cold_indices": 70,
    "swing_spectrum": 80,
    "52w_bounce": 90,
    "sector_momentum": 100,
    "abnormal_live": 110,
    "live_signals": 120,
    "orb_signals": 130,
}

SNAPSHOT_STATUS_WEIGHT: dict[str, int] = {
    "missing": 0,
    "stale": 1,
    "unknown": 2,
    "last-session": 3,
    "fresh": 4,
}

_DEFAULT_FRESH_AFTER_SECONDS = 15 * 60
_FRESH_AFTER_SECONDS_BY_KEY = {
    # These server-warmed scans intentionally run twice per hour. Keep the UI
    # honest without labelling normal between-refresh data as previous-session.
    "abnormal_live": 45 * 60,
    "swing_spectrum": 45 * 60,
    "sector_momentum": 45 * 60,
}

_SERVER_WARMABLE_KEYS = {
    "indices",
    "quote_sectors",
    "hot_cold_indices",
    "breadth",
    "top_movers",
    "pulse",
    "intraday_radar",
    "abnormal_live",
    "live_signals",
    "orb_signals",
    "52w_bounce",
    "swing_spectrum",
    "sector_momentum",
}

_BROKER_WARMABLE_KEYS = {
    "indices",
    "quote_sectors",
    "hot_cold_indices",
    "breadth",
    "top_movers",
    "pulse",
    "intraday_radar",
    "abnormal_live",
    "52w_bounce",
    "swing_spectrum",
    "sector_momentum",
}

_DEFAULT_WARM_TIMEOUT_S = 25
_WARM_TIMEOUT_BY_KEY = {
    "pulse": 45,
    "intraday_radar": 45,
    "abnormal_live": 75,
    "52w_bounce": 75,
    "sector_momentum": 75,
    "swing_spectrum": 420,
}


class SnapshotWarmRequest(BaseModel):
    """Request body for a controlled server-side snapshot warm run."""

    keys: list[str] | None = None
    limit: int = Field(default=3, ge=1, le=8)
    universe: str = "nifty200"
    symbolLimit: int = Field(default=120, ge=20, le=500)


async def _require_snapshot_warm_user(request: Request) -> dict[str, Any]:
    user = await get_current_user(request)
    if user.get("is_dev"):
        return await require_premium(request, sb=None)  # type: ignore[arg-type]

    try:
        sb = get_supabase_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return await require_premium(request, sb=sb)


@router.get("/status")
async def snapshot_status() -> dict[str, Any]:
    """Return availability and age of persisted last-good market snapshots."""
    now = time.time()
    rows = [_snapshot_row(key, label, group, now) for key, label, group in SNAPSHOT_KEYS]
    available = [row for row in rows if row["available"]]
    freshest = min((row for row in available if row["ageSeconds"] is not None), key=lambda row: row["ageSeconds"], default=None)
    stalest = max((row for row in available if row["ageSeconds"] is not None), key=lambda row: row["ageSeconds"], default=None)
    seed_queue = _seed_queue(rows)
    readiness = _replay_readiness(rows, seed_queue)
    return {
        "success": True,
        "asOf": datetime.now(settings.TIMEZONE).isoformat(),
        "summary": {
            "tracked": len(rows),
            "available": len(available),
            "missing": len(rows) - len(available),
            "freshest": freshest,
            "stalest": stalest,
            "needsSeeding": bool(seed_queue),
            "nextSeed": seed_queue[0] if seed_queue else None,
            "replayReadiness": readiness,
        },
        "snapshots": rows,
        "seedQueue": seed_queue,
    }


@router.post("/warm")
async def warm_snapshots(
    body: SnapshotWarmRequest | None = None,
    kite: KiteConnect | None = Depends(get_optional_kite),
    user: dict = Depends(_require_snapshot_warm_user),
) -> dict[str, Any]:
    """
    Warm one or more persisted market snapshots through a bounded backend path.

    This is intentionally sequential to avoid burst-loading Kite/Arrow while a
    trader is trying to recover stale replay data.
    """
    return await warm_snapshot_targets(
        request=body or SnapshotWarmRequest(),
        kite=kite,
        user=user,
    )


async def warm_snapshot_targets(
    *,
    request: SnapshotWarmRequest | None = None,
    kite: KiteConnect | None = None,
    user: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Warm ranked replay targets for routes and scheduled background jobs."""
    request = request or SnapshotWarmRequest()
    active_user = user or _system_snapshot_user()
    rows = [_snapshot_row(key, label, group, time.time()) for key, label, group in SNAPSHOT_KEYS]
    seed_queue = _seed_queue(rows)
    target_keys = _warm_target_keys(request, seed_queue)

    results: list[dict[str, Any]] = []
    for key in target_keys:
        if _snapshot_meta(key) is None:
            results.append(_warm_result(key, "SKIPPED", "Unknown snapshot key."))
            continue
        if key not in _SERVER_WARMABLE_KEYS:
            results.append(_warm_result(key, "SKIPPED", "No server-side warmer is configured for this snapshot."))
            continue
        try:
            payload = await asyncio.wait_for(
                _warm_snapshot_key(
                    key,
                    kite=kite,
                    user=active_user,
                    universe=request.universe,
                    symbol_limit=request.symbolLimit,
                ),
                timeout=_warm_timeout_seconds(key),
            )
            results.append(_warm_result(key, "WARMED", _warm_payload_summary(payload)))
        except asyncio.TimeoutError:
            results.append(_warm_result(key, "FAILED", f"Warm request timed out after {_warm_timeout_seconds(key)}s.", 504))
        except HTTPException as exc:
            results.append(_warm_result(key, "FAILED", str(exc.detail), exc.status_code))
        except Exception as exc:
            results.append(_warm_result(key, "FAILED", str(exc), 500))

    refreshed = await snapshot_status()
    return {
        "success": True,
        "requested": len(target_keys),
        "warmed": len([row for row in results if row["status"] == "WARMED"]),
        "failed": len([row for row in results if row["status"] == "FAILED"]),
        "skipped": len([row for row in results if row["status"] == "SKIPPED"]),
        "results": results,
        "snapshotStatus": refreshed,
    }


async def warm_next_replay_snapshots(
    *,
    limit: int = 2,
    universe: str = "nifty200",
    symbol_limit: int = 120,
    keys: list[str] | None = None,
) -> dict[str, Any]:
    """Best-effort scheduled replay warmer using the active broker session."""
    request = SnapshotWarmRequest(keys=keys, limit=limit, universe=universe, symbolLimit=symbol_limit)
    kite = kite_state.kite if kite_state.is_connected else None
    response = await warm_snapshot_targets(
        request=request,
        kite=kite,
        user=_system_snapshot_user(),
    )
    if response.get("requested") or response.get("failed"):
        logger.info(
            "Snapshot replay warmer completed: requested=%s warmed=%s failed=%s skipped=%s",
            response.get("requested"),
            response.get("warmed"),
            response.get("failed"),
            response.get("skipped"),
        )
    return response


def _system_snapshot_user() -> dict[str, Any]:
    return {
        "id": "system:snapshot-warmer",
        "email": "system@alpha-radar.local",
        "is_dev": True,
        "is_premium": True,
    }


@router.get("/{key}")
async def snapshot_detail(key: str) -> dict[str, Any]:
    """Return one persisted snapshot payload for replay/debugging screens."""
    meta = _snapshot_meta(key)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"Unknown snapshot key: {key}")

    snapshot_key, label, group = meta
    cached, _actual_key = _load_snapshot_session(snapshot_key)
    row = _snapshot_row(snapshot_key, label, group, time.time())
    if not cached:
        raise HTTPException(status_code=404, detail=f"No saved snapshot is available for {snapshot_key}")

    return {
        "success": True,
        "asOf": datetime.now(settings.TIMEZONE).isoformat(),
        "snapshot": row,
        "data": cached.get("data"),
    }


def _snapshot_meta(key: str) -> tuple[str, str, str] | None:
    for snapshot_key, label, group in SNAPSHOT_KEYS:
        if snapshot_key == key:
            return snapshot_key, label, group
    return None


def _warm_target_keys(request: SnapshotWarmRequest, seed_queue: list[dict[str, Any]]) -> list[str]:
    if request.keys:
        seen: set[str] = set()
        keys: list[str] = []
        for key in request.keys:
            clean = str(key or "").strip()
            if clean and clean not in seen:
                keys.append(clean)
                seen.add(clean)
        return keys[: request.limit]
    return [row["key"] for row in seed_queue if row.get("canSeedNow")][: request.limit]


def _warm_timeout_seconds(key: str) -> int:
    return _WARM_TIMEOUT_BY_KEY.get(key, _DEFAULT_WARM_TIMEOUT_S)


async def _warm_snapshot_key(
    key: str,
    *,
    kite: KiteConnect | None,
    user: dict,
    universe: str,
    symbol_limit: int,
) -> dict[str, Any]:
    if key in _BROKER_WARMABLE_KEYS and kite is None:
        raise HTTPException(
            status_code=503,
            detail="Broker is not connected. Login with Kite or Arrow before warming this snapshot.",
        )
    if key == "indices":
        from app.routes.quotes import indices
        return await indices(kite=kite)
    if key == "quote_sectors":
        from app.routes.quotes import quote_sectors
        return await quote_sectors(kite=kite)
    if key == "hot_cold_indices":
        from app.routes.quotes import hot_cold_indices
        return await hot_cold_indices(kite=kite)
    if key == "breadth":
        from app.routes.market import breadth
        return await breadth(kite=kite, user=user)
    if key == "top_movers":
        from app.routes.market import top_movers
        return await top_movers(kite=kite, user=user)
    if key == "pulse":
        from app.routes.pulse import PulseBody, market_pulse
        return await market_pulse(
            body=PulseBody(symbols=_warm_symbols(universe, symbol_limit)),
            kite=kite,
        )
    if key == "intraday_radar":
        from app.routes.intraday import build_live_intraday_radar
        return await build_live_intraday_radar(
            {
                "symbols": _warm_symbols(universe, symbol_limit),
                "minTradedValueLakh": 0,
                "useCache": True,
                "quoteProvider": "arrow_first",
            },
            kite,
        )
    if key == "abnormal_live":
        from app.routes.abnormal import abnormal_radar
        return await abnormal_radar(
            body={"source": "live", "quoteProvider": "arrow_first", "useCache": True},
            user=user,
        )
    if key == "live_signals":
        from app.routes.signals import live_signals
        return await live_signals(user=user)
    if key == "orb_signals":
        from app.routes.signals import orb_signals
        return await orb_signals(user=user)
    if key == "52w_bounce":
        from app.routes.bounce import bounce_52w
        return await bounce_52w(kite=kite, user=user)
    if key == "swing_spectrum":
        from app.routes.scanner import SwingWarmRequest, warm_swing_snapshot
        return await warm_swing_snapshot(
            payload=SwingWarmRequest(universe=universe, limit=symbol_limit),
            kite=kite,
            user=user,
        )
    if key == "sector_momentum":
        from app.routes.market import sector_momentum
        return await sector_momentum(kite=kite, user=user)
    raise HTTPException(status_code=400, detail=f"No warmer is configured for {key}")


def _warm_symbols(universe: str, limit: int) -> list[str]:
    try:
        from app.caches import stock_universes
        symbols = stock_universes.resolve_universe(universe, limit=limit)
    except Exception:
        symbols = []

    if not symbols:
        raise HTTPException(status_code=503, detail="No stock universe is available for snapshot warming.")
    return symbols


def _warm_result(key: str, status: str, message: str, status_code: int | None = None) -> dict[str, Any]:
    row = {
        "key": key,
        "label": (_snapshot_meta(key) or (key, key, ""))[1],
        "status": status,
        "message": message,
    }
    if status_code is not None:
        row["statusCode"] = status_code
    return row


def _warm_payload_summary(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return "Warm request completed."
    for key in ("count", "total", "scannedSymbols"):
        value = payload.get(key)
        if isinstance(value, int):
            return f"Warm request completed with {value} rows."
    for key in ("candidates", "stocks", "sectors", "signals", "indices", "gainers"):
        value = payload.get(key)
        if isinstance(value, list):
            return f"Warm request completed with {len(value)} {key}."
    return "Warm request completed."


def _snapshot_row(key: str, label: str, group: str, now: float) -> dict[str, Any]:
    cached, actual_key = _load_snapshot_session(key)
    path = settings.DATA_DIR / f"session_{actual_key}.json"
    if not cached:
        return {
            "key": key,
            "label": label,
            "group": group,
            "available": False,
            "status": "missing",
            "timestamp": None,
            "savedAt": None,
            "ageSeconds": None,
            "ageLabel": "missing",
            "bytes": _file_size(settings.DATA_DIR / f"session_{key}.json"),
            "path": f"session_{key}.json",
            "source": _snapshot_source(key),
        }

    saved_at = _safe_float(cached.get("savedAt"))
    age_seconds = round(now - saved_at, 1) if saved_at else None
    return {
        "key": key,
        "label": label,
        "group": group,
        "available": True,
        "status": _status_for_age(age_seconds, key=key),
        "timestamp": cached.get("timestamp"),
        "savedAt": saved_at,
        "ageSeconds": age_seconds,
        "ageLabel": _age_label(age_seconds),
        "bytes": _file_size(path),
        "path": path.name,
        "source": _snapshot_source(key),
    }


def _load_snapshot_session(key: str) -> tuple[dict | None, str]:
    cached = load_session(key)
    if cached:
        return cached, key
    for alias in SNAPSHOT_ALIASES.get(key, ()):
        cached = load_session(alias)
        if cached:
            return cached, alias
    return None, key


def _snapshot_source(key: str) -> dict[str, Any]:
    return SNAPSHOT_SOURCES.get(
        key,
        {
            "method": None,
            "endpoint": None,
            "page": None,
            "requiresPremium": False,
            "requiresBroker": False,
            "hint": "No source metadata is configured for this snapshot.",
        },
    )


def _seed_queue(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates = [
        _seed_queue_item(row)
        for row in rows
        if row["status"] in {"missing", "stale", "unknown"}
    ]
    candidates.sort(key=lambda row: (row["sortKey"], -(row.get("ageSeconds") or 0)))
    return [
        {key: value for key, value in item.items() if key != "sortKey"}
        for item in candidates
    ]


def _seed_queue_item(row: dict[str, Any]) -> dict[str, Any]:
    source = row.get("source") or {}
    blockers = []
    if source.get("requiresBroker") and not kite_state.is_connected:
        blockers.append("broker_login")

    status = row["status"]
    if status == "missing":
        reason = "No replay snapshot exists yet."
    elif status == "stale":
        reason = f"Last replay is stale at {row.get('ageLabel') or 'unknown age'}."
    else:
        reason = "Snapshot exists but freshness could not be verified."

    return {
        "key": row["key"],
        "label": row["label"],
        "group": row["group"],
        "status": status,
        "ageSeconds": row.get("ageSeconds"),
        "ageLabel": row.get("ageLabel"),
        "priority": SNAPSHOT_SEED_PRIORITY.get(row["key"], 999),
        "reason": reason,
        "blockedBy": blockers,
        "canSeedNow": not blockers,
        "source": source,
        "sortKey": (
            SNAPSHOT_STATUS_WEIGHT.get(status, 9),
            SNAPSHOT_SEED_PRIORITY.get(row["key"], 999),
        ),
    }


def _replay_readiness(rows: list[dict[str, Any]], seed_queue: list[dict[str, Any]]) -> dict[str, Any]:
    tracked = len(rows)
    weights = {
        "fresh": 1.0,
        "last-session": 0.75,
        "stale": 0.25,
        "unknown": 0.0,
        "missing": 0.0,
    }
    score = _readiness_score(rows, weights)
    needs_attention = len([row for row in rows if row["status"] in {"missing", "stale", "unknown"}])
    blocked = len([row for row in seed_queue if row.get("blockedBy")])
    can_seed_now = len([row for row in seed_queue if row.get("canSeedNow")])
    if tracked == 0:
        label = "Not configured"
        mode = "unknown"
        action = "No replay feeds are configured."
    elif score >= 85 and needs_attention == 0:
        label = "Live ready"
        mode = "ready"
        action = "Replay coverage is healthy."
    elif score >= 65:
        label = "Usable"
        mode = "watch"
        action = _next_seed_action(seed_queue)
    elif score >= 35:
        label = "Degraded"
        mode = "degraded"
        action = _next_seed_action(seed_queue)
    else:
        label = "Needs seeding"
        mode = "blocked" if blocked else "offline"
        action = _next_seed_action(seed_queue)

    return {
        "score": score,
        "label": label,
        "mode": mode,
        "tracked": tracked,
        "ready": len([row for row in rows if row["status"] in {"fresh", "last-session"}]),
        "needsAttention": needs_attention,
        "blocked": blocked,
        "canSeedNow": can_seed_now,
        "action": action,
        "byGroup": _group_readiness(rows, weights),
    }


def _readiness_score(rows: list[dict[str, Any]], weights: dict[str, float]) -> int:
    if not rows:
        return 0
    weighted = sum(weights.get(row["status"], 0.0) for row in rows)
    return round(weighted / len(rows) * 100)


def _group_readiness(rows: list[dict[str, Any]], weights: dict[str, float]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(row["group"], []).append(row)
    return [
        {
            "group": group,
            "score": _readiness_score(group_rows, weights),
            "tracked": len(group_rows),
            "ready": len([row for row in group_rows if row["status"] in {"fresh", "last-session"}]),
            "needsAttention": len([row for row in group_rows if row["status"] in {"missing", "stale", "unknown"}]),
        }
        for group, group_rows in sorted(groups.items())
    ]


def _next_seed_action(seed_queue: list[dict[str, Any]]) -> str:
    if not seed_queue:
        return "Replay coverage is healthy."
    next_seed = seed_queue[0]
    blockers = next_seed.get("blockedBy") or []
    if "broker_login" in blockers:
        return f"Login to broker, then warm {next_seed['label']}."
    return f"Warm {next_seed['label']} from {next_seed.get('source', {}).get('page') or 'the source page'}."


def _safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.exists() else None
    except OSError:
        return None


def _status_for_age(age_seconds: float | None, key: str | None = None) -> str:
    if age_seconds is None:
        return "unknown"
    fresh_after = _FRESH_AFTER_SECONDS_BY_KEY.get(str(key or ""), _DEFAULT_FRESH_AFTER_SECONDS)
    if age_seconds <= fresh_after:
        return "fresh"
    if age_seconds <= 36 * 60 * 60:
        return "last-session"
    return "stale"


def _age_label(age_seconds: float | None) -> str:
    if age_seconds is None:
        return "unknown"
    if age_seconds < 60:
        return f"{int(age_seconds)}s"
    if age_seconds < 3600:
        return f"{int(age_seconds // 60)}m"
    if age_seconds < 86400:
        return f"{round(age_seconds / 3600, 1)}h"
    return f"{round(age_seconds / 86400, 1)}d"
