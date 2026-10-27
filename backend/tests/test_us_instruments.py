import asyncio
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from uuid import UUID

import httpx
import pytest

from app.services.us_instruments import instrument_snapshot, load_instruments, bind_instruments
from app.services.us_research import research_package

NOW = datetime(2026, 10, 20, tzinfo=timezone.utc)


def asset(symbol, number=1, **changes):
    return {"id": str(UUID(int=number)), "symbol": symbol, "class": "us_equity",
            "exchange": "NASDAQ", "status": "active", "name": "Not used to infer share class", **changes}


def source():
    bar = {"t": "2026-07-01T04:00:00Z", "o": 10, "h": 12, "l": 9, "c": 11, "v": 100}
    result = research_package(["AAPL"], {"AAPL": [bar], "SPY": [bar]}, [{"date": "2026-07-01", "close": "16:00"}], NOW)
    result["setups"] = [{"symbol": "AAPL", "setup_id": "original-thesis", "setup_version": "original-version", "source_snapshot_id": result["source_snapshot_id"]}]
    return result


def snapshot(**changes):
    rows = {"AAPL": asset("AAPL"), "SPY": asset("SPY", 2)}
    rows.update(changes)
    return instrument_snapshot(["AAPL", "SPY"], rows, NOW)


def test_current_identity_unknown_subtype_and_listing_dates_are_honest():
    row = snapshot()["records"]["AAPL"]
    assert row["provider_asset_id"] == str(UUID(int=1))
    assert row["resolution"] == "resolved"
    assert row["security_type"] == "unclassified"
    assert row["listing_date"] is None and row["delisting_date"] is None
    assert "tradable" not in row


@pytest.mark.parametrize("bad", [None, {}, asset("OTHER"), asset("AAPL", **{"class": "crypto"}),
    asset("AAPL", id="not-uuid"), asset("AAPL", status="unknown"), asset("AAPL", exchange=None)])
def test_missing_malformed_wrong_class_or_alias_response_withholds_setups(bad):
    package = bind_instruments(source(), snapshot(AAPL=bad))
    assert package["state"] == "partial"
    assert package["setups"] == []
    assert "AAPL" in package["instrument_exclusions"]


def test_inactive_is_not_assumed_to_have_been_delisted_on_an_invented_date():
    evidence = snapshot(AAPL=asset("AAPL", status="inactive"))
    assert evidence["records"]["AAPL"]["resolution"] == "excluded"
    assert evidence["records"]["AAPL"]["delisting_date"] is None
    assert bind_instruments(source(), evidence)["state"] == "partial"


def test_two_requested_symbols_cannot_share_one_unambiguous_provider_identity():
    evidence = snapshot(SPY=asset("SPY", 1))
    assert all(row["resolution"] == "unavailable" for row in evidence["records"].values())
    with pytest.raises(ValueError, match="Benchmark"):
        bind_instruments(source(), evidence)


def test_ticker_reuse_changes_setup_identity_without_rewriting_original_package():
    original = source()
    first = bind_instruments(original, snapshot())
    second = bind_instruments(original, snapshot(AAPL=asset("AAPL", 3)))
    assert first["setups"][0]["setup_id"] != second["setups"][0]["setup_id"]
    assert first["setups"][0]["setup_version"] != second["setups"][0]["setup_version"]
    assert first["source_snapshot_id"] != second["source_snapshot_id"]
    assert original["setups"][0]["setup_id"] == "original-thesis"
    assert first["setups"][0]["provider_asset_id"] == str(UUID(int=1))


def test_repeat_observation_does_not_change_content_identity():
    initial = snapshot()
    repeated = instrument_snapshot(["SPY", "AAPL"], {"SPY": asset("SPY", 2), "AAPL": asset("AAPL")}, NOW + timedelta(minutes=5))
    assert initial["id"] == repeated["id"]
    package = source()
    assert bind_instruments(package, initial)["id"] == bind_instruments(package, repeated)["id"]


@pytest.mark.parametrize("status", [401, 403])
def test_provider_access_denial_does_not_echo_response_or_publish(status):
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status, text="private response"))) as client:
            with pytest.raises(RuntimeError, match="access denied") as error:
                await load_instruments(client, ["AAPL"])
            assert "private response" not in str(error.value)
    asyncio.run(exercise())


def test_read_only_asset_transport_and_missing_provider_response():
    requests = []
    def handler(request):
        requests.append(request)
        symbol = request.url.path.rsplit("/", 1)[1]
        return httpx.Response(404) if symbol == "MISSING" else httpx.Response(200, json=asset(symbol))
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await load_instruments(client, ["AAPL", "MISSING"])
        assert result["records"]["MISSING"]["resolution"] == "unavailable"
        assert result["records"]["AAPL"]["resolution"] == "resolved"
    asyncio.run(exercise())
    assert all(request.method == "GET" and request.url.path.startswith("/v2/assets/") for request in requests)


def test_refresh_wires_identity_before_publication_without_network_or_credentials(tmp_path):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app.services import us_research
    package = source()
    with patch.object(us_research, "load_dotenv"), patch.object(us_research.os, "getenv", return_value="synthetic-test"), \
         patch.object(us_research, "load_instruments", AsyncMock(return_value=snapshot())), \
         patch.object(us_research.AlpacaHistory, "load", AsyncMock(return_value=([], {}))), \
         patch.object(us_research, "research_package", return_value=package):
        result = asyncio.run(us_research.run(SimpleNamespace(symbols="AAPL", benchmark="SPY", feed="sip", output=str(tmp_path))))
    assert result["instrument_snapshot"]["records"]["AAPL"]["provider_asset_id"] == str(UUID(int=1))
    assert result["version"] == "us-swing-eod-v3"
    assert (tmp_path / (result["id"] + ".json")).exists()


@pytest.mark.parametrize('status',[401,403])
def test_denied_lookup_cancels_and_drains_other_provider_requests(status):
    async def exercise():
        sibling_started=asyncio.Event();started=[];cancelled=[]
        async def handler(request):
            symbol=request.url.path.rsplit('/',1)[-1]
            started.append(symbol)
            if symbol=='AAPL':
                await sibling_started.wait()
                return httpx.Response(status,text='Private provider detail')
            sibling_started.set()
            try:await asyncio.Event().wait()
            finally:cancelled.append(symbol)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(RuntimeError,match='access denied') as error:
                await load_instruments(client,['AAPL','MSFT','NVDA','SPY','QQQ','AMD','META'])
            assert 'Private provider detail' not in str(error.value)
            count=len(started)
            await asyncio.sleep(0)
            assert len(started)==count
            assert set(cancelled)==set(started)-{'AAPL'} and cancelled
            assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    asyncio.run(exercise())


def test_caller_cancellation_drains_all_instrument_lookup_tasks():
    async def exercise():
        started=asyncio.Event();active=set()
        async def handler(request):
            symbol=request.url.path.rsplit('/',1)[-1]
            active.add(symbol);started.set()
            try:await asyncio.Event().wait()
            finally:active.remove(symbol)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            parent=asyncio.create_task(load_instruments(client,['AAPL','MSFT','NVDA','SPY','QQQ','AMD']))
            await started.wait()
            parent.cancel()
            with pytest.raises(asyncio.CancelledError):await parent
            assert not active
            assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    asyncio.run(exercise())
