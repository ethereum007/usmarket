"""
F&O routes -- list F&O stocks, stock options chain, active futures.

Ported from tradingdesk/apps/gateway/src/routes/fno.routes.ts
"""

from __future__ import annotations

import logging
import time
from copy import deepcopy
from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from kiteconnect import KiteConnect

from app.config import settings
from app.dependencies import get_optional_kite
from app.services import arrow_market_data_service as arrow

logger = logging.getLogger("alpha_radar.routes.fno")

router = APIRouter(prefix="/api/fno", tags=["fno"])

# ── NFO instruments cache ────────────────────────────────────────────────────
_nfo_instruments: list[dict] | None = None
_nfo_instruments_ts: float = 0
_ARROW_MIN_CHAIN_ROWS = 3
_CHAIN_CACHE_TTL_SECONDS = 60
_CHAIN_CACHE_STALE_SECONDS = 15 * 60
_chain_cache: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}


def _cached_chain(key: tuple[str, str, str], *, allow_stale: bool = False) -> dict[str, Any] | None:
    cached = _chain_cache.get(key)
    if not cached:
        return None
    cached_at, payload = cached
    age = max(0.0, time.time() - cached_at)
    limit = _CHAIN_CACHE_STALE_SECONDS if allow_stale else _CHAIN_CACHE_TTL_SECONDS
    if age > limit:
        return None
    result = deepcopy(payload)
    result["cached"] = True
    result["cachedAgeSeconds"] = round(age, 1)
    result["stale"] = age > _CHAIN_CACHE_TTL_SECONDS
    return result


def _store_chain(key: tuple[str, str, str], payload: dict[str, Any]) -> dict[str, Any]:
    _chain_cache[key] = (time.time(), deepcopy(payload))
    return payload


def _get_nfo_instruments(kite: KiteConnect) -> list[dict]:
    global _nfo_instruments, _nfo_instruments_ts
    if not _nfo_instruments or time.time() - _nfo_instruments_ts > 3600:
        _nfo_instruments = kite.instruments("NFO")
        _nfo_instruments_ts = time.time()
    return _nfo_instruments


def _is_arrow_configured() -> bool:
    token, _ = arrow.get_active_access_token()
    return bool(settings.ARROW_APP_ID and token)


def _wants_arrow(provider: str) -> bool:
    return (provider or "arrow_first").lower() in {"arrow", "arrow_first"}


def _should_try_arrow(provider: str) -> bool:
    return _wants_arrow(provider) and _is_arrow_configured()


def _arrow_expiry(value: str | date | datetime) -> str:
    if isinstance(value, datetime):
        return value.strftime("%d-%b-%Y").upper()
    if isinstance(value, date):
        return value.strftime("%d-%b-%Y").upper()
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%d-%b-%Y").upper()
        except ValueError:
            continue
    return text.upper()


def _append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        clean = value.strip().upper()
        if clean and clean not in target:
            target.append(clean)


def _last_tuesday(year: int, month: int) -> date:
    cursor = date(year, month, 28)
    while cursor.month == month:
        cursor += timedelta(days=1)
    cursor -= timedelta(days=1)
    while cursor.weekday() != 1:
        cursor -= timedelta(days=1)
    return cursor


def _fallback_stock_expiry_candidates(limit: int = 10) -> list[str]:
    today = datetime.now(settings.TIMEZONE).date()
    candidates: list[str] = []

    month_cursor = date(today.year, today.month, 1)
    for _ in range(4):
        monthly = _last_tuesday(month_cursor.year, month_cursor.month)
        if monthly >= today:
            candidates.append(_arrow_expiry(monthly))
        next_month = month_cursor.month + 1
        next_year = month_cursor.year + (1 if next_month > 12 else 0)
        month_cursor = date(next_year, 1 if next_month > 12 else next_month, 1)

    cursor = today
    while len(candidates) < limit:
        if cursor.weekday() < 5:
            candidates.append(_arrow_expiry(cursor))
        cursor += timedelta(days=1)

    deduped: list[str] = []
    _append_unique(deduped, candidates)
    return deduped[:limit]


