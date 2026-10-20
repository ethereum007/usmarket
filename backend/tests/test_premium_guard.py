from __future__ import annotations

import unittest

from fastapi import HTTPException
from starlette.requests import Request

from app.dependencies import require_premium


def make_request(host: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/admin/signal-stats",
            "headers": [(b"host", host.encode("utf-8"))],
        }
    )


class PremiumGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_guest_production_request_is_not_granted_dev_premium(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await require_premium(make_request("alpha-radar.in"), sb=None)  # type: ignore[arg-type]

        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(ctx.exception.detail, "Authentication required")

    async def test_guest_localhost_request_keeps_dev_premium_bypass(self) -> None:
        user = await require_premium(make_request("localhost:9000"), sb=None)  # type: ignore[arg-type]

        self.assertTrue(user["is_premium"])
        self.assertTrue(user["is_admin"])


if __name__ == "__main__":
    unittest.main()
