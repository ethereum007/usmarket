"""
Squeeze detection route -- monitors OI compression near ATM for explosive moves.

Ported from tradingdesk/apps/gateway/src/routes/squeeze.routes.ts
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Path
from kiteconnect import KiteConnect

from app.dependencies import get_kite
from app.engines import SqueezeMonitor
from app.routes.options import (
    INDEX_CONFIG,
    get_options_chain,
    get_stale_options_chain_response,
)

logger = logging.getLogger("alpha_radar.routes.squeeze")

router = APIRouter(prefix="/api", tags=["squeeze"])

# ── Per-index squeeze monitors ───────────────────────────────────────────────
_monitor = SqueezeMonitor()


def _analytics_for_monitor(analytics: dict) -> dict:
    return {
        "total_call_oi": analytics.get("totalCallOI", 0),
        "total_put_oi": analytics.get("totalPutOI", 0),
        "pcr": analytics.get("pcr", 0),
    }


def _serialize_alert(alert) -> dict:
    return {
        "type": alert.type,
        "severity": alert.severity,
        "direction": alert.direction,
        "message": alert.message,
        "value": alert.value,
        "threshold": alert.threshold,
    }


def _serialize_snapshot(snapshot) -> dict:
    return {
        "time": snapshot.time,
        "timeStr": snapshot.time_str,
        "spot": snapshot.spot,
        "totalCallOI": snapshot.total_call_oi,
        "totalPutOI": snapshot.total_put_oi,
        "pcr": snapshot.pcr,
        "range": snapshot.range,
    }


# ── GET /api/squeeze/{index} ─────────────────────────────────────────────────
@router.get("/squeeze/{index}")
async def squeeze_status(
    index: str = Path(..., description="Index key: nifty, banknifty, etc."),
    kite: KiteConnect = Depends(get_kite),
) -> dict:
    """Return squeeze status with alerts, score, phase, and OI snapshots."""
    key = index.lower()
    if key not in INDEX_CONFIG:
        raise HTTPException(
            status_code=400,
            detail={"error": "Unknown index", "available": list(INDEX_CONFIG.keys())},
        )

    try:
        feed_warning = None
        try:
            chain_data = get_options_chain(kite, key)
        except Exception as chain_exc:
            fallback = get_stale_options_chain_response(
                key,
                f"options_{key}",
                "Squeeze monitor is using the latest available options chain while live feed recovers.",
            )
            if not fallback:
                raise chain_exc
            logger.warning("[squeeze] Using cached options chain for %s: %s", key, chain_exc)
            chain_data = fallback
            feed_warning = fallback.get("warning")

        cfg = INDEX_CONFIG[key]
        now = int(time.time() * 1000)

        _monitor.take_snapshot(
            key,
            chain_data["spot"],
            chain_data["chain"],
            _analytics_for_monitor(chain_data["analytics"]),
            cfg["strikeStep"],
        )
        squeeze_result = _monitor.get_squeeze_status(key)
        snapshots = _monitor.get_snapshots(key, 20)

        return {
            "success": True,
            "index": key,
            "name": cfg["name"],
            "spot": chain_data["spot"],
            "alerts": [_serialize_alert(a) for a in squeeze_result.alerts],
            "squeezeScore": squeeze_result.squeeze_score,
            "squeezePhase": squeeze_result.squeeze_phase,
            "rangeCompression": squeeze_result.range_compression,
            "oiBuildupRatio": squeeze_result.oi_buildup_ratio,
            "pcrTrend": squeeze_result.pcr_trend,
            "netOIDirection": squeeze_result.net_oi_direction,
            "snapshotCount": _monitor.snapshot_count.get(key, len(snapshots)),
            "snapshots": [_serialize_snapshot(s) for s in snapshots],
            "timestamp": now,
            "cached": bool(chain_data.get("cached")),
            "stale": bool(chain_data.get("stale")),
            "warning": feed_warning,
        }

    except Exception as exc:
        logger.exception("[squeeze] Error for %s", key)
        raise HTTPException(status_code=500, detail=str(exc))
