"""
RRG admin endpoints.

The actual data reads happen client-side from Supabase (the frontend uses
the anon key + RLS policies on rrg_snapshots / alerts). The backend only
needs to expose:

  POST /api/rrg/recompute   admin trigger for a manual EOD rerun
  GET  /api/rrg/status      last run summary + Supabase row counts
  GET  /api/rrg/instruments helper to debug Kite index naming mismatches
  GET  /api/rrg/latest      public chart tails
  GET  /api/rrg/dates       public replay dates
  GET  /api/rrg/alerts      public quadrant crossings
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query

from app.config import settings
from app.core.kite_client import kite_state
from app.core.supabase_client import get_supabase_client
from app.services import rrg_service

logger = logging.getLogger("alpha_radar.routes.rrg")
router = APIRouter(prefix="/api/rrg", tags=["rrg"])


# Cached so the GET /status endpoint can report what the last run looked like
# without going back to Supabase. Reset on backend restart — that's fine, the
# next scheduled run repopulates it.
_last_run_summary: Optional[dict] = None


def _require_admin(x_admin_secret: Optional[str]) -> None:
    if not settings.ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="Admin secret not configured")
    if x_admin_secret != settings.ADMIN_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.post("/recompute")
async def recompute(
    lookback_days: int = Query(400, ge=30, le=2000),
    x_admin_secret: Optional[str] = Header(default=None),
) -> dict:
    """Manually trigger an EOD recompute. Useful for backfills or hotfixes."""
    _require_admin(x_admin_secret)

    global _last_run_summary
    loop = asyncio.get_running_loop()
    _last_run_summary = await loop.run_in_executor(
        None, rrg_service.run_eod, lookback_days
    )
    return _last_run_summary


@router.get("/status")
def status() -> dict:
    """Health summary — row counts + last-run info. Public read."""
    sb = get_supabase_client()
    counts = {}
    for table in ("prices", "rrg_snapshots", "alerts"):
        try:
            res = sb.table(table).select("*", count="exact").limit(0).execute()
            counts[table] = res.count
        except Exception as exc:
            counts[table] = f"error: {exc}"
    return {
        "kite_connected": kite_state.is_connected,
        "row_counts": counts,
        "last_run": _last_run_summary,
    }


@router.get("/instruments")
def instruments(
    contains: Optional[str] = Query(None, description="Filter by substring (case-insensitive)"),
    x_admin_secret: Optional[str] = Header(default=None),
) -> dict:
    """Dump NSE indices Kite knows about. Use when a symbol fails to resolve."""
    _require_admin(x_admin_secret)
    if not kite_state.is_connected:
        raise HTTPException(status_code=503, detail="Kite not connected")

    df = rrg_service._index_table(kite_state.kite)
    if contains:
        needle = contains.upper()
        df = df[df["tradingsymbol_upper"].str.contains(needle, na=False)]
    df = df.sort_values("tradingsymbol_upper")
    return {
        "total": len(df),
        "instruments": [
            {
                "tradingsymbol": row["tradingsymbol"],
                "instrument_token": int(row["instrument_token"]),
            }
            for _, row in df.iterrows()
        ],
    }


# Public read of the latest snapshot for whichever benchmark/timeframe.
# Frontend can hit either this OR query Supabase directly via the anon key.
@router.get("/latest")
def latest(
    benchmark: str = Query("NIFTY 50"),
    timeframe: str = Query("daily", pattern="^(daily|weekly)$"),
    tail: int = Query(5, ge=1, le=30),
    as_of: Optional[str] = Query(None, description="Replay date in YYYY-MM-DD format"),
) -> dict:
    sb = get_supabase_client()

    if as_of:
        try:
            resolved_as_of = datetime.fromisoformat(as_of).date().isoformat()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid as_of date") from exc
    else:
        latest_q = (
            sb.table("rrg_snapshots")
            .select("as_of_date")
            .eq("benchmark", benchmark)
            .eq("timeframe", timeframe)
            .order("as_of_date", desc=True)
            .limit(1)
            .execute()
        )
        if not latest_q.data:
            return {
                "benchmark": benchmark,
                "timeframe": timeframe,
                "as_of": None,
                "asOf": None,
                "tails": {},
            }
        resolved_as_of = latest_q.data[0]["as_of_date"]

    # Generous horizon for non-trading days
    horizon = (tail * 10) if timeframe == "weekly" else (tail * 3 + 14)
    since = (
        datetime.fromisoformat(resolved_as_of) - timedelta(days=horizon)
    ).date().isoformat()

    rows_q = (
        sb.table("rrg_snapshots")
        .select("*")
        .eq("benchmark", benchmark)
        .eq("timeframe", timeframe)
        .gte("as_of_date", since)
        .lte("as_of_date", resolved_as_of)
        .order("as_of_date", desc=False)
        .execute()
    )
    rows = rows_q.data or []
    by_symbol: dict[str, list[dict]] = {}
    for r in rows:
        by_symbol.setdefault(r["symbol"], []).append(r)
    tails = {s: lst[-tail:] for s, lst in by_symbol.items()}
    return {
        "benchmark": benchmark,
        "timeframe": timeframe,
        "as_of": resolved_as_of,
        "asOf": resolved_as_of,
        "tails": tails,
    }


@router.get("/dates")
def dates(
    benchmark: str = Query("NIFTY 50"),
    timeframe: str = Query("daily", pattern="^(daily|weekly)$"),
) -> dict:
    """Replay dates for a benchmark/timeframe. Public read."""
    sb = get_supabase_client()
    probe = next((sym for sym in rrg_service.SECTORS if sym != benchmark), None)
    query = (
        sb.table("rrg_snapshots")
        .select("as_of_date")
        .eq("benchmark", benchmark)
        .eq("timeframe", timeframe)
        .order("as_of_date", desc=False)
    )
    if probe:
        query = query.eq("symbol", probe)

    rows = query.execute().data or []
    seen = set()
    out = []
    for row in rows:
        value = row["as_of_date"]
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return {"benchmark": benchmark, "timeframe": timeframe, "dates": out}


@router.get("/alerts")
def alerts(
    benchmark: str = Query("NIFTY 50"),
    timeframe: str = Query("daily", pattern="^(daily|weekly)$"),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    """Recent quadrant-crossing alerts for a benchmark/timeframe. Public read."""
    sb = get_supabase_client()
    rows = (
        sb.table("alerts")
        .select("*")
        .eq("benchmark", benchmark)
        .eq("timeframe", timeframe)
        .order("as_of_date", desc=True)
        .order("symbol", desc=False)
        .limit(limit)
        .execute()
        .data
        or []
    )
    return {"benchmark": benchmark, "timeframe": timeframe, "alerts": rows}
