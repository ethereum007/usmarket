from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace
from unittest.mock import patch

from fastapi import HTTPException

from app.config import settings
from app.services.provider_gateway import ProviderGateway


class ProviderGatewayTest(unittest.IsolatedAsyncioTestCase):
    async def test_retries_consume_individual_provider_request_slots(self) -> None:
        gateway = ProviderGateway()
        attempts = 0

        async def flaky_operation() -> str:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise HTTPException(status_code=429, detail="provider busy")
            return "ok"

        guarded_settings = replace(
            settings,
            ARROW_PROVIDER_REQUESTS_PER_MINUTE=10_000,
            ARROW_PROVIDER_MIN_INTERVAL_SECONDS=0,
            PROVIDER_MAX_RETRIES=1,
            PROVIDER_RETRY_BASE_SECONDS=0,
        )
        with patch("app.services.provider_gateway.settings", guarded_settings):
            result = await gateway.run("arrow", flaky_operation)

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, 2)
        self.assertEqual(gateway.metrics().get("arrow.requests"), 2)
        self.assertEqual(gateway.metrics().get("arrow.retries"), 1)

    async def test_provider_requests_are_spaced(self) -> None:
        gateway = ProviderGateway()
        started: list[float] = []

        async def operation() -> str:
            started.append(asyncio.get_running_loop().time())
            return "ok"

        guarded_settings = replace(
            settings,
            ARROW_PROVIDER_REQUESTS_PER_MINUTE=10_000,
            ARROW_PROVIDER_MIN_INTERVAL_SECONDS=0.02,
            PROVIDER_MAX_RETRIES=0,
        )
        with patch("app.services.provider_gateway.settings", guarded_settings):
            await gateway.run("arrow", operation)
            await gateway.run("arrow", operation)

        self.assertGreaterEqual(started[1] - started[0], 0.015)
        self.assertEqual(gateway.metrics().get("arrow.requests"), 2)


if __name__ == "__main__":
    unittest.main()
