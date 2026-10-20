from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.core.shared_store import SharedStore


class _FakeRedisClient:
    def __init__(self, *, ping_error: Exception | None = None) -> None:
        self.ping = AsyncMock(side_effect=ping_error)
        self.aclose = AsyncMock()


class SharedStoreRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_store_retries_connection_after_startup_outage(self) -> None:
        unavailable = _FakeRedisClient(ping_error=OSError("connection refused"))
        available = _FakeRedisClient()
        store = SharedStore()

        with patch(
            "app.core.shared_store.from_url",
            side_effect=[unavailable, available],
        ):
            await store.connect()
            self.assertFalse(store.available)

            # Simulate the bounded retry interval expiring while Redis finishes
            # its restart; no app/PM2 restart should be required.
            store._last_connect_attempt = 0
            await store.connect()

        self.assertTrue(store.available)
        available.ping.assert_awaited_once()
        await store.close()


if __name__ == "__main__":
    unittest.main()
