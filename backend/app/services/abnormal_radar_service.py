"""Live abnormal momentum radar data assembly.

This service keeps the Abnormal Moves route fast by doing one backend quote
fan-out, enriching quotes from local caches, and then reusing the transparent
10-point scoring engine.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import asdict
from typing import Any

from kiteconnect import KiteConnect

from app.engines.abnormal_momentum import apply_filters, score_rows
from app.routes.market import SECTOR_MAP
from app.services import arrow_market_data_service as arrow

logger = logging.getLogger("alpha_radar.services.abnormal_radar")

_RESPONSE_CACHE_TTL_S = 30
_QUOTE_CACHE_TTL_S = 18
_MAX_SYMBOLS = 500

_response_cache: dict[str, dict[str, Any]] = {}
_quote_cache: dict[str, Any] = {"ts": 0.0, "key": "", "data": {}, "meta": {}}

MOMENTUM_WATCH = [
    "NETWEB",
    "DATAPATTNS",
    "KAYNES",
    "PGEL",
    "ZENTEC",
    "IDEAFORGE",
    "TITAGARH",
    "BEML",
    "COCHINSHIP",
    "MAZDOCK",
    "OLECTRA",
    "TEJASNET",
]


async def build_live_abnormal_radar(
    kite: KiteConnect,
    *,
    symbols: list[str] | None = None,
    filters: dict[str, Any] | None = None,
    quote_provider: str = "arrow_first",
    use_cache: bool = True,
) -> dict[str, Any]:
    """Build a live abnormal-momentum response from current market quotes."""
    clean_symbols = _symbols_for_live_scan(symbols)
    if not clean_symbols:
        return _empty_live_response("No live universe configured.")

    cache_key = _cache_key(clean_symbols, filters or {}, quote_provider)
    if use_cache:
        cached = _get_response_cache(cache_key)
        if cached:
            return cached

    started = time.perf_counter()
    quote_map, provider_meta = await _fetch_quotes(kite, clean_symbols, quote_provider)
    rows, data_quality = _rows_from_quotes(clean_symbols, quote_map)
    scored = score_rows(rows)
    try:
        from app.engines.runner.context import runner_context

        runner_context.ingest_rows(
            [asdict(item) for item in scored],
            score_field="alpha_score",
            target_field="abnormal_score",
        )
    except Exception:
        logger.debug("Runner abnormal-score join skipped", exc_info=True)
    effective_filters = filters or {}
    filtered = apply_filters(scored, effective_filters)
    warnings: list[str] = []

    filter_meta: dict[str, Any] = {"relaxedVolumeFilter": False}
    min_volume = _to_float(effective_filters.get("minVolumeSpike"), 1)
    if not filtered and scored and min_volume > 1 and data_quality["avgVolumeCoveragePct"] < 20:
        relaxed_filters = {**effective_filters, "minVolumeSpike": 1}
        relaxed = apply_filters(scored, relaxed_filters)
        if relaxed:
            filtered = relaxed
            filter_meta = {
                "relaxedVolumeFilter": True,
                "requestedMinVolumeSpike": min_volume,
                "effectiveMinVolumeSpike": 1,
            }
            warnings.append(
                "Average-volume cache is still cold, so this scan relaxed Min Vol x to 1.0. Treat volume confirmation as pending."
            )

    response = {
        "success": True,
        "source": "live",
        "count": len(filtered),
        "totalScored": len(scored),
        "results": filtered,
        "summary": {
            "cleanMomentum": sum(1 for item in filtered if item.risk_flag == "Clean Momentum"),
            "watchCarefully": sum(1 for item in filtered if item.risk_flag == "Watch Carefully"),
            "avoid": sum(1 for item in filtered if item.risk_flag.startswith("Avoid")),
            "avgScore": round(sum(item.alpha_score for item in filtered) / len(filtered), 2) if filtered else 0,
        },
        "meta": {
            "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            "disclaimer": "Screening and risk tool only. Not investment advice and not a manipulation detector.",
            "provider": provider_meta,
            "universe": {
                "requested": len(clean_symbols),
                "quoted": len(quote_map),
                "scored": len(scored),
            },
            "dataQuality": data_quality,
            "filters": filter_meta,
            "cache": {"hit": False, "ttlSeconds": _RESPONSE_CACHE_TTL_S},
            "warning": " ".join(warnings) or None,
        },
    }
    _set_response_cache(cache_key, response)
    return _serialize_response(response)


def _symbols_for_live_scan(symbols: list[str] | None) -> list[str]:
    if symbols:
        raw_symbols = symbols
    else:
        try:
            from app.caches import stock_universes

            raw_symbols = list(stock_universes.NIFTY500_STOCKS)
        except Exception:
            raw_symbols = list(SECTOR_MAP.keys())

    try:
        from app.caches.stock_universes import RECENT_IPO_WATCH_STOCKS
    except Exception:
        RECENT_IPO_WATCH_STOCKS = []

    seen: set[str] = set()
    clean: list[str] = []
    for symbol in [*MOMENTUM_WATCH, *RECENT_IPO_WATCH_STOCKS, *raw_symbols]:
        s = str(symbol).strip().upper()
        if not s or s in seen:
            continue
        seen.add(s)
        clean.append(s)
        if len(clean) >= _MAX_SYMBOLS:
            break
    return clean


def _cache_key(symbols: list[str], filters: dict[str, Any], provider: str) -> str:
    raw = ",".join(symbols) + f"|provider={provider}|filters={sorted(filters.items())}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _get_response_cache(cache_key: str) -> dict[str, Any] | None:
    cached = _response_cache.get(cache_key)
    if not cached:
        return None
    age = time.time() - float(cached["ts"])
    if age > _RESPONSE_CACHE_TTL_S:
        return None
    data = _serialize_response(cached["data"])
    data["cached"] = True
    data["cachedAgeSeconds"] = round(age, 1)
    data["meta"] = {
        **data.get("meta", {}),
        "cache": {"hit": True, "ageSeconds": round(age, 1), "ttlSeconds": _RESPONSE_CACHE_TTL_S},
    }
    return data


def _set_response_cache(cache_key: str, response: dict[str, Any]) -> None:
    _response_cache[cache_key] = {"ts": time.time(), "data": response}


async def _fetch_quotes(
    kite: KiteConnect,
    symbols: list[str],
    quote_provider: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    provider = quote_provider if quote_provider in {"arrow_first", "arrow", "kite"} else "arrow_first"
    quote_key = ",".join(symbols) + f"|{provider}"
    if _quote_cache["key"] == quote_key and time.time() - float(_quote_cache["ts"]) < _QUOTE_CACHE_TTL_S:
        return dict(_quote_cache["data"]), {**_quote_cache["meta"], "quoteCacheHit": True}

    quote_map: dict[str, Any] = {}
    meta: dict[str, Any] = {"provider": "kite", "requested": len(symbols), "returned": 0, "fallback": False}

    if provider in {"arrow_first", "arrow"}:
        try:
            arrow_quotes = await arrow.fetch_quotes(symbols, exchange="NSE", mode="ohlcv")
            arrow_meta = arrow_quotes.pop("_meta", {})
            quote_map = arrow_quotes
            meta = {
                "provider": "arrow",
                "requested": len(symbols),
                "returned": len(quote_map),
                "elapsedMs": arrow_meta.get("elapsedMs"),
                "mode": arrow_meta.get("mode", "ohlcv"),
                "partial": bool(arrow_meta.get("partial")),
                "missing": max(0, len(symbols) - len(quote_map)),
                "errors": arrow_meta.get("errors", []),
                "fallback": False,
            }
            min_usable = max(1, int(len(symbols) * 0.25))
            if len(quote_map) < min_usable and provider == "arrow_first":
                meta = {
                    "provider": "kite",
                    "requested": len(symbols),
                    "returned": len(quote_map),
                    "fallback": True,
                    "fallbackReason": f"Arrow returned {len(quote_map)}/{len(symbols)} quotes",
                }
                quote_map = {}
        except Exception as exc:
            if provider == "arrow":
                raise
            logger.warning("[abnormal-radar] Arrow quote fetch failed; falling back to Kite: %s", exc)
            meta = {
                "provider": "kite",
                "requested": len(symbols),
                "returned": 0,
                "fallback": True,
                "fallbackReason": str(getattr(exc, "detail", exc))[:180],
            }

    if not quote_map:
        quote_map = await asyncio.to_thread(_fetch_kite_quotes, kite, symbols)
        meta = {**meta, "provider": "kite", "returned": len(quote_map)}

    _quote_cache.update({"ts": time.time(), "key": quote_key, "data": quote_map, "meta": meta})
    return dict(quote_map), meta


def _fetch_kite_quotes(kite: KiteConnect, symbols: list[str]) -> dict[str, Any]:
    all_quotes: dict[str, Any] = {}
    kite_symbols = [f"NSE:{symbol}" for symbol in symbols]
    for idx in range(0, len(kite_symbols), 400):
        batch = kite_symbols[idx : idx + 400]
        try:
            all_quotes.update(kite.quote(batch))
        except Exception:
            logger.warning("[abnormal-radar] Kite quote batch failed %d-%d", idx, idx + len(batch))
    return all_quotes


def _rows_from_quotes(symbols: list[str], quote_map: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        from app.caches import avg_volume_cache, delivery_cache, pdh_pdl_cache
        if hasattr(avg_volume_cache, "restore_from_disk"):
            avg_volume_cache.restore_from_disk()
    except Exception:
        avg_volume_cache = delivery_cache = pdh_pdl_cache = None  # type: ignore[assignment]

    rows: list[dict[str, Any]] = []
    avg_volume_hits = 0
    delivery_hits = 0
    pdh_hits = 0
    for symbol in symbols:
        quote = quote_map.get(f"NSE:{symbol}")
        if not quote:
            continue
        ltp = float(quote.get("last_price") or 0)
        if ltp <= 0:
            continue
        ohlc = quote.get("ohlc", {}) or {}
        prev_close = float(ohlc.get("close") or ltp)
        volume = float(quote.get("volume") or 0)
        avg_volume_value = _cache_value(avg_volume_cache, "get_avg_volume", symbol)
        avg_volume = avg_volume_value or volume
        delivery_pct = _cache_value(delivery_cache, "get_delivery_pct", symbol)
        pdh = _cache_value(pdh_pdl_cache, "get_pdh", symbol)
        if avg_volume_value and avg_volume_value > 0:
            avg_volume_hits += 1
        if delivery_pct is not None:
            delivery_hits += 1
        if pdh is not None:
            pdh_hits += 1

        rows.append({
            "symbol": symbol,
            "last_price": ltp,
            "prev_close": prev_close,
            "volume": volume,
            "avg_volume20": avg_volume,
            "delivery_pct": delivery_pct,
            "pdh": pdh,
            "sector": SECTOR_MAP.get(symbol, "Others"),
            "sector_change_pct": 0,
            "market_cap_bucket": _bucket_for(symbol),
            "turnover_lakh": (volume * ltp) / 100000 if ltp > 0 else 0,
            "asm_gsm": False,
            "trade_to_trade": False,
            "circuit_hit": _circuit_hit(quote, ltp),
        })

    total = len(rows) or 1
    return rows, {
        "avgVolumeCoveragePct": round((avg_volume_hits / total) * 100, 1),
        "deliveryCoveragePct": round((delivery_hits / total) * 100, 1),
        "pdhCoveragePct": round((pdh_hits / total) * 100, 1),
        "avgVolumeHits": avg_volume_hits,
        "deliveryHits": delivery_hits,
        "pdhHits": pdh_hits,
    }


def _cache_value(cache_module: Any, fn_name: str, symbol: str) -> float | None:
    if not cache_module:
        return None
    try:
        fn = getattr(cache_module, fn_name)
        value = fn(symbol)
        return float(value) if value is not None else None
    except Exception:
        return None


def _bucket_for(symbol: str) -> str:
    if symbol in {"RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "SBIN", "BHARTIARTL", "LT"}:
        return "large"
    if symbol in SECTOR_MAP:
        return "mid"
    return "small"


def _circuit_hit(quote: dict[str, Any], ltp: float) -> bool:
    lower = float(quote.get("lower_circuit_limit") or 0)
    upper = float(quote.get("upper_circuit_limit") or 0)
    return bool((upper and ltp >= upper) or (lower and ltp <= lower))


def _to_float(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _empty_live_response(message: str) -> dict[str, Any]:
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
            "warning": message,
        },
    }


def _serialize_response(response: dict[str, Any]) -> dict[str, Any]:
    return {
        **response,
        "results": [
            _serialize_result(item) if hasattr(item, "score_breakdown") else item
            for item in response.get("results", [])
        ],
    }


def _serialize_result(result: Any) -> dict[str, Any]:
    data = asdict(result)
    data["score_breakdown"] = asdict(result.score_breakdown)
    return data
