"""Arrow Trade adapter routes for benchmarking and migration."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from kiteconnect import KiteConnect
from pydantic import BaseModel

from app.dependencies import get_kite, require_admin_request
from app.services import arrow_market_data_service as arrow

router = APIRouter(prefix="/api/arrow", tags=["arrow"])


class ArrowTokenBody(BaseModel):
    request_token: str


class ArrowQuoteBody(BaseModel):
    symbols: list[str]
    exchange: str = "NSE"
    mode: str = "ohlcv"


@router.get("/login-url")
async def arrow_auth_url(request: Request) -> dict[str, Any]:
    """Return the Arrow login URL for the configured appID."""
    await require_admin_request(request)
    return {"success": True, "url": arrow.arrow_login_url()}


@router.get("/status")
async def arrow_status(request: Request) -> dict[str, Any]:
    """Return Arrow adapter configuration/token status without exposing secrets."""
    await require_admin_request(request)
    token, token_source = arrow.get_active_access_token()
    token_metadata = arrow.get_saved_access_token_metadata()
    auto_login = arrow.get_auto_login_status()
    token_fresh = token_metadata.get("fresh") if token_source == "saved" else None
    if not token:
        message = "Arrow token missing or expired. Re-login with Arrow."
    elif token_source == "saved" and token_fresh is False:
        message = "Saved Arrow token has expired. The next auto-login attempt will replace it."
    else:
        message = None
    return {
        "success": True,
        "configured": bool(arrow.settings.ARROW_APP_ID and arrow.settings.ARROW_APP_SECRET),
        "hasAccessToken": bool(token),
        "hasToken": bool(token),
        "tokenSource": token_source,
        "tokenFresh": token_fresh,
        "tokenSavedAt": token_metadata.get("savedAt") if token_source == "saved" else None,
        "tokenExpiresAt": token_metadata.get("expiresAt") if token_source == "saved" else None,
        "message": message,
        "autoLogin": auto_login,
    }


@router.post("/auto-login")
async def arrow_auto_login(request: Request) -> dict[str, Any]:
    """Run the configured Arrow automated login immediately for admin verification."""
    await require_admin_request(request)
    result = await arrow.auto_login(reason="admin")
    if not result.get("success"):
        status_code = 503 if result.get("missingSettings") else 502
        raise HTTPException(status_code=status_code, detail=result.get("error") or "Arrow auto-login failed")
    return result


@router.post("/exchange-token")
async def arrow_exchange_token(body: ArrowTokenBody, request: Request) -> dict[str, Any]:
    """Exchange the redirected Arrow request-token for an access token."""
    await require_admin_request(request)
    result = await arrow.exchange_request_token(body.request_token)
    return {"success": True, "provider": "arrow", "result": result}


@router.post("/quotes")
async def arrow_quotes(body: ArrowQuoteBody, request: Request) -> dict[str, Any]:
    """Fetch normalized Arrow quotes for quick adapter validation."""
    await require_admin_request(request)
    quotes = await arrow.fetch_quotes(body.symbols, exchange=body.exchange, mode=body.mode)  # type: ignore[arg-type]
    meta = quotes.pop("_meta", {})
    return {"success": True, "meta": meta, "data": quotes}


@router.get("/benchmark/quotes")
async def benchmark_quotes(
    request: Request,
    symbols: str = Query("RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK", description="Comma-separated symbols"),
    exchange: str = Query("NSE"),
    mode: str = Query("ohlcv"),
    kite: KiteConnect = Depends(get_kite),
) -> dict[str, Any]:
    """Compare quote latency between Kite and Arrow for the same symbol basket."""
    await require_admin_request(request)
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    kite_symbols = [f"{exchange.upper()}:{s}" for s in symbol_list]

    kite_started = time.perf_counter()
    kite_quotes = await _kite_quote(kite, kite_symbols)
    kite_ms = round((time.perf_counter() - kite_started) * 1000, 2)

    arrow_quotes = await arrow.fetch_quotes(symbol_list, exchange=exchange, mode=mode)  # type: ignore[arg-type]
    arrow_meta = arrow_quotes.pop("_meta", {})

    return {
        "success": True,
        "timestamp": datetime.utcnow().isoformat(),
        "symbols": symbol_list,
        "kite": {
            "elapsedMs": kite_ms,
            "requested": len(symbol_list),
            "returned": len(kite_quotes),
        },
        "arrow": arrow_meta,
        "sample": {
            "kite": next(iter(kite_quotes.values()), None),
            "arrow": next(iter(arrow_quotes.values()), None),
        },
    }


async def _kite_quote(kite: KiteConnect, instruments: list[str]) -> dict[str, Any]:
    import asyncio

    return await asyncio.to_thread(kite.quote, instruments)
