"""Pure-enough feature assembly over normalized state, bars and TOD baselines."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.engines.runner.baselines import BaselineRepository, minute_of_session
from app.engines.runner.context import RunnerContextStore
from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import (
    DataQuality,
    NormalizedMarketTick,
    RunnerFeatureSnapshot,
)
from app.engines.runner.statistics import (
    approximate_percentile,
    pct_change,
    safe_ratio,
    zscore,
)

IST = ZoneInfo("Asia/Kolkata")


def calculate_features(
    tick: NormalizedMarketTick,
    bars: MinuteBarBuilder,
    baselines: BaselineRepository,
    context_store: RunnerContextStore,
    *,
    short_lookback: int = 20,
    long_lookback: int = 60,
    feature_version: str = "runner-v1",
    processing_timestamp: datetime | None = None,
    stale_after_seconds: int = 30,
) -> RunnerFeatureSnapshot:
    """Calculate a snapshot using observations no later than the source tick."""
    processing = processing_timestamp or datetime.now(IST)
    minute = minute_of_session(tick.exchange_timestamp)
    history = bars.bars(tick.symbol)

    def ret(window: int) -> float | None:
        if not history:
            return None
        target = history[-1].minute_timestamp - timedelta(minutes=window)
        prior = next(
            (bar for bar in reversed(history[:-1]) if bar.minute_timestamp <= target),
            None,
        )
        return pct_change(history[-1].close, prior.close) if prior else None

    returns = {window: ret(window) for window in (1, 3, 5, 10, 15, 30)}
    session_date = tick.exchange_timestamp.astimezone(IST).date()

    def valid(stat):
        return stat if stat is not None and stat.as_of_date <= session_date else None

    short = lambda metric: valid(
        baselines.get(tick.symbol, minute, short_lookback, metric)
    )
    long = lambda metric: valid(
        baselines.get(tick.symbol, minute, long_lookback, metric)
    )

    window_end = MinuteBarBuilder.minute_floor(tick.exchange_timestamp)
    actual_volumes = {
        window: sum(
            bar.volume
            for bar in history
            if window_end - timedelta(minutes=window - 1)
            <= bar.minute_timestamp
            <= window_end
        )
        if history
        else None
        for window in (1, 3, 5, 10, 15)
    }
    volume_ratios: dict[int, float | None] = {}
    for window, actual in actual_volumes.items():
        baseline = short(f"volume_{window}m")
        volume_ratios[window] = safe_ratio(
            actual, baseline.median if baseline else None
        )

    cumulative = tick.cumulative_volume
    cumulative_short = short("cumulative_volume")
    cumulative_long = long("cumulative_volume")
    range_stat = short("intraday_range")
    current_range = (
        tick.day_high - tick.day_low
        if tick.day_high is not None and tick.day_low is not None
        else None
    )
    rvol5 = volume_ratios[5]
    prior5_end = window_end - timedelta(minutes=5)
    prior5_start = prior5_end - timedelta(minutes=4)
    prior5_bars = [
        bar for bar in history if prior5_start <= bar.minute_timestamp <= prior5_end
    ]
    prior5 = sum(bar.volume for bar in prior5_bars) if prior5_bars else None
    prior_baseline = valid(
        baselines.get(tick.symbol, max(0, minute - 5), short_lookback, "volume_5m")
    )
    prior5_ratio = safe_ratio(prior5, prior_baseline.median if prior_baseline else None)
    acceleration = safe_ratio(rvol5, prior5_ratio)

    quality = list(tick.data_quality)
    if history:
        quality = list(dict.fromkeys([*quality, *history[-1].quality]))
    if cumulative_short is None and DataQuality.MISSING_BASELINE not in quality:
        quality.append(DataQuality.MISSING_BASELINE)
    freshness = max(
        tick.freshness_seconds, (processing - tick.exchange_timestamp).total_seconds()
    )
    if freshness > stale_after_seconds and DataQuality.STALE not in quality:
        quality.append(DataQuality.STALE)
    if len(quality) > 1 and DataQuality.GOOD in quality:
        quality.remove(DataQuality.GOOD)

    vwap = tick.average_price
    from app.caches import orb_cache, pdh_pdl_cache

    pdh, pdl = pdh_pdl_cache.get_pdh(tick.symbol), pdh_pdl_cache.get_pdl(tick.symbol)
    orb = orb_cache.get_orb(tick.symbol)
    ctx = context_store.get(tick.symbol)
    spread_bps = (
        tick.spread / tick.ltp * 10_000
        if tick.spread is not None and tick.ltp
        else None
    )
    range_location = (
        (tick.ltp - tick.day_low) / (tick.day_high - tick.day_low)
        if tick.day_high is not None
        and tick.day_low is not None
        and tick.day_high > tick.day_low
        else None
    )
    latest_bar = history[-1] if history else None
    clv = (
        ((latest_bar.close - latest_bar.low) - (latest_bar.high - latest_bar.close))
        / (latest_bar.high - latest_bar.low)
        if latest_bar and latest_bar.high > latest_bar.low
        else None
    )
    prior_vwap_bar = next(
        (
            bar
            for bar in reversed(history[:-1])
            if bar.vwap is not None
            and latest_bar
            and bar.minute_timestamp
            <= latest_bar.minute_timestamp - timedelta(minutes=5)
        ),
        None,
    )
    vwap_slope = (
        pct_change(latest_bar.vwap, prior_vwap_bar.vwap) / 5
        if latest_bar and latest_bar.vwap is not None and prior_vwap_bar
        else None
    )
    # Daily context is usable only for the session it was built for. This
    # prevents yesterday's process cache (or an EOD next-session warm) from
    # silently entering a feature row with the wrong information boundary.
    daily_context_current = ctx.get("daily_structure_as_of") == session_date
    atr = ctx.get("atr14") if daily_context_current else None
    high_20 = ctx.get("high_20d") if daily_context_current else None
    high_50 = ctx.get("high_50d") if daily_context_current else None
    if (
        not daily_context_current
        or atr is None
        or high_20 is None
        or high_50 is None
    ) and DataQuality.MISSING_HISTORY not in quality:
        quality.append(DataQuality.MISSING_HISTORY)
    if len(quality) > 1 and DataQuality.GOOD in quality:
        quality.remove(DataQuality.GOOD)

    return RunnerFeatureSnapshot(
        timestamp=tick.exchange_timestamp,
        source_timestamp=tick.exchange_timestamp,
        processing_timestamp=processing,
        session_date=tick.exchange_timestamp.astimezone(IST).date(),
        minute_timestamp=MinuteBarBuilder.minute_floor(tick.exchange_timestamp),
        minute_of_session=minute,
        symbol=tick.symbol,
        exchange=tick.exchange,
        ltp=tick.ltp,
        ret_1m=returns[1],
        ret_3m=returns[3],
        ret_5m=returns[5],
        ret_10m=returns[10],
        ret_15m=returns[15],
        ret_30m=returns[30],
        ret_from_open=pct_change(tick.ltp, tick.day_open),
        ret_from_prev_close=pct_change(tick.ltp, tick.previous_close),
        return_z_1m=_return_z(returns[1], short("ret_1m")),
        return_z_5m=_return_z(returns[5], short("ret_5m")),
        return_z_15m=_return_z(returns[15], short("ret_15m")),
        rvol_tod_20d=safe_ratio(
            cumulative, cumulative_short.median if cumulative_short else None
        ),
        rvol_tod_60d=safe_ratio(
            cumulative, cumulative_long.median if cumulative_long else None
        ),
        rvol_tod_z_20d=zscore(
            float(cumulative) if cumulative is not None else None,
            cumulative_short.mean if cumulative_short else None,
            cumulative_short.std if cumulative_short else None,
        ),
        rvol_tod_z_60d=zscore(
            float(cumulative) if cumulative is not None else None,
            cumulative_long.mean if cumulative_long else None,
            cumulative_long.std if cumulative_long else None,
        ),
        volume_percentile_20d=approximate_percentile(
            float(cumulative) if cumulative is not None else None,
            cumulative_short.median if cumulative_short else None,
            cumulative_short.percentiles if cumulative_short else None,
        ),
        volume_percentile_60d=approximate_percentile(
            float(cumulative) if cumulative is not None else None,
            cumulative_long.median if cumulative_long else None,
            cumulative_long.percentiles if cumulative_long else None,
        ),
        rvol_1m=volume_ratios[1],
        rvol_3m=volume_ratios[3],
        rvol_5m=rvol5,
        rvol_10m=volume_ratios[10],
        rvol_15m=volume_ratios[15],
        volume_velocity_1m=volume_ratios[1],
        volume_velocity_3m=volume_ratios[3],
        volume_velocity_5m=rvol5,
        volume_acceleration=acceleration,
        turnover=tick.cumulative_turnover,
        turnover_velocity=safe_ratio(
            tick.cumulative_turnover,
            short("cumulative_turnover").median
            if short("cumulative_turnover")
            else None,
        ),
        current_intraday_range=current_range,
        range_tod_ratio=safe_ratio(
            current_range, range_stat.median if range_stat else None
        ),
        range_expansion=zscore(
            current_range,
            range_stat.mean if range_stat else None,
            range_stat.std if range_stat else None,
        ),
        atr_normalized_move=safe_ratio(
            abs(tick.ltp - tick.previous_close)
            if tick.previous_close is not None
            else None,
            atr,
        ),
        vwap=vwap,
        above_vwap=tick.ltp >= vwap if vwap else None,
        distance_vwap_pct=pct_change(tick.ltp, vwap),
        vwap_slope=vwap_slope,
        pdh=pdh,
        pdl=pdl,
        distance_pdh_pct=pct_change(tick.ltp, pdh),
        distance_pdl_pct=pct_change(tick.ltp, pdl),
        pdh_break=tick.ltp > pdh if pdh else None,
        pdl_break=tick.ltp < pdl if pdl else None,
        orb15_break_high=tick.ltp > orb.orb_high_15
        if orb and orb.orb_high_15
        else None,
        orb15_break_low=tick.ltp < orb.orb_low_15 if orb and orb.orb_low_15 else None,
        orb30_break_high=tick.ltp > orb.orb_high_30
        if orb and orb.orb_high_30
        else None,
        orb30_break_low=tick.ltp < orb.orb_low_30 if orb and orb.orb_low_30 else None,
        distance_20d_high_pct=pct_change(tick.ltp, high_20),
        distance_50d_high_pct=pct_change(tick.ltp, high_50),
        at_20d_high=tick.ltp >= high_20 if high_20 else None,
        at_50d_high=tick.ltp >= high_50 if high_50 else None,
        day_range_location=range_location,
        close_location_value=clv,
        sector=ctx.get("sector"),
        sector_return=ctx.get("sector_return"),
        sector_relative_strength=ctx.get("sector_relative_strength"),
        sector_rank=ctx.get("sector_rank"),
        market_return=ctx.get("market_return"),
        market_above_vwap=ctx.get("market_above_vwap"),
        market_breadth=ctx.get("market_breadth"),
        market_regime=ctx.get("market_regime"),
        spread_bps=spread_bps,
        depth_metadata={
            "buy_levels": len(tick.depth_buy or []),
            "sell_levels": len(tick.depth_sell or []),
        }
        if tick.depth_buy is not None or tick.depth_sell is not None
        else None,
        abnormal_score=ctx.get("abnormal_score"),
        accumulation_score=ctx.get("accumulation_score"),
        institutional_score=ctx.get("institutional_score"),
        market_pulse=ctx.get("market_pulse"),
        cpr_metadata=ctx.get("cpr_metadata"),
        vcp_metadata=ctx.get("vcp_metadata"),
        data_source=tick.source_provider,
        data_quality=quality,
        freshness_seconds=max(0.0, freshness),
        feature_version=feature_version,
    )


def _return_z(value, stat):
    return zscore(value, stat.mean if stat else None, stat.std if stat else None)
