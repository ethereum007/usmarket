"""Time-of-day baseline construction and exact-minute lookup."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime, timedelta
from threading import RLock
from zoneinfo import ZoneInfo

from app.engines.runner.constants import (
    DEFAULT_BASELINE_VERSION,
    MARKET_OPEN,
    SESSION_MINUTES,
)
from app.engines.runner.schemas import BaselineStat, MinuteBar
from app.engines.runner.statistics import describe, pct_change

IST = ZoneInfo("Asia/Kolkata")


def minute_of_session(value: datetime) -> int:
    local = value if value.tzinfo else value.replace(tzinfo=IST)
    local = local.astimezone(IST)
    return (local.hour * 60 + local.minute) - (
        MARKET_OPEN.hour * 60 + MARKET_OPEN.minute
    )


class BaselineRepository:
    """Hot in-memory baseline index populated from Postgres or a rebuild."""

    def __init__(self) -> None:
        self._items: dict[tuple[str, int, int, str], BaselineStat] = {}
        self._lock = RLock()

    def put_many(self, stats: Iterable[BaselineStat]) -> None:
        with self._lock:
            for stat in stats:
                self._items[
                    (
                        stat.symbol,
                        stat.minute_of_session,
                        stat.lookback_sessions,
                        stat.metric,
                    )
                ] = stat

    def replace_minute(self, minute: int, stats: Iterable[BaselineStat]) -> None:
        """Keep the hot index bounded to current and acceleration-prior slices."""
        with self._lock:
            self._items = {
                key: value
                for key, value in self._items.items()
                if max(0, minute - 5) <= key[1] <= minute
            }
            for stat in stats:
                self._items[
                    (
                        stat.symbol,
                        stat.minute_of_session,
                        stat.lookback_sessions,
                        stat.metric,
                    )
                ] = stat

    def get(
        self, symbol: str, minute: int, lookback: int, metric: str
    ) -> BaselineStat | None:
        with self._lock:
            return self._items.get((symbol.upper(), minute, lookback, metric))

    def for_symbol(self, symbol: str) -> list[BaselineStat]:
        with self._lock:
            return [
                v
                for (s, _m, _l, _metric), v in self._items.items()
                if s == symbol.upper()
            ]

    def coverage(self, symbols: Iterable[str], lookback: int) -> float:
        symbols = list(symbols)
        if not symbols:
            return 0.0
        covered = {
            s
            for (s, _m, l, metric) in self._items
            if l == lookback and metric == "cumulative_volume"
        }
        return round(len(set(symbols) & covered) / len(set(symbols)) * 100, 2)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def build_symbol_baselines(
    symbol: str,
    session_bars: dict[date, list[MinuteBar]],
    *,
    as_of_date: date,
    lookbacks: tuple[int, ...] = (20, 60),
    baseline_version: str = DEFAULT_BASELINE_VERSION,
) -> list[BaselineStat]:
    """Build reproducible baselines strictly from sessions before ``as_of_date``."""
    eligible = sorted(d for d in session_bars if d < as_of_date)
    result: list[BaselineStat] = []
    for lookback in lookbacks:
        selected_dates = set(eligible[-lookback:])
        by_minute_metric: dict[tuple[int, str], list[float]] = defaultdict(list)
        # Re-run per selected session to preserve lookback semantics.
        prior_closes = {
            day: max(
                session_bars[eligible[idx - 1]], key=lambda bar: bar.minute_timestamp
            ).close
            for idx, day in enumerate(eligible)
            if idx > 0 and session_bars[eligible[idx - 1]]
        }
        for session_date in selected_dates:
            bars = sorted(
                session_bars[session_date], key=lambda bar: bar.minute_timestamp
            )
            cumulative_volume = 0
            cumulative_turnover = 0.0
            session_high = session_low = None
            for idx, bar in enumerate(bars):
                minute = minute_of_session(bar.minute_timestamp)
                if minute < 0 or minute >= SESSION_MINUTES:
                    continue
                cumulative_volume = (
                    bar.cumulative_volume
                    if bar.cumulative_volume is not None
                    else cumulative_volume + bar.volume
                )
                cumulative_turnover = (
                    bar.cumulative_traded_value
                    if bar.cumulative_traded_value is not None
                    else cumulative_turnover + (bar.traded_value or 0)
                )
                session_high = (
                    bar.high if session_high is None else max(session_high, bar.high)
                )
                session_low = (
                    bar.low if session_low is None else min(session_low, bar.low)
                )
                values = {
                    "cumulative_volume": cumulative_volume,
                    "volume_1m": bar.volume,
                    "cumulative_turnover": cumulative_turnover,
                    "intraday_range": session_high - session_low,
                    "abs_move_open": abs(pct_change(bar.close, bars[0].open) or 0.0),
                }
                if session_date in prior_closes:
                    values["abs_move_prev_close"] = abs(
                        pct_change(bar.close, prior_closes[session_date]) or 0.0
                    )
                for window in (3, 5, 10, 15):
                    window_start = bar.minute_timestamp - timedelta(minutes=window - 1)
                    values[f"volume_{window}m"] = sum(
                        item.volume
                        for item in bars[: idx + 1]
                        if window_start <= item.minute_timestamp <= bar.minute_timestamp
                    )
                for window in (1, 5, 15):
                    target = bar.minute_timestamp - timedelta(minutes=window)
                    prior = next(
                        (
                            item
                            for item in reversed(bars[:idx])
                            if item.minute_timestamp <= target
                        ),
                        None,
                    )
                    if prior is not None:
                        values[f"ret_{window}m"] = pct_change(bar.close, prior.close)
                for metric, value in values.items():
                    if value is not None:
                        by_minute_metric[(minute, metric)].append(float(value))
        for (minute, metric), values in by_minute_metric.items():
            summary = describe(values)
            result.append(
                BaselineStat(
                    symbol=symbol.upper(),
                    minute_of_session=minute,
                    lookback_sessions=lookback,
                    metric=metric,
                    median=summary["median"],
                    mean=summary["mean"],
                    std=summary["std"],
                    percentiles=summary["percentiles"],
                    as_of_date=as_of_date,
                    baseline_version=baseline_version,
                    sample_count=int(summary["sample_count"]),
                )
            )
    return result


baseline_repository = BaselineRepository()
