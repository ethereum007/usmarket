"""Thread-safe, cumulative-volume-aware one-minute OHLCV aggregation."""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import date, datetime, timedelta
from threading import RLock
from zoneinfo import ZoneInfo

from app.engines.runner.constants import MAX_ROLLING_BARS
from app.engines.runner.schemas import DataQuality, MinuteBar, NormalizedMarketTick

IST = ZoneInfo("Asia/Kolkata")


class MinuteBarBuilder:
    """Build bars without allocating DataFrames on the tick path."""

    def __init__(self, max_bars: int = MAX_ROLLING_BARS) -> None:
        self._current: dict[str, MinuteBar] = {}
        self._completed: dict[str, deque[MinuteBar]] = defaultdict(
            lambda: deque(maxlen=max_bars)
        )
        self._last_cumulative_volume: dict[str, int] = {}
        self._last_cumulative_turnover: dict[str, float] = {}
        self._session_date: date | None = None
        self._fingerprints: dict[str, tuple] = {}
        self._last_timestamp: dict[str, datetime] = {}
        self._lock = RLock()
        self.bars_completed = 0
        self.duplicates_ignored = 0

    @staticmethod
    def minute_floor(value: datetime) -> datetime:
        value = value if value.tzinfo else value.replace(tzinfo=IST)
        return value.astimezone(IST).replace(second=0, microsecond=0)

    def update(self, tick: NormalizedMarketTick) -> list[MinuteBar]:
        """Apply one tick and return bars completed by its minute rollover."""
        minute = self.minute_floor(tick.exchange_timestamp)
        with self._lock:
            if self._session_date != minute.date():
                self.reset(minute.date())

            fingerprint = (
                tick.exchange_timestamp,
                tick.ltp,
                tick.cumulative_volume,
                tick.cumulative_turnover,
            )
            if self._fingerprints.get(tick.symbol) == fingerprint:
                self.duplicates_ignored += 1
                return []
            self._fingerprints[tick.symbol] = fingerprint

            last_timestamp = self._last_timestamp.get(tick.symbol)
            if last_timestamp is not None and tick.exchange_timestamp < last_timestamp:
                if DataQuality.CLOCK_ANOMALY not in tick.data_quality:
                    tick.data_quality.append(DataQuality.CLOCK_ANOMALY)
                return []
            self._last_timestamp[tick.symbol] = tick.exchange_timestamp

            current = self._current.get(tick.symbol)
            if current and minute < current.minute_timestamp:
                if DataQuality.CLOCK_ANOMALY not in tick.data_quality:
                    tick.data_quality.append(DataQuality.CLOCK_ANOMALY)
                return []

            completed: list[MinuteBar] = []
            if current and minute > current.minute_timestamp:
                self._completed[tick.symbol].append(current.model_copy(deep=True))
                self.bars_completed += 1
                completed.append(current.model_copy(deep=True))
                current = None

            first_observation = tick.symbol not in self._last_cumulative_volume
            volume_delta, volume_reset = self._volume_delta(tick)
            turnover_delta = self._turnover_delta(tick)
            quality = list(tick.data_quality)
            session_minute = (minute.hour * 60 + minute.minute) - (9 * 60 + 15)
            if first_observation and session_minute > 0:
                volume_delta = 0
                turnover_delta = 0.0 if turnover_delta is not None else None
                quality = list(
                    dict.fromkeys(
                        [*quality, DataQuality.PARTIAL, DataQuality.MISSING_HISTORY]
                    )
                )
            if volume_reset and DataQuality.VOLUME_RESET not in quality:
                quality.append(DataQuality.VOLUME_RESET)

            if current is None:
                current = MinuteBar(
                    symbol=tick.symbol,
                    exchange=tick.exchange,
                    minute_timestamp=minute,
                    open=tick.ltp,
                    high=tick.ltp,
                    low=tick.ltp,
                    close=tick.ltp,
                    volume=volume_delta,
                    cumulative_volume=tick.cumulative_volume,
                    traded_value=turnover_delta,
                    cumulative_traded_value=tick.cumulative_turnover,
                    vwap=tick.average_price,
                    tick_count=1,
                    quality=quality,
                )
                self._current[tick.symbol] = current
            else:
                current.high = max(current.high, tick.ltp)
                current.low = min(current.low, tick.ltp)
                current.close = tick.ltp
                current.volume += volume_delta
                current.cumulative_volume = tick.cumulative_volume
                current.tick_count += 1
                current.quality = list(dict.fromkeys([*current.quality, *quality]))
                if turnover_delta is not None:
                    current.traded_value = (
                        current.traded_value or 0.0
                    ) + turnover_delta
                current.cumulative_traded_value = tick.cumulative_turnover
                current.vwap = tick.average_price or self._calculated_vwap(current)
            return completed

    def _volume_delta(self, tick: NormalizedMarketTick) -> tuple[int, bool]:
        cumulative = tick.cumulative_volume
        if cumulative is None:
            return 0, False
        cumulative = max(0, int(cumulative))
        previous = self._last_cumulative_volume.get(tick.symbol)
        self._last_cumulative_volume[tick.symbol] = cumulative
        if previous is None:
            return cumulative, False
        if cumulative < previous:
            return cumulative, True
        return cumulative - previous, False

    def _turnover_delta(self, tick: NormalizedMarketTick) -> float | None:
        cumulative = tick.cumulative_turnover
        if cumulative is None:
            return None
        previous = self._last_cumulative_turnover.get(tick.symbol)
        self._last_cumulative_turnover[tick.symbol] = cumulative
        if previous is None or cumulative < previous:
            return max(0.0, cumulative)
        return cumulative - previous

    @staticmethod
    def _calculated_vwap(bar: MinuteBar) -> float | None:
        if bar.cumulative_traded_value is None or not bar.cumulative_volume:
            return None
        return bar.cumulative_traded_value / bar.cumulative_volume

    def bars(self, symbol: str, *, include_current: bool = True) -> list[MinuteBar]:
        with self._lock:
            # Completed bars are immutable after rollover; only copy the mutable
            # current bar. Avoiding deep copies here is material at Nifty 500 scale.
            result = list(self._completed.get(symbol, ()))
            if include_current and symbol in self._current:
                result.append(self._current[symbol].model_copy())
            return result

    def current(self, symbol: str) -> MinuteBar | None:
        with self._lock:
            bar = self._current.get(symbol)
            return bar.model_copy() if bar else None

    def rolling_volume(
        self, symbol: str, minutes: int, *, as_of: datetime | None = None
    ) -> int | None:
        bars = self.bars(symbol)
        if as_of is not None:
            cutoff = self.minute_floor(as_of)
            bars = [bar for bar in bars if bar.minute_timestamp <= cutoff]
        if not bars:
            return None
        end = (
            self.minute_floor(as_of) if as_of is not None else bars[-1].minute_timestamp
        )
        start = end - timedelta(minutes=minutes - 1)
        return sum(bar.volume for bar in bars if start <= bar.minute_timestamp <= end)

    def prior_rolling_volume(self, symbol: str, minutes: int) -> int | None:
        bars = self.bars(symbol)
        if not bars:
            return None
        end = bars[-1].minute_timestamp - timedelta(minutes=minutes)
        start = end - timedelta(minutes=minutes - 1)
        selected = [bar for bar in bars if start <= bar.minute_timestamp <= end]
        return sum(bar.volume for bar in selected) if selected else None

    def reset(self, session_date: date | None = None) -> None:
        with self._lock:
            self._current.clear()
            self._completed.clear()
            self._last_cumulative_volume.clear()
            self._last_cumulative_turnover.clear()
            self._fingerprints.clear()
            self._last_timestamp.clear()
            self._session_date = session_date

    @property
    def session_date(self) -> date | None:
        return self._session_date
