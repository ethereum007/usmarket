import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services.us_filings import issuer_for, filing_evidence, FilingUnavailable, SecGateway

NOW = datetime(2026, 10, 20, tzinfo=timezone.utc)


def payload():
    return {"cik": "0000000123", "filings": {"recent": {
        "accessionNumber": ["0000000123-26-000001", "0000000123-26-000002"],
        "form": ["8-K", "8-K/A"], "filingDate": ["2026-10-18", "2026-10-19"],
        "acceptanceDateTime": ["2026-10-18T20:00:00Z", "2026-10-19T20:00:00Z"],
        "primaryDocument": ["results.htm", "amendment.htm"], "items": ["2.02,9.01", "2.02"],
        "reportDate": ["2026-10-17", "2026-10-17"],
    }}}


def test_filing_dates_never_become_earnings_dates_and_amendments_preserved():
    evidence = filing_evidence("AAPL", "123", payload(), NOW)
    assert evidence["earnings_status"] == "unknown"
    assert evidence["filings"][0]["amendment"]
    assert len({row["id"] for row in evidence["filings"]}) == 2
    for row in evidence["filings"]:
        assert row["earnings_date"] is None and row["fiscal_period"] is None
        assert row["earnings_timing"] == "unknown"
        assert row["results_item_reported"]
        assert row["source_url"].startswith("https://www.sec.gov/Archives/edgar/data/123/")


@pytest.mark.parametrize("column,value", [
    ("acceptanceDateTime", "2026-10-21T01:00:00Z"), ("acceptanceDateTime", "2026-10-18T20:00:00"),
    ("primaryDocument", "../private.htm"), ("primaryDocument", "https://example.com/doc"),
    ("accessionNumber", "not-accession"), ("filingDate", "2026-02-30"), ("items", None),
])
def test_malformed_or_future_evidence_is_partial_not_false_clearance(column, value):
    data = payload()
    data["filings"]["recent"][column][0] = value
    evidence = filing_evidence("AAPL", "123", data, NOW)
    assert evidence["state"] == "partial" and evidence["omitted_records"] == 1
    assert evidence["earnings_status"] == "unknown"


@pytest.mark.parametrize("change", [None, [], {"recent": {}}, {"recent": {"accessionNumber": []}}])
def test_schema_failure_is_not_an_empty_success(change):
    data = payload()
    data["filings"] = change
    with pytest.raises(FilingUnavailable):
        filing_evidence("AAPL", "123", data, NOW)


def test_inconsistent_columns_and_wrong_issuer_fail_closed():
    data = payload()
    data["filings"]["recent"]["form"].pop()
    with pytest.raises(FilingUnavailable):
        filing_evidence("AAPL", "123", data, NOW)
    with pytest.raises(FilingUnavailable):
        filing_evidence("AAPL", "999", payload(), NOW)


def test_duplicate_accession_is_reported_as_partial():
    data = payload()
    data["filings"]["recent"]["accessionNumber"][1] = data["filings"]["recent"]["accessionNumber"][0]
    evidence = filing_evidence("AAPL", "123", data, NOW)
    assert evidence["state"] == "partial" and evidence["omitted_records"] == 1


@pytest.mark.parametrize("mapping", [{}, {"0": {"ticker": "AAPL", "cik_str": "bad"}},
    {"0": {"ticker": "AAPL", "cik_str": 123}, "1": {"ticker": "AAPL", "cik_str": 456}}])
def test_missing_or_ambiguous_ticker_is_not_guessed(mapping):
    with pytest.raises(FilingUnavailable):
        issuer_for("AAPL", mapping)


def test_share_classes_can_share_issuer_without_claiming_asset_equivalence():
    mapping = {"0": {"ticker": "GOOG", "cik_str": 123}, "1": {"ticker": "GOOGL", "cik_str": 123}}
    assert issuer_for("GOOG", mapping) == issuer_for("GOOGL", mapping) == "123"


def test_mocked_get_transport_cache_retains_original_retrieval_time():
    requests = []
    def handler(request):
        requests.append(request)
        data = {"0": {"ticker": "AAPL", "cik_str": 123}} if request.url.host == "www.sec.gov" else payload()
        return httpx.Response(200, json=data)
    async def exercise():
        gateway = SecGateway(interval=0)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            first = await gateway.load("AAPL", client)
            second = await gateway.load("AAPL", client)
        assert first["observed_at"] == second["observed_at"]
    asyncio.run(exercise())
    assert len(requests) == 2 and all(row.method == "GET" for row in requests)
    assert requests[1].url.path == "/submissions/CIK0000000123.json"


