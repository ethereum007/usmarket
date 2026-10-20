"""Protected diagnostics and baseline administration for Runner PR1-PR3."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.caches.stock_universes import resolve_universe
from app.config import settings
from app.dependencies import require_admin_request
from app.engines.runner.baselines import baseline_repository, minute_of_session
from app.engines.runner.ranking import RankingThresholds, build_runner_rankings
from app.engines.runner.shortlist import build_participation_shortlist
from app.services.runner_service import runner_service

router = APIRouter(prefix="/api/runner", tags=["runner"])


class BaselineRebuildBody(BaseModel):
    symbol: str | None = None
    universe: str | None = None
    limit: int | None = Field(default=None, ge=1, le=750)


@router.get("/status")
async def runner_status(
    _admin: Annotated[dict, Depends(require_admin_request)],
) -> dict[str, Any]:
    return runner_service.status()


@router.get("/latest")
async def runner_latest_features(
    _admin: Annotated[dict, Depends(require_admin_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    sort_by: Annotated[
        Literal[
            "rvol_tod_20d",
            "rvol_tod_60d",
            "rvol_5m",
            "volume_acceleration",
            "ret_5m",
            "range_tod_ratio",
            "freshness_seconds",
        ],
        Query(alias="sort"),
    ] = "rvol_tod_20d",
) -> dict[str, Any]:
    """Return a bounded admin view of current in-memory feature snapshots.

    This intentionally does not expose the historical feature store. It exists for
    live operational inspection and keeps missing values at the end of the result.
    """

    features = list(runner_service.latest_features.values())
    features.sort(
        key=lambda feature: (
            getattr(feature, sort_by) is not None,
            getattr(feature, sort_by) if getattr(feature, sort_by) is not None else 0,
        ),
        reverse=True,
    )
    selected = features[:limit]
    return {
        "timestamp": datetime.now(settings.TIMEZONE).isoformat(),
        "featureVersion": settings.RUNNER_FEATURE_VERSION,
        "sort": sort_by,
        "total": len(features),
        "returned": len(selected),
        "features": [feature.model_dump(mode="json") for feature in selected],
    }


@router.get("/shortlist")
async def runner_participation_shortlist(
    _admin: Annotated[dict, Depends(require_admin_request)],
    universe: Annotated[
        Literal["nifty100", "nifty500", "smallcap", "broad"], Query()
    ] = "broad",
    limit: Annotated[int, Query(ge=1, le=5)] = 5,
) -> dict[str, Any]:
    """Return the small volume-first research queue; never an entry signal."""

    members = set(resolve_universe(universe))
    available = [
        feature
        for symbol, feature in runner_service.latest_features.items()
        if symbol in members
    ]
    shortlist = build_participation_shortlist(
        available,
        limit=min(limit, settings.RUNNER_SHORTLIST_LIMIT),
        min_rvol_tod=settings.RUNNER_SHORTLIST_MIN_RVOL_TOD,
        min_rvol_5m=settings.RUNNER_SHORTLIST_MIN_RVOL_5M,
        min_acceleration=settings.RUNNER_SHORTLIST_MIN_ACCELERATION,
        min_turnover_crore=settings.RUNNER_SHORTLIST_MIN_TURNOVER_CRORE,
    )
    return {
        "timestamp": datetime.now(settings.TIMEZONE).isoformat(),
        "universe": universe,
        "universeSize": len(members),
        "featuresAvailable": len(available),
        "status": "PARTICIPATION_FOUND" if shortlist else "NO_PARTICIPATION",
        "count": len(shortlist),
        "candidates": shortlist,
        "thresholds": {
            "rvolTod20d": settings.RUNNER_SHORTLIST_MIN_RVOL_TOD,
            "rvol5m": settings.RUNNER_SHORTLIST_MIN_RVOL_5M,
            "acceleration": settings.RUNNER_SHORTLIST_MIN_ACCELERATION,
            "turnoverCrore": settings.RUNNER_SHORTLIST_MIN_TURNOVER_CRORE,
        },
        "entryReady": False,
    }


@router.get("/rankings")
async def runner_rankings(
    _admin: Annotated[dict, Depends(require_admin_request)],
    universe: Annotated[
        Literal["nifty100", "nifty500", "smallcap", "broad"], Query()
    ] = "broad",
    limit: Annotated[int, Query(ge=1, le=25)] = 10,
) -> dict[str, Any]:
    """Return the versioned PR4 research ranking; never an entry instruction."""

    members = set(resolve_universe(universe))
    available = [
        feature
        for symbol, feature in runner_service.latest_features.items()
        if symbol in members
    ]
    thresholds = RankingThresholds(
        unusual_score=settings.RUNNER_SCORE_UNUSUAL_MIN,
        candidate_score=settings.RUNNER_SCORE_CANDIDATE_MIN,
        high_quality_score=settings.RUNNER_SCORE_HIGH_QUALITY_MIN,
        candidate_percentile=settings.RUNNER_SCORE_CANDIDATE_PERCENTILE,
        high_quality_percentile=settings.RUNNER_SCORE_HIGH_QUALITY_PERCENTILE,
        min_turnover_crore=settings.RUNNER_SHORTLIST_MIN_TURNOVER_CRORE,
    )
    all_rankings = build_runner_rankings(
        available,
        limit=max(1, len(available)),
        score_version=settings.RUNNER_SCORE_VERSION,
        thresholds=thresholds,
    )
    rankings = all_rankings[: min(limit, settings.RUNNER_RANKING_LIMIT)]
    high_quality = [row for row in all_rankings if row["tier"] == "HIGH_QUALITY"]
    candidates = [
        row
        for row in all_rankings
        if row["tier"] in {"HIGH_QUALITY", "RUNNER_CANDIDATE"}
    ]
    return {
        "timestamp": datetime.now(settings.TIMEZONE).isoformat(),
        "universe": universe,
        "universeSize": len(members),
        "featuresAvailable": len(available),
        "eligible": len(all_rankings),
        "scoreVersion": settings.RUNNER_SCORE_VERSION,
        "status": "CANDIDATES_FOUND" if candidates else "NO_HIGH_QUALITY_CANDIDATE",
        "candidateCount": len(candidates),
        "highQualityCount": len(high_quality),
        "rankings": rankings,
        "entryReady": False,
        "notice": "Research ranking only. Setup, extension and risk gates are not implemented.",
    }


@router.get("/features/{symbol}")
async def runner_features(
    symbol: str, _admin: Annotated[dict, Depends(require_admin_request)]
) -> dict[str, Any]:
    feature = runner_service.latest_features.get(symbol.upper())
    if feature is None:
        raise HTTPException(
            status_code=404, detail="No Runner feature snapshot for symbol"
        )
    return feature.model_dump(mode="json")


@router.get("/baseline/{symbol}")
async def runner_baseline(
    symbol: str,
    _admin: Annotated[dict, Depends(require_admin_request)],
    minute: Annotated[int | None, Query(ge=0, le=374)] = None,
) -> dict[str, Any]:
    normalized_symbol = symbol.upper()
    current_minute = minute_of_session(datetime.now(settings.TIMEZONE))
    target_minute = minute if minute is not None else min(374, max(0, current_minute))
    stored = await runner_service.store.get_baseline_diagnostics(
        normalized_symbol, target_minute
    )
    source = "DATABASE"
    if stored is None:
        source = "MEMORY_FALLBACK"
        stats = [
            stat
            for stat in baseline_repository.for_symbol(normalized_symbol)
            if stat.minute_of_session == target_minute
        ]
    else:
        stats = stored
    return {
        "symbol": normalized_symbol,
        "minuteOfSession": target_minute,
        "baselineVersion": settings.RUNNER_BASELINE_VERSION,
        "source": source,
        "count": len(stats),
        "baselines": [
            stat.model_dump(mode="json")
            for stat in sorted(
                stats,
                key=lambda s: (s.lookback_sessions, s.minute_of_session, s.metric),
            )
        ],
    }


@router.post("/baselines/rebuild", status_code=202)
async def rebuild_runner_baselines(
    body: BaselineRebuildBody, _admin: Annotated[dict, Depends(require_admin_request)]
) -> dict[str, Any]:
    if not runner_service.enabled:
        raise HTTPException(status_code=409, detail="Runner Engine is disabled")
    if runner_service.baseline_service is None:
        raise HTTPException(
            status_code=503, detail="Runner market-data provider is unavailable"
        )
    symbols = (
        [body.symbol.upper()]
        if body.symbol
        else resolve_universe(body.universe or runner_service.universe_name, body.limit)
    )
    result = runner_service.launch_baseline_rebuild(symbols)
    return {
        **result,
        "universe": body.universe or runner_service.universe_name,
    }


@router.post("/context/rebuild", status_code=202)
async def rebuild_runner_context(
    body: BaselineRebuildBody, _admin: Annotated[dict, Depends(require_admin_request)]
) -> dict[str, Any]:
    """Refresh leakage-safe daily ATR and prior-session high context."""
    if not runner_service.enabled:
        raise HTTPException(status_code=409, detail="Runner Engine is disabled")
    if runner_service.daily_context_service is None:
        raise HTTPException(
            status_code=503, detail="Runner market-data provider is unavailable"
        )
    symbols = (
        [body.symbol.upper()]
        if body.symbol
        else resolve_universe(body.universe or runner_service.universe_name, body.limit)
    )
    result = runner_service.launch_daily_context_warm(symbols)
    return {**result, "universe": body.universe or runner_service.universe_name}
