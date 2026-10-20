"""Explicit, versioned schemas shared by Runner calculation and persistence."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class MarketDataSource(StrEnum):
    KITE = "KITE"
    ARROW = "ARROW"
    UNKNOWN = "UNKNOWN"


class DataQuality(StrEnum):
    GOOD = "GOOD"
    STALE = "STALE"
    MISSING_BASELINE = "MISSING_BASELINE"
    MISSING_HISTORY = "MISSING_HISTORY"
    PARTIAL = "PARTIAL"
    PROVIDER_MISMATCH = "PROVIDER_MISMATCH"
    VOLUME_RESET = "VOLUME_RESET"
    CLOCK_ANOMALY = "CLOCK_ANOMALY"


class DepthLevel(BaseModel):
    price: float | None = None
    quantity: int | None = None
    orders: int | None = None


class NormalizedMarketTick(BaseModel):
    """Canonical live state. No downstream formula consumes broker dictionaries."""

    model_config = ConfigDict(extra="ignore")

    symbol: str
    exchange: str = "NSE"
    instrument_token: int | str | None = None
    exchange_timestamp: datetime
    received_timestamp: datetime
    ltp: float
    day_open: float | None = None
    day_high: float | None = None
    day_low: float | None = None
    previous_close: float | None = None
    cumulative_volume: int | None = None
    cumulative_turnover: float | None = None
    average_price: float | None = None
    best_bid: float | None = None
    best_ask: float | None = None
    spread: float | None = None
    total_buy_quantity: int | None = None
    total_sell_quantity: int | None = None
    depth_buy: list[DepthLevel] | None = None
    depth_sell: list[DepthLevel] | None = None
    oi: int | None = None
    source_provider: MarketDataSource = MarketDataSource.UNKNOWN
    freshness_seconds: float = 0.0
    data_quality: list[DataQuality] = Field(default_factory=lambda: [DataQuality.GOOD])


class MinuteBar(BaseModel):
    symbol: str
    exchange: str
    minute_timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int = 0
    cumulative_volume: int | None = None
    traded_value: float | None = None
    cumulative_traded_value: float | None = None
    vwap: float | None = None
    tick_count: int = 0
    quality: list[DataQuality] = Field(default_factory=lambda: [DataQuality.GOOD])


class BaselineStat(BaseModel):
    symbol: str
    minute_of_session: int
    lookback_sessions: int
    metric: str
    median: float | None
    mean: float | None
    std: float | None
    percentiles: dict[str, float] = Field(default_factory=dict)
    as_of_date: date
    baseline_version: str
    sample_count: int


class DailyStructureContext(BaseModel):
    """Slow daily features built only from sessions before ``as_of_date``."""

    symbol: str
    as_of_date: date
    atr14: float | None = None
    high_20d: float | None = None
    high_50d: float | None = None
    sample_count: int


class RunnerFeatureSnapshot(BaseModel):
    """Research-safe minute feature vector. Missing observations remain null."""

    timestamp: datetime
    source_timestamp: datetime
    processing_timestamp: datetime
    session_date: date
    minute_timestamp: datetime
    minute_of_session: int
    symbol: str
    exchange: str
    ltp: float
    ret_1m: float | None = None
    ret_3m: float | None = None
    ret_5m: float | None = None
    ret_10m: float | None = None
    ret_15m: float | None = None
    ret_30m: float | None = None
    ret_from_open: float | None = None
    ret_from_prev_close: float | None = None
    return_z_1m: float | None = None
    return_z_5m: float | None = None
    return_z_15m: float | None = None
    rvol_tod_20d: float | None = None
    rvol_tod_60d: float | None = None
    rvol_tod_z_20d: float | None = None
    rvol_tod_z_60d: float | None = None
    volume_percentile_20d: float | None = None
    volume_percentile_60d: float | None = None
    rvol_1m: float | None = None
    rvol_3m: float | None = None
    rvol_5m: float | None = None
    rvol_10m: float | None = None
    rvol_15m: float | None = None
    volume_velocity_1m: float | None = None
    volume_velocity_3m: float | None = None
    volume_velocity_5m: float | None = None
    volume_acceleration: float | None = None
    turnover: float | None = None
    turnover_velocity: float | None = None
    current_intraday_range: float | None = None
    range_tod_ratio: float | None = None
    range_expansion: float | None = None
    atr_normalized_move: float | None = None
    vwap: float | None = None
    above_vwap: bool | None = None
    distance_vwap_pct: float | None = None
    vwap_slope: float | None = None
    pdh: float | None = None
    pdl: float | None = None
    distance_pdh_pct: float | None = None
    distance_pdl_pct: float | None = None
    pdh_break: bool | None = None
    pdl_break: bool | None = None
    orb15_break_high: bool | None = None
    orb15_break_low: bool | None = None
    orb30_break_high: bool | None = None
    orb30_break_low: bool | None = None
    distance_20d_high_pct: float | None = None
    distance_50d_high_pct: float | None = None
    at_20d_high: bool | None = None
    at_50d_high: bool | None = None
    day_range_location: float | None = None
    close_location_value: float | None = None
    sector: str | None = None
    sector_return: float | None = None
    sector_relative_strength: float | None = None
    sector_rank: int | None = None
    market_return: float | None = None
    market_above_vwap: bool | None = None
    market_breadth: float | None = None
    market_regime: str | None = None
    spread_bps: float | None = None
    depth_metadata: dict[str, Any] | None = None
    abnormal_score: float | None = None
    accumulation_score: float | None = None
    institutional_score: float | None = None
    market_pulse: str | None = None
    cpr_metadata: dict[str, Any] | None = None
    vcp_metadata: dict[str, Any] | None = None
    data_source: MarketDataSource
    data_quality: list[DataQuality]
    freshness_seconds: float
    feature_version: str
