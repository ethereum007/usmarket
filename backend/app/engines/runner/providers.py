"""Thin adapters over Alpha Radar's existing Kite and Arrow clients."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from app.core.symbols import (
    canonical_equity_symbol,
    canonical_equity_symbols,
    kite_equity_key,
)
from app.engines.runner.schemas import (
    DataQuality,
    DepthLevel,
    MarketDataSource,
    NormalizedMarketTick,
)

IST = ZoneInfo("Asia/Kolkata")
KITE_MINUTE_HISTORY_CHUNK_DAYS = 55
KITE_QUOTE_BATCH_SIZE = 500


class MarketDataProvider(Protocol):
    name: MarketDataSource

    async def get_quotes(
        self, symbols: list[str]
    ) -> dict[str, NormalizedMarketTick]: ...
    async def get_quote(self, symbol: str) -> NormalizedMarketTick | None: ...
    async def get_depth(
        self, symbol: str
    ) -> tuple[list[DepthLevel] | None, list[DepthLevel] | None]: ...
    async def get_history(
        self, symbol: str, from_dt: datetime, to_dt: datetime, interval: str = "minute"
    ) -> list[dict[str, Any]]: ...
    def subscribe(
        self, symbols: list[str], callback: Callable[[list[dict]], None]
    ) -> None: ...


def _timestamp(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        result = datetime.fromtimestamp(seconds, tz=IST)
    elif isinstance(value, str):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            result = fallback
    else:
        result = fallback
    return (
        result.replace(tzinfo=IST) if result.tzinfo is None else result.astimezone(IST)
    )


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _integer(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _levels(raw: Any) -> list[DepthLevel] | None:
    if not isinstance(raw, list):
        return None
    return [
        DepthLevel(
            price=_number(x.get("price")),
            quantity=_integer(x.get("quantity", x.get("qty"))),
            orders=_integer(x.get("orders")),
        )
        for x in raw
        if isinstance(x, dict)
    ]


def normalize_quote(
    symbol: str,
    raw: dict[str, Any],
    source: MarketDataSource,
    *,
    received_at: datetime | None = None,
) -> NormalizedMarketTick:
    """Normalize Kite ticks, Kite REST quotes, or Arrow's Kite-like output."""
    received = received_at or datetime.now(IST)
    received = (
        received.replace(tzinfo=IST)
        if received.tzinfo is None
        else received.astimezone(IST)
    )
    ohlc = raw.get("ohlc") if isinstance(raw.get("ohlc"), dict) else {}
    depth = raw.get("depth") if isinstance(raw.get("depth"), dict) else {}
    buys = depth.get("buy") or raw.get("bids")
    sells = depth.get("sell") or raw.get("asks")
    buy_levels, sell_levels = _levels(buys), _levels(sells)
    best_bid = buy_levels[0].price if buy_levels else None
    best_ask = sell_levels[0].price if sell_levels else None
    ltp = _number(raw.get("last_price", raw.get("ltp")))
    if ltp is None:
        raise ValueError(f"{source} quote for {symbol} has no LTP")
    raw_timestamp = raw.get(
        "exchange_timestamp", raw.get("timestamp", raw.get("time"))
    )
    exchange_ts = _timestamp(raw_timestamp, received)
    raw_freshness = (received - exchange_ts).total_seconds()
    freshness = max(0.0, raw_freshness)
    average_price = _number(
        raw.get(
            "average_price",
            raw.get("average_traded_price", raw.get("avgPrice")),
        )
    )
    cumulative_volume = _integer(raw.get("volume_traded", raw.get("volume")))
    cumulative_turnover = _number(raw.get("turnover"))
    quality = [DataQuality.GOOD]
    if raw_timestamp is None or cumulative_volume is None:
        quality = [DataQuality.PARTIAL]
    if raw_freshness < -1:
        quality = list(dict.fromkeys([*quality, DataQuality.CLOCK_ANOMALY]))
        if DataQuality.GOOD in quality:
            quality.remove(DataQuality.GOOD)
    if (
        cumulative_turnover is None
        and average_price is not None
        and cumulative_volume is not None
    ):
        cumulative_turnover = average_price * cumulative_volume
    elif cumulative_turnover is None and cumulative_volume is not None:
        # Kite occasionally omits ATP for an otherwise complete stream tick.
        # LTP x cumulative volume is adequate for a conservative liquidity gate,
        # but it is only an estimate, so never label the observation GOOD.
        cumulative_turnover = ltp * cumulative_volume
        quality = list(dict.fromkeys([*quality, DataQuality.PARTIAL]))
        if DataQuality.GOOD in quality:
            quality.remove(DataQuality.GOOD)
    return NormalizedMarketTick(
        # The adapter's requested symbol is canonical. Provider payload symbols may
        # contain transport suffixes such as Arrow's ``-EQ`` and must not leak into
        # universe membership, rolling bars, or persistence keys.
        symbol=symbol.upper(),
        exchange=(raw.get("exchange") or "NSE").upper(),
        instrument_token=raw.get("instrument_token", raw.get("token")),
        exchange_timestamp=exchange_ts,
        received_timestamp=received,
        ltp=ltp,
        day_open=_number(ohlc.get("open", raw.get("open"))),
        day_high=_number(ohlc.get("high", raw.get("high"))),
        day_low=_number(ohlc.get("low", raw.get("low"))),
        previous_close=_number(ohlc.get("close", raw.get("close"))),
        cumulative_volume=cumulative_volume,
        cumulative_turnover=cumulative_turnover,
        average_price=average_price,
        best_bid=best_bid,
        best_ask=best_ask,
        spread=best_ask - best_bid
        if best_bid is not None and best_ask is not None
        else None,
        total_buy_quantity=_integer(
            raw.get("total_buy_quantity", raw.get("totalBuyQty"))
        ),
        total_sell_quantity=_integer(
            raw.get("total_sell_quantity", raw.get("totalSellQty"))
        ),
        depth_buy=buy_levels,
        depth_sell=sell_levels,
        oi=_integer(raw.get("oi")),
        source_provider=source,
        freshness_seconds=freshness,
        data_quality=quality,
    )


