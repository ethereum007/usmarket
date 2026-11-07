import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import Response

from app.us_main import private_us_cache_policy


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
