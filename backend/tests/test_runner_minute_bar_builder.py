from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.engines.runner.minute_bar_builder import MinuteBarBuilder
from app.engines.runner.schemas import (
    DataQuality,
    MarketDataSource,
    NormalizedMarketTick,
)

IST = ZoneInfo("Asia/Kolkata")


def tick(at, price, volume, turnover=None):
    return NormalizedMarketTick(
        symbol="TEST",
        exchange="NSE",
        exchange_timestamp=at,
        received_timestamp=at,
        ltp=price,
        cumulative_volume=volume,
        cumulative_turnover=turnover,
        source_provider=MarketDataSource.KITE,
    )


def test_ohlc_incremental_volume_and_rollover():
    builder = MinuteBarBuilder()
    start = datetime(2026, 8, 3, 9, 15, 1, tzinfo=IST)
    builder.update(tick(start, 100, 10, 1000))
    builder.update(tick(start + timedelta(seconds=20), 104, 15, 1520))
    builder.update(tick(start + timedelta(seconds=40), 99, 20, 2015))
    completed = builder.update(tick(start + timedelta(minutes=1), 102, 25, 2525))
    assert len(completed) == 1
    assert (
        completed[0].open,
        completed[0].high,
        completed[0].low,
        completed[0].close,
    ) == (100, 104, 99, 99)
    assert completed[0].volume == 20
    assert completed[0].traded_value == 2015
    assert builder.current("TEST").volume == 5


def test_duplicate_out_of_order_missing_minute_and_reset():
    builder = MinuteBarBuilder()
    start = datetime(2026, 8, 3, 9, 15, tzinfo=IST)
    first = tick(start, 100, 100)
    builder.update(first)
    builder.update(first)
    assert builder.current("TEST").tick_count == 1
    assert builder.duplicates_ignored == 1

    # A gap does not fabricate zero-volume bars.
    builder.update(tick(start + timedelta(minutes=3), 101, 130))
    assert [b.minute_timestamp.minute for b in builder.bars("TEST")] == [15, 18]
    builder.update(tick(start + timedelta(minutes=1), 50, 999))
    assert builder.current("TEST").close == 101

    # Provider cumulative counter reset is explicit, not a negative bar.
    builder.update(tick(start + timedelta(minutes=3, seconds=10), 102, 4))
    current = builder.current("TEST")
    assert current.volume == 34
    assert DataQuality.VOLUME_RESET in current.quality

    builder.update(tick(start + timedelta(days=1), 200, 7))
    assert len(builder.bars("TEST")) == 1
    assert builder.current("TEST").volume == 7


def test_late_process_start_does_not_claim_cumulative_volume_as_one_minute():
    builder = MinuteBarBuilder()
    at = datetime(2026, 8, 3, 9, 32, tzinfo=IST)
    builder.update(tick(at, 100, 1_200_000))
    current = builder.current("TEST")
    assert current.cumulative_volume == 1_200_000
    assert current.volume == 0
    assert DataQuality.PARTIAL in current.quality
    assert DataQuality.MISSING_HISTORY in current.quality
