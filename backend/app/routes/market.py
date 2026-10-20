"""
Market data routes -- status, breadth, FII/DII, delivery, symbols, sector momentum, top movers.

Ported from Alpha-Radar-backend/server.js
"""

from __future__ import annotations

import json
import logging
import time
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from kiteconnect import KiteConnect
from supabase import Client

from app.config import settings
from app.caches.sector_map import SECTOR_MAP, get_sector
from app.core.session_cache import save_session, load_session, is_market_hours
from app.dependencies import get_current_user, get_kite, get_optional_kite, get_supabase, require_premium

logger = logging.getLogger("alpha_radar.routes.market")

router = APIRouter(prefix="/api", tags=["market"])

def _get_sector(symbol: str) -> str:
    return get_sector(symbol)


def _get_nifty500() -> list[str]:
    try:
        from app.caches import stock_universes
        return stock_universes.NIFTY500_STOCKS
    except ImportError:
        return list(SECTOR_MAP.keys())


def _get_fno_stocks() -> list[str]:
    try:
        from app.caches import stock_universes
        return stock_universes.FNO_STOCKS
    except ImportError:
        return list(SECTOR_MAP.keys())


def _get_universe(name: str, limit: int | None = None) -> list[str]:
    try:
        from app.caches import stock_universes
        return stock_universes.resolve_universe(name, limit=limit)
    except ImportError:
        base = list(SECTOR_MAP.keys())
        return base[:limit] if limit else base


def _cached_session_response(key: str, reason: str) -> dict | None:
    cached = load_session(key)
    if not cached:
        return None
    resp = cached.get("data") or {}
    if not resp:
        return None
    resp = dict(resp)
    resp["cached"] = True
    resp["cachedAt"] = cached.get("timestamp")
    resp["warning"] = reason
    return resp


# ── FII/DII cache ───────────────────────────────────────────────────────────
_FII_DII_CACHE_FILE = settings.DATA_DIR / "fiidii_cache.json"
_fii_dii_cache: dict | None = None

# Load from disk on import
if _FII_DII_CACHE_FILE.exists():
    try:
        _fii_dii_cache = json.loads(_FII_DII_CACHE_FILE.read_text())
    except Exception:
        pass

# ── Top movers cache ────────────────────────────────────────────────────────
_movers_cache: dict | None = None
_movers_cache_ts: float = 0
_KITE_QUOTE_TIMEOUT_S = 8


async def _kite_quote_async(kite: KiteConnect, symbols: list[str], timeout: int = _KITE_QUOTE_TIMEOUT_S) -> dict:
    """Run the blocking Kite SDK quote call away from the event loop."""
    return await asyncio.wait_for(asyncio.to_thread(kite.quote, symbols), timeout=timeout)


# ── GET /api/market-status ───────────────────────────────────────────────────
@router.get("/market-status")
async def market_status() -> dict:
    """Is market open/closed based on IST time."""
    now = datetime.now(settings.TIMEZONE)
    total_mins = now.hour * 60 + now.minute
    is_weekday = now.weekday() < 5  # Mon=0, Fri=4
    is_open = is_weekday and 555 <= total_mins <= 930  # 9:15 to 15:30

    if not is_weekday:
        message = "Weekend"
    elif total_mins < 555:
        message = "Pre-Market"
    elif total_mins > 930:
        message = "Closed"
    else:
        message = "Market Open"

    return {"isOpen": is_open, "message": message, "timestamp": int(time.time() * 1000)}