def _resolve_arrow_stock_expiries(
    kite: KiteConnect | None,
    symbol: str,
    requested_expiry: str | None,
) -> list[str]:
    candidates: list[str] = []
    if requested_expiry:
        _append_unique(candidates, [_arrow_expiry(requested_expiry)])
        return candidates

    if kite is not None:
        try:
            now = datetime.now()
            instruments = _get_nfo_instruments(kite)
            expiries = sorted({
                datetime(inst["expiry"].year, inst["expiry"].month, inst["expiry"].day)
                if hasattr(inst.get("expiry"), "year")
                else datetime.fromisoformat(str(inst.get("expiry")))
                for inst in instruments
                if inst.get("name") == symbol
                and inst.get("instrument_type") != "FUT"
                and inst.get("expiry")
            })
            _append_unique(candidates, [_arrow_expiry(exp) for exp in expiries if exp > now][:4])
        except Exception as exc:
            logger.debug("[fno] Could not resolve Kite expiries for Arrow %s: %s", symbol, exc)

    _append_unique(candidates, _fallback_stock_expiry_candidates(limit=10))
    return candidates[:10]


async def _get_arrow_stock_chain(
    *,
    symbol: str,
    kite: KiteConnect | None,
    expiry: str | None,
) -> dict[str, Any]:
    underlying = symbol if symbol.endswith("-EQ") else f"{symbol}-EQ"
    last_exc: Exception | None = None
    for arrow_expiry in _resolve_arrow_stock_expiries(kite, symbol.replace("-EQ", ""), expiry):
        try:
            data = await arrow.fetch_option_chain(
                underlying=underlying,
                exchange="NSE",
                expiry=arrow_expiry,
                count=arrow.ARROW_OPTION_CHAIN_COUNT,
                name=symbol.replace("-EQ", ""),
                lot_size=0,
                strike_step=0,
            )
            if len(data.get("chain") or []) < _ARROW_MIN_CHAIN_ROWS:
                raise ValueError(f"Arrow returned too few option-chain rows for {symbol}")
            data["symbol"] = symbol.replace("-EQ", "")
            return data
        except Exception as exc:
            last_exc = exc
            logger.info("[fno] Arrow option-chain attempt failed for %s %s: %s", symbol, arrow_expiry, exc)
    raise last_exc or HTTPException(status_code=502, detail="Arrow stock option-chain fetch failed")


# ── GET /api/fno/stocks ──────────────────────────────────────────────────────
@router.get("/stocks")
async def fno_stocks(kite: KiteConnect | None = Depends(get_optional_kite)) -> dict:
    """List all stocks with active F&O contracts."""
    if kite is None:
        raise HTTPException(status_code=503, detail="Kite is not connected. Stock F&O list needs Kite instruments for now.")
    try:
        instruments = _get_nfo_instruments(kite)
        stock_set: set[str] = set()
        for i in instruments:
            if i.get("instrument_type") == "FUT" and i.get("name") and i.get("segment") == "NFO-FUT":
                stock_set.add(i["name"])

        index_names = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"}
        stocks = sorted(stock_set - index_names)

        return {"success": True, "count": len(stocks), "stocks": stocks}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── GET /api/fno/chain/{symbol} ──────────────────────────────────────────────
