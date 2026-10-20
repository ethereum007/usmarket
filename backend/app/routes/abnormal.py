"""Abnormal momentum surveillance routes."""

from __future__ import annotations

from copy import deepcopy
import time
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, File, UploadFile

from app.core.kite_client import kite_state
from app.core.session_cache import load_session, save_session
from app.dependencies import require_premium
from app.engines.abnormal_momentum import SAMPLE_ROWS, apply_filters, parse_csv_rows, score_rows
from app.services.abnormal_radar_service import build_live_abnormal_radar

router = APIRouter(prefix="/api/abnormal", tags=["abnormal-momentum"])
LIVE_SESSION_KEY = "abnormal_live"
LEGACY_LIVE_SESSION_KEY = "abnormal_radar_live"


def _serialize(result) -> dict[str, Any]:
    data = asdict(result)
    data["score_breakdown"] = asdict(result.score_breakdown)
    return data


def _cached_live_response(reason: str) -> dict[str, Any] | None:
    cached = load_session(LIVE_SESSION_KEY) or load_session(LEGACY_LIVE_SESSION_KEY)
    if not cached:
        return None
    response = deepcopy(cached.get("data") or {})
    if not response:
        return None
    response["cached"] = True
    response["cachedAt"] = cached.get("timestamp")
    response["source"] = "live-cache"
    response["meta"] = {
        **response.get("meta", {}),
        "warning": f"{reason} Showing the last successful Abnormal Moves scan.",
        "cache": {
            **(response.get("meta", {}).get("cache") or {}),
            "sessionFallback": True,
        },
    }
    return response


def _live_unavailable_response(reason: str) -> dict[str, Any]:
    return {
        "success": True,
        "source": "live",
        "count": 0,
        "totalScored": 0,
        "results": [],
        "summary": {"cleanMomentum": 0, "watchCarefully": 0, "avoid": 0, "avgScore": 0},
        "meta": {
            "elapsedMs": 0,
            "disclaimer": "Screening and risk tool only. Not investment advice and not a manipulation detector.",
            "warning": f"{reason} No cached Abnormal Moves scan is available yet.",
        },
    }


def _log_abnormal_signal_fires(results: list[Any]) -> dict[str, int]:
    """Feed qualified Abnormal Moves ideas into the shadow performance tracker."""
    summary = {"eligible": 0, "logged": 0}
    if not results:
        return summary

    try:
        from app.services.signal_validator import compute_market_context, log_signal_fire
    except Exception:
        return summary

    context = {**compute_market_context(), "scanner": "abnormal_moves"}
    for item in results:
        if not _is_trackable_abnormal_result(item):
            continue

        change_pct = _num(_field(item, "change_pct")) or 0
        direction = "BULLISH" if change_pct >= 0 else "BEARISH"
        trigger_price = _num(_field(item, "last_price"))
        symbol = str(_field(item, "symbol") or "").upper()
        if not symbol or not trigger_price:
            continue

        summary["eligible"] += 1
        risk_flag = str(_field(item, "risk_flag") or "Watch Carefully")
        side = "BULL" if direction == "BULLISH" else "BEAR"
        signal_type = f"ABNORMAL_{_slug(risk_flag)}_{side}"
        alpha_score = _num(_field(item, "alpha_score")) or 0

        try:
            fire_id = log_signal_fire(
                symbol=symbol,
                signal_type=signal_type,
                trigger_price=trigger_price,
                strength=alpha_score * 10,
                direction=direction,
                confidence="STRONG" if alpha_score >= 7.5 else "MODERATE",
                category="stock",
                metadata={
                    "alpha_score": alpha_score,
                    "risk_flag": risk_flag,
                    "breakout_status": _field(item, "breakout_status"),
                    "volume_vs_avg": _num(_field(item, "volume_vs_avg")),
                    "change_pct": change_pct,
                    "delivery_pct": _num(_field(item, "delivery_pct")),
                    "liquidity_score": _num(_field(item, "liquidity_score")),
                    "turnover_lakh": _num(_field(item, "turnover_lakh")),
                    "market_cap_bucket": _field(item, "market_cap_bucket"),
                    "sector": _field(item, "sector"),
                    "invalidation_level": _num(_field(item, "invalidation_level")),
                    "tags": _field(item, "tags") or [],
                    "reasons": (_field(item, "reasons") or [])[:5],
                },
                context=context,
            )
            if fire_id:
                summary["logged"] += 1
        except Exception:
            pass

    return summary