# ── GET /api/breadth ─────────────────────────────────────────────────────────
@router.get("/breadth")
async def breadth(
    kite: KiteConnect | None = Depends(get_optional_kite),
    user: dict = Depends(get_current_user),
) -> dict:
    """Advances/declines from Nifty 500 quotes."""
    if not kite:
        cached = _cached_session_response("breadth", "Kite is not connected. Showing the last successful breadth snapshot.")
        if cached:
            return cached
        return {
            "advances": 0, "declines": 0, "unchanged": 0,
            "strongBuy": 0, "total": 0,
            "timestamp": int(time.time() * 1000),
            "cached": False,
            "warning": "Kite is not connected and no saved breadth snapshot is available.",
        }

    try:
        nifty500 = _get_nifty500()
        kite_symbols = [f"NSE:{s}" for s in nifty500]

        all_quotes: dict = {}
        for i in range(0, len(kite_symbols), 500):
            q = await _kite_quote_async(kite, kite_symbols[i: i + 500])
            all_quotes.update(q)

        try:
            from app.caches import avg_volume_cache
            avg_vol = avg_volume_cache.get_all() if hasattr(avg_volume_cache, "get_all") else {}
        except ImportError:
            avg_vol = {}

        advances = declines = unchanged = strong_buy = total = 0
        for symbol in nifty500:
            q = all_quotes.get(f"NSE:{symbol}")
            if not q:
                continue
            total += 1
            ltp = q.get("last_price", 0)
            prev_close = q.get("ohlc", {}).get("close", ltp) or ltp
            pct = ((ltp - prev_close) / prev_close * 100) if prev_close > 0 else 0
            if pct > 0.05:
                advances += 1
            elif pct < -0.05:
                declines += 1
            else:
                unchanged += 1
            vol = q.get("volume", 0) or 0
            avg = avg_vol.get(symbol, vol) or vol
            if pct > 1 and avg > 0 and vol / avg >= 1.5:
                strong_buy += 1

        response = {
            "advances": advances, "declines": declines, "unchanged": unchanged,
            "strongBuy": strong_buy, "total": total,
            "timestamp": int(time.time() * 1000),
        }

        # Session cache: save if we got meaningful data
        if total > 0 and (advances > 0 or declines > 0):
            save_session("breadth", response)

        return response

    except Exception as exc:
        # Serve cached data when market is closed
        if not is_market_hours():
            cached = _cached_session_response("breadth", "Live breadth failed. Showing the last successful breadth snapshot.")
            if cached:
                return cached
        raise HTTPException(status_code=500, detail=str(exc))


# ── GET /api/fii-dii ─────────────────────────────────────────────────────────
@router.get("/fii-dii")
async def fii_dii(user: dict = Depends(get_current_user)) -> dict:
    """FII/DII flow data with 15-minute cache."""
    global _fii_dii_cache

    if _fii_dii_cache and _fii_dii_cache.get("fetchedAt") and time.time() - _fii_dii_cache["fetchedAt"] < 900:
        return _fii_dii_cache

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "https://www.nseindia.com/market-data/fii-dii-activity",
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Hit homepage first for cookies
            await client.get("https://www.nseindia.com", headers=headers)
            resp = await client.get("https://www.nseindia.com/api/fiidiiTradeReact", headers=headers)
            parsed = resp.json()

        row = parsed[0] if parsed else None
        if not row or not row.get("date"):
            raise ValueError("Invalid NSE FII/DII response")

        result = {
            "date": row["date"],
            "source": "NSE",
            "fii": {
                "buy": float(row.get("fii_buy_value", 0) or 0),
                "sell": float(row.get("fii_sell_value", 0) or 0),
                "net": float(row.get("fii_net_value", 0) or 0),
            },
            "dii": {
                "buy": float(row.get("dii_buy_value", 0) or 0),
                "sell": float(row.get("dii_sell_value", 0) or 0),
                "net": float(row.get("dii_net_value", 0) or 0),
            },
            "fetchedAt": time.time(),
        }
        _fii_dii_cache = result
        try:
            settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
            _FII_DII_CACHE_FILE.write_text(json.dumps(result))
        except Exception:
            pass
        return result

    except Exception as exc:
        logger.warning("FII/DII fetch failed: %s", exc)
        if _fii_dii_cache:
            return {**_fii_dii_cache, "stale": True}
        return {
            "date": datetime.now(settings.TIMEZONE).strftime("%d-%b-%Y"),
            "fii": {"buy": 0, "sell": 0, "net": 0},
            "dii": {"buy": 0, "sell": 0, "net": 0},
            "error": "Data temporarily unavailable",
        }


