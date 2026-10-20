"""
Options chain routes -- index options chain with analytics.

Ported from tradingdesk/apps/gateway/src/routes/options.routes.ts
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from kiteconnect import KiteConnect

from app.config import settings
from app.core.session_cache import save_session, load_session, is_market_hours
from app.dependencies import get_optional_kite, require_premium
from app.engines.options_direction import compute_options_direction
from app.engines.options_fall_capture import build_options_fall_capture
from app.engines.options_trade_decision import build_options_trade_decision
from app.services import arrow_market_data_service as arrow

logger = logging.getLogger("alpha_radar.routes.options")

router = APIRouter(prefix="/api/options", tags=["options"])

# ── Index configurations ─────────────────────────────────────────────────────
INDEX_CONFIG: dict[str, dict[str, Any]] = {
    "nifty": {
        "name": "NIFTY",
        "underlying": "NSE:NIFTY 50",
        "exchange": "NFO",
        "lotSize": 75,
        "strikeStep": 50,
        "histToken": 256265,
    },
    "banknifty": {
        "name": "BANKNIFTY",
        "underlying": "NSE:NIFTY BANK",
        "exchange": "NFO",
        "lotSize": 15,
        "strikeStep": 100,
        "histToken": 260105,
    },
    "finnifty": {
        "name": "FINNIFTY",
        "underlying": "NSE:NIFTY FIN SERVICE",
        "exchange": "NFO",
        "lotSize": 40,
        "strikeStep": 50,
        "histToken": 257801,
    },
    "midcpnifty": {
        "name": "MIDCPNIFTY",
        "underlying": "NSE:NIFTY MIDCAP SELECT",
        "exchange": "NFO",
        "lotSize": 75,
        "strikeStep": 25,
        "histToken": 288009,
    },
    "sensex": {
        "name": "SENSEX",
        "underlying": "BSE:SENSEX",
        "exchange": "BFO",
        "lotSize": 10,
        "strikeStep": 100,
        "histToken": 265,
    },
}

# ── Instrument caches ────────────────────────────────────────────────────────
_nfo_instruments: list[dict] | None = None
_nfo_instruments_ts: float = 0
_bfo_instruments: list[dict] | None = None
_bfo_instruments_ts: float = 0

# ── OI cache (60s TTL) ──────────────────────────────────────────────────────
_oi_cache: dict[str, dict[str, Any]] = {}
_CACHE_TTL_SECONDS = 60
_STALE_CACHE_SECONDS = 15 * 60
_ARROW_MIN_CHAIN_ROWS = 3


def _is_rate_limit_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "too many requests" in text
        or "rate limit" in text
        or "ratelimit" in text
        or "429" in text
        or "budget exhausted" in text
    )


def _is_arrow_configured() -> bool:
    token, _ = arrow.get_active_access_token()
    return bool(settings.ARROW_APP_ID and token)


def _wants_arrow(provider: str) -> bool:
    return (provider or "arrow_first").lower() in {"arrow", "arrow_first"}


def _should_try_arrow(provider: str) -> bool:
    return _wants_arrow(provider) and _is_arrow_configured()


def _can_use_cached_options(data: dict[str, Any], provider: str) -> bool:
    if not _wants_arrow(provider):
        return True
    if not _is_arrow_configured():
        return True
    return (data.get("provider") or {}).get("provider") == "arrow"


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _refresh_arrow_underlying_context(
    kite: KiteConnect | None,
    index_key: str,
    data: dict[str, Any],
) -> None:
    """Use Kite index quote to correct Arrow option-chain spot/prev-close when available."""
    if kite is None or not data.get("chain"):
        return

    cfg = INDEX_CONFIG.get(index_key)
    if not cfg:
        return

    try:
        quote = kite.quote([cfg["underlying"]]).get(cfg["underlying"], {})
    except Exception as exc:
        logger.debug("[options] Could not refresh Arrow underlying context for %s: %s", index_key, exc)
        return

    live_spot = _safe_float(quote.get("last_price"))
    live_prev_close = _safe_float((quote.get("ohlc") or {}).get("close"))
    if live_spot <= 0:
        return

    old_spot = _safe_float(data.get("spot"))
    old_prev_close = _safe_float(data.get("prevClose"))
    strike_step = _safe_float(data.get("strikeStep"), _safe_float(cfg.get("strikeStep"), 50.0)) or 50.0

    stale_price_context = old_prev_close <= 0 or abs(old_prev_close - old_spot) < 0.01
    material_spot_gap = old_spot <= 0 or abs(live_spot - old_spot) >= max(1.0, strike_step * 0.25)
    if not stale_price_context and not material_spot_gap:
        return

    data["spot"] = round(live_spot, 2)
    if live_prev_close > 0:
        data["prevClose"] = round(live_prev_close, 2)
    data["analytics"] = arrow._build_options_analytics(data.get("chain") or [], live_spot)
    data["timestamp"] = int(time.time() * 1000)
    provider = data.setdefault("provider", {})
    provider["spotProvider"] = "kite"
    provider["spotSource"] = cfg["underlying"]
    if old_spot > 0:
        provider["spotOverrideFrom"] = round(old_spot, 2)
    data.pop("direction", None)
    data.pop("fallCapture", None)
    data.pop("tradeDecision", None)


def _arrow_expiry(value: str | date | datetime) -> str:
    if isinstance(value, datetime):
        return value.strftime("%d-%b-%Y").upper()
    if isinstance(value, date):
        return value.strftime("%d-%b-%Y").upper()
    text = str(value).strip()
    if not text:
        return text
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%d-%b-%Y").upper()
        except ValueError:
            continue
    return text.upper()


def _next_weekday_candidates(limit: int = 10) -> list[str]:
    today = datetime.now(settings.TIMEZONE).date()
    candidates: list[str] = []
    cursor = today
    while len(candidates) < limit:
        if cursor.weekday() < 5:
            candidates.append(_arrow_expiry(cursor))
        cursor += timedelta(days=1)
    return candidates


def _append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        clean = value.strip().upper()
        if clean and clean not in target:
            target.append(clean)


def _resolve_arrow_index_expiries(
    kite: KiteConnect | None,
    index_key: str,
    requested_expiry: str | None,
) -> list[str]:
    candidates: list[str] = []
    if requested_expiry:
        _append_unique(candidates, [_arrow_expiry(requested_expiry)])
        return candidates

    if kite is not None:
        try:
            instruments, _exchange = _get_instruments(kite, index_key)
            cfg = INDEX_CONFIG[index_key]
            now = datetime.now()
            expiries = sorted({
                datetime(inst["expiry"].year, inst["expiry"].month, inst["expiry"].day)
                if hasattr(inst.get("expiry"), "year")
                else datetime.fromisoformat(str(inst.get("expiry")))
                for inst in instruments
                if inst.get("name") == cfg["name"]
                and inst.get("instrument_type") != "FUT"
                and inst.get("expiry")
            })
            _append_unique(candidates, [_arrow_expiry(exp) for exp in expiries if exp > now][:4])
        except Exception as exc:
            logger.debug("[options] Could not resolve Kite expiries for Arrow %s: %s", index_key, exc)

    _append_unique(candidates, _next_weekday_candidates(limit=10))
    return candidates[:10]


async def get_options_chain_arrow(
    *,
    kite: KiteConnect | None,
    index_key: str,
    expiry: str | None = None,
) -> dict[str, Any]:
    cfg = INDEX_CONFIG.get(index_key)
    if not cfg:
        raise ValueError(f"Unknown index: {index_key}")

    expiries = _resolve_arrow_index_expiries(kite, index_key, expiry)
    last_exc: Exception | None = None
    for arrow_expiry in expiries:
        try:
            data = await arrow.fetch_option_chain(
                underlying=cfg["name"],
                exchange="INDEX",
                expiry=arrow_expiry,
                count=arrow.ARROW_OPTION_CHAIN_COUNT,
                index_key=index_key,
                name=cfg["name"],
                lot_size=cfg["lotSize"],
                strike_step=cfg["strikeStep"],
            )
            if len(data.get("chain") or []) < _ARROW_MIN_CHAIN_ROWS:
                raise ValueError(f"Arrow returned too few option-chain rows for {cfg['name']}")
            _refresh_arrow_underlying_context(kite, index_key, data)
            _store_options_chain(index_key, data)
            return data
        except Exception as exc:
            last_exc = exc
            logger.info("[options] Arrow option-chain attempt failed for %s %s: %s", cfg["name"], arrow_expiry, exc)
            # A throttle applies to the whole provider, not one expiry. Do not
            # fan out retries across every candidate and amplify the incident.
            if _is_rate_limit_error(exc):
                break

    raise last_exc or HTTPException(status_code=502, detail="Arrow option-chain fetch failed")


def get_cached_options_chain(
    index_key: str,
    max_age_seconds: int | None = None,
) -> tuple[dict[str, Any], int] | None:
    cached = _oi_cache.get(index_key)
    if not cached:
        return None

    age = max(0, int(time.time() - cached["ts"]))
    if max_age_seconds is not None and age > max_age_seconds:
        return None
    return cached["data"], age


def _store_options_chain(index_key: str, data: dict[str, Any]) -> None:
    _attach_direction(data)
    _oi_cache[index_key] = {"ts": time.time(), "data": data}
    if data.get("chain") and len(data["chain"]) > 0:
        save_session(f"options_{index_key}", data)


def _attach_direction(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("chain") and not data.get("direction"):
        data["direction"] = compute_options_direction(data)
    if data.get("chain") and not data.get("fallCapture"):
        data["fallCapture"] = build_options_fall_capture(data)
    return data


def _attach_trade_decision(
    response: dict[str, Any],
    *,
    cached: bool = False,
    stale: bool = False,
    warning: str | None = None,
) -> dict[str, Any]:
    response["tradeDecision"] = build_options_trade_decision(
        response,
        cached=cached,
        stale=stale,
        market_open=is_market_hours(),
        warning=warning or response.get("warning"),
    )
    return response


def _live_options_response(data: dict[str, Any]) -> dict[str, Any]:
    data = _attach_direction(data)
    response = {"success": True, **data}
    return _attach_trade_decision(response)


def _cached_options_response(
    data: dict[str, Any],
    *,
    stale: bool = False,
    cached_age_seconds: int | None = None,
    cached_at: Any | None = None,
    warning: str | None = None,
) -> dict[str, Any]:
    data = _attach_direction(data)
    response = {"success": True, **data, "cached": True}
    if stale:
        response["stale"] = True
    if cached_age_seconds is not None:
        response["cachedAgeSeconds"] = cached_age_seconds
    if cached_at:
        response["cachedAt"] = cached_at
    if warning:
        response["warning"] = warning
    _attach_trade_decision(response, cached=True, stale=stale, warning=warning)
    return response


def get_stale_options_chain_response(
    index_key: str,
    session_key: str,
    warning: str,
) -> dict[str, Any] | None:
    cached = get_cached_options_chain(index_key, _STALE_CACHE_SECONDS)
    if cached:
        data, age = cached
        return _cached_options_response(
            data,
            stale=True,
            cached_age_seconds=age,
            warning=warning,
        )

    session_cached = load_session(session_key)
    if session_cached:
        return _cached_options_response(
            session_cached["data"],
            stale=True,
            cached_at=session_cached.get("timestamp"),
            warning=warning,
        )

    return None


def _get_instruments(kite: KiteConnect, index_key: str) -> tuple[list[dict], str]:
    """Return (instruments, exchange) for the given index, with 1-hour caching."""
    global _nfo_instruments, _nfo_instruments_ts, _bfo_instruments, _bfo_instruments_ts

    cfg = INDEX_CONFIG[index_key]
    exchange = cfg["exchange"]

    if exchange == "BFO":
        if not _bfo_instruments or time.time() - _bfo_instruments_ts > 3600:
            _bfo_instruments = kite.instruments("BFO")
            _bfo_instruments_ts = time.time()
        return _bfo_instruments, exchange
    else:
        if not _nfo_instruments or time.time() - _nfo_instruments_ts > 3600:
            _nfo_instruments = kite.instruments("NFO")
            _nfo_instruments_ts = time.time()
        return _nfo_instruments, exchange


def get_options_chain(kite: KiteConnect, index_key: str) -> dict[str, Any]:
    """
    Build and return a full options chain with analytics for the given index.
    This function is also called from signals.py and squeeze.py.
    """
    cfg = INDEX_CONFIG.get(index_key)
    if not cfg:
        raise ValueError(f"Unknown index: {index_key}")

    cached = get_cached_options_chain(index_key, _CACHE_TTL_SECONDS)
    if cached:
        return cached[0]

    # Fetch spot price
    spot_quote = kite.quote([cfg["underlying"]])
    sq = spot_quote.get(cfg["underlying"], {})
    spot = sq.get("last_price")
    prev_close = sq.get("ohlc", {}).get("close", 0) or 0

    if not spot:
        ltp_data = kite.ltp([cfg["underlying"]])
        spot = ltp_data.get(cfg["underlying"], {}).get("last_price")
    if not spot:
        raise ValueError(f"Could not fetch spot price for {cfg['name']}")

    instruments, exchange = _get_instruments(kite, index_key)

    # Filter to this index's options (not futures)
    index_instruments = [
        i for i in instruments
        if i.get("name") == cfg["name"] and i.get("instrument_type") != "FUT"
    ]

    now = datetime.now()

    # Group by expiry
    expiry_map: dict[str, dict] = {}
    for inst in index_instruments:
        expiry = inst.get("expiry")
        if not expiry:
            continue
        d = datetime(expiry.year, expiry.month, expiry.day) if hasattr(expiry, "year") else datetime.fromisoformat(str(expiry))
        if d <= now:
            continue
        key = d.strftime("%Y-%m-%d")
        if key not in expiry_map:
            expiry_map[key] = {"date": d, "instruments": []}
        expiry_map[key]["instruments"].append(inst)

    sorted_expiries = sorted(expiry_map.values(), key=lambda x: x["date"])
    if not sorted_expiries:
        raise ValueError(f"No expiries for {cfg['name']}")

    # Nearest expiry -- filter to strikes within +/-15% of spot
    chain_instruments = [
        i for i in sorted_expiries[0]["instruments"]
        if i["strike"] >= spot * 0.85 and i["strike"] <= spot * 1.15
    ]
    nearest_expiry = sorted_expiries[0]["date"].strftime("%Y-%m-%d")
    all_expiries = [e["date"].strftime("%Y-%m-%d") for e in sorted_expiries]

    # Fetch quotes in batches of 150
    tokens = [f"{exchange}:{i['tradingsymbol']}" for i in chain_instruments]
    all_quotes: dict = {}
    for i in range(0, len(tokens), 150):
        try:
            q = kite.quote(tokens[i: i + 150])
            all_quotes.update(q)
        except Exception as exc:
            logger.error("[options] %s: batch failed: %s", cfg["name"], exc)
        if i + 150 < len(tokens):
            time.sleep(0.4)

    # Build strike map
    strike_map: dict[float, dict] = {}
    for inst in chain_instruments:
        strike = inst["strike"]
        if strike not in strike_map:
            strike_map[strike] = {"strike": strike, "call": None, "put": None}

        q = all_quotes.get(f"{exchange}:{inst['tradingsymbol']}")
        if not q:
            continue

        oi = q.get("oi", 0) or 0
        oi_change = oi - (q.get("oi_day_low", oi) or oi)
        data = {
            "token": inst["instrument_token"],
            "oi": oi,
            "oiChange": oi_change,
            "volume": q.get("volume", 0) or 0,
            "ltp": q.get("last_price", 0) or 0,
            "iv": round(q["implied_volatility"], 1) if q.get("implied_volatility") else None,
            "tradingsymbol": inst["tradingsymbol"],
            "bidQty": (q.get("depth", {}).get("buy", [{}])[0].get("quantity", 0)) if q.get("depth") else 0,
            "askQty": (q.get("depth", {}).get("sell", [{}])[0].get("quantity", 0)) if q.get("depth") else 0,
        }

        if inst["instrument_type"] == "CE":
            strike_map[strike]["call"] = data
        elif inst["instrument_type"] == "PE":
            strike_map[strike]["put"] = data

    chain = sorted(
        [s for s in strike_map.values() if s["call"] and s["put"]],
        key=lambda s: s["strike"],
    )

    # Analytics
    total_call_oi = sum(s["call"]["oi"] for s in chain)
    total_put_oi = sum(s["put"]["oi"] for s in chain)
    pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi > 0 else 0

    # Max Pain
    min_loss = float("inf")
    max_pain_strike = chain[0]["strike"] if chain else 0
    for pivot in chain:
        total_loss = 0
        for row in chain:
            if row["strike"] < pivot["strike"]:
                total_loss += (pivot["strike"] - row["strike"]) * (row["call"]["oi"])
            if row["strike"] > pivot["strike"]:
                total_loss += (row["strike"] - pivot["strike"]) * (row["put"]["oi"])
        if total_loss < min_loss:
            min_loss = total_loss
            max_pain_strike = pivot["strike"]

    # Top OI strikes
    top_call_strikes = [
        s["strike"] for s in sorted(chain, key=lambda s: s["call"]["oi"], reverse=True)[:3]
    ]
    top_put_strikes = [
        s["strike"] for s in sorted(chain, key=lambda s: s["put"]["oi"], reverse=True)[:3]
    ]

    # ATM IV
    atm_strike = min(chain, key=lambda s: abs(s["strike"] - spot)) if chain else None
    atm_iv = 0.0
    if atm_strike:
        ce_iv = atm_strike["call"]["iv"] or 0
        pe_iv = atm_strike["put"]["iv"] or 0
        atm_iv = (ce_iv + pe_iv) / 2

    data = {
        "index": index_key,
        "name": cfg["name"],
        "spot": round(spot, 2),
        "prevClose": round(prev_close, 2),
        "expiry": nearest_expiry,
        "expiries": all_expiries,
        "lotSize": cfg["lotSize"],
        "strikeStep": cfg["strikeStep"],
        "chain": chain,
        "analytics": {
            "pcr": pcr,
            "pcrSentiment": "BULLISH" if pcr > 1.3 else ("BEARISH" if pcr < 0.7 else "NEUTRAL"),
            "maxPainStrike": max_pain_strike,
            "maxPainDistance": round(spot - max_pain_strike),
            "totalCallOI": total_call_oi,
            "totalPutOI": total_put_oi,
            "resistance": top_call_strikes,
            "support": top_put_strikes,
            "atmIV": round(atm_iv, 1),
        },
        "timestamp": int(time.time() * 1000),
    }
    data["direction"] = compute_options_direction(data)
    _store_options_chain(index_key, data)
    return data


# ── GET /api/options/ ────────────────────────────────────────────────────────
@router.get("/")
async def list_indices() -> dict:
    """List available index options."""
    return {
        "success": True,
        "indices": [
            {
                "key": key,
                "name": cfg["name"],
                "lotSize": cfg["lotSize"],
                "strikeStep": cfg["strikeStep"],
            }
            for key, cfg in INDEX_CONFIG.items()
        ],
    }


# â”€â”€ GET /api/options/{index}/direction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@router.get("/{index}/direction")
async def options_direction(
    index: str = Path(..., description="Index key: nifty, banknifty, etc."),
    provider: Literal["arrow_first", "arrow", "kite"] = Query("arrow_first"),
    expiry: str | None = Query(None, description="Arrow expiry, e.g. 23-JUN-2026"),
    kite: KiteConnect | None = Depends(get_optional_kite),
) -> dict:
    """
    Direction-only options regime for the specified index.

    This reuses the normal options-chain cache and does not make a separate
    broker request when a fresh chain snapshot is already available.
    """
    key = index.lower()
    if key not in INDEX_CONFIG:
        raise HTTPException(
            status_code=400,
            detail={"error": "Unknown index", "available": list(INDEX_CONFIG.keys())},
        )

    session_key = f"options_{key}"
    cached = get_cached_options_chain(key, _CACHE_TTL_SECONDS)
    if cached:
        data, age = cached
        if _can_use_cached_options(data, provider):
            data = _attach_direction(data)
            return {
                "success": True,
                "index": data.get("index"),
                "name": data.get("name"),
                "spot": data.get("spot"),
                "prevClose": data.get("prevClose"),
                "expiry": data.get("expiry"),
                "timestamp": data.get("timestamp"),
                "direction": data.get("direction"),
                "fallCapture": data.get("fallCapture"),
                "provider": data.get("provider"),
                "cached": True,
                "cachedAgeSeconds": age,
            }

    from app.services.oi_history_service import oi_history_service

    shared = await oi_history_service.read_chain(
        key,
        expiry=expiry,
        max_age_seconds=settings.OI_HISTORY_SHARED_CHAIN_SECONDS,
    )
    if shared:
        data, age, _cached_at = shared
        if _can_use_cached_options(data, provider):
            _store_options_chain(key, data)
            data = _attach_direction(data)
            return {
                "success": True,
                "index": data.get("index"),
                "name": data.get("name"),
                "spot": data.get("spot"),
                "prevClose": data.get("prevClose"),
                "expiry": data.get("expiry"),
                "timestamp": data.get("timestamp"),
                "direction": data.get("direction"),
                "fallCapture": data.get("fallCapture"),
                "provider": data.get("provider"),
                "cached": True,
                "cachedAgeSeconds": age,
                "cacheSource": "shared",
            }

    if not is_market_hours():
        fallback = get_stale_options_chain_response(
            key,
            session_key,
            "Market is closed. Showing the last saved options direction.",
        )
        if fallback:
            data = _attach_direction(fallback)
            return {
                "success": True,
                "index": data.get("index"),
                "name": data.get("name"),
                "spot": data.get("spot"),
                "prevClose": data.get("prevClose"),
                "expiry": data.get("expiry"),
                "timestamp": data.get("timestamp"),
                "direction": data.get("direction"),
                "fallCapture": data.get("fallCapture"),
                "provider": data.get("provider"),
                "cached": True,
                "stale": True,
                "warning": fallback.get("warning"),
            }

    try:
        if _should_try_arrow(provider):
            data = _attach_direction(await get_options_chain_arrow(kite=kite, index_key=key, expiry=expiry))
        elif provider == "arrow":
            raise HTTPException(status_code=503, detail="Arrow is not configured or token is missing. Re-login with Arrow.")
        else:
            if kite is None:
                raise HTTPException(status_code=503, detail="Kite is not connected and Arrow provider was not requested.")
            data = _attach_direction(get_options_chain(kite, key))
        await oi_history_service.cache_chain(key, data)
        return {
            "success": True,
            "index": data.get("index"),
            "name": data.get("name"),
            "spot": data.get("spot"),
            "prevClose": data.get("prevClose"),
            "expiry": data.get("expiry"),
            "timestamp": data.get("timestamp"),
            "direction": data.get("direction"),
            "fallCapture": data.get("fallCapture"),
            "provider": data.get("provider"),
        }
    except Exception as exc:
        if _should_try_arrow(provider) and provider == "arrow_first" and kite is not None:
            try:
                data = _attach_direction(get_options_chain(kite, key))
                await oi_history_service.cache_chain(key, data)
                return {
                    "success": True,
                    "index": data.get("index"),
                    "name": data.get("name"),
                    "spot": data.get("spot"),
                    "prevClose": data.get("prevClose"),
                    "expiry": data.get("expiry"),
                    "timestamp": data.get("timestamp"),
                    "direction": data.get("direction"),
                    "fallCapture": data.get("fallCapture"),
                    "provider": {
                        "provider": "kite",
                        "fallback": True,
                        "fallbackReason": str(exc)[:180],
                    },
                }
            except Exception as kite_exc:
                logger.warning("[options] Kite direction fallback also failed for %s: %s", key, kite_exc)

        rate_limited = _is_rate_limit_error(exc)
        warning = (
            "Live options feed is rate-limited. Showing the latest available options direction."
            if rate_limited
            else "Live options feed is temporarily unavailable. Showing the latest available options direction."
        )
        fallback = get_stale_options_chain_response(key, session_key, warning)
        if fallback:
            data = _attach_direction(fallback)
            return {
                "success": True,
                "index": data.get("index"),
                "name": data.get("name"),
                "spot": data.get("spot"),
                "prevClose": data.get("prevClose"),
                "expiry": data.get("expiry"),
                "timestamp": data.get("timestamp"),
                "direction": data.get("direction"),
                "fallCapture": data.get("fallCapture"),
                "provider": data.get("provider"),
                "cached": True,
                "stale": True,
                "warning": fallback.get("warning"),
            }

        raise HTTPException(
            status_code=429 if rate_limited else 503,
            detail=(
                "Options direction is rate-limited. Please retry in a minute."
                if rate_limited
                else "Options direction is temporarily unavailable. Please retry shortly."
            ),
        )


# ── GET /api/options/{index}/oi-history ─────────────────────────────────────
@router.get("/{index}/oi-history")
async def options_oi_history(
    index: str = Path(..., description="Index key: nifty, banknifty, etc."),
    expiry: str = Query(..., min_length=3, max_length=40),
    strike: float | None = Query(None, gt=0),
    limit: int = Query(24, ge=1, le=96),
    user: dict = Depends(require_premium),
) -> dict:
    """Return five-minute overall and selected-strike OI explanations."""
    del user
    key = index.lower()
    if key not in INDEX_CONFIG:
        raise HTTPException(
            status_code=400,
            detail={"error": "Unknown index", "available": list(INDEX_CONFIG.keys())},
        )
    from app.services.oi_history_service import oi_history_service

    return await oi_history_service.history(
        key,
        expiry,
        strike=strike,
        limit=limit,
    )


# ── GET /api/options/{index} ─────────────────────────────────────────────────
@router.get("/{index}")
async def options_chain(
    index: str = Path(..., description="Index key: nifty, banknifty, etc."),
    provider: Literal["arrow_first", "arrow", "kite"] = Query("arrow_first"),
    expiry: str | None = Query(None, description="Arrow expiry, e.g. 23-JUN-2026"),
    kite: KiteConnect | None = Depends(get_optional_kite),
) -> dict:
    """
    Full options chain + analytics for the specified index.
    60-second cache per index.
    """
    key = index.lower()
    if key not in INDEX_CONFIG:
        raise HTTPException(
            status_code=400,
            detail={"error": "Unknown index", "available": list(INDEX_CONFIG.keys())},
        )

    session_key = f"options_{key}"

    # Return cache if still fresh. This keeps the chain, OI clock, and squeeze
    # monitor from making duplicate broker calls for the same snapshot.
    cached = get_cached_options_chain(key, _CACHE_TTL_SECONDS)
    if cached:
        data, age = cached
        if _can_use_cached_options(data, provider):
            return _cached_options_response(data, cached_age_seconds=age)

    from app.services.oi_history_service import oi_history_service

    shared = await oi_history_service.read_chain(
        key,
        expiry=expiry,
        max_age_seconds=settings.OI_HISTORY_SHARED_CHAIN_SECONDS,
    )
    if shared:
        data, age, cached_at = shared
        if _can_use_cached_options(data, provider):
            _store_options_chain(key, data)
            response = _cached_options_response(
                data,
                cached_age_seconds=age,
                cached_at=cached_at,
            )
            response["cacheSource"] = "shared"
            return response

    # If market is closed and no in-memory cache, try session cache
    if not is_market_hours():
        fallback = get_stale_options_chain_response(
            key,
            session_key,
            "Market is closed. Showing the last saved options chain.",
        )
        if fallback:
            return fallback

    try:
        if _should_try_arrow(provider):
            data = await get_options_chain_arrow(kite=kite, index_key=key, expiry=expiry)
        elif provider == "arrow":
            raise HTTPException(status_code=503, detail="Arrow is not configured or token is missing. Re-login with Arrow.")
        else:
            if kite is None:
                raise HTTPException(status_code=503, detail="Kite is not connected and Arrow provider was not requested.")
            data = get_options_chain(kite, key)
        await oi_history_service.cache_chain(key, data)
        return _live_options_response(data)
    except Exception as exc:
        if _should_try_arrow(provider) and provider == "arrow_first" and kite is not None:
            try:
                data = get_options_chain(kite, key)
                data["provider"] = {
                    "provider": "kite",
                    "fallback": True,
                    "fallbackReason": str(exc)[:180],
                }
                _store_options_chain(key, data)
                await oi_history_service.cache_chain(key, data)
                return _live_options_response(data)
            except Exception as kite_exc:
                logger.warning("[options] Kite fallback also failed for %s: %s", key, kite_exc)

        rate_limited = _is_rate_limit_error(exc)
        if rate_limited:
            logger.warning("[options] Rate limited for %s: %s", key, exc)
        else:
            logger.exception("[options] Error for %s", key)
        warning = (
            "Live options feed is rate-limited. Showing the latest available chain."
            if rate_limited
            else "Live options feed is temporarily unavailable. Showing the latest available chain."
        )
        fallback = get_stale_options_chain_response(key, session_key, warning)
        if fallback:
            return fallback

        raise HTTPException(
            status_code=429 if rate_limited else 503,
            detail=(
                "Options feed is rate-limited. Please retry in a minute."
                if rate_limited
                else "Options feed is temporarily unavailable. Please retry shortly."
            ),
        )
