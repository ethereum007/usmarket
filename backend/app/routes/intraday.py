"""
Intraday Radar routes.
"""

from __future__ import annotations

import logging
import re
import time
import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from kiteconnect import KiteConnect
from pydantic import BaseModel, Field

from app.core.session_cache import is_market_hours, load_session, save_session
from app.dependencies import get_optional_kite, require_premium
from app.services import arrow_market_data_service as arrow
from app.services.intraday_breakout_service import intraday_breakout_service
from app.services.intraday_radar_service import build_intraday_radar

logger = logging.getLogger("alpha_radar.routes.intraday")

router = APIRouter(prefix="/api/intraday", tags=["intraday"])
_RADAR_BUILD_TIMEOUT_S = 20


class IntradayRadarRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list, max_length=500)
    minTradedValueLakh: float = Field(default=0, ge=0)
    useCache: bool = True
    quoteProvider: str = Field(default="arrow_first", pattern="^(arrow_first|arrow|kite)$")


def _exception_detail(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return str(exc.detail)
    return str(exc)


def _cached_intraday_response(reason: str, symbols: list[str] | None = None) -> dict | None:
    cached = load_session("intraday_radar")
    if not cached:
        return None
    resp = cached.get("data") or {}
    if not resp:
        return None
    resp = dict(resp)
    if symbols:
        resp = _filter_cached_intraday_response(resp, symbols)
    resp["cached"] = True
    resp["cachedAt"] = cached.get("timestamp")
    resp["warning"] = reason
    resp["provider"] = {
        **(resp.get("provider") or {}),
        "fallback": True,
        "fallbackReason": reason,
    }
    return resp


def _filter_cached_intraday_response(resp: dict[str, Any], symbols: list[str]) -> dict[str, Any]:
    allowed = {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
    if not allowed:
        return resp

    filtered = dict(resp)
    candidates = _filter_candidate_list(resp.get("candidates"), allowed)
    actionable = _filter_candidate_list(resp.get("actionable"), allowed)
    watchlist = _filter_candidate_list(resp.get("watchlist"), allowed)

    filtered["candidates"] = candidates
    filtered["actionable"] = actionable
    filtered["watchlist"] = watchlist
    filtered["summary"] = _candidate_summary(candidates, actionable)
    filtered["sectors"] = _sector_summary(candidates)
    filtered["dataQuality"] = _data_quality_summary(candidates, resp.get("dataQuality") or {})
    filtered["filters"] = {
        **(resp.get("filters") or {}),
        "inputSymbols": len(allowed),
        "returnedCandidates": len(candidates),
    }
    return filtered


def _filter_candidate_list(value: Any, allowed: set[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict) and str(item.get("symbol") or "").upper() in allowed]


def _candidate_summary(candidates: list[dict[str, Any]], actionable: list[dict[str, Any]]) -> dict[str, Any]:
    scores = [_to_float(item.get("score")) for item in candidates]
    scores = [score for score in scores if score is not None]
    return {
        "total": len(candidates),
        "long": sum(1 for item in candidates if item.get("bias") == "LONG"),
        "short": sum(1 for item in candidates if item.get("bias") == "SHORT"),
        "neutral": sum(1 for item in candidates if item.get("bias") == "NEUTRAL"),
        "actionable": len(actionable),
        "avgScore": round(sum(scores) / len(scores), 1) if scores else 0,
    }


def _sector_summary(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in candidates:
        grouped.setdefault(str(item.get("sector") or "Unknown"), []).append(item)

    sectors: list[dict[str, Any]] = []
    for name, items in grouped.items():
        long = sum(1 for item in items if item.get("bias") == "LONG")
        short = sum(1 for item in items if item.get("bias") == "SHORT")
        neutral = sum(1 for item in items if item.get("bias") == "NEUTRAL")
        scores = [_to_float(item.get("score")) or 0 for item in items]
        changes = [_to_float(item.get("changePct")) or 0 for item in items]
        high_rvol = sum(1 for item in items if (_to_float(item.get("volRatio")) or 0) >= 1.5)
        avg_score = round(sum(scores) / len(scores), 1) if scores else 0
        avg_change = round(sum(changes) / len(changes), 2) if changes else 0
        bias = "LONG" if long > short else "SHORT" if short > long else "NEUTRAL"
        sectors.append(
            {
                "name": name,
                "count": len(items),
                "bias": bias,
                "long": long,
                "short": short,
                "neutral": neutral,
                "avgChangePct": avg_change,
                "avgScore": avg_score,
                "highRvol": high_rvol,
                "leadershipScore": round(avg_score + high_rvol * 3 + abs(avg_change), 1),
                "topStocks": [
                    {
                        "symbol": item.get("symbol"),
                        "bias": item.get("bias"),
                        "score": item.get("score"),
                        "changePct": item.get("changePct"),
                    }
                    for item in sorted(
                        items,
                        key=lambda row: (_to_float(row.get("score")) or 0, abs(_to_float(row.get("changePct")) or 0)),
                        reverse=True,
                    )[:4]
                ],
            }
        )
    return sorted(sectors, key=lambda item: item["leadershipScore"], reverse=True)[:12]


def _data_quality_summary(candidates: list[dict[str, Any]], current: dict[str, Any]) -> dict[str, Any]:
    statuses = [
        str((item.get("freshness") or {}).get("status") or "unknown")
        for item in candidates
        if isinstance(item.get("freshness") or {}, dict)
    ]
    return {
        "fresh": statuses.count("fresh"),
        "stale": statuses.count("stale"),
        "unknown": statuses.count("unknown") + max(0, len(candidates) - len(statuses)),
        "missingStats": current.get("missingStats", 0),
    }


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


async def build_live_intraday_radar(
    body_data: dict[str, Any],
    kite: KiteConnect | None,
) -> dict:
    """Build one broker-backed radar snapshot for the shared refresh worker."""
    body = IntradayRadarRequest.model_validate(body_data)
    if not body.symbols:
        raise HTTPException(status_code=400, detail="symbols array required")

    try:
        quote_map: dict[str, Any] | None = None
        provider_meta: dict[str, Any] = {
            "provider": "kite",
            "requested": len(body.symbols),
            "returned": 0,
            "fallback": False,
        }

        if body.quoteProvider in {"arrow_first", "arrow"}:
            try:
                arrow_quotes = await arrow.fetch_quotes(body.symbols, exchange="NSE", mode="ohlcv")
                arrow_meta = arrow_quotes.pop("_meta", {})
                arrow_returned = len(arrow_quotes)
                min_usable = max(1, int(len(body.symbols) * 0.25))
                if arrow_returned >= min_usable or body.quoteProvider == "arrow":
                    quote_map = arrow_quotes
                    provider_meta = {
                        "provider": "arrow",
                        "requested": len(body.symbols),
                        "returned": arrow_returned,
                        "elapsedMs": arrow_meta.get("elapsedMs"),
                        "mode": arrow_meta.get("mode", "ohlcv"),
                        "partial": bool(arrow_meta.get("partial")),
                        "missing": max(0, len(body.symbols) - arrow_returned),
                        "errors": arrow_meta.get("errors", []),
                        "fallback": False,
                    }
                else:
                    provider_meta = {
                        "provider": "kite",
                        "requested": len(body.symbols),
                        "returned": arrow_returned,
                        "fallback": True,
                        "fallbackReason": f"Arrow returned {arrow_returned}/{len(body.symbols)} quotes",
                    }
            except Exception as arrow_exc:
                if body.quoteProvider == "arrow":
                    raise
                logger.warning("[intraday-radar] Arrow quote fetch failed; falling back to Kite: %s", arrow_exc)
                provider_meta = {
                    "provider": "kite",
                    "requested": len(body.symbols),
                    "returned": 0,
                    "fallback": True,
                    "fallbackReason": _exception_detail(arrow_exc)[:180],
                }

        if not kite and quote_map is None:
            cached = _cached_intraday_response(
                "Kite is not connected. Showing the last successful Intraday Radar scan.",
                body.symbols,
            )
            if cached:
                return cached
            return {
                "success": True,
                "marketRegime": {"label": "Offline", "bias": "NEUTRAL", "confidence": 0},
                "summary": {"total": 0, "long": 0, "short": 0, "neutral": 0, "actionable": 0},
                "sectors": [],
                "candidates": [],
                "actionable": [],
                "watchlist": [],
                "timestamp": int(time.time() * 1000),
                "statsCached": 0,
                "dataQuality": {"fresh": 0, "stale": 0, "missingStats": len(body.symbols)},
                "cached": False,
                "warning": "Kite is not connected and no saved Intraday Radar scan is available.",
                "provider": provider_meta,
                "filters": {
                    "minTradedValueLakh": body.minTradedValueLakh,
                    "inputSymbols": len(body.symbols),
                    "returnedCandidates": 0,
                },
            }

        response = await asyncio.wait_for(
            asyncio.to_thread(
                build_intraday_radar,
                kite,
                body.symbols,
                min_traded_value_lakh=body.minTradedValueLakh,
                use_cache=body.useCache,
                quote_map=quote_map,
                provider_meta=provider_meta,
            ),
            timeout=_RADAR_BUILD_TIMEOUT_S,
        )
        if response.get("candidates"):
            save_session("intraday_radar", response)
        elif not is_market_hours():
            cached = _cached_intraday_response(
                "Live Intraday Radar returned no candidates outside market hours. Showing the last successful scan.",
                body.symbols,
            )
            if cached:
                return cached
        return response
    except Exception as exc:
        logger.exception("[intraday-radar] Error")
        if not is_market_hours():
            cached = _cached_intraday_response(
                "Live Intraday Radar failed. Showing the last successful scan.",
                body.symbols,
            )
            if cached:
                return cached
        raise HTTPException(status_code=500, detail=str(exc))


def _pending_intraday_response(body: IntradayRadarRequest, *, refresh_queued: bool) -> dict[str, Any]:
    """Return an honest non-error payload while the shared worker warms data."""
    now = int(time.time() * 1000)
    return {
        "success": True,
        "marketRegime": {"label": "Warming", "bias": "NEUTRAL", "confidence": 0, "notes": ["Shared market snapshot is warming."]},
        "summary": {"total": 0, "long": 0, "short": 0, "neutral": 0, "actionable": 0, "avgScore": 0},
        "sectors": [],
        "candidates": [],
        "actionable": [],
        "watchlist": [],
        "timestamp": now,
        "cached": True,
        "generatedAt": None,
        "nextRefreshAt": None,
        "freshness": {"status": "pending", "ageSeconds": None, "source": "shared_snapshot"},
        "isStale": True,
        "refreshQueued": refresh_queued,
        "warning": "Live market data is warming. The view will update automatically without sending another broker request from your browser.",
        "provider": {"provider": "shared_snapshot", "fallback": True},
        "filters": {
            "minTradedValueLakh": body.minTradedValueLakh,
            "inputSymbols": len(body.symbols),
            "returnedCandidates": 0,
        },
        "dataQuality": {"fresh": 0, "stale": 0, "unknown": 0, "missingStats": len(body.symbols)},
    }


def _decorate_session_fallback(response: dict[str, Any], *, refresh_queued: bool) -> dict[str, Any]:
    data = dict(response)
    generated_at = data.get("cachedAt")
    data.update({
        "cached": True,
        "generatedAt": generated_at,
        "nextRefreshAt": None,
        "freshness": {"status": "stale", "ageSeconds": None, "source": "disk_session"},
        "isStale": True,
        "refreshQueued": refresh_queued,
    })
    return data


@router.post("/radar")
async def intraday_radar(
    body: IntradayRadarRequest,
    kite: KiteConnect | None = Depends(get_optional_kite),
) -> dict:
    """Serve a shared radar snapshot; browser traffic never calls a broker inline."""
    from app.services.market_snapshot_service import market_snapshot_service

    del kite  # The single worker owns broker access for this customer endpoint.
    body_data = body.model_dump()
    cached = await market_snapshot_service.read_intraday(body_data)
    if cached is not None:
        return cached

    # A paid heartbeat starts the 30/60 second scheduler. On a cold start, a
    # request only queues a single deduplicated job and receives a last-good
    # session result (or a warming response) immediately.
    active = await market_snapshot_service.has_paid_activity()
    queued = await market_snapshot_service.queue_intraday(body_data) if active else False
    fallback = _cached_intraday_response(
        "Live market snapshot is warming. Showing the last successful Intraday Radar scan.",
        body.symbols,
    )
    if fallback:
        return _decorate_session_fallback(fallback, refresh_queued=queued)
    return _pending_intraday_response(body, refresh_queued=queued)


@router.get("/status")
async def intraday_status() -> dict:
    """Lightweight status for the intraday subsystem."""
    from app.services.market_snapshot_service import market_snapshot_service

    return {
        "success": True,
        "marketOpen": is_market_hours(),
        "timestamp": int(time.time() * 1000),
        "sharedSnapshots": await market_snapshot_service.status(),
    }


@router.get("/breakouts")
async def intraday_breakouts(
    _premium_user: dict[str, Any] = Depends(require_premium),
) -> dict[str, Any]:
    """Return today's premium 5m/15m retracement and PDH breakout tags."""
    return await intraday_breakout_service.snapshot(refresh_if_stale=True)


@router.get("/breakouts/{symbol}")
async def intraday_breakout_chart(
    symbol: str,
    timeframe: int = 5,
    _premium_user: dict[str, Any] = Depends(require_premium),
) -> dict[str, Any]:
    """Return today's focused candle chart for one premium breakout symbol."""
    clean_symbol = symbol.strip().upper()
    if not re.fullmatch(r"[A-Z0-9&.-]{1,32}", clean_symbol):
        raise HTTPException(status_code=400, detail="Invalid symbol")
    if timeframe not in {5, 15}:
        raise HTTPException(status_code=422, detail="Timeframe must be 5 or 15")
    return await intraday_breakout_service.chart(clean_symbol, timeframe)
