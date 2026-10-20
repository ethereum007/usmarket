import asyncio
from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.core.symbols import (
    arrow_equity_symbol,
    canonical_equity_symbol,
    kite_equity_key,
)
from app.engines.runner.providers import KiteProvider, normalize_quote
from app.engines.runner.schemas import DataQuality, MarketDataSource

IST = ZoneInfo("Asia/Kolkata")


def test_kite_provider_normalization():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    raw = {
        "instrument_token": 123,
        "exchange_timestamp": now,
        "last_price": 101.5,
        "volume_traded": 5000,
        "average_price": 100,
        "ohlc": {"open": 99, "high": 102, "low": 98, "close": 100},
        "depth": {
            "buy": [{"price": 101.4, "quantity": 10}],
            "sell": [{"price": 101.6, "quantity": 12}],
        },
        "total_buy_quantity": 100,
        "total_sell_quantity": 120,
    }
    tick = normalize_quote("TEST", raw, MarketDataSource.KITE, received_at=now)
    assert tick.symbol == "TEST"
    assert tick.cumulative_volume == 5000
    assert tick.cumulative_turnover == 500_000
    assert tick.spread == pytest.approx(0.2)


def test_kite_websocket_average_traded_price_derives_turnover_and_vwap():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = normalize_quote(
        "TEST",
        {
            "instrument_token": 123,
            "exchange_timestamp": now,
            "last_price": 101.5,
            "volume_traded": 5000,
            "average_traded_price": 100,
        },
        MarketDataSource.KITE,
        received_at=now,
    )

    assert tick.average_price == 100
    assert tick.cumulative_turnover == 500_000


def test_missing_provider_turnover_uses_disclosed_ltp_estimate():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = normalize_quote(
        "TEST",
        {
            "exchange_timestamp": now,
            "last_price": 101.5,
            "volume_traded": 5000,
        },
        MarketDataSource.KITE,
        received_at=now,
    )

    assert tick.average_price is None
    assert tick.cumulative_turnover == 507_500
    assert tick.data_quality == [DataQuality.PARTIAL]


def test_provider_payload_symbol_suffix_does_not_change_canonical_symbol():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = normalize_quote(
        "RELIANCE",
        {
            "tradingsymbol": "RELIANCE-EQ",
            "last_price": 100,
            "volume": 10,
            "timestamp": now,
        },
        MarketDataSource.ARROW,
        received_at=now,
    )

    assert tick.symbol == "RELIANCE"


def test_provider_symbol_formats_keep_one_canonical_equity_identity():
    assert canonical_equity_symbol("NSE:BAJAJ-AUTO-EQ") == "BAJAJ-AUTO"
    assert arrow_equity_symbol("BAJAJ-AUTO") == "BAJAJ-AUTO-EQ"
    assert arrow_equity_symbol("M&M") == "M&M-EQ"
    assert kite_equity_key("M&M-EQ") == "NSE:M&M"
    assert arrow_equity_symbol("NIFTY 50") == "NIFTY 50"


def test_kite_provider_accepts_arrow_transport_symbols():
    class Kite:
        def quote(self, instruments):
            assert instruments == ["NSE:BAJAJ-AUTO"]
            return {
                "NSE:BAJAJ-AUTO": {
                    "last_price": 100,
                    "volume": 10,
                    "timestamp": datetime(2026, 8, 4, 10, 0, tzinfo=IST),
                }
            }

    quotes = asyncio.run(KiteProvider(Kite()).get_quotes(["BAJAJ-AUTO-EQ"]))

    assert list(quotes) == ["BAJAJ-AUTO"]


def test_kite_broad_quotes_are_split_at_provider_limit():
    class Kite:
        def __init__(self):
            self.calls = []

        def quote(self, instruments):
            self.calls.append(instruments)
            return {
                instrument: {
                    "last_price": 100,
                    "volume": 10,
                    "timestamp": datetime(2026, 8, 4, 10, 0, tzinfo=IST),
                }
                for instrument in instruments
            }

    kite = Kite()
    symbols = [f"STOCK{index}" for index in range(501)]

    quotes = asyncio.run(KiteProvider(kite).get_quotes(symbols))

    assert len(kite.calls) == 2
    assert len(kite.calls[0]) == 500
    assert len(kite.calls[1]) == 1
    assert len(quotes) == 501


def test_arrow_provider_normalization():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    raw = {
        "instrument_token": "NSE:TEST",
        "timestamp": int(now.timestamp()),
        "last_price": 201,
        "volume": 900,
        "average_price": 200,
        "ohlc": {"open": 198, "high": 202, "low": 197, "close": 199},
        "source": "arrow",
        "exchange": "NSE",
    }
    tick = normalize_quote("TEST", raw, MarketDataSource.ARROW, received_at=now)
    assert tick.source_provider is MarketDataSource.ARROW
    assert tick.previous_close == 199
    assert tick.cumulative_volume == 900


def test_kite_minute_history_is_chunked_without_overlap():
    class Kite:
        def __init__(self):
            self.calls = []

        def historical_data(self, token, from_dt, to_dt, interval):
            self.calls.append((token, from_dt, to_dt, interval))
            return [{"date": from_dt}]

    kite = Kite()
    start = datetime(2026, 1, 1, 9, 15, tzinfo=IST)
    end = start + timedelta(days=130)
    with patch("app.caches.instrument_cache.get_instrument_token", return_value=123):
        rows = asyncio.run(KiteProvider(kite).get_history("TEST", start, end))

    assert len(rows) == len(kite.calls) == 3
    assert kite.calls[1][1] == kite.calls[0][2] + timedelta(minutes=1)
    assert kite.calls[2][2] == end


def test_missing_provider_timestamp_and_volume_are_partial():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = normalize_quote(
        "TEST", {"last_price": 100}, MarketDataSource.ARROW, received_at=now
    )

    assert tick.exchange_timestamp == now
    assert tick.data_quality == [DataQuality.PARTIAL]


def test_future_provider_timestamp_is_clock_anomaly():
    now = datetime(2026, 8, 4, 10, 0, tzinfo=IST)
    tick = normalize_quote(
        "TEST",
        {
            "last_price": 100,
            "volume": 10,
            "timestamp": now + timedelta(seconds=5),
        },
        MarketDataSource.ARROW,
        received_at=now,
    )

    assert DataQuality.CLOCK_ANOMALY in tick.data_quality
    assert DataQuality.GOOD not in tick.data_quality


import pytest
