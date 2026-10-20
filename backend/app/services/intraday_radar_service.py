"""
Intraday Radar service.

Builds one ranked intraday candidate list from live quotes plus daily
context: previous day levels, average volume/range, VWAP proxy, ORB cache,
and market breadth. This is the backend-owned spine for the Radar page.
"""

from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from kiteconnect import KiteConnect

from app.config import settings
from app.engines.market_pulse import compute_pulse

logger = logging.getLogger("alpha_radar.services.intraday_radar")

Bias = Literal["LONG", "SHORT", "NEUTRAL"]

_stats_cache: dict[str, dict[str, float]] = {}
_stats_cache_date = ""
_quote_cache: dict[str, Any] = {"ts": 0.0, "symbols_key": "", "data": {}}
_radar_response_cache: dict[str, dict[str, Any]] = {}
_QUOTE_TTL_S = 12
_RADAR_TTL_S = 18
# Historical candles are deliberately warmed a few at a time. This avoids a
# cold Nifty 500 cache turning into dozens of Kite requests in one browser flow.
_MAX_STATS_FETCH_PER_REQUEST = 6
_DAILY_STATS_SYNC_BUDGET_S = 4.0
_historical_request_lock = threading.Lock()
_next_historical_request_at = 0.0


@dataclass
class IntradayRadarBody:
    symbols: list[str]