@router.get("/chain/{symbol}")
async def fno_chain(
    symbol: str = Path(..., description="Stock symbol, e.g. RELIANCE"),
    expiry: str | None = Query(None, description="Expiry date YYYY-MM-DD"),
    provider: Literal["arrow_first", "arrow", "kite"] = Query("arrow_first"),
    kite: KiteConnect | None = Depends(get_optional_kite),
) -> dict:
    """Options chain for a specific F&O stock."""
    symbol = symbol.upper().replace("-EQ", "")
    cache_key = (symbol, expiry or "", provider)
    fresh = _cached_chain(cache_key)
    if fresh:
        return fresh

    if _should_try_arrow(provider):
        try:
            data = await _get_arrow_stock_chain(symbol=symbol, kite=kite, expiry=expiry)
            return _store_chain(cache_key, {"success": True, **data})
        except Exception as exc:
            if provider == "arrow":
                stale = _cached_chain(cache_key, allow_stale=True)
                if stale:
                    return stale
                raise HTTPException(status_code=503, detail=str(exc)[:240]) from exc
            logger.warning("[fno] Arrow fallback to Kite for %s: %s", symbol, exc)
    elif provider == "arrow":
        raise HTTPException(status_code=503, detail="Arrow is not configured or token is missing. Re-login with Arrow.")

    if kite is None:
        stale = _cached_chain(cache_key, allow_stale=True)
        if stale:
            return stale
        raise HTTPException(status_code=503, detail="Kite is not connected and Arrow option-chain fetch did not return data.")

    try:
        # Spot price
        spot_quote = kite.quote([f"NSE:{symbol}"])
        sq = spot_quote.get(f"NSE:{symbol}", {})
        spot = sq.get("last_price")
        if not spot:
            raise HTTPException(status_code=404, detail=f"Symbol not found: {symbol}")

        instruments = _get_nfo_instruments(kite)
        stock_opts = [i for i in instruments if i.get("name") == symbol and i.get("instrument_type") != "FUT"]
        if not stock_opts:
            raise HTTPException(status_code=404, detail=f"No F&O contracts for {symbol}")

        now = datetime.now()
        expiry_map: dict[str, dict] = {}
        for inst in stock_opts:
            exp = inst.get("expiry")
            if not exp:
                continue
            d = datetime(exp.year, exp.month, exp.day) if hasattr(exp, "year") else datetime.fromisoformat(str(exp))
            if d <= now:
                continue
            key = d.strftime("%Y-%m-%d")
            if key not in expiry_map:
                expiry_map[key] = {"date": d, "instruments": []}
            expiry_map[key]["instruments"].append(inst)

        sorted_expiries = sorted(expiry_map.values(), key=lambda x: x["date"])
        if not sorted_expiries:
            raise HTTPException(status_code=404, detail=f"No active expiries for {symbol}")

        # Select expiry
        if expiry:
            selected = next((e for e in sorted_expiries if e["date"].strftime("%Y-%m-%d") == expiry), sorted_expiries[0])
        else:
            selected = sorted_expiries[0]

        chain_instruments = selected["instruments"]
        all_expiries = [e["date"].strftime("%Y-%m-%d") for e in sorted_expiries]

        # Fetch quotes in batches
        tokens = [f"NFO:{i['tradingsymbol']}" for i in chain_instruments]
        all_quotes: dict = {}
        for i in range(0, len(tokens), 200):
            q = kite.quote(tokens[i: i + 200])
            all_quotes.update(q)
            if i + 200 < len(tokens):
                time.sleep(0.35)

        # Build chain
        strike_map: dict[float, dict] = {}
        for inst in chain_instruments:
            strike = inst["strike"]
            if strike not in strike_map:
                strike_map[strike] = {"strike": strike, "call": None, "put": None}
            q = all_quotes.get(f"NFO:{inst['tradingsymbol']}")
            if not q:
                continue

            oi = q.get("oi", 0) or 0
            oi_change = oi - (q.get("oi_day_low", oi) or oi)
            data = {
                "oi": oi,
                "oiChange": oi_change,
                "volume": q.get("volume", 0) or 0,
                "ltp": q.get("last_price", 0) or 0,
                "iv": round(q["implied_volatility"], 1) if q.get("implied_volatility") else None,
                "tradingsymbol": inst["tradingsymbol"],
                "lotSize": inst.get("lot_size", 0),
            }
            if inst["instrument_type"] == "CE":
                strike_map[strike]["call"] = data
            elif inst["instrument_type"] == "PE":
                strike_map[strike]["put"] = data

        chain = sorted(
            [s for s in strike_map.values() if s["call"] or s["put"]],
            key=lambda s: s["strike"],
        )

        # Analytics
        full_chain = [s for s in chain if s["call"] and s["put"]]
        total_call_oi = sum(s["call"]["oi"] for s in full_chain)
        total_put_oi = sum(s["put"]["oi"] for s in full_chain)
        pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi > 0 else 0

        min_loss = float("inf")
        max_pain_strike = full_chain[0]["strike"] if full_chain else 0
        for pivot in full_chain:
            total_loss = 0
            for row in full_chain:
                if row["strike"] < pivot["strike"]:
                    total_loss += (pivot["strike"] - row["strike"]) * row["call"]["oi"]
                if row["strike"] > pivot["strike"]:
                    total_loss += (row["strike"] - pivot["strike"]) * row["put"]["oi"]
            if total_loss < min_loss:
                min_loss = total_loss
                max_pain_strike = pivot["strike"]

        return _store_chain(cache_key, {
            "success": True,
            "symbol": symbol,
            "spot": round(spot, 2),
            "expiry": selected["date"].strftime("%Y-%m-%d"),
            "expiries": all_expiries,
            "lotSize": chain_instruments[0].get("lot_size", 0) if chain_instruments else 0,
            "chain": chain,
            "analytics": {
                "pcr": pcr,
                "pcrSentiment": "BULLISH" if pcr > 1.3 else ("BEARISH" if pcr < 0.7 else "NEUTRAL"),
                "maxPainStrike": max_pain_strike,
                "totalCallOI": total_call_oi,
                "totalPutOI": total_put_oi,
            },
            "timestamp": int(time.time() * 1000),
        })

    except HTTPException:
        stale = _cached_chain(cache_key, allow_stale=True)
        if stale:
            return stale
        raise
    except Exception as exc:
        stale = _cached_chain(cache_key, allow_stale=True)
        if stale:
            return stale
        logger.exception("[fno] Chain error for %s", symbol)
        raise HTTPException(status_code=500, detail=str(exc))


