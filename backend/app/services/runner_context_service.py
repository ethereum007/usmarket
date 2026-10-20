"""Rate-aware daily structure context for live Runner feature joins."""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.engines.runner.context import RunnerContextStore
from app.engines.runner.schemas import DailyStructureContext

logger = logging.getLogger("alpha_radar.runner.context")
IST = ZoneInfo("Asia/Kolkata")


def build_daily_structure(
    symbol: str, rows: list[Any], *, as_of_date: date
) -> DailyStructureContext:
    """Build leakage-safe structure from completed sessions before ``as_of_date``."""
    candles: dict[date, tuple[float, float, float, float, float]] = {}
    for row in rows:
        parsed = _parse_daily_row(row)
        if parsed is None or parsed[0] >= as_of_date:
            continue
        candle_date, open_, high, low, close, volume = parsed
        candidate = (open_, high, low, close, volume)
        current = candles.get(candle_date)
        # Deterministic duplicate selection: prefer the most complete volume,
        # then use OHLC as a stable provider-independent tie-break.
        if current is None or (volume, open_, high, low, close) > (
            current[4], current[0], current[1], current[2], current[3]
        ):
            candles[candle_date] = candidate

    ordered = [candles[key] for key in sorted(candles)]
    true_ranges: list[float] = []
    previous_close: float | None = None
    for _, high, low, close, _ in ordered:
        true_ranges.append(
            high - low
            if previous_close is None
            else max(high - low, abs(high - previous_close), abs(low - previous_close))
        )
        previous_close = close

    return DailyStructureContext(
        symbol=symbol.upper(),
        as_of_date=as_of_date,
        atr14=sum(true_ranges[-14:]) / 14 if len(true_ranges) >= 14 else None,
        high_20d=max(row[1] for row in ordered[-20:]) if len(ordered) >= 20 else None,
        high_50d=max(row[1] for row in ordered[-50:]) if len(ordered) >= 50 else None,
        sample_count=len(ordered),
    )


def _parse_daily_row(
    row: Any,
) -> tuple[date, float, float, float, float, float] | None:
    if isinstance(row, (list, tuple)) and len(row) >= 6:
        raw_date, open_, high, low, close, volume = row[:6]
    elif isinstance(row, dict):
        raw_date = row.get("date", row.get("timestamp", row.get("time")))
        open_, high, low, close, volume = (
            row.get("open"),
            row.get("high"),
            row.get("low"),
            row.get("close"),
            row.get("volume", 0),
        )
    else:
        return None
    try:
        if isinstance(raw_date, datetime):
            candle_date = raw_date.astimezone(IST).date() if raw_date.tzinfo else raw_date.date()
        elif isinstance(raw_date, date):
            candle_date = raw_date
        else:
            parsed_date = datetime.fromisoformat(
                str(raw_date).replace("Z", "+00:00")
            )
            candle_date = (
                parsed_date.astimezone(IST).date()
                if parsed_date.tzinfo
                else parsed_date.date()
            )
        values = tuple(float(value) for value in (open_, high, low, close))
        volume = float(volume or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    open_, high, low, close = values
    if (
        not all(math.isfinite(value) and value > 0 for value in values)
        or not math.isfinite(volume)
        or volume < 0
        or high < max(open_, low, close)
        or low > min(open_, high, close)
    ):
        return None
    return candle_date, open_, high, low, close, volume


class RunnerDailyContextService:
    """Warm slow daily features outside the live tick and snapshot paths."""

    def __init__(
        self,
        provider: Any,
        context_store: RunnerContextStore,
        *,
        request_delay_seconds: float = 0.35,
    ) -> None:
        self.provider = provider
        self.context_store = context_store
        self.request_delay_seconds = max(0.0, request_delay_seconds)
        self.running = False
        self.progress: dict[str, Any] = {}

    async def warm(
        self, symbols: list[str], *, as_of_date: date | None = None
    ) -> dict[str, Any]:
        if self.running:
            return {"accepted": False, "reason": "daily context warm already running"}
        cutoff = as_of_date or datetime.now(IST).date()
        normalized = list(dict.fromkeys(symbol.upper() for symbol in symbols if symbol))
        self.running = True
        self.progress = {
            "running": True,
            "asOfDate": cutoff.isoformat(),
            "total": len(normalized),
            "completed": 0,
            "loaded": 0,
            "failed": 0,
        }
        from_dt = datetime.combine(cutoff - timedelta(days=100), time.min, IST)
        to_dt = datetime.combine(cutoff - timedelta(days=1), time.max, IST)
        try:
            for index, symbol in enumerate(normalized, 1):
                try:
                    rows = await self.provider.get_history(symbol, from_dt, to_dt, "day")
                    context = build_daily_structure(symbol, rows, as_of_date=cutoff)
                    self.context_store.update_slow_features(
                        symbol,
                        {
                            **context.model_dump(),
                            "daily_structure_as_of": cutoff,
                        },
                    )
                    if context.sample_count:
                        self.progress["loaded"] += 1
                except Exception:
                    self.progress["failed"] += 1
                    logger.debug("Runner daily context failed for %s", symbol, exc_info=True)
                self.progress["completed"] = index
                if index % 25 == 0 or index == len(normalized):
                    logger.info(
                        "Runner daily context progress completed=%d total=%d loaded=%d failed=%d",
                        index,
                        len(normalized),
                        self.progress["loaded"],
                        self.progress["failed"],
                    )
                if self.request_delay_seconds and index < len(normalized):
                    await asyncio.sleep(self.request_delay_seconds)
        finally:
            self.running = False
            self.progress["running"] = False
        return {"accepted": True, **self.progress}