class KiteProvider:
    name = MarketDataSource.KITE

    def __init__(self, kite: Any) -> None:
        self.kite = kite

    async def get_quotes(self, symbols: list[str]) -> dict[str, NormalizedMarketTick]:
        symbols = canonical_equity_symbols(symbols)
        quotes: dict[str, NormalizedMarketTick] = {}
        for offset in range(0, len(symbols), KITE_QUOTE_BATCH_SIZE):
            batch = symbols[offset : offset + KITE_QUOTE_BATCH_SIZE]
            raw = await asyncio.to_thread(
                self.kite.quote, [kite_equity_key(symbol) for symbol in batch]
            )
            quotes.update(
                {
                    symbol: normalize_quote(
                        symbol, raw[kite_equity_key(symbol)], self.name
                    )
                    for symbol in batch
                    if kite_equity_key(symbol) in raw
                }
            )
        return quotes

    async def get_quote(self, symbol: str) -> NormalizedMarketTick | None:
        canonical = canonical_equity_symbol(symbol)
        return (await self.get_quotes([canonical])).get(canonical)

    async def get_depth(
        self, symbol: str
    ) -> tuple[list[DepthLevel] | None, list[DepthLevel] | None]:
        quote = await self.get_quote(symbol)
        return (quote.depth_buy, quote.depth_sell) if quote else (None, None)

    async def get_history(
        self, symbol: str, from_dt: datetime, to_dt: datetime, interval: str = "minute"
    ) -> list[dict[str, Any]]:
        from app.caches.instrument_cache import get_instrument_token

        token = get_instrument_token(canonical_equity_symbol(symbol))
        if token is None:
            return []
        if interval != "minute":
            return await asyncio.to_thread(
                self.kite.historical_data, token, from_dt, to_dt, interval
            )
        # Kite minute history is requested in conservative bounded chunks so
        # the configurable 60-session baseline does not depend on one oversized
        # call. Boundaries do not overlap, preventing duplicated candles.
        rows: list[dict[str, Any]] = []
        cursor = from_dt
        while cursor <= to_dt:
            chunk_end = min(
                cursor + timedelta(days=KITE_MINUTE_HISTORY_CHUNK_DAYS), to_dt
            )
            rows.extend(
                await asyncio.to_thread(
                    self.kite.historical_data,
                    token,
                    cursor,
                    chunk_end,
                    interval,
                )
            )
            cursor = chunk_end + timedelta(minutes=1)
            if cursor <= to_dt:
                await asyncio.sleep(0.35)
        return rows

    def subscribe(
        self, symbols: list[str], callback: Callable[[list[dict]], None]
    ) -> None:
        from app.caches.instrument_cache import get_instrument_token
        from app.core.kite_ticker import init_ticker, subscribe

        tokens = [
            token
            for symbol in symbols
            if (
                token := get_instrument_token(canonical_equity_symbol(symbol))
            )
            is not None
        ]
        init_ticker(callback)
        subscribe(tokens)


class ArrowProvider:
    name = MarketDataSource.ARROW

    async def get_quotes(self, symbols: list[str]) -> dict[str, NormalizedMarketTick]:
        from app.services.arrow_market_data_service import fetch_quotes

        symbols = canonical_equity_symbols(symbols)
        raw = await fetch_quotes(symbols, exchange="NSE", mode="full")
        return {
            s: normalize_quote(s, raw[f"NSE:{s}"], self.name)
            for s in symbols
            if f"NSE:{s}" in raw
        }

    async def get_quote(self, symbol: str) -> NormalizedMarketTick | None:
        canonical = canonical_equity_symbol(symbol)
        return (await self.get_quotes([canonical])).get(canonical)

    async def get_depth(
        self, symbol: str
    ) -> tuple[list[DepthLevel] | None, list[DepthLevel] | None]:
        quote = await self.get_quote(symbol)
        return (quote.depth_buy, quote.depth_sell) if quote else (None, None)

    async def get_history(
        self, symbol: str, from_dt: datetime, to_dt: datetime, interval: str = "minute"
    ) -> list[dict[str, Any]]:
        from app.services.arrow_market_data_service import fetch_historical

        quote = await self.get_quote(symbol)
        token = quote.instrument_token if quote else None
        if token is None:
            return []
        payload = await fetch_historical(
            exchange="NSE",
            token=str(token),
            interval=interval,
            from_dt=from_dt,
            to_dt=to_dt,
        )
        data = payload.get("data", payload) if isinstance(payload, dict) else payload
        return (
            data
            if isinstance(data, list)
            else data.get("candles", [])
            if isinstance(data, dict)
            else []
        )

    def subscribe(
        self, symbols: list[str], callback: Callable[[list[dict]], None]
    ) -> None:
        raise NotImplementedError(
            "Existing Arrow integration is quote/history based; use configured batched polling"
        )
