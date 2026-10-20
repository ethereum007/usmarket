from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.engines.runner.context import RunnerContextStore, derive_market_context
from app.engines.runner.schemas import MarketDataSource, NormalizedMarketTick

IST = ZoneInfo("Asia/Kolkata")


def _tick(
    symbol: str,
    ltp: float,
    *,
    at: datetime,
    previous_close: float = 100.0,
    average_price: float | None = None,
) -> NormalizedMarketTick:
    return NormalizedMarketTick(
        symbol=symbol,
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=ltp,
        previous_close=previous_close,
        average_price=average_price,
        cumulative_volume=1_000,
        source_provider=MarketDataSource.KITE,
    )


def test_market_context_derives_breadth_sector_rank_and_nifty_context():
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    ticks = [
        _tick("TCS", 102, at=at),
        _tick("INFY", 104, at=at),
        _tick("HDFCBANK", 99, at=at),
        _tick("RELIANCE", 103, at=at),
    ]
    benchmark = _tick(
        "NIFTY 50", 25_250, at=at, previous_close=25_000, average_price=25_100
    )

    context = derive_market_context(
        ticks,
        benchmark=benchmark,
        as_of=at + timedelta(seconds=5),
        minimum_symbols=1,
    )

    assert context.symbols_sampled == 4
    assert context.advancing == 3
    assert context.declining == 1
    assert context.market_breadth == 75.0
    assert context.market_regime == "bullish trend"
    assert context.market_return == pytest.approx(1.0)
    assert context.market_above_vwap is True
    assert context.sector_returns["IT"] == pytest.approx(3.0)
    assert context.sector_returns["Banks"] == pytest.approx(-1.0)
    assert "Others" not in context.sector_returns
    assert context.sector_ranks == {"IT": 1, "Energy": 2, "Banks": 3}


def test_market_context_excludes_stale_wrong_day_and_future_ticks():
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    ticks = [
        _tick("TCS", 102, at=at - timedelta(seconds=31)),
        _tick("INFY", 104, at=at - timedelta(days=1)),
        _tick("HDFCBANK", 99, at=at + timedelta(seconds=1)),
    ]
    stale_benchmark = _tick(
        "NIFTY 50",
        25_250,
        at=at - timedelta(seconds=31),
        previous_close=25_000,
        average_price=25_100,
    )

    context = derive_market_context(
        ticks,
        benchmark=stale_benchmark,
        as_of=at,
        stale_after_seconds=30,
        minimum_symbols=1,
    )

    assert context.symbols_sampled == 0
    assert context.market_breadth is None
    assert context.market_regime is None
    assert context.market_return is None
    assert context.market_above_vwap is None
    assert context.sector_returns == {}


def test_market_regime_waits_for_minimum_fresh_coverage():
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    context = derive_market_context(
        [_tick("TCS", 110, at=at)], as_of=at, minimum_symbols=2
    )

    assert context.market_breadth == 100.0
    assert context.coverage_sufficient is False
    assert context.market_regime is None


def test_context_store_joins_relative_strength_and_reports_diagnostics():
    at = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    market = derive_market_context(
        [_tick("TCS", 102, at=at), _tick("HDFCBANK", 101, at=at)],
        benchmark=_tick("NIFTY 50", 100.5, at=at, previous_close=100),
        as_of=at,
        minimum_symbols=1,
    )
    store = RunnerContextStore()
    store.set_market(market)

    joined = store.get("TCS")
    diagnostics = store.market_diagnostics()

    assert joined["sector"] == "IT"
    assert joined["sector_return"] == pytest.approx(2.0)
    assert joined["sector_relative_strength"] == pytest.approx(1.5)
    assert diagnostics["symbolsSampled"] == 2
    assert diagnostics["sectorCount"] == 2
    assert diagnostics["niftyReturn"] == pytest.approx(0.5)
