from __future__ import annotations

from starlette.requests import Request

from app.core.request_rate_limiter import request_identity


def test_unverified_auth_and_forwarded_headers_cannot_choose_rate_bucket() -> None:
    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/api/intraday/radar",
        "headers": [
            (b"authorization", b"Bearer attacker-controlled-jwt"),
            (b"x-forwarded-for", b"198.51.100.99"),
        ],
        "client": ("203.0.113.25", 45678),
    })

    assert request_identity(request) == "client:203.0.113.25"
