"""Cached slow-feature, sector and market context joined onto live features."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from statistics import mean
from threading import RLock
from typing import Any
from zoneinfo import ZoneInfo

from app.caches.sector_map import get_sector
from app.engines.runner.schemas import NormalizedMarketTick
from app.engines.runner.statistics import pct_change

IST = ZoneInfo("Asia/Kolkata")


@dataclass
class MarketContext:
    market_return: float | None = None
    market_above_vwap: bool | None = None
    market_breadth: float | None = None
    market_regime: str | None = None
    sector_returns: dict[str, float] = field(default_factory=dict)
    sector_ranks: dict[str, int] = field(default_factory=dict)
    source_timestamp: datetime | None = None
    symbols_sampled: int = 0
    advancing: int = 0
    declining: int = 0
    coverage_sufficient: bool = False


def derive_market_context(
    ticks: list[NormalizedMarketTick],
    *,
    benchmark: NormalizedMarketTick | None = None,
    as_of: datetime | None = None,
    stale_after_seconds: int = 30,
    minimum_symbols: int = 20,
) -> MarketContext:
    """Derive broad and sector context from current normalized live state."""
    now = as_of or datetime.now(IST)
    now = now.replace(tzinfo=IST) if now.tzinfo is None else now.astimezone(IST)
    returns: list[tuple[str, float, datetime]] = []
    for tick in ticks:
        timestamp = tick.exchange_timestamp.astimezone(IST)
        value = pct_change(tick.ltp, tick.previous_close)
        if (
            value is None
            or timestamp.date() != now.date()
            or (now - timestamp).total_seconds() > stale_after_seconds
            or timestamp > now
        ):
            continue
        returns.append((tick.symbol, value, timestamp))

    advancing = sum(value > 0.05 for _, value, _ in returns)
    declining = sum(value < -0.05 for _, value, _ in returns)
    breadth = advancing / len(returns) * 100 if returns else None
    average_return = mean(value for _, value, _ in returns) if returns else None
    coverage_sufficient = len(returns) >= max(1, minimum_symbols)
    if not coverage_sufficient or breadth is None or average_return is None:
        regime = None
    elif breadth >= 62 and average_return > 0.25:
        regime = "bullish trend"
    elif breadth <= 38 and average_return < -0.25:
        regime = "bearish trend"
    else:
        regime = "mixed or range-bound"

    sector_values: dict[str, list[float]] = {}
    for symbol, value, _ in returns:
        sector = get_sector(symbol)
        # "Others" is an unknown classification, not a coherent sector.
        if sector != "Others":
            sector_values.setdefault(sector, []).append(value)
    sector_returns = {
        sector: mean(values) for sector, values in sector_values.items() if values
    }
    ranked = sorted(sector_returns, key=sector_returns.get, reverse=True)

    benchmark_return: float | None = None
    benchmark_above_vwap: bool | None = None
    benchmark_timestamp: datetime | None = None
    if benchmark is not None:
        benchmark_timestamp = benchmark.exchange_timestamp.astimezone(IST)
        benchmark_is_current = (
            benchmark_timestamp.date() == now.date()
            and 0 <= (now - benchmark_timestamp).total_seconds() <= stale_after_seconds
        )
        if benchmark_is_current:
            benchmark_return = pct_change(benchmark.ltp, benchmark.previous_close)
            benchmark_above_vwap = (
                benchmark.ltp >= benchmark.average_price
                if benchmark.average_price is not None
                and benchmark.average_price > 0
                else None
            )

    timestamps = [timestamp for _, _, timestamp in returns]
    if benchmark_timestamp and benchmark_return is not None:
        timestamps.append(benchmark_timestamp)
    return MarketContext(
        market_return=benchmark_return,
        market_above_vwap=benchmark_above_vwap,
        market_breadth=breadth,
        market_regime=regime,
        sector_returns=sector_returns,
        sector_ranks={sector: index for index, sector in enumerate(ranked, 1)},
        source_timestamp=max(timestamps) if timestamps else None,
        symbols_sampled=len(returns),
        advancing=advancing,
        declining=declining,
        coverage_sufficient=coverage_sufficient,
    )


class RunnerContextStore:
    """Single join point for precomputed scanners; never runs them per tick."""

    def __init__(self) -> None:
        self._market = MarketContext()
        self._slow: dict[str, dict[str, Any]] = {}
        self._lock = RLock()

    def set_market(self, context: MarketContext) -> None:
        with self._lock:
            self._market = context

    def update_market(self, **values: Any) -> None:
        """Update available context fields while preserving independent sources."""
        with self._lock:
            for key, value in values.items():
                if value is not None and hasattr(self._market, key):
                    setattr(self._market, key, value)

    def market_diagnostics(self) -> dict[str, Any]:
        with self._lock:
            return {
                "sourceTimestamp": self._market.source_timestamp.isoformat()
                if self._market.source_timestamp
                else None,
                "symbolsSampled": self._market.symbols_sampled,
                "advancing": self._market.advancing,
                "declining": self._market.declining,
                "coverageSufficient": self._market.coverage_sufficient,
                "breadthPct": self._market.market_breadth,
                "regime": self._market.market_regime,
                "sectorCount": len(self._market.sector_returns),
                "niftyReturn": self._market.market_return,
                "niftyAboveVwap": self._market.market_above_vwap,
            }

    def set_slow_features(self, symbol: str, values: dict[str, Any]) -> None:
        with self._lock:
            self._slow[symbol.upper()] = dict(values)

    def update_slow_features(self, symbol: str, values: dict[str, Any]) -> None:
        """Merge one slow source without erasing scores supplied by other engines."""
        with self._lock:
            self._slow.setdefault(symbol.upper(), {}).update(values)

    def daily_structure_coverage(
        self, symbols: list[str], *, as_of_date: date | None = None
    ) -> dict[str, int]:
        """Return bounded coverage counts without exposing the full context store."""
        with self._lock:
            rows = [self._slow.get(symbol.upper(), {}) for symbol in symbols]
            if as_of_date is not None:
                rows = [
                    row
                    for row in rows
                    if row.get("daily_structure_as_of") == as_of_date
                ]
            return {
                "loaded": len(rows),
                "atr14": sum(row.get("atr14") is not None for row in rows),
                "high20d": sum(row.get("high_20d") is not None for row in rows),
                "high50d": sum(row.get("high_50d") is not None for row in rows),
            }

    def ingest_rows(
        self, rows: list[dict[str, Any]], *, score_field: str, target_field: str
    ) -> int:
        """Join a cached scanner response without rerunning the scanner on live ticks."""
        updated = 0
        with self._lock:
            for row in rows:
                symbol = str(row.get("symbol") or "").upper()
                if not symbol or row.get(score_field) is None:
                    continue
                self._slow.setdefault(symbol, {})[target_field] = row[score_field]
                updated += 1
        return updated

    def get(self, symbol: str) -> dict[str, Any]:
        with self._lock:
            sector = get_sector(symbol)
            result = dict(self._slow.get(symbol.upper(), {}))
            result.update(
                {
                    "sector": sector,
                    "sector_return": self._market.sector_returns.get(sector),
                    "sector_rank": self._market.sector_ranks.get(sector),
                    "market_return": self._market.market_return,
                    "market_above_vwap": self._market.market_above_vwap,
                    "market_breadth": self._market.market_breadth,
                    "market_regime": self._market.market_regime,
                }
            )
            market_return = self._market.market_return
            sector_return = result["sector_return"]
            result["sector_relative_strength"] = (
                sector_return - market_return
                if sector_return is not None and market_return is not None
                else None
            )
            return result


runner_context = RunnerContextStore()