@pytest.mark.parametrize("status", [403, 429, 500, 302])
def test_provider_failure_is_sanitized_and_not_cached_as_empty(status):
    async def exercise():
        gateway = SecGateway(interval=0)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status, text="private provider response"))) as client:
            with pytest.raises(FilingUnavailable) as error:
                await gateway.load("AAPL", client)
            assert "private provider" not in str(error.value)
            assert gateway.cache == {}
    asyncio.run(exercise())


def test_missing_service_user_agent_fails_without_network():
    async def exercise():
        with patch("app.services.us_filings.os.getenv", return_value=""):
            with pytest.raises(FilingUnavailable, match="not configured"):
                await SecGateway().load("AAPL")
    asyncio.run(exercise())


@pytest.mark.parametrize('blocked_at', ['lock', 'mapping', 'submissions'])
def test_total_deadline_cancels_wait_and_allows_later_recovery(monkeypatch, blocked_at):
    monkeypatch.setattr('app.services.us_filings.REQUEST_DEADLINE_SECONDS', 0.02)
    async def exercise():
        gateway = SecGateway(interval=0)
        requests, cancelled = [], []
        blocked = asyncio.Event()
        async def handler(request):
            requests.append(request.url.host)
            is_mapping = request.url.host == 'www.sec.gov'
            if (blocked_at == 'mapping' and is_mapping) or (blocked_at == 'submissions' and not is_mapping):
                try:
                    await blocked.wait()
                finally:
                    cancelled.append(True)
            return httpx.Response(200, json={'0': {'ticker': 'AAPL', 'cik_str': 123}} if is_mapping else payload())
        if blocked_at == 'lock':
            await gateway.lock.acquire()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            try:
                with pytest.raises(FilingUnavailable, match='timed out; earnings status remains unknown'):
                    await gateway.load('AAPL', client)
            finally:
                if blocked_at == 'lock':
                    gateway.lock.release()
            if blocked_at == 'lock':
                assert requests == [] and cancelled == []
            else:
                assert cancelled == [True]
                assert not gateway.lock.locked()
            assert all('submissions' not in url for url in gateway.cache)
            blocked.set()
            monkeypatch.setattr('app.services.us_filings.REQUEST_DEADLINE_SECONDS', 1)
            recovered = await gateway.load('AAPL', client)
            assert recovered['earnings_status'] == 'unknown'
            assert recovered['filings']
    asyncio.run(exercise())


def test_caller_cancellation_is_not_relabelled_as_provider_failure():
    async def exercise():
        gateway = SecGateway(interval=0)
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def handler(request):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            task = asyncio.create_task(gateway.load('AAPL', client))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert cancelled.is_set() and not gateway.lock.locked()
            assert gateway.cache == {}
    asyncio.run(exercise())


def test_hosted_route_requires_auth_and_validates_symbol():
    from app.us_main import app
    from app.us_auth import require_us_user
    from app.routes import us_filings as api
    client = TestClient(app)
    assert client.get("/api/us/filings?symbol=AAPL", headers={"Host": "localhost"}).status_code == 401
    app.dependency_overrides[require_us_user] = lambda: {"id": "owner"}
    try:
        assert client.get("/api/us/filings?symbol=../bad").status_code == 422
        with patch.object(api.gateway, "load", AsyncMock(return_value={"symbol": "AAPL", "earnings_status": "unknown"})):
            assert client.get("/api/us/filings?symbol=AAPL").json()["evidence"]["earnings_status"] == "unknown"
        with patch.object(api.gateway, "load", AsyncMock(side_effect=FilingUnavailable("SEC evidence is temporarily unavailable"))):
            assert client.get("/api/us/filings?symbol=AAPL").status_code == 503
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize('agent',['missing-contact','contact@example.test\nsecret','contact@example.test\tsecret',
    'contact@example.test \u00e9','contact@example.test '+('x'*512)])
def test_invalid_sec_operator_header_never_constructs_provider_client(monkeypatch,agent):
    from unittest.mock import patch
    from app.services import us_filings as filings
    import asyncio
    monkeypatch.setenv('SEC_USER_AGENT',agent)
    with patch.object(filings.httpx,'AsyncClient') as client:
        with pytest.raises(filings.FilingUnavailable,match='not configured'):
            asyncio.run(filings.SecGateway().load('AAPL'))
        client.assert_not_called()
