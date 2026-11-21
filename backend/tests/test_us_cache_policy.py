import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import Response

from app.us_main import private_us_cache_policy


@pytest.mark.parametrize('path', ['/api/us/plans', '/api/us/research/access', '/api/us/filings?symbol=AAPL'])
def test_unexpected_private_failures_are_sanitized_and_uncacheable(path):
    from fastapi.testclient import TestClient
    from app.us_main import app
    from app.us_auth import require_us_user
    def fail():
        raise RuntimeError('PRIVATE_TOKEN private-owner private-storage-path')
    prior = app.dependency_overrides.copy()
    app.dependency_overrides[require_us_user] = fail
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get(path)
        assert response.status_code == 500
        assert response.json() == {'detail': 'US service is temporarily unavailable'}
        assert response.headers['cache-control'] == 'private, no-store'
        assert response.headers['pragma'] == 'no-cache'
        assert response.headers['expires'] == '0'
        assert response.headers['vary'] == 'Authorization'
        assert 'PRIVATE_TOKEN' not in response.text
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(prior)


@pytest.mark.parametrize(
    ("second_header", "expected"),
    [
        ("Accept-Language", "Origin, Accept-Encoding, Accept-Language, Authorization"),
        ("authorization", "Origin, Accept-Encoding, authorization"),
        ("*", "Origin, Accept-Encoding, *"),
    ],
)
def test_private_cache_policy_preserves_repeated_vary_fields(second_header, expected):
    request = Request({"type": "http", "path": "/api/us/plans", "headers": []})
    upstream = Response(headers={"Vary": "Origin, Accept-Encoding"})
    upstream.headers.append("Vary", second_header)

    async def call_next(_request):
        return upstream

    response = asyncio.run(private_us_cache_policy(request, call_next))

    assert response.headers.getlist("Vary") == [expected]
    assert response.headers["Cache-Control"] == "private, no-store"
