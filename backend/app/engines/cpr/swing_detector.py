"""
Swing Spectrum detector.

The scanner keeps classic swing buckets, but also has a live momentum bucket for
stocks already moving hard intraday. That matters for names like NETWEB where
the best trader question is not only "did it close above a 10D high?", but "is
today's move real enough to chase, wait, or avoid?"
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd


@dataclass
class SwingSignal:
    symbol: str
    strategy: str
    signal: str
    current_price: float
    change_pct: float
    trigger_date: str
    breakout_level: float
    stop_loss: float
    target: float
    strength: float
    notes: str
    entry_price: float
    risk_pct: float
    reward_pct: float
    rr: float
    hold_days: str
    trend_score: float
    volume_score: float
    pattern_score: float
    quality: str
    rvol: float
    setup_phase: str
    reasons: list[str] = field(default_factory=list)
    benchmark_rs_20: Optional[float] = None
    benchmark_rs_60: Optional[float] = None
    weekly_trend: str = "MIXED"
    distance_to_trigger_pct: float = 0.0
    extension_atr: float = 0.0
    lifecycle_state: str = "FORMING"


def _clean_ohlc(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()

    out = df.copy()
    if "date" in out.columns:
        out["date"] = pd.to_datetime(out["date"], errors="coerce")
        out = out.sort_values("date")

    for col in ["open", "high", "low", "close", "volume"]:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce")

    required = ["open", "high", "low", "close"]
    out = out.dropna(subset=[c for c in required if c in out.columns])
    if "volume" not in out.columns:
        out["volume"] = 0

    return out.reset_index(drop=True)


def _indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    close = out["close"]
    high = out["high"]
    low = out["low"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)

    out["atr14"] = tr.rolling(14, min_periods=5).mean()
    out["sma20"] = close.rolling(20, min_periods=10).mean()
    out["sma50"] = close.rolling(50, min_periods=25).mean()
    out["sma200"] = close.rolling(200, min_periods=100).mean()
    out["ema8"] = close.ewm(span=8, adjust=False, min_periods=5).mean()
    out["ema21"] = close.ewm(span=21, adjust=False, min_periods=10).mean()
    out["ema50"] = close.ewm(span=50, adjust=False, min_periods=25).mean()
    out["avg_volume20"] = out["volume"].rolling(20, min_periods=5).mean()
    out["range_pct"] = np.where(close > 0, (high - low) / close * 100, 0)
    out["close_position"] = np.where((high - low) > 0, (close - low) / (high - low), 0.5)
    return out


def _pct(a: float, b: float) -> float:
    return ((a - b) / b * 100) if b else 0.0


def _quality(score: float) -> str:
    if score >= 86:
        return "A+"
    if score >= 76:
        return "A"
    if score >= 66:
        return "B"
    return "WATCH"


def _risk_signal(
    *,
    symbol: str,
    strategy: str,
    signal: str,
    current: pd.Series,
    prev_close: float,
    level: float,
    stop: float,
    trend_score: float,
    volume_score: float,
    pattern_score: float,
    notes: str,
    reasons: list[str],
    hold_days: str = "2-10D",
    setup_phase: str = "CONFIRMED_CLOSE",
) -> Optional[SwingSignal]:
    close = float(current["close"])
    if close <= 0 or stop <= 0:
        return None

    risk = close - stop if signal == "BULL" else stop - close
    if risk <= 0:
        return None

    risk_pct = risk / close * 100
    if risk_pct < 0.8 or risk_pct > 8.5:
        return None

    target = close + risk * 2.2 if signal == "BULL" else close - risk * 2.2
    reward_pct = abs(target - close) / close * 100
    rr = reward_pct / risk_pct if risk_pct else 0
    if rr < 1.8:
        return None

    strength = round(min(100, trend_score * 0.35 + volume_score * 0.25 + pattern_score * 0.40), 0)
    if strength < 62:
        return None

    date_value = str(current.get("date", ""))[:10]
    change_pct = _pct(close, prev_close)

    return SwingSignal(
        symbol=symbol,
        strategy=strategy,
        signal=signal,
        current_price=round(close, 2),
        change_pct=round(change_pct, 2),
        trigger_date=date_value,
        breakout_level=round(level, 2),
        stop_loss=round(stop, 2),
        target=round(target, 2),
        strength=strength,
        notes=notes,
        entry_price=round(close, 2),
        risk_pct=round(risk_pct, 2),
        reward_pct=round(reward_pct, 2),
        rr=round(rr, 2),
        hold_days=hold_days,
        trend_score=round(trend_score, 0),
        volume_score=round(volume_score, 0),
        pattern_score=round(pattern_score, 0),
        quality=_quality(strength),
        rvol=round(_rvol(current), 2),
        setup_phase=setup_phase,
        reasons=reasons,
    )


def _trend_scores(row: pd.Series, direction: str) -> tuple[float, list[str]]:
    close = float(row["close"])
    sma20 = float(row.get("sma20", 0) or 0)
    sma50 = float(row.get("sma50", 0) or 0)
    ema21 = float(row.get("ema21", 0) or 0)
    reasons: list[str] = []
    score = 45.0

    if direction == "BULL":
        if close > ema21:
            score += 15
            reasons.append("price above 21 EMA")
        if close > sma20:
            score += 15
            reasons.append("price above 20 DMA")
        if sma20 > sma50 > 0:
            score += 20
            reasons.append("20 DMA above 50 DMA")
        elif close > sma50 > 0:
            score += 10
            reasons.append("price above 50 DMA")
    else:
        if close < ema21:
            score += 15
            reasons.append("price below 21 EMA")
        if close < sma20:
            score += 15
            reasons.append("price below 20 DMA")
        if 0 < sma20 < sma50:
            score += 20
            reasons.append("20 DMA below 50 DMA")
        elif 0 < sma50 and close < sma50:
            score += 10
            reasons.append("price below 50 DMA")

    return min(100, score), reasons


def _volume_score(row: pd.Series) -> tuple[float, list[str]]:
    rvol = _rvol(row)
    score = 45 + min(45, max(0, (rvol - 0.8) * 45))
    reasons: list[str] = []

    if rvol >= 2.5:
        reasons.append(f"exceptional volume {rvol:.1f}x")
    elif rvol >= 1.8:
        reasons.append(f"strong volume {rvol:.1f}x")
    elif rvol >= 1.2:
        reasons.append(f"volume confirmation {rvol:.1f}x")
    elif rvol < 0.75:
        score -= 18
        reasons.append("weak volume")

    return min(100, max(0, score)), reasons


def _rvol(row: pd.Series) -> float:
    volume = float(row.get("volume", 0) or 0)
    avg_volume = float(row.get("avg_volume20", 0) or 0)
    return volume / avg_volume if avg_volume else 1.0


def _return_over(df: pd.DataFrame, sessions: int) -> float:
    if len(df) <= sessions:
        return 0.0
    return _pct(float(df.iloc[-1]["close"]), float(df.iloc[-(sessions + 1)]["close"]))


def _weekly_trend(df: pd.DataFrame) -> str:
    if df.empty:
        return "MIXED"

    dated = df.copy()
    if "date" in dated.columns and dated["date"].notna().any():
        dated["date"] = pd.to_datetime(dated["date"], errors="coerce")
        dated = dated.dropna(subset=["date"]).set_index("date")
        weekly_close = dated["close"].resample("W-FRI").last().dropna()
    else:
        weekly_close = df["close"].groupby(np.arange(len(df)) // 5).last()

    if len(weekly_close) < 10:
        return "MIXED"

    latest = float(weekly_close.iloc[-1])
    ma10 = float(weekly_close.rolling(10, min_periods=8).mean().iloc[-1])
    ma30_series = weekly_close.rolling(30, min_periods=20).mean()
    ma30 = float(ma30_series.iloc[-1]) if pd.notna(ma30_series.iloc[-1]) else 0.0

    if latest > ma10 and (ma30 <= 0 or ma10 > ma30):
        return "BULLISH"
    if latest < ma10 and (ma30 <= 0 or ma10 < ma30):
        return "BEARISH"
    return "MIXED"


def _lifecycle_state(signal: SwingSignal) -> str:
    phase = str(signal.setup_phase or "").upper()
    change = abs(signal.change_pct)

    if signal.extension_atr >= 2.5 or change >= 7:
        return "EXTENDED_AVOID"
    if phase in {"EARLY_IGNITION", "FIRST_RECLAIM", "LIQUIDITY_ABSORPTION", "SQUEEZE_READY"}:
        return "FORMING"
    if phase == "RS_PULLBACK" or signal.strategy == "REVERSAL":
        return "PULLBACK_ENTRY"
    if phase == "LIVE_MOMENTUM":
        return "TRIGGERED"
    if signal.distance_to_trigger_pct < -1:
        return "TRIGGERED"
    if signal.distance_to_trigger_pct <= 1.5:
        return "READY"
    return "FORMING"


def _enrich_signal(
    signal: SwingSignal,
    daily: pd.DataFrame,
    benchmark: pd.DataFrame,
) -> SwingSignal:
    def relative_return(period: int) -> Optional[float]:
        if len(daily) <= period or len(benchmark) <= period or "date" not in daily or "date" not in benchmark:
            return None
        stock_dates = pd.to_datetime(daily["date"]).dt.strftime("%Y-%m-%d").iloc[-period-1:].tolist()
        benchmark_dates = pd.to_datetime(benchmark["date"]).dt.strftime("%Y-%m-%d").iloc[-period-1:].tolist()
        if stock_dates != benchmark_dates:
            return None
        return round(_return_over(daily, period) - _return_over(benchmark, period), 2)
    signal.benchmark_rs_20 = relative_return(20)
    signal.benchmark_rs_60 = relative_return(60)
    signal.weekly_trend = _weekly_trend(daily)

    close = float(daily.iloc[-1]["close"])
    atr = float(daily.iloc[-1].get("atr14", 0) or 0)
    ema21 = float(daily.iloc[-1].get("ema21", close) or close)
    if signal.signal == "BULL":
        signal.distance_to_trigger_pct = round(_pct(signal.breakout_level, close), 2)
        signal.extension_atr = round(max(0.0, (close - ema21) / atr), 2) if atr else 0.0
        relative_edge = signal.benchmark_rs_60
        weekly_aligned = signal.weekly_trend == "BULLISH"
        weekly_opposed = signal.weekly_trend == "BEARISH"
    else:
        signal.distance_to_trigger_pct = round(_pct(close, signal.breakout_level), 2)
        signal.extension_atr = round(max(0.0, (ema21 - close) / atr), 2) if atr else 0.0
        relative_edge = -signal.benchmark_rs_60 if signal.benchmark_rs_60 is not None else None
        weekly_aligned = signal.weekly_trend == "BEARISH"
        weekly_opposed = signal.weekly_trend == "BULLISH"

    score_adjustment = 0.0
    if relative_edge is None:
        pass  # Missing benchmark evidence supplies neither a bonus nor a penalty.
    elif relative_edge >= 6:
        score_adjustment += 5
    elif relative_edge >= 2:
        score_adjustment += 3
    elif relative_edge <= -4:
        score_adjustment -= 7
    elif relative_edge < 0:
        score_adjustment -= 3

    if weekly_aligned:
        score_adjustment += 3
    elif weekly_opposed:
        score_adjustment -= 5
    if signal.extension_atr >= 2.5:
        score_adjustment -= 10
    elif signal.extension_atr >= 1.8:
        score_adjustment -= 5

    signal.strength = round(min(100, max(0, signal.strength + score_adjustment)), 0)
    signal.lifecycle_state = _lifecycle_state(signal)
    signal.quality = (
        "WATCH"
        if signal.lifecycle_state == "EXTENDED_AVOID" or signal.setup_phase == "EXTENDED_WAIT"
        else _quality(signal.strength)
    )
    signal.reasons = [
        *signal.reasons,
        f"Nifty 500 RS 20D {signal.benchmark_rs_20:+.1f} pp" if signal.benchmark_rs_20 is not None else "Nifty 500 RS 20D unavailable",
        f"Nifty 500 RS 60D {signal.benchmark_rs_60:+.1f} pp" if signal.benchmark_rs_60 is not None else "Nifty 500 RS 60D unavailable",
        f"weekly trend {signal.weekly_trend.lower()}",
        f"{signal.extension_atr:.1f} ATR from 21 EMA",
    ]
    return signal


def _build_watch_signal(
    *,
    symbol: str,
    strategy: str = "ACCELERATION",
    current: pd.Series,
    prev_close: float,
    level: float,
    stop: float,
    trend_score: float,
    volume_score: float,
    pattern_score: float,
    notes: str,
    reasons: list[str],
    setup_phase: str,
    hold_days: str = "2-10D",
) -> Optional[SwingSignal]:
    close = float(current["close"])
    if close <= 0 or stop <= 0 or stop >= close:
        return None

    risk = close - stop
    risk_pct = risk / close * 100
    target = close + risk * 2.2
    reward_pct = abs(target - close) / close * 100
    rr = reward_pct / risk_pct if risk_pct else 0
    strength = round(min(100, trend_score * 0.30 + volume_score * 0.30 + pattern_score * 0.40), 0)
    if strength < 58:
        return None

    quality = "WATCH" if setup_phase == "EXTENDED_WAIT" or risk_pct > 9.5 else _quality(strength)
    date_value = str(current.get("date", ""))[:10]
    change_pct = _pct(close, prev_close)

    return SwingSignal(
        symbol=symbol,
        strategy=strategy,
        signal="BULL",
        current_price=round(close, 2),
        change_pct=round(change_pct, 2),
        trigger_date=date_value,
        breakout_level=round(level, 2),
        stop_loss=round(stop, 2),
        target=round(target, 2),
        strength=strength,
        notes=notes,
        entry_price=round(close, 2),
        risk_pct=round(risk_pct, 2),
        reward_pct=round(reward_pct, 2),
        rr=round(rr, 2),
        hold_days=hold_days,
        trend_score=round(trend_score, 0),
        volume_score=round(volume_score, 0),
        pattern_score=round(pattern_score, 0),
        quality=quality,
        rvol=round(_rvol(current), 2),
        setup_phase=setup_phase,
        reasons=reasons,
    )


def detect_early_momentum(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    """Find bottom/base accumulation before the visible breakout gets extended."""
    if len(df) < 45:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    close = float(current["close"])
    prev_close = float(prev["close"])
    if close <= 0 or prev_close <= 0:
        return None

    close_pos = float(current.get("close_position", 0.5) or 0.5)
    change_pct = _pct(close, prev_close)
    ret_3 = _return_over(df, 3)
    ret_5 = _return_over(df, 5)
    rvol = _rvol(current)
    atr = float(current.get("atr14", 0) or 0)
    ema8 = float(current.get("ema8", 0) or 0)
    ema21 = float(current.get("ema21", 0) or 0)
    sma20 = float(current.get("sma20", 0) or 0)
    sma50 = float(current.get("sma50", 0) or 0)

    lookback_20 = df.iloc[-21:-1]
    lookback_50 = df.iloc[-51:-1] if len(df) >= 55 else df.iloc[:-1]
    recent_8 = df.tail(8)
    recent_10 = df.tail(10)
    base_20 = df.iloc[-21:-1]
    prior_15 = df.iloc[-24:-9] if len(df) >= 30 else df.iloc[:-9]

    high_20 = float(lookback_20["high"].max())
    low_20 = float(lookback_20["low"].min())
    high_50 = float(lookback_50["high"].max())
    prev_5_high = float(df.iloc[-6:-1]["high"].max())
    prior_5_low = float(df.iloc[-11:-6]["low"].min())
    recent_5_low = float(df.iloc[-6:-1]["low"].min())
    base_range_pct = (float(base_20["high"].max()) - float(base_20["low"].min())) / close * 100 if close else 99
    recent_range_pct = (float(recent_10["high"].max()) - float(recent_10["low"].min())) / close * 100 if close else 99
    drawdown_pct = _pct(high_50, close)
    bounce_from_low_pct = _pct(close, low_20)

    avg_volume20 = float(current.get("avg_volume20", 0) or 0)
    prior_volume = float(prior_15["volume"].mean()) if not prior_15.empty else avg_volume20
    recent_volume = float(recent_8["volume"].mean()) if not recent_8.empty else avg_volume20
    volume_dryup = avg_volume20 > 0 and prior_volume <= avg_volume20 * 0.92
    volume_waking = avg_volume20 > 0 and recent_volume >= prior_volume * 1.08

    accumulation_days = 0
    distribution_days = 0
    for idx in recent_8.index:
        if idx == 0:
            continue
        row = df.loc[idx]
        prior = df.iloc[df.index.get_loc(idx) - 1]
        row_volume = float(row.get("volume", 0) or 0)
        row_close = float(row["close"])
        prior_close_value = float(prior["close"])
        if row_close > prior_close_value and (avg_volume20 <= 0 or row_volume >= avg_volume20 * 0.9):
            accumulation_days += 1
        if row_close < prior_close_value and avg_volume20 > 0 and row_volume >= avg_volume20 * 1.15:
            distribution_days += 1

    was_below_sma20 = bool((base_20["close"] < base_20["sma20"]).tail(12).any()) if "sma20" in base_20 else False
    no_fresh_low = recent_5_low >= prior_5_low * 0.985 and close >= low_20 * 1.025
    reclaim_ema = close > ema8 > 0 and float(prev["close"]) <= float(prev.get("ema8", ema8)) * 1.015
    reclaim_ma = (close > ema21 > 0 and float(prev["close"]) <= float(prev.get("ema21", ema21)) * 1.012) or (
        close > sma20 > 0 and float(prev["close"]) <= float(prev.get("sma20", sma20)) * 1.012
    )
    first_5d_break = close >= prev_5_high * 0.998 and close_pos >= 0.55
    corrected = drawdown_pct >= 6.0 or was_below_sma20
    compressed = recent_range_pct <= 10.5 or base_range_pct <= 14.0
    not_extended = change_pct <= 5.5 and ret_3 <= 8.5 and ret_5 <= 12.0 and bounce_from_low_pct <= 16.0 and close <= high_20 * 1.045
    enough_participation = accumulation_days >= 2 and distribution_days <= 2 and (rvol >= 0.85 or volume_waking)
    early_trigger = reclaim_ema or reclaim_ma or first_5d_break

    if not (corrected and compressed and no_fresh_low and early_trigger and enough_participation and not_extended):
        return None

    trend_score = 48.0
    trend_reasons: list[str] = []
    if close > ema8 > 0:
        trend_score += 12
        trend_reasons.append("reclaimed 8 EMA")
    if close > ema21 > 0:
        trend_score += 10
        trend_reasons.append("above 21 EMA")
    if close > sma20 > 0:
        trend_score += 12
        trend_reasons.append("reclaimed 20 DMA")
    if recent_5_low >= prior_5_low * 0.995:
        trend_score += 10
        trend_reasons.append("higher-low structure")
    if sma20 > 0 and sma50 > 0 and sma20 >= sma50 * 0.97:
        trend_score += 6

    volume_score = 46.0
    volume_reasons: list[str] = []
    if volume_dryup:
        volume_score += 10
        volume_reasons.append("prior volume dry-up")
    if volume_waking:
        volume_score += 12
        volume_reasons.append("volume waking up")
    if accumulation_days >= 3:
        volume_score += 16
        volume_reasons.append(f"{accumulation_days} accumulation days")
    elif accumulation_days >= 2:
        volume_score += 10
        volume_reasons.append("early accumulation")
    if rvol >= 1.2:
        volume_score += 8
        volume_reasons.append(f"RVOL {rvol:.1f}x")

    pattern_score = 50.0
    pattern_reasons: list[str] = []
    if no_fresh_low:
        pattern_score += 12
        pattern_reasons.append("no fresh 10D low")
    if compressed:
        pattern_score += 12
        pattern_reasons.append(f"base compression {recent_range_pct:.1f}%")
    if first_5d_break:
        pattern_score += 13
        pattern_reasons.append("first 5D high reclaim")
    elif reclaim_ma or reclaim_ema:
        pattern_score += 9
        pattern_reasons.append("first reclaim from base")
    if 6 <= drawdown_pct <= 28:
        pattern_score += 8
        pattern_reasons.append(f"{drawdown_pct:.1f}% below recent high")

    stop_candidates = [
        recent_5_low * 0.985,
        low_20 * 0.992,
        close - atr * 1.6 if atr > 0 else 0,
    ]
    valid_stops = [value for value in stop_candidates if 0 < value < close]
    if not valid_stops:
        return None
    stop = max(valid_stops)
    notes = (
        f"Early momentum: base held, {accumulation_days} accumulation days, "
        f"{ret_3:+.1f}% in 3D; still close enough to base for controlled risk."
    )
    reasons = [
        *trend_reasons,
        *volume_reasons,
        *pattern_reasons,
    ]

    return _build_watch_signal(
        symbol=symbol,
        strategy="EARLY_MOMENTUM",
        current=current,
        prev_close=prev_close,
        level=prev_5_high,
        stop=stop,
        trend_score=min(100, trend_score),
        volume_score=min(100, volume_score),
        pattern_score=min(100, pattern_score),
        notes=notes,
        reasons=reasons,
        setup_phase="EARLY_IGNITION" if first_5d_break else "FIRST_RECLAIM",
        hold_days="5-20D",
    )


def detect_acceleration_watch(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    """Catch multi-session swing acceleration even when the trade needs a pullback."""
    if len(df) < 35:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    close = float(current["close"])
    prev_close = float(prev["close"])
    close_pos = float(current.get("close_position", 0.5) or 0.5)
    rvol = _rvol(current)
    change_pct = _pct(close, prev_close)
    ret_3 = _return_over(df, 3)
    ret_5 = _return_over(df, 5)
    ret_20 = _return_over(df, 20)
    recent = df.tail(5)
    lookback_20 = df.iloc[-21:-1]
    lookback_50 = df.iloc[-51:-1] if len(df) >= 55 else lookback_20
    high_20 = float(lookback_20["high"].max())
    high_50 = float(lookback_50["high"].max())
    close_high_20 = close >= high_20 * 0.992
    close_high_50 = close >= high_50 * 0.992
    avg_volume20 = float(current.get("avg_volume20", 0) or 0)
    accumulation_days = 0
    for idx in recent.index:
        if idx == 0:
            continue
        row = df.loc[idx]
        prior = df.iloc[df.index.get_loc(idx) - 1]
        row_volume = float(row.get("volume", 0) or 0)
        if float(row["close"]) > float(prior["close"]) and (avg_volume20 <= 0 or row_volume >= avg_volume20 * 1.15):
            accumulation_days += 1

    trend_ok = close > float(current.get("ema21", 0) or 0) or close > float(current.get("sma20", 0) or 0)
    acceleration = (
        (change_pct >= 4.0 and rvol >= 1.6 and close_pos >= 0.48)
        or (ret_3 >= 7.0 and rvol >= 1.25)
        or (ret_5 >= 10.0 and accumulation_days >= 2)
        or ((close_high_20 or close_high_50) and ret_3 >= 4.5 and rvol >= 1.1)
    )
    if not trend_ok or not acceleration:
        return None

    extended = change_pct >= 8.0 or ret_3 >= 14.0 or ret_5 >= 22.0
    trend_score, trend_reasons = _trend_scores(current, "BULL")
    volume_score, volume_reasons = _volume_score(current)
    high_bonus = 12 if close_high_50 else 8 if close_high_20 else 0
    accumulation_bonus = min(16, accumulation_days * 4)
    extension_penalty = max(0, ret_5 - 28) * 0.9
    pattern_score = min(
        100,
        50
        + min(24, ret_3 * 1.8)
        + min(18, ret_5 * 0.9)
        + high_bonus
        + accumulation_bonus
        + close_pos * 8
        - extension_penalty,
    )
    atr = float(current.get("atr14", 0) or 0)
    ema8 = float(current.get("ema8", 0) or 0)
    ema21 = float(current.get("ema21", 0) or 0)
    stop_candidates = [
        value
        for value in (ema8 * 0.985, high_20 * 0.985 if close_high_20 else 0, close - atr * 1.8 if atr > 0 else 0, ema21 * 0.99)
        if 0 < value < close
    ]
    stop = max(stop_candidates) if stop_candidates else float(current["low"])
    setup_phase = "EXTENDED_WAIT" if extended else "ACCELERATION"
    notes = (
        f"Swing acceleration: {ret_3:+.1f}% in 3D, {ret_5:+.1f}% in 5D; "
        f"{'wait for pullback/retest' if extended else 'emerging continuation watch'}."
    )
    reasons = [
        *trend_reasons,
        *volume_reasons,
        f"3D return {ret_3:+.1f}%",
        f"5D return {ret_5:+.1f}%",
    ]
    if ret_20 > 15:
        reasons.append(f"20D relative strength {ret_20:+.1f}%")
    if close_high_50:
        reasons.append("near 50D high")
    elif close_high_20:
        reasons.append("near 20D high")
    if accumulation_days >= 2:
        reasons.append(f"{accumulation_days} accumulation days")

    return _build_watch_signal(
        symbol=symbol,
        current=current,
        prev_close=prev_close,
        level=high_50 if close_high_50 else high_20,
        stop=stop,
        trend_score=trend_score,
        volume_score=volume_score,
        pattern_score=pattern_score,
        notes=notes,
        reasons=reasons,
        setup_phase=setup_phase,
        hold_days="2-15D",
    )


def detect_momentum_burst(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    """Catch live, high-participation moves that classic EOD breakout rules miss."""
    if len(df) < 35:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    lookback = df.iloc[-21:-1]
    lookback_50 = df.iloc[-51:-1] if len(df) >= 55 else lookback
    tight_base = lookback.tail(10)
    close = float(current["close"])
    prev_close = float(prev["close"])
    open_ = float(current["open"])
    low = float(current["low"])
    high = float(current["high"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)
    change_pct = _pct(close, prev_close)
    gap_pct = _pct(open_, prev_close)
    open_drive_pct = _pct(close, open_)
    rvol = _rvol(current)
    high_20 = float(lookback["high"].max())
    low_20 = float(lookback["low"].min())
    high_50 = float(lookback_50["high"].max())
    low_50 = float(lookback_50["low"].min())
    tight_range_pct = ((float(tight_base["high"].max()) - float(tight_base["low"].min())) / close * 100) if close else 0
    near_major_high = close >= high_20 * 0.992 or close >= high_50 * 0.992
    near_major_low = close <= low_20 * 1.008 or close <= low_50 * 1.008

    bull_power_gap = gap_pct >= 1.4 and open_drive_pct >= -0.25 and rvol >= 1.15 and close_pos >= 0.62 and close >= high_20 * 0.97
    bull_compression_breakout = tight_range_pct <= 11 and close > high_20 and rvol >= 1.15 and close_pos >= 0.58
    bull_momentum_expansion = change_pct >= 3.0 and rvol >= 1.25 and close_pos >= 0.58 and near_major_high

    if bull_momentum_expansion or bull_power_gap or bull_compression_breakout:
        trend_score, trend_reasons = _trend_scores(current, "BULL")
        volume_score, volume_reasons = _volume_score(current)
        extension_penalty = max(0, change_pct - 10) * 2.2
        compression_bonus = max(0, 12 - tight_range_pct) * 1.5 if bull_compression_breakout else 0
        gap_bonus = max(0, min(gap_pct, 5)) * 1.5 if bull_power_gap else 0
        pattern_score = min(100, 60 + change_pct * 2.4 + max(0, rvol - 1.0) * 9 + close_pos * 16 + compression_bonus + gap_bonus - extension_penalty)
        stop = max(low, close - atr * 1.15) if atr > 0 else low
        reasons = [
            *trend_reasons,
            *volume_reasons,
            f"momentum burst +{change_pct:.1f}%",
        ]
        if close > high_20:
            reasons.append("20D high cleared")
        if close > high_50 and len(df) >= 55:
            reasons.append("50D high cleared")
        if bull_power_gap:
            reasons.append(f"power gap holding +{gap_pct:.1f}%")
        if bull_compression_breakout:
            reasons.append(f"compressed 10D range {tight_range_pct:.1f}%")
        elif open_drive_pct > 2:
            reasons.append("open drive holding")
        return _risk_signal(
            symbol=symbol,
            strategy="MOMENTUM_BURST",
            signal="BULL",
            current=current,
            prev_close=prev_close,
            level=high_20,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Live bullish momentum burst near/above 20D high {high_20:.2f}",
            reasons=reasons,
            hold_days="1-5D",
            setup_phase="LIVE_MOMENTUM",
        )

    bear_power_gap = gap_pct <= -1.4 and open_drive_pct <= 0.25 and rvol >= 1.15 and close_pos <= 0.38 and close <= low_20 * 1.03
    bear_compression_breakdown = tight_range_pct <= 11 and close < low_20 and rvol >= 1.15 and close_pos <= 0.42
    bear_momentum_expansion = change_pct <= -3.0 and rvol >= 1.25 and close_pos <= 0.42 and near_major_low

    if bear_momentum_expansion or bear_power_gap or bear_compression_breakdown:
        trend_score, trend_reasons = _trend_scores(current, "BEAR")
        volume_score, volume_reasons = _volume_score(current)
        extension_penalty = max(0, abs(change_pct) - 10) * 2.2
        compression_bonus = max(0, 12 - tight_range_pct) * 1.5 if bear_compression_breakdown else 0
        gap_bonus = max(0, min(abs(gap_pct), 5)) * 1.5 if bear_power_gap else 0
        pattern_score = min(100, 60 + abs(change_pct) * 2.4 + max(0, rvol - 1.0) * 9 + (1 - close_pos) * 16 + compression_bonus + gap_bonus - extension_penalty)
        stop = min(high, close + atr * 1.15) if atr > 0 else high
        reasons = [
            *trend_reasons,
            *volume_reasons,
            f"momentum breakdown {change_pct:.1f}%",
        ]
        if close < low_20:
            reasons.append("20D low lost")
        if close < low_50 and len(df) >= 55:
            reasons.append("50D low lost")
        if bear_power_gap:
            reasons.append(f"power gap down holding {gap_pct:.1f}%")
        if bear_compression_breakdown:
            reasons.append(f"compressed 10D range {tight_range_pct:.1f}%")
        elif open_drive_pct < -2:
            reasons.append("open drive lower")
        return _risk_signal(
            symbol=symbol,
            strategy="MOMENTUM_BURST",
            signal="BEAR",
            current=current,
            prev_close=prev_close,
            level=low_20,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Live bearish momentum burst near/below 20D low {low_20:.2f}",
            reasons=reasons,
            hold_days="1-5D",
            setup_phase="LIVE_MOMENTUM",
        )

    return None


def detect_breakout(df: pd.DataFrame, symbol: str, period: int, label: str) -> Optional[SwingSignal]:
    if len(df) < period + 5:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    lookback = df.iloc[-(period + 1):-1]
    close = float(current["close"])
    prev_close = float(prev["close"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)

    high_n = float(lookback["high"].max())
    low_n = float(lookback["low"].min())
    avg_range_pct = float(lookback["range_pct"].tail(min(20, period)).mean())

    if close > high_n and close_pos >= 0.58:
        breakout_pct = _pct(close, high_n)
        if breakout_pct > 6.5:
            return None
        trend_score, trend_reasons = _trend_scores(current, "BULL")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(100, 56 + breakout_pct * 6 + close_pos * 22 + max(0, 3.5 - avg_range_pct) * 3)
        stop = min(float(current["low"]), high_n - atr * 0.35) if atr > 0 else float(current["low"])
        reasons = [*trend_reasons, *volume_reasons, f"closed above {period}D high"]
        return _risk_signal(
            symbol=symbol,
            strategy=label,
            signal="BULL",
            current=current,
            prev_close=prev_close,
            level=high_n,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bullish {period}D breakout above {high_n:.2f}",
            reasons=reasons,
            hold_days="2-8D" if period <= 10 else "5-20D",
        )

    if close < low_n and close_pos <= 0.42:
        breakdown_pct = _pct(low_n, close)
        if breakdown_pct > 6.5:
            return None
        trend_score, trend_reasons = _trend_scores(current, "BEAR")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(100, 56 + breakdown_pct * 6 + (1 - close_pos) * 22 + max(0, 3.5 - avg_range_pct) * 3)
        stop = max(float(current["high"]), low_n + atr * 0.35) if atr > 0 else float(current["high"])
        reasons = [*trend_reasons, *volume_reasons, f"closed below {period}D low"]
        return _risk_signal(
            symbol=symbol,
            strategy=label,
            signal="BEAR",
            current=current,
            prev_close=prev_close,
            level=low_n,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bearish {period}D breakdown below {low_n:.2f}",
            reasons=reasons,
            hold_days="2-8D" if period <= 10 else "5-20D",
        )

    return None


def detect_reversal(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    if len(df) < 35:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    recent = df.iloc[-8:-1]
    close = float(current["close"])
    prev_close = float(prev["close"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)
    sma20 = float(current.get("sma20", 0) or 0)
    sma50 = float(current.get("sma50", 0) or 0)

    recent_low = float(recent["low"].min())
    recent_high = float(recent["high"].max())
    pullback_pct = _pct(recent_high, recent_low)
    bounce_pct = _pct(close, recent_low)

    if sma20 > sma50 > 0 and recent_low <= sma20 * 1.02 and close > sma20 and close_pos >= 0.62 and close > prev_close:
        if bounce_pct > 7:
            return None
        trend_score, trend_reasons = _trend_scores(current, "BULL")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(100, 58 + pullback_pct * 2 + close_pos * 22)
        stop = min(recent_low, close - atr * 1.2) if atr > 0 else recent_low
        reasons = [*trend_reasons, *volume_reasons, "uptrend pullback reclaimed 20 DMA"]
        return _risk_signal(
            symbol=symbol,
            strategy="REVERSAL",
            signal="BULL",
            current=current,
            prev_close=prev_close,
            level=sma20,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bullish pullback reversal from {recent_low:.2f}",
            reasons=reasons,
            hold_days="3-12D",
        )

    fade_pct = _pct(recent_high, close)
    if 0 < sma20 < sma50 and recent_high >= sma20 * 0.98 and close < sma20 and close_pos <= 0.38 and close < prev_close:
        if fade_pct > 7:
            return None
        trend_score, trend_reasons = _trend_scores(current, "BEAR")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(100, 58 + pullback_pct * 2 + (1 - close_pos) * 22)
        stop = max(recent_high, close + atr * 1.2) if atr > 0 else recent_high
        reasons = [*trend_reasons, *volume_reasons, "downtrend rally rejected 20 DMA"]
        return _risk_signal(
            symbol=symbol,
            strategy="REVERSAL",
            signal="BEAR",
            current=current,
            prev_close=prev_close,
            level=sma20,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bearish rally rejection from {recent_high:.2f}",
            reasons=reasons,
            hold_days="3-12D",
        )

    return None


def detect_channel_breakout(df: pd.DataFrame, symbol: str, period: int = 20) -> Optional[SwingSignal]:
    if len(df) < period + 20:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    lookback = df.iloc[-(period + 1):-1]
    close = float(current["close"])
    prev_close = float(prev["close"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)

    channel_high = float(lookback["high"].max())
    channel_low = float(lookback["low"].min())
    channel_mid = (channel_high + channel_low) / 2
    channel_width = channel_high - channel_low
    channel_width_pct = channel_width / close * 100 if close else 0
    avg_range_pct = float(lookback["range_pct"].mean())

    if channel_width <= 0 or channel_width_pct > 18:
        return None

    if close > channel_high and close_pos >= 0.6:
        trend_score, trend_reasons = _trend_scores(current, "BULL")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(100, 60 + (18 - channel_width_pct) * 1.3 + close_pos * 18)
        stop = max(channel_mid, close - atr * 1.8) if atr > 0 else channel_mid
        reasons = [*trend_reasons, *volume_reasons, "20D channel expansion"]
        if avg_range_pct <= 3:
            reasons.append("tight prior range")
        return _risk_signal(
            symbol=symbol,
            strategy="CHANNEL_BO",
            signal="BULL",
            current=current,
            prev_close=prev_close,
            level=channel_high,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bullish channel breakout above {channel_high:.2f}",
            reasons=reasons,
            hold_days="3-15D",
        )

    if close < channel_low and close_pos <= 0.4:
        trend_score, trend_reasons = _trend_scores(current, "BEAR")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(100, 60 + (18 - channel_width_pct) * 1.3 + (1 - close_pos) * 18)
        stop = min(channel_mid, close + atr * 1.8) if atr > 0 else channel_mid
        reasons = [*trend_reasons, *volume_reasons, "20D channel expansion"]
        if avg_range_pct <= 3:
            reasons.append("tight prior range")
        return _risk_signal(
            symbol=symbol,
            strategy="CHANNEL_BO",
            signal="BEAR",
            current=current,
            prev_close=prev_close,
            level=channel_low,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bearish channel breakdown below {channel_low:.2f}",
            reasons=reasons,
            hold_days="3-15D",
        )

    return None


def detect_liquidity_shock(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    """Spot institutional absorption/distribution before a clean breakout is obvious."""
    if len(df) < 45:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    lookback_20 = df.iloc[-21:-1]
    recent_8 = df.tail(8)
    close = float(current["close"])
    prev_close = float(prev["close"])
    high = float(current["high"])
    low = float(current["low"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)
    change_pct = _pct(close, prev_close)
    rvol = _rvol(current)
    if close <= 0 or prev_close <= 0 or rvol < 1.75:
        return None

    high_20 = float(lookback_20["high"].max())
    low_20 = float(lookback_20["low"].min())
    range_20_pct = (high_20 - low_20) / close * 100 if close else 99
    ret_5 = _return_over(df, 5)
    ret_20 = _return_over(df, 20)
    avg_volume20 = float(current.get("avg_volume20", 0) or 0)

    accumulation_days = 0
    distribution_days = 0
    for idx in recent_8.index:
        if idx == 0:
            continue
        row = df.loc[idx]
        prior = df.iloc[df.index.get_loc(idx) - 1]
        row_volume = float(row.get("volume", 0) or 0)
        row_close = float(row["close"])
        prior_close_value = float(prior["close"])
        if row_close > prior_close_value and (avg_volume20 <= 0 or row_volume >= avg_volume20):
            accumulation_days += 1
        if row_close < prior_close_value and avg_volume20 > 0 and row_volume >= avg_volume20 * 1.15:
            distribution_days += 1

    not_chased = abs(change_pct) <= 4.8 and abs(ret_5) <= 9.5
    compressed_enough = range_20_pct <= 16.0
    bull_absorption = (
        close_pos >= 0.58
        and close >= low_20 * 1.035
        and close <= high_20 * 1.035
        and accumulation_days >= 2
        and distribution_days <= 2
        and not_chased
        and compressed_enough
    )
    bear_distribution = (
        close_pos <= 0.38
        and close <= high_20 * 0.985
        and close >= low_20 * 0.965
        and distribution_days >= 2
        and not_chased
        and compressed_enough
    )

    if bull_absorption:
        trend_score, trend_reasons = _trend_scores(current, "BULL")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(
            100,
            58
            + min(18, rvol * 4)
            + min(14, accumulation_days * 4)
            + max(0, 16 - range_20_pct)
            + close_pos * 10,
        )
        stop_candidates = [
            low * 0.99,
            low_20 * 0.992,
            close - atr * 1.45 if atr > 0 else 0,
        ]
        valid_stops = [value for value in stop_candidates if 0 < value < close]
        if not valid_stops:
            return None
        stop = max(valid_stops)
        reasons = [
            *trend_reasons,
            *volume_reasons,
            f"liquidity shock RVOL {rvol:.1f}x",
            f"{accumulation_days} absorption days",
            f"20D range {range_20_pct:.1f}%",
        ]
        if ret_20 > 5:
            reasons.append(f"20D strength {ret_20:+.1f}%")
        return _risk_signal(
            symbol=symbol,
            strategy="LIQUIDITY_SHOCK",
            signal="BULL",
            current=current,
            prev_close=prev_close,
            level=high_20,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bullish liquidity absorption: {rvol:.1f}x volume without a chase candle.",
            reasons=reasons,
            hold_days="3-15D",
            setup_phase="LIQUIDITY_ABSORPTION",
        )

    if bear_distribution:
        trend_score, trend_reasons = _trend_scores(current, "BEAR")
        volume_score, volume_reasons = _volume_score(current)
        pattern_score = min(
            100,
            58
            + min(18, rvol * 4)
            + min(14, distribution_days * 4)
            + max(0, 16 - range_20_pct)
            + (1 - close_pos) * 10,
        )
        stop_candidates = [
            high * 1.01,
            high_20 * 1.008,
            close + atr * 1.45 if atr > 0 else 0,
        ]
        valid_stops = [value for value in stop_candidates if value > close]
        if not valid_stops:
            return None
        stop = min(valid_stops)
        reasons = [
            *trend_reasons,
            *volume_reasons,
            f"distribution shock RVOL {rvol:.1f}x",
            f"{distribution_days} distribution days",
            f"20D range {range_20_pct:.1f}%",
        ]
        return _risk_signal(
            symbol=symbol,
            strategy="LIQUIDITY_SHOCK",
            signal="BEAR",
            current=current,
            prev_close=prev_close,
            level=low_20,
            stop=stop,
            trend_score=trend_score,
            volume_score=volume_score,
            pattern_score=pattern_score,
            notes=f"Bearish liquidity distribution: {rvol:.1f}x volume with weak close.",
            reasons=reasons,
            hold_days="3-12D",
            setup_phase="LIQUIDITY_DISTRIBUTION",
        )

    return None


def detect_volatility_squeeze(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    """Find quiet bases where range has compressed and participation is waking up."""
    if len(df) < 55:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    lookback_20 = df.iloc[-21:-1]
    lookback_50 = df.iloc[-51:-1]
    close = float(current["close"])
    prev_close = float(prev["close"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)
    rvol = _rvol(current)
    if close <= 0 or prev_close <= 0:
        return None

    high_20 = float(lookback_20["high"].max())
    low_20 = float(lookback_20["low"].min())
    high_50 = float(lookback_50["high"].max())
    low_50 = float(lookback_50["low"].min())
    range_10_pct = (float(df.iloc[-11:-1]["high"].max()) - float(df.iloc[-11:-1]["low"].min())) / close * 100
    range_20_pct = (high_20 - low_20) / close * 100
    range_50_pct = (high_50 - low_50) / close * 100
    atr_pct = atr / close * 100 if close else 99
    change_pct = _pct(close, prev_close)
    ret_5 = _return_over(df, 5)
    volume_lift = rvol >= 1.05
    near_break = close >= high_20 * 0.985 and close_pos >= 0.52
    tight_base = range_10_pct <= 5.8 or (range_20_pct <= 9.5 and range_50_pct <= 18)
    not_extended = change_pct <= 3.8 and ret_5 <= 7.5

    if not (tight_base and near_break and volume_lift and not_extended):
        return None

    trend_score, trend_reasons = _trend_scores(current, "BULL")
    volume_score, volume_reasons = _volume_score(current)
    pattern_score = min(
        100,
        62
        + max(0, 10 - range_20_pct) * 2.2
        + max(0, 2.8 - atr_pct) * 6
        + close_pos * 12
        + min(10, max(0, rvol - 1.0) * 8),
    )
    stop_candidates = [
        low_20 * 0.992,
        close - atr * 1.8 if atr > 0 else 0,
    ]
    valid_stops = [value for value in stop_candidates if 0 < value < close]
    if not valid_stops:
        return None
    stop = max(valid_stops)
    reasons = [
        *trend_reasons,
        *volume_reasons,
        f"10D range compressed to {range_10_pct:.1f}%",
        f"near 20D trigger {high_20:.2f}",
    ]
    if atr_pct <= 2.8:
        reasons.append(f"ATR quiet at {atr_pct:.1f}%")

    return _risk_signal(
        symbol=symbol,
        strategy="VOL_SQUEEZE",
        signal="BULL",
        current=current,
        prev_close=prev_close,
        level=high_20,
        stop=stop,
        trend_score=trend_score,
        volume_score=volume_score,
        pattern_score=pattern_score,
        notes=f"Volatility squeeze: quiet range near {high_20:.2f} with volume waking up.",
        reasons=reasons,
        hold_days="5-20D",
        setup_phase="SQUEEZE_READY",
    )


def detect_relative_strength_pullback(df: pd.DataFrame, symbol: str) -> Optional[SwingSignal]:
    """Prefer strong stocks resting near support instead of late extended breakouts."""
    if len(df) < 60:
        return None

    current = df.iloc[-1]
    prev = df.iloc[-2]
    recent = df.iloc[-8:-1]
    close = float(current["close"])
    prev_close = float(prev["close"])
    atr = float(current.get("atr14", 0) or 0)
    close_pos = float(current.get("close_position", 0.5) or 0.5)
    ema21 = float(current.get("ema21", 0) or 0)
    sma20 = float(current.get("sma20", 0) or 0)
    sma50 = float(current.get("sma50", 0) or 0)
    if close <= 0 or prev_close <= 0 or not (sma20 > sma50 > 0):
        return None

    ret_20 = _return_over(df, 20)
    ret_50 = _return_over(df, 50)
    recent_high = float(df.iloc[-21:-1]["high"].max())
    recent_low = float(recent["low"].min())
    pullback_from_high = _pct(recent_high, close)
    bounce_from_low = _pct(close, recent_low)
    rvol = _rvol(current)
    support_hold = recent_low <= max(sma20, ema21) * 1.025 and close >= max(sma20, ema21) * 0.995
    constructive_close = close >= prev_close * 0.995 and close_pos >= 0.5
    strong_not_extended = ret_20 >= 6.0 and ret_50 >= 8.0 and 2.0 <= pullback_from_high <= 12.0 and bounce_from_low <= 6.5

    if not (support_hold and constructive_close and strong_not_extended):
        return None

    trend_score, trend_reasons = _trend_scores(current, "BULL")
    volume_score, volume_reasons = _volume_score(current)
    pattern_score = min(
        100,
        58
        + min(18, ret_20 * 0.85)
        + min(12, ret_50 * 0.35)
        + max(0, 12 - pullback_from_high)
        + close_pos * 10
        + (6 if rvol >= 0.85 else 0),
    )
    stop_candidates = [
        recent_low * 0.99,
        sma50 * 0.992,
        close - atr * 1.8 if atr > 0 else 0,
    ]
    valid_stops = [value for value in stop_candidates if 0 < value < close]
    if not valid_stops:
        return None
    stop = max(valid_stops)
    reasons = [
        *trend_reasons,
        *volume_reasons,
        f"20D RS {ret_20:+.1f}%",
        f"50D RS {ret_50:+.1f}%",
        f"pullback {pullback_from_high:.1f}% from recent high",
        "support held near 20/21 EMA zone",
    ]

    return _risk_signal(
        symbol=symbol,
        strategy="RS_PULLBACK",
        signal="BULL",
        current=current,
        prev_close=prev_close,
        level=recent_high,
        stop=stop,
        trend_score=trend_score,
        volume_score=volume_score,
        pattern_score=pattern_score,
        notes=f"Relative-strength pullback: leader cooled {pullback_from_high:.1f}% into support.",
        reasons=reasons,
        hold_days="5-20D",
        setup_phase="RS_PULLBACK",
    )


def scan_swing_spectrum(
    df: pd.DataFrame,
    symbol: str,
    benchmark_df: Optional[pd.DataFrame] = None,
) -> list[SwingSignal]:
    daily = _indicators(_clean_ohlc(df))
    if len(daily) < 35:
        return []
    benchmark = _indicators(_clean_ohlc(benchmark_df)) if benchmark_df is not None else pd.DataFrame()

    signals = [
        detect_early_momentum(daily, symbol),
        detect_liquidity_shock(daily, symbol),
        detect_volatility_squeeze(daily, symbol),
        detect_relative_strength_pullback(daily, symbol),
        detect_acceleration_watch(daily, symbol),
        detect_momentum_burst(daily, symbol),
        detect_breakout(daily, symbol, 10, "10D_BO"),
        detect_breakout(daily, symbol, 50, "50D_BO"),
        detect_reversal(daily, symbol),
        detect_channel_breakout(daily, symbol, 20),
    ]

    valid = [_enrich_signal(s, daily, benchmark) for s in signals if s is not None]
    valid.sort(key=lambda s: (s.strength, s.rr), reverse=True)
    return valid


def swing_signal_to_dict(s: SwingSignal) -> dict:
    return {
        "symbol": s.symbol,
        "strategy": s.strategy,
        "signal": s.signal,
        "current_price": s.current_price,
        "change_pct": s.change_pct,
        "trigger_date": s.trigger_date,
        "breakout_level": s.breakout_level,
        "stop_loss": s.stop_loss,
        "target": s.target,
        "strength": s.strength,
        "notes": s.notes,
        "entry_price": s.entry_price,
        "risk_pct": s.risk_pct,
        "reward_pct": s.reward_pct,
        "rr": s.rr,
        "hold_days": s.hold_days,
        "trend_score": s.trend_score,
        "volume_score": s.volume_score,
        "pattern_score": s.pattern_score,
        "quality": s.quality,
        "rvol": s.rvol,
        "setup_phase": s.setup_phase,
        "reasons": s.reasons,
        "benchmark_rs_20": s.benchmark_rs_20,
        "benchmark_rs_60": s.benchmark_rs_60,
        "weekly_trend": s.weekly_trend,
        "distance_to_trigger_pct": s.distance_to_trigger_pct,
        "extension_atr": s.extension_atr,
        "lifecycle_state": s.lifecycle_state,
    }
