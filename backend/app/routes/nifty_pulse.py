"""NIFTY Pulse Index API."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from kiteconnect import KiteConnect

from app.config import settings
from app.dependencies import get_current_user, get_kite
from app.engines.nifty_pulse_index import calculate_nifty_pulse

logger = logging.getLogger("alpha_radar.routes.nifty_pulse")
router = APIRouter(prefix="/api", tags=["market"])

_CACHE_TTL_SECONDS = 15 * 60
_cache: dict | None = None
_cache_at = 0.0
_CACHE_FILE = settings.DATA_DIR / "nifty_pulse_index.json"

SYMBOLS = {
    "nifty": "NSE:NIFTY 50",
    "broad": "NSE:NIFTY 500",
    "vix": "NSE:INDIA VIX",
}


def _normalise_history(candles: list[dict], live_price: float, today: date) -> list[float]:
    closes = [float(bar["close"]) for bar in candles if float(bar.get("close") or 0) > 0]
    if not closes:
        return closes
    # Historical candles may or may not include today's partial candle.  Using
    # the current quote as the last observation makes the daily score useful
    # intraday without adding a duplicate data point.
    if live_price > 0:
        raw_date = candles[-1].get("date")
        candle_date = raw_date.date() if isinstance(raw_date, datetime) else raw_date
        if isinstance(candle_date, str):
            try:
                candle_date = datetime.fromisoformat(candle_date).date()
            except ValueError:
                candle_date = None
        if candle_date == today:
            closes[-1] = float(live_price)
        else:
            closes.append(float(live_price))
    return closes


async def _build_response(kite: KiteConnect) -> dict:
    quote_map = await asyncio.to_thread(kite.ltp, list(SYMBOLS.values()))
    now = datetime.now(settings.TIMEZONE)
    from_date = now - timedelta(days=240)

    async def load(symbol: str) -> list[float]:
        quote = quote_map.get(symbol) or {}
        token = quote.get("instrument_token")
        if not token:
            raise ValueError(f"Instrument unavailable: {symbol}")
        candles = await asyncio.to_thread(kite.historical_data, token, from_date, now, "day")
        return _normalise_history(candles or [], float(quote.get("last_price") or 0), now.date())

    nifty, broad, vix = await asyncio.gather(
        load(SYMBOLS["nifty"]),
        load(SYMBOLS["broad"]),
        load(SYMBOLS["vix"]),
    )
    if min(len(nifty), len(broad), len(vix)) < 90:
        raise ValueError("Insufficient index history returned by the market-data provider")

    return {
        "success": True,
        "name": "NIFTY Pulse Index",
        "scale": "0 = extreme greed, 100 = extreme fear",
        "methodologyVersion": "nifty-pulse-v1",
        "asOf": now.isoformat(),
        "timeframes": calculate_nifty_pulse(nifty, broad, vix),
    }


@router.get("/nifty-pulse-index")
async def nifty_pulse_index(
    kite: KiteConnect = Depends(get_kite),
    _user: dict = Depends(get_current_user),
) -> dict:
    """Return transparent daily, weekly and monthly fear-pressure scores."""
    global _cache, _cache_at
    if _cache and time.time() - _cache_at < _CACHE_TTL_SECONDS:
        return _cache

    try:
        response = await _build_response(kite)
        _cache = response
        _cache_at = time.time()
        try:
            settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
            _CACHE_FILE.write_text(json.dumps(response), encoding="utf-8")
        except Exception:
            logger.warning("Could not persist NIFTY Pulse cache", exc_info=True)
        return response
    except Exception as exc:
        logger.warning("NIFTY Pulse calculation failed: %s", exc)
        fallback = _cache
        if fallback is None and _CACHE_FILE.exists():
            try:
                fallback = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
            except Exception:
                fallback = None
        if fallback:
            return {**fallback, "cached": True, "warning": "Showing the latest saved pulse reading."}
        raise HTTPException(status_code=503, detail="NIFTY Pulse data is temporarily unavailable") from exc
