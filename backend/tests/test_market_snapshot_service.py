from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.core.shared_store import shared_store
from app.services.market_snapshot_service import MarketSnapshotService


class MarketSnapshotServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.service = MarketSnapshotService()
        self.body = {
            "symbols": ["TCS", "RELIANCE"],
            "minTradedValueLakh": 0,
            "useCache": True,
            "quoteProvider": "arrow_first",
        }
        self.signature = self.service.intraday_signature(self.body)
        await shared_store.delete(self.service._snapshot_key(self.signature))
        await shared_store.delete(f"alpha:market:rescan:test-user:{self.signature}")

    async def asyncTearDown(self) -> None:
        await shared_store.delete(self.service._snapshot_key(self.signature))
        await shared_store.delete(f"alpha:market:rescan:test-user:{self.signature}")
        await shared_store.delete(self.service._refresh_lock_key(self.signature))

    async def test_read_snapshot_adds_freshness_contract(self) -> None:
        import time

        now = time.time()
        await shared_store.set_json(
            self.service._snapshot_key(self.signature),
            {
                "data": {"success": True, "candidates": [{"symbol": "TCS"}]},
                "generatedAt": "2026-07-22T09:15:00+05:30",
                "generatedAtEpoch": now - 4,
                "intervalSeconds": 30,
            },
            ttl_seconds=60,
        )

        response = await self.service.read_intraday(self.body)

        assert response is not None
        self.assertTrue(response["cached"])
        self.assertFalse(response["isStale"])
        self.assertEqual(response["freshness"]["source"], "shared_snapshot")
        self.assertEqual(response["refreshIntervalSeconds"], 30)
        self.assertIsNotNone(response["nextRefreshAt"])

    async def test_manual_rescan_is_deduplicated_for_sixty_seconds(self) -> None:
        self.service.queue_intraday = AsyncMock(return_value=True)  # type: ignore[method-assign]

        first = await self.service.request_manual_rescan(user_id="test-user", body=self.body)
        second = await self.service.request_manual_rescan(user_id="test-user", body=self.body)

        self.assertTrue(first["accepted"])
        self.assertTrue(first["refreshQueued"])
        self.assertFalse(second["accepted"])
        self.assertFalse(second["refreshQueued"])
        self.assertGreater(second["retryAfterSeconds"], 0)
        self.service.queue_intraday.assert_awaited_once()  # type: ignore[attr-defined]

    async def test_many_simultaneous_cache_misses_queue_one_shared_refresh(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocked_refresh(*_args: object) -> None:
            started.set()
            await release.wait()

        with patch.object(self.service, "_refresh_intraday", side_effect=blocked_refresh) as refresh:
            queued = await asyncio.gather(*(self.service.queue_intraday(self.body) for _ in range(100)))
            await asyncio.wait_for(started.wait(), timeout=1)
            self.assertEqual(sum(queued), 1)
            refresh.assert_awaited_once()
            release.set()
            await asyncio.sleep(0)

    async def test_expired_refresh_lease_cannot_release_new_owner(self) -> None:
        key = self.service._refresh_lock_key(self.signature)
        await shared_store.set_text(key, "new-owner", ttl_seconds=30)
        self.assertFalse(await shared_store.delete_if_value(key, "old-owner"))
        self.assertEqual(await shared_store.get_text(key), "new-owner")
        self.assertTrue(await shared_store.delete_if_value(key, "new-owner"))


if __name__ == "__main__":
    unittest.main()