# ── GET /api/fno/futures ─────────────────────────────────────────────────────
@router.get("/futures")
async def fno_futures(kite: KiteConnect | None = Depends(get_optional_kite)) -> dict:
    """Active nearest futures with quotes for all F&O stocks."""
    if kite is None:
        raise HTTPException(status_code=503, detail="Kite is not connected. F&O futures list needs Kite instruments for now.")
    try:
        instruments = _get_nfo_instruments(kite)
        now = datetime.now()

        futures = sorted(
            [i for i in instruments if i.get("instrument_type") == "FUT" and _exp_date(i) > now],
            key=lambda i: _exp_date(i),
        )

        nearest_fut: dict[str, dict] = {}
        for f in futures:
            name = f.get("name", "")
            if name not in nearest_fut:
                nearest_fut[name] = f

        symbols = [f"NFO:{inst['tradingsymbol']}" for inst in nearest_fut.values()]

        all_quotes: dict = {}
        for i in range(0, len(symbols), 200):
            q = kite.quote(symbols[i: i + 200])
            all_quotes.update(q)
            if i + 200 < len(symbols):
                time.sleep(0.35)

        result = []
        for name, inst in nearest_fut.items():
            q = all_quotes.get(f"NFO:{inst['tradingsymbol']}", {})
            ltp = q.get("last_price", 0)
            close = q.get("ohlc", {}).get("close", ltp) or ltp
            change_pct = round(((ltp - close) / close * 100), 2) if close > 0 else 0

            oi = q.get("oi", 0) or 0
            oi_day_low = q.get("oi_day_low", 0) or 0
            oi_change = oi - oi_day_low if oi_day_low > 0 else 0
            oi_change_pct = round((oi_change / oi_day_low) * 100, 2) if oi_day_low > 0 else 0

            result.append({
                "name": name,
                "tradingsymbol": inst["tradingsymbol"],
                "expiry": _exp_date(inst).strftime("%Y-%m-%d"),
                "lotSize": inst.get("lot_size", 0),
                "last": ltp,
                "volume": q.get("volume", 0) or 0,
                "oi": oi,
                "oiDayLow": oi_day_low,
                "oiChange": oi_change,
                "oiChangePercent": oi_change_pct,
                "change": q.get("net_change", 0) or 0,
                "changePercent": change_pct,
            })

        result.sort(key=lambda x: x["name"])
        return {"success": True, "count": len(result), "data": result}

    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


def _exp_date(inst: dict) -> datetime:
    exp = inst.get("expiry")
    if hasattr(exp, "year"):
        return datetime(exp.year, exp.month, exp.day)
    return datetime.fromisoformat(str(exp))