def build_intraday_radar(
    kite: KiteConnect | None,
    symbols: list[str],
    *,
    min_traded_value_lakh: float = 0,
    use_cache: bool = True,
    quote_map: dict[str, Any] | None = None,
    provider_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a ranked intraday radar response for the supplied symbols."""
    clean_symbols = _normalize_symbols(symbols)
    if not clean_symbols:
        return _empty_response("No symbols supplied")

    provider = str((provider_meta or {}).get("provider") or "kite").lower()
    cache_key = _radar_cache_key(clean_symbols, min_traded_value_lakh, provider)
    if use_cache:
        cached = _get_cached_radar(cache_key)
        if cached:
            return cached

    if quote_map is None:
        if kite is None:
            raise ValueError("Kite is required when no Arrow quote map is available")
        quote_map = _fetch_quotes(kite, clean_symbols)
        provider_meta = {
            **(provider_meta or {}),
            "provider": "kite",
            "requested": len(clean_symbols),
            "returned": len(quote_map),
            "fallback": bool((provider_meta or {}).get("fallback")),
        }
    stats_status = _ensure_daily_stats(kite, clean_symbols, quote_map=quote_map)

    raw_candidates: list[dict[str, Any]] = []
    # Private diagnostics for Intraday; never added to the shared Radar response.
    score_context: dict[str, Any] = {}
    for symbol in clean_symbols:
        quote = quote_map.get(f"NSE:{symbol}")
        candidate = _build_candidate(symbol, quote, _stats_cache.get(symbol), score_context=score_context)
        if candidate:
            if min_traded_value_lakh > 0 and candidate.get("tradedValueLakh", 0) < min_traded_value_lakh:
                continue
            raw_candidates.append(candidate)

    regime = _classify_market_regime(raw_candidates)
    candidates = [_apply_regime_adjustment(c, regime) for c in raw_candidates]
    candidates.sort(key=lambda c: (abs(c["score"]), c["volRatio"], abs(c["changePct"])), reverse=True)

    actionable = [c for c in candidates if c["bias"] != "NEUTRAL" and c["score"] >= 35]
    watchlist = [c for c in candidates if c["bias"] != "NEUTRAL" and c["score"] < 35]

    response = {
        "success": True,
        "marketRegime": regime,
        "summary": _build_summary(candidates),
        "sectors": _sector_leadership(candidates),
        "candidates": candidates[:80],
        "actionable": actionable[:30],
        "watchlist": watchlist[:30],
        "timestamp": int(time.time() * 1000),
        "statsCached": len(_stats_cache),
        "dataQuality": _data_quality(candidates),
        "cache": {
            "hit": False,
            "ttlSeconds": _RADAR_TTL_S,
            "key": cache_key[:12],
        },
        "statsStatus": stats_status,
        "provider": provider_meta or {"provider": "kite"},
        "filters": {
            "minTradedValueLakh": min_traded_value_lakh,
            "inputSymbols": len(clean_symbols),
            "returnedCandidates": len(candidates),
        },
    }
    if min_traded_value_lakh == 0:
        try:
            from app.services.intraday_monitoring import publish_universe

            publish_universe(clean_symbols, candidates, score_context, response, quote_map)
        except Exception:
            # Intraday diagnostics must never disrupt the established Radar feed.
            logger.warning("Intraday monitoring snapshot unavailable", exc_info=True)
    try:
        from app.engines.runner.context import runner_context

        runner_context.update_market(
            market_breadth=regime.get("breadthPct"),
            market_regime=regime.get("label"),
            sector_returns={item["name"]: item["avgChangePct"] for item in response["sectors"]},
            sector_ranks={item["name"]: rank for rank, item in enumerate(response["sectors"], 1)},
        )
        runner_context.ingest_rows(
            candidates, score_field="marketPulse", target_field="market_pulse"
        )
    except Exception:
        logger.debug("Runner market-context join skipped", exc_info=True)
    _set_cached_radar(cache_key, response)
    _log_actionable_radar_fires(actionable[:10], regime)
    return response


def _radar_cache_key(symbols: list[str], min_traded_value_lakh: float, provider: str) -> str:
    raw = ",".join(symbols) + f"|tv={min_traded_value_lakh}|provider={provider}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _get_cached_radar(cache_key: str) -> dict[str, Any] | None:
    cached = _radar_response_cache.get(cache_key)
    if not cached:
        return None
    age = time.time() - float(cached["ts"])
    if age > _RADAR_TTL_S:
        return None
    data = dict(cached["data"])
    data["cached"] = True
    data["cachedAgeSeconds"] = round(age, 1)
    data["cache"] = {
        **data.get("cache", {}),
        "hit": True,
        "ageSeconds": round(age, 1),
    }
    return data


def _set_cached_radar(cache_key: str, response: dict[str, Any]) -> None:
    _radar_response_cache[cache_key] = {"ts": time.time(), "data": response}


def _normalize_symbols(symbols: list[str]) -> list[str]:
    seen: set[str] = set()
    clean: list[str] = []
    for symbol in symbols[:500]:
        s = str(symbol).strip().upper()
        if not s or s in seen:
            continue
        seen.add(s)
        clean.append(s)
    return clean


def _empty_response(message: str) -> dict[str, Any]:
    return {
        "success": True,
        "marketRegime": {"label": "no-data", "bias": "NEUTRAL", "confidence": 0, "notes": [message]},
        "summary": {"total": 0, "long": 0, "short": 0, "neutral": 0},
        "candidates": [],
        "actionable": [],
        "watchlist": [],
        "timestamp": int(time.time() * 1000),
        "statsCached": len(_stats_cache),
        "dataQuality": {"fresh": 0, "stale": 0, "missingStats": 0},
    }


def _ensure_daily_stats(
    kite: KiteConnect | None,
    symbols: list[str],
    *,
    quote_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Cache previous session levels and average range/volume for the day."""
    global _stats_cache_date
    today = datetime.now(settings.TIMEZONE).strftime("%Y-%m-%d")
    if _stats_cache_date != today:
        _stats_cache.clear()
        _stats_cache_date = today

    _seed_stats_from_global_caches(symbols)

    missing = [s for s in symbols if s not in _stats_cache]
    if not missing:
        return {
            "cached": len(symbols),
            "missing": 0,
            "fetched": 0,
            "deferred": 0,
            "source": "cache",
        }

    if kite is None:
        return {
            "cached": len(symbols) - len(missing),
            "missing": len(missing),
            "fetched": 0,
            "deferred": len(missing),
            "source": "cache-only; Kite disconnected",
        }

    if _stats_cache_date == today and len(missing) < len(symbols):
        logger.info(
            "[intraday-radar] Daily context seeded from caches for %d/%d symbols; fetching %d misses",
            len(symbols) - len(missing),
            len(symbols),
            len(missing),
        )

    if not missing:
        return {
            "cached": len(symbols),
            "missing": 0,
            "fetched": 0,
            "deferred": 0,
            "source": "cache",
        }

    prioritized_missing = _prioritize_missing_stats(missing, quote_map)
    fetch_now = prioritized_missing[:_MAX_STATS_FETCH_PER_REQUEST]
    deferred = prioritized_missing[_MAX_STATS_FETCH_PER_REQUEST:]
    logger.info(
        "[intraday-radar] Loading daily stats for up to %d/%d missing symbols; deferring %d",
        len(fetch_now),
        len(missing),
        len(deferred),
    )
    token_map = _resolve_nse_tokens(kite, fetch_now)
    to_date = datetime.now(settings.TIMEZONE).date()
    from_date = to_date - timedelta(days=35)

    fetched = 0
    attempted = 0
    deadline = time.time() + _DAILY_STATS_SYNC_BUDGET_S
    for idx, symbol in enumerate(fetch_now):
        if idx and time.time() > deadline:
            deferred = fetch_now[idx:] + deferred
            logger.info(
                "[intraday-radar] Daily stats sync budget hit after %d attempts; deferring %d",
                attempted,
                len(deferred),
            )
            break
        attempted += 1
        token = token_map.get(symbol)
        if not token:
            continue
        try:
            candles = _paced_historical_data(
                kite,
                instrument_token=token,
                from_date=from_date.isoformat(),
                to_date=to_date.isoformat(),
                interval="day",
            )
            completed = [c for c in candles if str(c.get("date", ""))[:10] < today]
            if len(completed) < 5:
                continue
            lookback = completed[-20:]
            ranges = [float(c["high"]) - float(c["low"]) for c in lookback]
            volumes = [float(c.get("volume", 0) or 0) for c in lookback]
            closes = [float(c["close"]) for c in lookback]
            prev = completed[-1]
            _stats_cache[symbol] = {
                "avg_volume": sum(volumes) / len(volumes) if volumes else 0,
                "avg_range": sum(ranges) / len(ranges) if ranges else 0,
                "avg_close": sum(closes) / len(closes) if closes else 0,
                "pdh": float(prev["high"]),
                "pdl": float(prev["low"]),
                "pdc": float(prev["close"]),
            }
            fetched += 1
        except Exception:
            logger.debug("[intraday-radar] Daily stats failed for %s", symbol, exc_info=True)

        if idx and idx % 50 == 0:
            logger.info("[intraday-radar] Daily stats %d/%d", idx, len(fetch_now))

    return {
        "cached": len([s for s in symbols if s in _stats_cache]),
        "missing": len(missing),
        "fetched": fetched,
        "attempted": attempted,
        "deferred": len(deferred),
        "source": "cache+historical",
        "capPerRequest": _MAX_STATS_FETCH_PER_REQUEST,
        "syncBudgetSeconds": _DAILY_STATS_SYNC_BUDGET_S,
    }


def _prioritize_missing_stats(symbols: list[str], quote_map: dict[str, Any] | None) -> list[str]:
    """Warm context for the names moving now, not just the first N in the universe."""
    if not quote_map:
        return symbols
    return sorted(
        symbols,
        key=lambda symbol: _quote_priority_score(symbol, quote_map),
        reverse=True,
    )


def _quote_priority_score(symbol: str, quote_map: dict[str, Any]) -> float:
    quote = quote_map.get(f"NSE:{symbol}") or {}
    if not isinstance(quote, dict):
        return 0.0
    ltp = _safe_float(quote.get("last_price"))
    ohlc = quote.get("ohlc", {}) if isinstance(quote.get("ohlc"), dict) else {}
    prev_close = _safe_float(ohlc.get("close")) or ltp
    open_ = _safe_float(ohlc.get("open")) or ltp
    high = _safe_float(ohlc.get("high")) or ltp
    low = _safe_float(ohlc.get("low")) or ltp
    volume = _safe_float(quote.get("volume"))
    change_pct = abs(((ltp - prev_close) / prev_close) * 100) if prev_close else 0.0
    intraday_drive = abs(((ltp - open_) / open_) * 100) if open_ else 0.0
    range_pct = ((high - low) / ltp) * 100 if ltp else 0.0
    traded_value_lakh = (volume * ltp) / 100000 if ltp else 0.0
    liquidity_score = min(4.0, math.log10(max(traded_value_lakh, 1.0)))
    return change_pct * 4 + intraday_drive * 3 + range_pct * 2 + liquidity_score


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _seed_stats_from_global_caches(symbols: list[str]) -> None:
    """Use preloaded app caches before making expensive historical calls."""
    try:
        from app.caches import avg_volume_cache, pdh_pdl_cache
    except Exception:
        return

    for symbol in symbols:
        if symbol in _stats_cache:
            continue
        avg_volume = avg_volume_cache.get_avg_volume(symbol) or 0
        pdh = pdh_pdl_cache.get_pdh(symbol) or 0
        pdl = pdh_pdl_cache.get_pdl(symbol) or 0
        if avg_volume <= 0 and (pdh <= 0 or pdl <= 0):
            continue
        avg_range = max(float(pdh) - float(pdl), 0.0) if pdh and pdl else 0.0
        _stats_cache[symbol] = {
            "avg_volume": float(avg_volume),
            "avg_range": avg_range,
            "avg_close": 0.0,
            "pdh": float(pdh),
            "pdl": float(pdl),
            "pdc": 0.0,
        }


def _resolve_nse_tokens(kite: KiteConnect, symbols: list[str]) -> dict[str, int]:
    target = set(symbols)
    try:
        from app.caches import instrument_cache

        cached_instruments = instrument_cache.get_nse_instruments()
        if cached_instruments:
            return {
                inst.get("tradingsymbol", ""): inst["instrument_token"]
                for inst in cached_instruments
                if inst.get("tradingsymbol") in target and inst.get("instrument_token")
            }
    except Exception:
        logger.debug("[intraday-radar] NSE instrument cache lookup failed", exc_info=True)
    try:
        instruments = kite.instruments("NSE")
    except Exception:
        logger.exception("[intraday-radar] Could not fetch NSE instruments")
        return {}
    return {
        inst.get("tradingsymbol", ""): inst["instrument_token"]
        for inst in instruments
        if inst.get("tradingsymbol") in target and inst.get("instrument_token")
    }


def _paced_historical_data(kite: KiteConnect, **kwargs: Any) -> list[dict[str, Any]]:
    """Serialise the small cold-cache historical warmup below Kite's burst cap."""
    global _next_historical_request_at
    with _historical_request_lock:
        now = time.monotonic()
        pause = max(0.0, _next_historical_request_at - now)
        if pause:
            time.sleep(pause)
        _next_historical_request_at = time.monotonic() + max(0.0, settings.KITE_PROVIDER_MIN_INTERVAL_SECONDS)
        return kite.historical_data(**kwargs) or []


def _fetch_quotes(kite: KiteConnect, symbols: list[str]) -> dict[str, Any]:
    global _quote_cache
    symbols_key = ",".join(symbols)
    if (
        _quote_cache["symbols_key"] == symbols_key
        and time.time() - float(_quote_cache["ts"]) < _QUOTE_TTL_S
    ):
        return dict(_quote_cache["data"])

    kite_symbols = [f"NSE:{s}" for s in symbols]
    all_quotes: dict[str, Any] = {}
    for idx in range(0, len(kite_symbols), 300):
        batch = kite_symbols[idx : idx + 300]
        try:
            all_quotes.update(kite.quote(batch))
        except Exception:
            logger.warning("[intraday-radar] Quote batch failed %d-%d", idx, idx + len(batch))
        if idx + 300 < len(kite_symbols):
            time.sleep(max(1.05, settings.KITE_PROVIDER_MIN_INTERVAL_SECONDS))

    _quote_cache = {"ts": time.time(), "symbols_key": symbols_key, "data": all_quotes}
    return all_quotes


def _build_candidate(symbol: str, quote: dict[str, Any] | None, stats: dict[str, float] | None, *, score_context: dict[str, Any] | None = None) -> dict[str, Any] | None:
    if not quote or not quote.get("last_price"):
        return None

    ltp = float(quote["last_price"])
    ohlc = quote.get("ohlc", {}) or {}
    open_ = float(ohlc.get("open", ltp) or ltp)
    high = float(ohlc.get("high", ltp) or ltp)
    low = float(ohlc.get("low", ltp) or ltp)
    prev_close = float(ohlc.get("close", ltp) or ltp)
    volume = int(quote.get("volume", 0) or 0)
    traded_value_lakh = (volume * ltp) / 100000 if ltp > 0 else 0.0
    vwap = float(quote.get("average_price", 0) or 0)
    change_pct = ((ltp - prev_close) / prev_close * 100) if prev_close else 0

    avg_volume = float(stats.get("avg_volume", 0)) if stats else 0
    avg_range = float(stats.get("avg_range", 0)) if stats else 0
    pdh = float(stats.get("pdh", 0)) if stats else 0
    pdl = float(stats.get("pdl", 0)) if stats else 0

    pulse = compute_pulse(
        symbol=symbol,
        ltp=ltp,
        open_=open_,
        high=high,
        low=low,
        volume=volume,
        change_pct=change_pct,
        avg_volume=avg_volume,
        avg_range=avg_range,
        pdh=pdh,
        pdl=pdl,
    )

    today_range = max(high - low, 0)
    vol_ratio = (volume / avg_volume) if avg_volume > 0 else 1.0
    r_factor = (today_range / avg_range) if avg_range > 0 else (1.0 if today_range > 0 else 0.0)
    orb = _orb_status(symbol, ltp)
    setup_info = _detect_setups(ltp, open_, high, low, vwap, pdh, pdl, change_pct, vol_ratio, r_factor, orb)
    bias = _choose_bias(change_pct, setup_info["longScore"], setup_info["shortScore"])
    base_score = _score_candidate(change_pct, vol_ratio, r_factor, setup_info, bias)
    if score_context is not None:
        score_context[symbol] = {
            "changePct": change_pct, "volRatio": vol_ratio, "rFactor": r_factor,
            "setupPoints": setup_info["longScore"] if bias == "LONG" else setup_info["shortScore"],
            "baseScore": base_score,
        }
    levels = _levels_for_candidate(bias, ltp, high, low, open_, vwap, pdh, pdl, avg_range)
    freshness = _freshness(quote)

    if bias == "NEUTRAL" and abs(change_pct) < 0.25 and r_factor < 0.55 and vol_ratio < 1.2:
        return None

    reasons = _build_reasons(bias, setup_info["setups"], change_pct, vol_ratio, r_factor, vwap, pdh, pdl, freshness)
    if not reasons and pulse:
        reasons.append(f"Pulse signal is {pulse.signal} with signal strength {pulse.signal_pct}.")
    quality = _quality_label(base_score, bias, setup_info["setups"], freshness, stats)

    return {
        "symbol": symbol,
        "bias": bias,
        "score": base_score,
        "quality": quality["quality"],
        "action": quality["action"],
        "setups": setup_info["setups"],
        "entry": levels["entry"],
        "stop": levels["stop"],
        "target1": levels["target1"],
        "target2": levels["target2"],
        "riskReward": levels["riskReward"],
        "invalidation": levels["invalidation"],
        "ltp": round(ltp, 2),
        "open": round(open_, 2),
        "high": round(high, 2),
        "low": round(low, 2),
        "prevClose": round(prev_close, 2),
        "changePct": round(change_pct, 2),
        "volume": volume,
        "tradedValueLakh": round(traded_value_lakh, 2),
        "volRatio": round(vol_ratio, 2),
        "rFactor": round(r_factor, 2),
        "vwap": round(vwap, 2) if vwap > 0 else None,
        "pdh": round(pdh, 2) if pdh > 0 else None,
        "pdl": round(pdl, 2) if pdl > 0 else None,
        "orb": orb,
        "marketPulse": pulse.signal if pulse else None,
        "sector": _sector_for(symbol),
        "freshness": freshness,
        "dataWarnings": _data_warnings(stats, freshness, vwap),
        "reasons": reasons,
    }


def _detect_setups(
    ltp: float,
    open_: float,
    high: float,
    low: float,
    vwap: float,
    pdh: float,
    pdl: float,
    change_pct: float,
    vol_ratio: float,
    r_factor: float,
    orb: dict[str, Any],
) -> dict[str, Any]:
    setups: list[str] = []
    long_score = 0
    short_score = 0

    if pdh > 0 and ltp > pdh:
        setups.append("PDH_BREAK")
        long_score += 24
    if pdl > 0 and ltp < pdl:
        setups.append("PDL_BREAK")
        short_score += 24
    if vwap > 0 and ltp > vwap and open_ >= vwap:
        setups.append("VWAP_HOLD")
        long_score += 12
    elif vwap > 0 and ltp > vwap and open_ < vwap:
        setups.append("VWAP_RECLAIM")
        long_score += 16
    elif vwap > 0 and ltp < vwap and open_ <= vwap:
        setups.append("VWAP_REJECT")
        short_score += 12
    elif vwap > 0 and ltp < vwap and open_ > vwap:
        setups.append("VWAP_LOSS")
        short_score += 16
    if change_pct >= 1.0 and ltp > open_:
        setups.append("OPEN_DRIVE_UP")
        long_score += 14
    if change_pct <= -1.0 and ltp < open_:
        setups.append("OPEN_DRIVE_DOWN")
        short_score += 14
    if vol_ratio >= 1.5:
        setups.append("RVOL_EXPANSION")
        long_score += 8 if change_pct > 0 else 0
        short_score += 8 if change_pct < 0 else 0
    if r_factor >= 1.2:
        setups.append("RANGE_EXPANSION")
        long_score += 6 if change_pct > 0 else 0
        short_score += 6 if change_pct < 0 else 0
    if orb.get("orbBreak30"):
        setups.append("ORB30_BREAK")
        long_score += 18
    elif orb.get("nearOrb30"):
        setups.append("NEAR_ORB30")
        long_score += 8
    if orb.get("orbBreak15"):
        setups.append("ORB15_BREAK")
        long_score += 12
    elif orb.get("nearOrb15"):
        setups.append("NEAR_ORB15")
        long_score += 6
    if orb.get("orbBreakDown30"):
        setups.append("ORB30_BREAKDOWN")
        short_score += 18
    if orb.get("orbBreakDown15"):
        setups.append("ORB15_BREAKDOWN")
        short_score += 12
    if pdh > 0 and 0 <= (pdh - ltp) / ltp * 100 <= 0.35 and change_pct > 0:
        setups.append("NEAR_PDH")
        long_score += 8
    if pdl > 0 and 0 <= (ltp - pdl) / ltp * 100 <= 0.35 and change_pct < 0:
        setups.append("NEAR_PDL")
        short_score += 8
    if high > low:
        close_pos = (ltp - low) / (high - low)
        if close_pos >= 0.78:
            long_score += 8
        elif close_pos <= 0.22:
            short_score += 8

    return {"setups": setups, "longScore": long_score, "shortScore": short_score}


def _choose_bias(change_pct: float, long_score: int, short_score: int) -> Bias:
    if long_score >= short_score + 8 and (long_score >= 18 or change_pct > 0.5):
        return "LONG"
    if short_score >= long_score + 8 and (short_score >= 18 or change_pct < -0.5):
        return "SHORT"
    if change_pct >= 1.4 and long_score >= 10:
        return "LONG"
    if change_pct <= -1.4 and short_score >= 10:
        return "SHORT"
    return "NEUTRAL"


def _score_candidate(change_pct: float, vol_ratio: float, r_factor: float, setup_info: dict[str, Any], bias: Bias) -> int:
    if bias == "NEUTRAL":
        return min(34, round(abs(change_pct) * 8 + max(vol_ratio - 1, 0) * 8 + max(r_factor - 1, 0) * 8))

    directional_setup_score = setup_info["longScore"] if bias == "LONG" else setup_info["shortScore"]
    momentum = min(abs(change_pct) * 8, 24)
    volume = min(max(vol_ratio - 0.7, 0) * 14, 22)
    range_score = min(max(r_factor - 0.6, 0) * 12, 18)
    score = directional_setup_score + momentum + volume + range_score
    return max(1, min(100, round(score)))


def _quality_label(
    score: int,
    bias: Bias,
    setups: list[str],
    freshness: dict[str, Any],
    stats: dict[str, float] | None,
) -> dict[str, str]:
    if bias == "NEUTRAL":
        return {"quality": "WATCH", "action": "WAIT"}
    if freshness["status"] != "fresh" or not stats:
        return {"quality": "DATA_CHECK", "action": "CONFIRM"}
    has_level_break = any(s in setups for s in ["PDH_BREAK", "PDL_BREAK", "ORB30_BREAK", "ORB30_BREAKDOWN"])
    has_vwap = any(s in setups for s in ["VWAP_HOLD", "VWAP_RECLAIM", "VWAP_REJECT", "VWAP_LOSS"])
    has_participation = "RVOL_EXPANSION" in setups or "RANGE_EXPANSION" in setups
    if score >= 82 and has_level_break and has_vwap and has_participation:
        return {"quality": "A_PLUS", "action": "ACTIONABLE"}
    if score >= 68 and has_level_break and (has_vwap or has_participation):
        return {"quality": "A", "action": "ACTIONABLE"}
    if score >= 50:
        return {"quality": "B", "action": "CONFIRM"}
    return {"quality": "WATCH", "action": "WAIT"}


def _levels_for_candidate(
    bias: Bias,
    ltp: float,
    high: float,
    low: float,
    open_: float,
    vwap: float,
    pdh: float,
    pdl: float,
    avg_range: float,
) -> dict[str, Any]:
    if bias == "NEUTRAL":
        return {
            "entry": round(ltp, 2),
            "stop": None,
            "target1": None,
            "target2": None,
            "riskReward": None,
            "invalidation": "Wait for directional confirmation above PDH/VWAP or below PDL/VWAP.",
        }

    buffer = max(ltp * 0.0015, (avg_range or ltp * 0.02) * 0.08)
    if bias == "LONG":
        supports = [x for x in [pdh, vwap, open_, low] if x and x < ltp]
        stop = max(supports) - buffer if supports else ltp - max(avg_range * 0.35, ltp * 0.008)
        risk = max(ltp - stop, ltp * 0.004)
        return {
            "entry": round(ltp, 2),
            "stop": round(stop, 2),
            "target1": round(ltp + risk * 1.5, 2),
            "target2": round(ltp + risk * 2.5, 2),
            "riskReward": 1.5,
            "invalidation": "Loses nearest support/VWAP with volume, or falls back below breakout level.",
        }

    resistances = [x for x in [pdl, vwap, open_, high] if x and x > ltp]
    stop = min(resistances) + buffer if resistances else ltp + max(avg_range * 0.35, ltp * 0.008)
    risk = max(stop - ltp, ltp * 0.004)
    return {
        "entry": round(ltp, 2),
        "stop": round(stop, 2),
        "target1": round(ltp - risk * 1.5, 2),
        "target2": round(ltp - risk * 2.5, 2),
        "riskReward": 1.5,
        "invalidation": "Reclaims nearest resistance/VWAP with volume, or moves back above breakdown level.",
    }


def _freshness(quote: dict[str, Any]) -> dict[str, Any]:
    ts = quote.get("exchange_timestamp") or quote.get("timestamp")
    timestamp_seconds = _timestamp_seconds(ts)
    if timestamp_seconds is not None:
        age = max(0, time.time() - timestamp_seconds)
        exchange_ts = datetime.fromtimestamp(timestamp_seconds, tz=settings.TIMEZONE)
        return {
            "status": "fresh" if age <= 180 else "stale",
            "ageSeconds": round(age),
            "exchangeTimestamp": exchange_ts.isoformat(),
        }
    return {"status": "unknown", "ageSeconds": None, "exchangeTimestamp": None}


def _timestamp_seconds(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if hasattr(value, "timestamp"):
        try:
            return float(value.timestamp())
        except (TypeError, ValueError, OSError):
            return None
    if isinstance(value, (int, float)):
        timestamp = float(value)
        return timestamp / 1000 if timestamp > 10_000_000_000 else timestamp
    if isinstance(value, str):
        clean = value.strip()
        if not clean:
            return None
        try:
            timestamp = float(clean)
            return timestamp / 1000 if timestamp > 10_000_000_000 else timestamp
        except ValueError:
            pass
        try:
            parsed = datetime.fromisoformat(clean.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=settings.TIMEZONE)
            return float(parsed.timestamp())
        except ValueError:
            return None
    return None


def _orb_status(symbol: str, ltp: float) -> dict[str, Any]:
    """Best-effort ORB status from the live detector, falling back to cache levels."""
    empty = {
        "nearOrb15": False,
        "orbBreak15": False,
        "nearOrb30": False,
        "orbBreak30": False,
        "orbBreakDown15": False,
        "orbBreakDown30": False,
        "orbHigh15": None,
        "orbLow15": None,
        "orbHigh30": None,
        "orbLow30": None,
    }
    try:
        from app.services.quote_service import get_orb_detector
        status = get_orb_detector().check_orb_status(symbol, ltp)
        if any([
            status.orb_high_15,
            status.orb_low_15,
            status.orb_high_30,
            status.orb_low_30,
            status.orb_break15,
            status.orb_break30,
            status.orb_break_down15,
            status.orb_break_down30,
        ]):
            return {
                "nearOrb15": status.near_orb15,
                "orbBreak15": status.orb_break15,
                "nearOrb30": status.near_orb30,
                "orbBreak30": status.orb_break30,
                "orbBreakDown15": status.orb_break_down15,
                "orbBreakDown30": status.orb_break_down30,
                "orbHigh15": status.orb_high_15,
                "orbLow15": status.orb_low_15,
                "orbHigh30": status.orb_high_30,
                "orbLow30": status.orb_low_30,
            }
    except Exception:
        pass

    try:
        from app.caches import orb_cache
        state = orb_cache.get_orb(symbol)
        if not state:
            return empty
        orb_high_15 = state.orb_high_15
        orb_low_15 = state.orb_low_15
        orb_high_30 = state.orb_high_30
        orb_low_30 = state.orb_low_30
        return {
            "nearOrb15": bool(orb_high_15 and orb_high_15 * 0.995 <= ltp < orb_high_15),
            "orbBreak15": bool(orb_high_15 and ltp >= orb_high_15),
            "nearOrb30": bool(orb_high_30 and orb_high_30 * 0.995 <= ltp < orb_high_30),
            "orbBreak30": bool(orb_high_30 and ltp >= orb_high_30),
            "orbBreakDown15": bool(orb_low_15 and ltp <= orb_low_15),
            "orbBreakDown30": bool(orb_low_30 and ltp <= orb_low_30),
            "orbHigh15": orb_high_15,
            "orbLow15": orb_low_15,
            "orbHigh30": orb_high_30,
            "orbLow30": orb_low_30,
        }
    except Exception:
        return empty


def _data_warnings(stats: dict[str, float] | None, freshness: dict[str, Any], vwap: float) -> list[str]:
    warnings: list[str] = []
    if not stats:
        warnings.append("Missing daily context")
    if freshness["status"] in {"stale", "unknown"}:
        warnings.append("Quote freshness not confirmed")
    if vwap <= 0:
        warnings.append("VWAP unavailable")
    return warnings


def _build_reasons(
    bias: Bias,
    setups: list[str],
    change_pct: float,
    vol_ratio: float,
    r_factor: float,
    vwap: float,
    pdh: float,
    pdl: float,
    freshness: dict[str, Any],
) -> list[str]:
    reasons: list[str] = []
    if bias != "NEUTRAL":
        reasons.append(f"{bias} bias from {', '.join(setups[:4]) or 'price action'} confirmation.")
    if abs(change_pct) >= 0.5:
        reasons.append(f"Price is {change_pct:+.2f}% versus previous close.")
    if vol_ratio >= 1.2:
        reasons.append(f"Relative volume is {vol_ratio:.1f}x.")
    if r_factor >= 1.0:
        reasons.append(f"Range expansion is {r_factor:.1f}x average.")
    if vwap > 0:
        side = "above" if bias == "LONG" else "below" if bias == "SHORT" else "near"
        reasons.append(f"Trading {side} VWAP proxy at {vwap:.2f}.")
    if "PDH_BREAK" in setups:
        reasons.append(f"Cleared previous day high {pdh:.2f}.")
    if "PDL_BREAK" in setups:
        reasons.append(f"Broke previous day low {pdl:.2f}.")
    if freshness["status"] != "fresh":
        reasons.append("Treat cautiously until live quote freshness is confirmed.")
    return reasons[:6]


def _classify_market_regime(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(candidates)
    if total == 0:
        return {"label": "no-data", "bias": "NEUTRAL", "confidence": 0, "notes": ["No live candidates."]}

    long_count = sum(1 for c in candidates if c["bias"] == "LONG")
    short_count = sum(1 for c in candidates if c["bias"] == "SHORT")
    advancing = sum(1 for c in candidates if c["changePct"] > 0.05)
    declining = sum(1 for c in candidates if c["changePct"] < -0.05)
    avg_change = sum(c["changePct"] for c in candidates) / total
    high_rvol = sum(1 for c in candidates if c["volRatio"] >= 1.5)
    breadth = round((advancing / total) * 100)
    trend_balance = (long_count - short_count) / max(long_count + short_count, 1)

    if breadth >= 62 and avg_change > 0.25 and trend_balance > 0.25:
        label, bias = "bullish trend", "LONG"
    elif breadth <= 38 and avg_change < -0.25 and trend_balance < -0.25:
        label, bias = "bearish trend", "SHORT"
    elif high_rvol >= max(8, total * 0.12) and abs(avg_change) > 0.15:
        label, bias = "high participation momentum", "LONG" if avg_change > 0 else "SHORT"
    else:
        label, bias = "mixed or range-bound", "NEUTRAL"

    confidence = min(100, round(abs(breadth - 50) * 1.4 + abs(avg_change) * 10 + high_rvol / total * 40))
    return {
        "label": label,
        "bias": bias,
        "confidence": confidence,
        "breadthPct": breadth,
        "advancing": advancing,
        "declining": declining,
        "avgChangePct": round(avg_change, 2),
        "highRvolCount": high_rvol,
        "notes": _regime_notes(label, breadth, avg_change, high_rvol),
    }


def _sector_leadership(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sectors: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        sector = candidate.get("sector") or "Others"
        bucket = sectors.setdefault(
            sector,
            {
                "name": sector,
                "count": 0,
                "long": 0,
                "short": 0,
                "neutral": 0,
                "totalChangePct": 0.0,
                "totalScore": 0.0,
                "highRvol": 0,
                "topStocks": [],
            },
        )
        bucket["count"] += 1
        bucket["totalChangePct"] += candidate["changePct"]
        bucket["totalScore"] += candidate["score"]
        bucket["highRvol"] += 1 if candidate["volRatio"] >= 1.5 else 0
        key = candidate["bias"].lower()
        bucket[key] += 1
        bucket["topStocks"].append(
            {
                "symbol": candidate["symbol"],
                "bias": candidate["bias"],
                "score": candidate["score"],
                "changePct": candidate["changePct"],
            }
        )

    leadership: list[dict[str, Any]] = []
    for sector in sectors.values():
        count = sector["count"]
        directional = sector["long"] - sector["short"]
        leadership_score = (
            abs(directional) / count * 40
            + abs(sector["totalChangePct"] / count) * 8
            + sector["highRvol"] / count * 25
            + sector["totalScore"] / count * 0.25
        )
        top_stocks = sorted(sector["topStocks"], key=lambda s: s["score"], reverse=True)[:5]
        leadership.append(
            {
                "name": sector["name"],
                "count": count,
                "bias": "LONG" if directional > 0 else "SHORT" if directional < 0 else "NEUTRAL",
                "long": sector["long"],
                "short": sector["short"],
                "neutral": sector["neutral"],
                "avgChangePct": round(sector["totalChangePct"] / count, 2),
                "avgScore": round(sector["totalScore"] / count, 1),
                "highRvol": sector["highRvol"],
                "leadershipScore": round(leadership_score, 1),
                "topStocks": top_stocks,
            }
        )

    return sorted(leadership, key=lambda s: s["leadershipScore"], reverse=True)[:12]


def _regime_notes(label: str, breadth: int, avg_change: float, high_rvol: int) -> list[str]:
    notes = [f"Breadth is {breadth}% with average move {avg_change:+.2f}%."]
    if high_rvol:
        notes.append(f"{high_rvol} stocks show 1.5x+ relative volume.")
    if "range-bound" in label:
        notes.append("Prefer only clean level breaks; fade weak signals faster.")
    return notes


def _apply_regime_adjustment(candidate: dict[str, Any], regime: dict[str, Any]) -> dict[str, Any]:
    adjusted = dict(candidate)
    bias = adjusted["bias"]
    regime_bias = regime.get("bias")
    if bias != "NEUTRAL" and regime_bias == bias:
        adjusted["score"] = min(100, adjusted["score"] + 6)
        adjusted["reasons"] = adjusted["reasons"] + ["Aligned with market regime."]
    elif bias != "NEUTRAL" and regime_bias != "NEUTRAL" and regime_bias != bias:
        adjusted["score"] = max(1, adjusted["score"] - 8)
        adjusted["reasons"] = adjusted["reasons"] + ["Counter-regime signal; size down or demand confirmation."]
    return adjusted


def _build_summary(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "total": len(candidates),
        "long": sum(1 for c in candidates if c["bias"] == "LONG"),
        "short": sum(1 for c in candidates if c["bias"] == "SHORT"),
        "neutral": sum(1 for c in candidates if c["bias"] == "NEUTRAL"),
        "actionable": sum(1 for c in candidates if c["bias"] != "NEUTRAL" and c["score"] >= 35),
        "avgScore": round(sum(c["score"] for c in candidates) / len(candidates), 1) if candidates else 0,
    }


def _data_quality(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "fresh": sum(1 for c in candidates if c["freshness"]["status"] == "fresh"),
        "stale": sum(1 for c in candidates if c["freshness"]["status"] == "stale"),
        "unknown": sum(1 for c in candidates if c["freshness"]["status"] == "unknown"),
        "missingStats": sum(1 for c in candidates if "Missing daily context" in c["dataWarnings"]),
    }


def _log_actionable_radar_fires(candidates: list[dict[str, Any]], regime: dict[str, Any]) -> None:
    """Persist strongest radar fires for outcome tracking, best effort."""
    if not candidates:
        return
    try:
        from app.core.session_cache import is_market_hours
        if not is_market_hours():
            return
    except Exception:
        pass
    try:
        from app.services.signal_validator import compute_market_context, log_signal_fire
    except Exception:
        return

    base_context = compute_market_context()
    base_context["intraday_regime"] = regime

    for candidate in candidates:
        if candidate["score"] < 65 or candidate["bias"] not in {"LONG", "SHORT"}:
            continue
        try:
            direction = "BULLISH" if candidate["bias"] == "LONG" else "BEARISH"
            signal_type = f"INTRADAY_RADAR_{candidate['bias']}"
            log_signal_fire(
                symbol=candidate["symbol"],
                signal_type=signal_type,
                trigger_price=candidate["ltp"],
                strength=float(candidate["score"]),
                direction=direction,
                confidence="STRONG" if candidate["score"] >= 80 else "MODERATE",
                category="stock",
                metadata={
                    "setups": candidate["setups"],
                    "entry": candidate["entry"],
                    "stop": candidate["stop"],
                    "target1": candidate["target1"],
                    "target2": candidate["target2"],
                    "change_pct": candidate["changePct"],
                    "vol_ratio": candidate["volRatio"],
                    "r_factor": candidate["rFactor"],
                    "vwap": candidate["vwap"],
                    "pdh": candidate["pdh"],
                    "pdl": candidate["pdl"],
                    "sector": candidate["sector"],
                },
                context=base_context,
            )
        except Exception:
            logger.debug("[intraday-radar] signal fire log failed for %s", candidate["symbol"], exc_info=True)


def _sector_for(symbol: str) -> str:
    try:
        from app.routes.market import SECTOR_MAP
        return SECTOR_MAP.get(symbol, "Others")
    except Exception:
        return "Others"
