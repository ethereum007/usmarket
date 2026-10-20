"""
Scanner Service -- orchestrates scanner routes for CPR, patterns, VCP,
NR squeeze, volume profile, and swing detection.

Each scanner function:
1. Resolves instrument tokens for the requested symbols
2. Fetches historical OHLC from Kite in batches with rate limiting
3. Passes data to the corresponding CPR engine module
4. Returns scored/sorted results

All functions handle Kite API rate limiting (350-400ms between batch calls)
and skip symbols that fail individually.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

import pandas as pd
from kiteconnect import KiteConnect

from app.caches import instrument_cache
from app.config import settings

# CPR engine imports
from app.engines.cpr.signal_scorer import score_symbol, SignalResult
from app.engines.cpr.cpr_calculator import get_cpr_analysis, CPRSequenceResult
from app.engines.cpr.pema_calculator import compute_pema, PEMAResult
from app.engines.cpr.pattern_detector import scan_patterns as _scan_patterns, PatternResult as EnginePatternResult
from app.engines.cpr.vcp_detector import analyze_vcp, VCPResult as EngineVCPResult
from app.engines.cpr.nr_squeeze import analyze_nr_squeeze, NRSqueezeResult
from app.engines.cpr.volume_profile import analyze_volume_profile, VolumeProfileResult as EngineVolumeProfileResult
from app.engines.cpr.swing_detector import scan_swing_spectrum, SwingSignal as EngineSwingSignal

logger = logging.getLogger("alpha_radar.services.scanner")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_HISTORICAL_BATCH_DELAY_S = 0.38   # ~380ms between individual historical calls
_KITE_MAX_RETRIES = 1


# ---------------------------------------------------------------------------
# Helpers: token resolution + OHLC fetching
# ---------------------------------------------------------------------------


def _resolve_tokens(symbols: list[str], kite: KiteConnect | None = None) -> dict[str, int]:
    """
    Resolve NSE instrument tokens for a list of symbols using the
    instrument cache.

    Returns a symbol -> token mapping (only for symbols found).
    """
    all_tokens = instrument_cache.get_all_tokens()
    if not all_tokens and kite is not None:
        try:
            loaded = instrument_cache.load_instruments(kite)
            logger.info("Instrument cache warmed for scanner service: %d instruments", loaded)
            all_tokens = instrument_cache.get_all_tokens()
        except Exception:
            logger.exception("Scanner service could not warm instrument cache")

    return {s: all_tokens[s] for s in symbols if s in all_tokens}


async def _fetch_historical(
    kite: KiteConnect,
    token: int,
    interval: str,
    from_date: str,
    to_date: str,
) -> list[dict]:
    """
    Fetch historical OHLC candles from Kite (blocking call run in thread).

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    token : int
        Instrument token.
    interval : str
        Kite interval string: ``"day"``, ``"15minute"``, ``"60minute"``,
        ``"week"``, ``"month"``.
    from_date : str
        Start date (YYYY-MM-DD).
    to_date : str
        End date (YYYY-MM-DD).

    Returns
    -------
    list[dict]
        List of candle dicts with keys: date, open, high, low, close, volume.
    """
    return await asyncio.to_thread(
        kite.historical_data,
        instrument_token=token,
        from_date=from_date,
        to_date=to_date,
        interval=interval,
    )


def _candles_to_df(candles: list[dict]) -> pd.DataFrame:
    """
    Convert a list of Kite candle dicts to a pandas DataFrame.

    Ensures columns: date, open, high, low, close, volume.
    """
    if not candles:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])
    df = pd.DataFrame(candles)
    for col in ["date", "open", "high", "low", "close", "volume"]:
        if col not in df.columns:
            df[col] = 0
    return df


async def _fetch_live_quotes(kite: KiteConnect, symbols: list[str]) -> dict[str, dict]:
    if not symbols:
        return {}
    try:
        quotes = await asyncio.to_thread(kite.quote, [f"NSE:{symbol}" for symbol in symbols])
        return quotes if isinstance(quotes, dict) else {}
    except Exception:
        logger.debug("Live quote fetch failed for swing scan", exc_info=True)
        return {}


def _as_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _merge_live_daily_candle(df: pd.DataFrame, quote: dict | None, now: datetime | None = None) -> pd.DataFrame:
    """Merge a live quote into the daily series so server warm scans catch intraday moves."""
    if df.empty or not quote:
        return df

    observed_at = now or _today()
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=settings.TIMEZONE)
    observed_at = observed_at.astimezone(settings.TIMEZONE)
    if (observed_at.weekday() >= 5
            or observed_at.date().isoformat() in settings.MARKET_HOLIDAYS
            or observed_at.time() < settings.MARKET_OPEN
            or observed_at.time() > settings.MARKET_CLOSE):
        return df
    # Receipt time alone does not establish the session of a cached quote.
    raw_timestamp = quote.get("timestamp")
    try:
        quote_time = pd.Timestamp(raw_timestamp) if raw_timestamp is not None else pd.NaT
        if pd.isna(quote_time):
            return df
        if quote_time.tzinfo is None:
            quote_time = quote_time.tz_localize(settings.TIMEZONE)
        quote_time = quote_time.tz_convert(settings.TIMEZONE)
        age = (observed_at - quote_time.to_pydatetime()).total_seconds()
        if quote_time.date() != observed_at.date() or not 0 <= age <= 90:
            return df
    except (TypeError, ValueError):
        return df

    ohlc = quote.get("ohlc") or {}
    ltp = _as_float(quote.get("last_price"))
    open_ = _as_float(ohlc.get("open"))
    if not ltp or not open_:
        return df

    high = max(_as_float(ohlc.get("high")) or ltp, ltp)
    low = min(_as_float(ohlc.get("low")) or ltp, ltp)
    volume = int(_as_float(quote.get("volume")) or 0)
    today = observed_at.date()
    live_date = observed_at

    merged = df.copy()
    last_idx = merged.index[-1]
    parsed_dates = pd.to_datetime(merged.get("date"), errors="coerce") if "date" in merged.columns else pd.Series(dtype="datetime64[ns]")
    last_date = parsed_dates.iloc[-1].date() if len(parsed_dates) and not pd.isna(parsed_dates.iloc[-1]) else None
    if last_date is None or last_date > today:
        return df

    if last_date == today:
        existing_open = _as_float(merged.at[last_idx, "open"]) or open_
        existing_high = _as_float(merged.at[last_idx, "high"]) or high
        existing_low = _as_float(merged.at[last_idx, "low"]) or low
        existing_volume = int(_as_float(merged.at[last_idx, "volume"]) or 0)
        merged.at[last_idx, "open"] = existing_open
        merged.at[last_idx, "high"] = max(existing_high, high)
        merged.at[last_idx, "low"] = min(existing_low, low)
        merged.at[last_idx, "close"] = ltp
        merged.at[last_idx, "volume"] = max(existing_volume, volume)
        return merged

    live_row = pd.DataFrame(
        [
            {
                "date": live_date,
                "open": open_,
                "high": high,
                "low": low,
                "close": ltp,
                "volume": volume,
            }
        ]
    )
    return pd.concat([merged, live_row], ignore_index=True)


def _date_str(dt: datetime) -> str:
    """Format datetime to YYYY-MM-DD string."""
    return dt.strftime("%Y-%m-%d")


def _today() -> datetime:
    return datetime.now(settings.TIMEZONE)


# ---------------------------------------------------------------------------
# CPR Scanner
# ---------------------------------------------------------------------------


async def scan_cpr(
    kite: KiteConnect,
    symbols: list[str],
    capital: float = 10_000_000,
) -> list[dict]:
    """
    Scan symbols using the multi-timeframe CPR + PEMA scoring system.

    For each symbol, fetches:
    - Monthly OHLC (24 bars)
    - Weekly OHLC (60 bars)
    - Daily OHLC (120 bars)
    - Intraday 15-minute OHLC (200 bars)

    Then computes CPR sequences, PEMA stacks, and scores each.

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    symbols : list[str]
        NSE symbols to scan.
    capital : float
        Capital for position sizing (default 1Cr).

    Returns
    -------
    list[dict]
        Scored CPR results sorted by total_score descending.
        Only includes symbols with alert_tier != "None".
    """
    token_map = _resolve_tokens(symbols, kite)
    today = _today()
    to_date = _date_str(today)

    results: list[dict] = []

    for symbol in symbols:
        token = token_map.get(symbol)
        if not token:
            continue

        try:
            # Fetch all timeframes concurrently
            monthly_task = _fetch_historical(
                kite, token, "month",
                _date_str(today - timedelta(days=24 * 30)),
                to_date,
            )
            weekly_task = _fetch_historical(
                kite, token, "week",
                _date_str(today - timedelta(days=60 * 7)),
                to_date,
            )
            daily_task = _fetch_historical(
                kite, token, "day",
                _date_str(today - timedelta(days=180)),
                to_date,
            )
            intraday_task = _fetch_historical(
                kite, token, "15minute",
                _date_str(today - timedelta(days=5)),
                to_date,
            )

            monthly_candles, weekly_candles, daily_candles, intraday_candles = (
                await asyncio.gather(
                    monthly_task, weekly_task, daily_task, intraday_task,
                    return_exceptions=True,
                )
            )

            # Skip if any fetch raised an exception
            if isinstance(monthly_candles, Exception):
                monthly_candles = []
            if isinstance(weekly_candles, Exception):
                weekly_candles = []
            if isinstance(daily_candles, Exception):
                daily_candles = []
            if isinstance(intraday_candles, Exception):
                intraday_candles = []

            monthly_df = _candles_to_df(monthly_candles)
            weekly_df = _candles_to_df(weekly_candles)
            daily_df = _candles_to_df(daily_candles)
            intraday_df = _candles_to_df(intraday_candles)

            if daily_df.empty:
                continue

            current_price = float(daily_df["close"].iloc[-1])

            # Compute CPR sequences (get_cpr_analysis returns levels + sequence)
            _, monthly_seq = get_cpr_analysis(monthly_df)
            _, weekly_seq = get_cpr_analysis(weekly_df)
            _, daily_seq = get_cpr_analysis(daily_df)
            _, intraday_seq = get_cpr_analysis(intraday_df)

            # Compute PEMA (requires df + current_price)
            monthly_pema = compute_pema(monthly_df, current_price)
            weekly_pema = compute_pema(weekly_df, current_price)
            daily_pema = compute_pema(daily_df, current_price)
            intraday_pema = compute_pema(intraday_df, current_price)

            # 15-min trigger placeholder (would need real-time detection)
            trigger_15min = {"triggered": False, "trigger_type": None}

            signal_result: SignalResult = score_symbol(
                symbol=symbol,
                current_price=current_price,
                monthly_seq=monthly_seq,
                weekly_seq=weekly_seq,
                daily_seq=daily_seq,
                intraday_seq=intraday_seq,
                monthly_pema=monthly_pema,
                weekly_pema=weekly_pema,
                daily_pema=daily_pema,
                intraday_pema=intraday_pema,
                trigger_15min=trigger_15min,
                capital=capital,
            )

            if signal_result.alert_tier.value != "None":
                results.append(_signal_result_to_dict(signal_result))

        except Exception:
            logger.debug("CPR scan failed for %s", symbol, exc_info=True)

        # Rate limit between symbols
        await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    results.sort(key=lambda r: r.get("totalScore", 0), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Pattern Scanner
# ---------------------------------------------------------------------------


async def scan_patterns_service(
    kite: KiteConnect,
    symbols: list[str],
) -> list[dict]:
    """
    Scan symbols for chart patterns (triangles, H&S, flags, etc.).

    Fetches 120 days of daily OHLC per symbol and runs pattern detection.

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    symbols : list[str]
        NSE symbols to scan.

    Returns
    -------
    list[dict]
        Pattern results grouped by symbol.
    """
    token_map = _resolve_tokens(symbols, kite)
    today = _today()
    to_date = _date_str(today)
    from_date = _date_str(today - timedelta(days=180))

    results: list[dict] = []

    for symbol in symbols:
        token = token_map.get(symbol)
        if not token:
            continue

        try:
            candles = await _fetch_historical(kite, token, "day", from_date, to_date)
            df = _candles_to_df(candles)

            if len(df) < 20:
                continue

            patterns: list[EnginePatternResult] = _scan_patterns(df)
            if patterns:
                results.append({
                    "symbol": symbol,
                    "patterns": [
                        {
                            "pattern": p.pattern.value,
                            "confidence": p.confidence,
                            "direction": p.direction.value,
                            "entryPrice": round(p.entry_price, 2),
                            "stopLoss": round(p.stop_loss, 2),
                            "target": round(p.target, 2),
                            "riskReward": round(p.risk_reward, 2),
                            "notes": p.notes,
                        }
                        for p in patterns
                    ],
                    "timeframe": "daily",
                })
        except Exception:
            logger.debug("Pattern scan failed for %s", symbol, exc_info=True)

        await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    return results


# ---------------------------------------------------------------------------
# VCP Scanner
# ---------------------------------------------------------------------------


async def scan_vcp(
    kite: KiteConnect,
    symbols: list[str],
) -> list[dict]:
    """
    Scan for Volatility Contraction Patterns (Mark Minervini method).

    Fetches 250 days of daily OHLC per symbol + NIFTY 50 for relative
    strength comparison.

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    symbols : list[str]
        NSE symbols to scan.

    Returns
    -------
    list[dict]
        VCP results sorted by vcp_score descending.
    """
    token_map = _resolve_tokens(symbols, kite)
    today = _today()
    to_date = _date_str(today)
    from_date = _date_str(today - timedelta(days=365))

    # Fetch index data for RS comparison
    nifty_token = 256265  # NIFTY 50 instrument token
    index_change_pct = 0.0
    try:
        nifty_candles = await _fetch_historical(
            kite, nifty_token, "day", from_date, to_date
        )
        if len(nifty_candles) >= 2:
            first_close = nifty_candles[0].get("close", 0)
            last_close = nifty_candles[-1].get("close", 0)
            if first_close > 0:
                index_change_pct = ((last_close - first_close) / first_close) * 100
    except Exception:
        logger.debug("Failed to fetch NIFTY data for RS comparison")

    await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    results: list[dict] = []

    for symbol in symbols:
        token = token_map.get(symbol)
        if not token:
            continue

        try:
            candles = await _fetch_historical(kite, token, "day", from_date, to_date)
            df = _candles_to_df(candles)

            if len(df) < 50:
                continue

            vcp: EngineVCPResult = analyze_vcp(
                df=df,
                symbol=symbol,
                index_change_pct=index_change_pct,
            )

            if vcp.vcp_detected or vcp.trend_template_pass:
                results.append({
                    "symbol": vcp.symbol,
                    "currentPrice": round(vcp.current_price, 2),
                    "vcpDetected": vcp.vcp_detected,
                    "trendTemplatePass": vcp.trend_template_pass,
                    "numContractions": vcp.num_contractions,
                    "volumeDeclining": vcp.volume_declining,
                    "tightening": vcp.tightening,
                    "pivotPrice": round(vcp.pivot_price, 2),
                    "pivotDistancePct": round(vcp.pivot_distance_pct, 2),
                    "rsVsIndex": round(vcp.rs_vs_index, 2),
                    "vcpScore": vcp.vcp_score,
                    "stage": vcp.stage,
                    "notes": vcp.notes,
                    "priceAbove150ma": vcp.price_above_150ma,
                    "priceAbove200ma": vcp.price_above_200ma,
                    "pctFrom52wHigh": round(vcp.pct_from_52w_high, 2),
                    "pctFrom52wLow": round(vcp.pct_from_52w_low, 2),
                })
        except Exception:
            logger.debug("VCP scan failed for %s", symbol, exc_info=True)

        await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    results.sort(key=lambda r: r.get("vcpScore", 0), reverse=True)
    return results


# ---------------------------------------------------------------------------
# NR / Squeeze Scanner
# ---------------------------------------------------------------------------


async def scan_nr_squeeze(
    kite: KiteConnect,
    symbols: list[str],
) -> list[dict]:
    """
    Scan for NR4/NR7 narrow-range squeeze setups.

    Fetches 20 days of daily OHLC per symbol.

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    symbols : list[str]
        NSE symbols to scan.

    Returns
    -------
    list[dict]
        NR squeeze results (only symbols with NR4/NR7/inside bar detected),
        sorted by squeeze_score descending.
    """
    token_map = _resolve_tokens(symbols, kite)
    today = _today()
    to_date = _date_str(today)
    from_date = _date_str(today - timedelta(days=35))  # Extra buffer for 20 bars

    results: list[dict] = []

    for symbol in symbols:
        token = token_map.get(symbol)
        if not token:
            continue

        try:
            candles = await _fetch_historical(kite, token, "day", from_date, to_date)
            df = _candles_to_df(candles)

            if len(df) < 20:
                continue

            nr: NRSqueezeResult = analyze_nr_squeeze(df, symbol)

            if nr.is_nr4 or nr.is_nr7 or nr.is_inside_bar:
                results.append({
                    "symbol": nr.symbol,
                    "currentPrice": round(nr.current_price, 2),
                    "isNR4": nr.is_nr4,
                    "isNR7": nr.is_nr7,
                    "isInsideBar": nr.is_inside_bar,
                    "nrBarHigh": round(nr.nr_bar_high, 2),
                    "nrBarLow": round(nr.nr_bar_low, 2),
                    "nrBarRangePct": round(nr.nr_bar_range_pct, 2),
                    "bbSqueeze": nr.bb_squeeze,
                    "bbWidthPct": round(nr.bb_width_pct, 2),
                    "direction": nr.direction,
                    "buyAbove": round(nr.buy_above, 2),
                    "sellBelow": round(nr.sell_below, 2),
                    "longSL": round(nr.long_sl, 2),
                    "shortSL": round(nr.short_sl, 2),
                    "longTarget": round(nr.long_target, 2),
                    "shortTarget": round(nr.short_target, 2),
                    "squeezeScore": nr.squeeze_score,
                    "squeezeType": nr.squeeze_type,
                    "notes": nr.notes,
                })
        except Exception:
            logger.debug("NR squeeze scan failed for %s", symbol, exc_info=True)

        await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    results.sort(key=lambda r: r.get("squeezeScore", 0), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Volume Profile Scanner
# ---------------------------------------------------------------------------


async def scan_volume_profile(
    kite: KiteConnect,
    symbols: list[str],
) -> list[dict]:
    """
    Scan symbols for volume profile analysis (POC, VAH, VAL).

    Fetches 60 days of daily OHLC per symbol.

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    symbols : list[str]
        NSE symbols to scan.

    Returns
    -------
    list[dict]
        Volume profile results sorted by signal_strength descending.
    """
    token_map = _resolve_tokens(symbols, kite)
    today = _today()
    to_date = _date_str(today)
    from_date = _date_str(today - timedelta(days=90))

    results: list[dict] = []

    for symbol in symbols:
        token = token_map.get(symbol)
        if not token:
            continue

        try:
            candles = await _fetch_historical(kite, token, "day", from_date, to_date)
            df = _candles_to_df(candles)

            if len(df) < 10:
                continue

            vp: EngineVolumeProfileResult = analyze_volume_profile(
                df=df,
                symbol=symbol,
                lookback=60,
            )

            results.append({
                "symbol": vp.symbol,
                "currentPrice": round(vp.current_price, 2),
                "poc": round(vp.poc, 2),
                "vah": round(vp.vah, 2),
                "val": round(vp.val, 2),
                "priceVsProfile": vp.price_vs_profile,
                "distanceToPocPct": round(vp.distance_to_poc_pct, 2),
                "signal": vp.signal,
                "signalStrength": vp.signal_strength,
                "notes": vp.notes,
                "profileHigh": round(vp.profile_high, 2),
                "profileLow": round(vp.profile_low, 2),
            })
        except Exception:
            logger.debug("Volume profile scan failed for %s", symbol, exc_info=True)

        await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    results.sort(key=lambda r: r.get("signalStrength", 0), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Swing Scanner
# ---------------------------------------------------------------------------


async def scan_swing(
    kite: KiteConnect,
    symbols: list[str],
) -> list[dict]:
    """
    Scan for swing trading signals (10D BO, 50D BO, Reversal, Channel BO).

    Fetches enough daily history for 200-DMA and weekly trend confirmation,
    plus Nifty 500 history for true benchmark-relative strength.

    Parameters
    ----------
    kite : KiteConnect
        Authenticated Kite client.
    symbols : list[str]
        NSE symbols to scan.

    Returns
    -------
    list[dict]
        Swing signals sorted by strength descending.
    """
    token_map = _resolve_tokens(symbols, kite)
    today = _today()
    to_date = _date_str(today)
    from_date = _date_str(today - timedelta(days=420))
    live_quotes = await _fetch_live_quotes(kite, symbols)
    benchmark_df = pd.DataFrame()
    benchmark_token = _resolve_tokens(["NIFTY 500"], kite).get("NIFTY 500")
    if benchmark_token:
        try:
            benchmark_candles = await _fetch_historical(
                kite,
                benchmark_token,
                "day",
                from_date,
                to_date,
            )
            benchmark_df = _candles_to_df(benchmark_candles)
        except Exception:
            logger.warning("Nifty 500 history unavailable; swing RS will be neutral", exc_info=True)

    results: list[dict] = []

    for symbol in symbols:
        token = token_map.get(symbol)
        if not token:
            continue

        try:
            candles = await _fetch_historical(kite, token, "day", from_date, to_date)
            df = _candles_to_df(candles)
            df = _merge_live_daily_candle(df, live_quotes.get(f"NSE:{symbol}"), today)

            if len(df) < 15:
                continue

            signals: list[EngineSwingSignal] = scan_swing_spectrum(
                df,
                symbol,
                benchmark_df=benchmark_df,
            )

            for sig in signals:
                results.append({
                    "symbol": sig.symbol,
                    "strategy": sig.strategy,
                    "signal": sig.signal,
                    "currentPrice": round(sig.current_price, 2),
                    "changePct": round(sig.change_pct, 2),
                    "triggerDate": sig.trigger_date,
                    "breakoutLevel": round(sig.breakout_level, 2),
                    "stopLoss": round(sig.stop_loss, 2),
                    "target": round(sig.target, 2),
                    "strength": round(sig.strength),
                    "notes": sig.notes,
                    "entry_price": round(sig.entry_price, 2),
                    "risk_pct": round(sig.risk_pct, 2),
                    "reward_pct": round(sig.reward_pct, 2),
                    "rr": round(sig.rr, 2),
                    "hold_days": sig.hold_days,
                    "trend_score": round(sig.trend_score),
                    "volume_score": round(sig.volume_score),
                    "pattern_score": round(sig.pattern_score),
                    "quality": sig.quality,
                    "rvol": round(sig.rvol, 2),
                    "setup_phase": sig.setup_phase,
                    "reasons": sig.reasons,
                    "benchmark_rs_20": round(sig.benchmark_rs_20, 2) if sig.benchmark_rs_20 is not None else None,
                    "benchmark_rs_60": round(sig.benchmark_rs_60, 2) if sig.benchmark_rs_60 is not None else None,
                    "weekly_trend": sig.weekly_trend,
                    "distance_to_trigger_pct": round(sig.distance_to_trigger_pct, 2),
                    "extension_atr": round(sig.extension_atr, 2),
                    "lifecycle_state": sig.lifecycle_state,
                })
        except Exception:
            logger.debug("Swing scan failed for %s", symbol, exc_info=True)

        await asyncio.sleep(_HISTORICAL_BATCH_DELAY_S)

    results.sort(key=lambda r: r.get("strength", 0), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Conversion helpers
# ---------------------------------------------------------------------------


def _signal_result_to_dict(sr: SignalResult) -> dict:
    """Convert a CPR SignalResult dataclass to a JSON-friendly dict."""
    return {
        "symbol": sr.symbol,
        "scannedAt": sr.scanned_at.isoformat() if sr.scanned_at else None,
        "currentPrice": round(sr.current_price, 2),
        "totalScore": sr.total_score,
        "alertTier": sr.alert_tier.value,
        "direction": sr.direction.value,
        "monthly": _timeframe_score_to_dict(sr.monthly),
        "weekly": _timeframe_score_to_dict(sr.weekly),
        "daily": _timeframe_score_to_dict(sr.daily),
        "intraday": _timeframe_score_to_dict(sr.intraday),
        "entryPrice": round(sr.entry_price, 2) if sr.entry_price else None,
        "stopLoss": round(sr.stop_loss, 2) if sr.stop_loss else None,
        "target1R2": round(sr.target_1r2, 2) if sr.target_1r2 else None,
        "target1R3": round(sr.target_1r3, 2) if sr.target_1r3 else None,
        "slDistance": round(sr.sl_distance, 2) if sr.sl_distance else None,
        "risk1PctQty": sr.risk_1pct_qty,
        "triggerFired": sr.trigger_fired,
        "triggerType": sr.trigger_type,
        "isAplusBonus": sr.is_aplus_bonus,
        "notes": sr.notes,
    }


def _timeframe_score_to_dict(ts: Any) -> dict:
    """Convert a TimeframeScore dataclass to a dict."""
    return {
        "name": ts.name,
        "total": ts.total,
        "cprDirectionScore": ts.cpr_direction_score,
        "pemaStackScore": ts.pema_stack_score,
        "narrowCprScore": ts.narrow_cpr_score,
        "cprDirection": ts.cpr_direction.value,
        "cprWidthClass": ts.cpr_width_class.value,
        "pemaStack": ts.pema_stack.value,
        "pemaSlope": ts.pema_slope.value,
        "consecutiveAscending": ts.consecutive_ascending,
        "consecutiveDescending": ts.consecutive_descending,
        "priceVsCpr": ts.price_vs_cpr,
        "isValidForLong": ts.is_valid_for_long,
        "isValidForShort": ts.is_valid_for_short,
    }
