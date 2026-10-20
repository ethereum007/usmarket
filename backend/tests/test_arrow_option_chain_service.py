import asyncio

from app.services import arrow_market_data_service as service
from app.services.arrow_market_data_service import _normalise_option_chain_response


def test_arrow_option_chain_normalizer_handles_index_chain_payload():
    payload = {
        "data": {
            "spot": 2403835,
            "prevClose": 2390000,
            "expiry": "23-JUN-2026",
            "chain": [
                {
                    "strike": 24000,
                    "CE": {
                        "symbol": "NIFTY26JUN24000CE",
                        "token": 111,
                        "ltp": 12550,
                        "oi": 1_000_000,
                        "oiChange": 50_000,
                        "volume": 12_000,
                        "iv": 14.2,
                        "bidQty": 1200,
                        "askQty": 900,
                    },
                    "PE": {
                        "symbol": "NIFTY26JUN24000PE",
                        "token": 112,
                        "ltp": 9550,
                        "oi": 1_200_000,
                        "oiChange": 80_000,
                        "volume": 15_000,
                        "iv": 15.1,
                        "bidQty": 1000,
                        "askQty": 1100,
                    },
                },
                {
                    "strike": 24050,
                    "CE": {"ltp": 10100, "oi": 800_000, "volume": 10_000},
                    "PE": {"ltp": 11700, "oi": 900_000, "volume": 11_000},
                },
                {
                    "strike": 24100,
                    "CE": {"ltp": 8250, "oi": 700_000, "volume": 9_000},
                    "PE": {"ltp": 14000, "oi": 850_000, "volume": 8_000},
                },
            ],
        }
    }

    result = _normalise_option_chain_response(
        payload,
        request_body={
            "underlying": "NIFTY",
            "exchange": "INDEX",
            "count": "20",
            "expiry": "23-JUN-2026",
        },
        elapsed_ms=42.0,
        index_key="nifty",
        name="NIFTY",
        lot_size=75,
        strike_step=50,
    )

    assert result["index"] == "nifty"
    assert result["provider"]["provider"] == "arrow"
    assert result["provider"]["exchange"] == "INDEX"
    assert result["spot"] == 24038.35
    assert result["expiry"] == "2026-06-23"
    assert len(result["chain"]) == 3
    assert result["chain"][0]["call"]["ltp"] == 125.5
    assert result["chain"][0]["put"]["oiChange"] == 80_000
    assert result["analytics"]["pcr"] > 1


def test_arrow_option_chain_normalizer_handles_stock_underlying_payload():
    payload = {
        "data": [
            {
                "strikePrice": 1700,
                "call": {"tradingSymbol": "ICICIGI30JUN1700CE", "ltp": 2210, "openInterest": 1000},
                "put": {"tradingSymbol": "ICICIGI30JUN1700PE", "ltp": 1815, "openInterest": 1200},
            },
            {
                "strikePrice": 1720,
                "call": {"tradingSymbol": "ICICIGI30JUN1720CE", "ltp": 1510, "openInterest": 900},
                "put": {"tradingSymbol": "ICICIGI30JUN1720PE", "ltp": 2265, "openInterest": 1500},
            },
            {
                "strikePrice": 1740,
                "call": {"tradingSymbol": "ICICIGI30JUN1740CE", "ltp": 1010, "openInterest": 700},
                "put": {"tradingSymbol": "ICICIGI30JUN1740PE", "ltp": 3075, "openInterest": 1600},
            },
        ]
    }

    result = _normalise_option_chain_response(
        payload,
        request_body={
            "underlying": "ICICIGI-EQ",
            "exchange": "NSE",
            "count": "20",
            "expiry": "30-JUN-2026",
        },
        elapsed_ms=35.0,
        index_key=None,
        name="ICICIGI",
        lot_size=0,
        strike_step=0,
    )

    assert result["index"] == "icicigi"
    assert result["provider"]["underlying"] == "ICICIGI-EQ"
    assert result["provider"]["exchange"] == "NSE"
    assert result["expiry"] == "2026-06-30"
    assert result["chain"][0]["call"]["tradingsymbol"] == "ICICIGI30JUN1700CE"
    assert result["analytics"]["totalPutOI"] == 4300


def test_option_chain_quote_enrichment_requests_only_atm_plus_minus_five(monkeypatch):
    requested: list[str] = []

    async def fake_fetch_quotes(symbols, *, exchange, mode):
        requested.extend(symbols)
        return {"_meta": {"requested": len(symbols), "returned": 0, "elapsedMs": 1.0}}

    monkeypatch.setattr(service, "fetch_quotes", fake_fetch_quotes)
    chain = [
        {
            "strike": strike,
            "call": {"tradingsymbol": f"TEST{strike}CE", "oi": 1},
            "put": {"tradingsymbol": f"TEST{strike}PE", "oi": 1},
        }
        for strike in range(900, 1110, 10)
    ]
    payload = {"spot": 1000, "chain": chain, "provider": {}}

    asyncio.run(service._enrich_option_chain_quotes(payload, quote_exchange="NFO"))

    assert len(requested) == 22
    assert payload["provider"]["quoteScope"] == "ATM ±5"
    assert payload["provider"]["quoteStrikes"] == [950, 960, 970, 980, 990, 1000, 1010, 1020, 1030, 1040, 1050]