# ── GET /api/delivery ────────────────────────────────────────────────────────
@router.get("/delivery")
async def delivery(user: dict = Depends(require_premium)) -> dict:
    """Delivery percentage data (premium only)."""
    try:
        from app.caches import delivery_cache
        data = delivery_cache.get_all() if hasattr(delivery_cache, "get_all") else {}
        return data
    except ImportError:
        return {}


# ── GET /api/symbols ─────────────────────────────────────────────────────────
@router.get("/symbols")
async def symbols_list() -> dict:
    """Return stock universe lists."""
    return {
        "nifty50": _get_universe("nifty50"),
        "nifty100": _get_universe("nifty100"),
        "nifty200": _get_universe("nifty200"),
        "nifty500": _get_nifty500(),
        "smallcap": _get_universe("smallcap"),
        "microcap": _get_universe("microcap"),
        "fno": _get_fno_stocks(),
    }


# ── GET /api/sector-momentum ────────────────────────────────────────────────
@router.get("/sector-momentum")
async def sector_momentum(
    kite: KiteConnect = Depends(get_kite),
    user: dict = Depends(require_premium),
) -> dict:
    """Sector strength breakdown (premium only)."""
    try:
        fno_stocks = _get_fno_stocks()
        nifty50 = _get_nifty500()[:50]
        all_symbols = list(set(fno_stocks + nifty50))
        kite_symbols = [f"NSE:{s}" for s in all_symbols]

        all_quotes: dict = {}
        for i in range(0, len(kite_symbols), 500):
            q = await _kite_quote_async(kite, kite_symbols[i: i + 500])
            all_quotes.update(q)

        stocks: list[dict] = []
        for symbol in all_symbols:
            q = all_quotes.get(f"NSE:{symbol}")
            if not q:
                continue
            ltp = q.get("last_price", 0)
            prev_close = q.get("ohlc", {}).get("close", ltp) or ltp
            change_pct = round(((ltp - prev_close) / prev_close * 100), 2) if prev_close > 0 else 0
            stocks.append({"symbol": symbol, "ltp": ltp, "changePct": change_pct})

        # Try loading tracker state for ORB/PDH data
        try:
            from app.caches import live_tracker, orb_detector
            pdh_crossed = live_tracker.pdh_crossed
            combo_surge = live_tracker.combo_surge
            orb_breaks = orb_detector.get_state().get("orb_break_30", set()) | orb_detector.get_state().get("orb_break_15", set())
        except ImportError:
            pdh_crossed = set()
            combo_surge = set()
            orb_breaks = set()

        sectors: dict[str, dict] = {}
        for s in stocks:
            sec = _get_sector(s["symbol"])
            if sec not in sectors:
                sectors[sec] = {
                    "name": sec, "count": 0, "advances": 0, "declines": 0,
                    "orbBreaks": 0, "pdhCrosses": 0, "surges": 0,
                    "totalChangePct": 0, "topStocks": [],
                }
            sectors[sec]["count"] += 1
            sectors[sec]["totalChangePct"] += s["changePct"]
            if s["changePct"] > 0.05:
                sectors[sec]["advances"] += 1
            elif s["changePct"] < -0.05:
                sectors[sec]["declines"] += 1
            if s["symbol"] in orb_breaks:
                sectors[sec]["orbBreaks"] += 1
            if s["symbol"] in pdh_crossed:
                sectors[sec]["pdhCrosses"] += 1
            if s["symbol"] in combo_surge:
                sectors[sec]["surges"] += 1
            sectors[sec]["topStocks"].append({"symbol": s["symbol"], "changePct": s["changePct"]})

        result = []
        for sec in sectors.values():
            if sec["count"] == 0:
                continue
            sec["avgChangePct"] = round(sec["totalChangePct"] / sec["count"], 2)
            sec["breadth"] = round((sec["advances"] / sec["count"]) * 100)
            sec["topStocks"] = sorted(sec["topStocks"], key=lambda x: x["changePct"], reverse=True)[:3]
            del sec["totalChangePct"]
            result.append(sec)

        result.sort(key=lambda s: s["avgChangePct"], reverse=True)
        response = {"sectors": result, "timestamp": int(time.time() * 1000)}

        # Session cache: save if we got meaningful data
        if result:
            save_session("sector_momentum", response)

        return response

    except Exception as exc:
        logger.exception("Sector momentum error")
        # Serve cached data when market is closed
        if not is_market_hours():
            cached = load_session("sector_momentum")
            if cached:
                resp = cached["data"]
                resp["cached"] = True
                resp["cachedAt"] = cached.get("timestamp")
                return resp
        raise HTTPException(status_code=500, detail=str(exc))