def _is_trackable_abnormal_result(item: Any) -> bool:
    risk_flag = str(_field(item, "risk_flag") or "")
    if risk_flag.startswith("Avoid") or risk_flag in {"Circuit Risk", "Liquidity Trap", "News-Only Move"}:
        return False
    alpha_score = _num(_field(item, "alpha_score")) or 0
    volume_vs_avg = _num(_field(item, "volume_vs_avg")) or 0
    change_pct = abs(_num(_field(item, "change_pct")) or 0)
    liquidity_score = _num(_field(item, "liquidity_score")) or 0
    turnover_lakh = _num(_field(item, "turnover_lakh")) or 0
    return alpha_score >= 6.5 and volume_vs_avg >= 2 and change_pct >= 3 and liquidity_score >= 5 and turnover_lakh >= 300


def _field(item: Any, name: str) -> Any:
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def _num(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _slug(value: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in value.upper()).strip("_")


@router.post("/radar")
async def abnormal_radar(
    body: dict[str, Any],
    user: dict = Depends(require_premium),
) -> dict:
    """Rank abnormal price-volume-delivery moves from supplied rows or sample data."""
    rows = body.get("rows") or body.get("dailyRows")
    filters = body.get("filters") or {}
    source = str(body.get("source") or "live").lower()

    if not rows and source != "sample" and kite_state.is_connected:
        try:
            live_response = await build_live_abnormal_radar(
                kite_state.kite,
                symbols=body.get("symbols"),
                filters=filters,
                quote_provider=str(body.get("quoteProvider") or "arrow_first"),
                use_cache=bool(body.get("useCache", True)),
            )
            if live_response.get("totalScored", 0) > 0:
                if not live_response.get("cached"):
                    live_response.setdefault("meta", {})["validation"] = _log_abnormal_signal_fires(live_response.get("results") or [])
                save_session(LIVE_SESSION_KEY, live_response)
                return live_response
            fallback = _cached_live_response("Live broker quotes returned no scorable rows.")
            return fallback or live_response
        except Exception:
            fallback = _cached_live_response("Live broker quote fetch failed.")
            return fallback or _live_unavailable_response("Live broker quote fetch failed.")

    if not rows and source != "sample":
        fallback = _cached_live_response("Live broker session is not connected.")
        return fallback or _live_unavailable_response("Live broker session is not connected.")

    rows = rows or SAMPLE_ROWS
    started = time.perf_counter()
    scored = score_rows(rows)
    filtered = apply_filters(scored, filters)
    validation = _log_abnormal_signal_fires(filtered) if rows is not SAMPLE_ROWS else {"eligible": 0, "logged": 0}
    return {
        "success": True,
        "source": "sample" if rows is SAMPLE_ROWS else "payload",
        "count": len(filtered),
        "totalScored": len(scored),
        "results": [_serialize(item) for item in filtered],
        "summary": {
            "cleanMomentum": sum(1 for item in filtered if item.risk_flag == "Clean Momentum"),
            "watchCarefully": sum(1 for item in filtered if item.risk_flag == "Watch Carefully"),
            "avoid": sum(1 for item in filtered if item.risk_flag.startswith("Avoid")),
            "avgScore": round(sum(item.alpha_score for item in filtered) / len(filtered), 2) if filtered else 0,
        },
        "meta": {
            "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            "disclaimer": "Screening and risk tool only. Not investment advice and not a manipulation detector.",
            "warning": None if rows is not SAMPLE_ROWS else "Live broker session is not connected; showing sample abnormal-momentum data.",
            "validation": validation,
        },
    }


@router.post("/upload")
async def abnormal_upload(
    file: UploadFile = File(...),
    user: dict = Depends(require_premium),
) -> dict:
    """Parse a CSV upload into the normalized row format used by /api/abnormal/radar."""
    content = (await file.read()).decode("utf-8-sig")
    rows = parse_csv_rows(content)
    scored = score_rows(rows)
    return {
        "success": True,
        "filename": file.filename,
        "rows": rows,
        "preview": [_serialize(item) for item in scored[:10]],
        "count": len(rows),
    }