# ── GET /api/top-movers ──────────────────────────────────────────────────────
@router.get("/top-movers")
async def top_movers(
    kite: KiteConnect | None = Depends(get_optional_kite),
    user: dict = Depends(get_current_user),
) -> dict:
    """Top gainers/losers/most active (20s cache)."""
    global _movers_cache, _movers_cache_ts

    if _movers_cache and time.time() - _movers_cache_ts < 20:
        return _movers_cache

    if not kite:
        cached = _cached_session_response("top_movers", "Kite is not connected. Showing the last successful top movers snapshot.")
        if cached:
            _movers_cache = cached
            _movers_cache_ts = time.time()
            return cached
        return {
            "gainers": [], "losers": [], "active": [],
            "timestamp": int(time.time() * 1000),
            "cached": False,
            "warning": "Kite is not connected and no saved top movers snapshot is available.",
        }

    # If market is closed and no in-memory cache, try session cache
    if not is_market_hours() and not _movers_cache:
        cached = _cached_session_response("top_movers", "Market is closed. Showing the last successful top movers snapshot.")
        if cached:
            _movers_cache = cached
            _movers_cache_ts = time.time()
            return cached

    try:
        fno_stocks = _get_fno_stocks()
        kite_symbols = [f"NSE:{s}" for s in fno_stocks]

        all_quotes: dict = {}
        for i in range(0, len(kite_symbols), 500):
            q = await _kite_quote_async(kite, kite_symbols[i: i + 500])
            all_quotes.update(q)

        stocks: list[dict] = []
        for s in fno_stocks:
            q = all_quotes.get(f"NSE:{s}")
            if not q:
                continue
            ltp = q.get("last_price", 0)
            prev = q.get("ohlc", {}).get("close", ltp) or ltp
            chg = round(((ltp - prev) / prev * 100), 2) if prev > 0 else 0
            stocks.append({
                "symbol": s,
                "ltp": round(ltp, 2),
                "chg": chg,
                "volume": q.get("volume", 0) or 0,
                "sector": _get_sector(s),
            })

        gainers = sorted(stocks, key=lambda x: x["chg"], reverse=True)[:8]
        losers = sorted(stocks, key=lambda x: x["chg"])[:8]
        active = sorted(stocks, key=lambda x: x["volume"], reverse=True)[:8]

        result = {"gainers": gainers, "losers": losers, "active": active, "timestamp": int(time.time() * 1000)}

        # Session cache: save if we got meaningful data (non-zero changes)
        if stocks and any(s.get("chg", 0) != 0 for s in stocks):
            save_session("top_movers", result)

        _movers_cache = result
        _movers_cache_ts = time.time()
        return result

    except Exception as exc:
        # Serve cached data when market is closed
        if not is_market_hours():
            cached = _cached_session_response("top_movers", "Live top movers failed. Showing the last successful top movers snapshot.")
            if cached:
                return cached
        raise HTTPException(status_code=500, detail=str(exc))
