from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app import main


class StartupWarmTest(unittest.IsolatedAsyncioTestCase):
    async def test_health_reports_instrument_cache_readiness(self) -> None:
        with (
            patch("app.core.kite_client.kite_state", SimpleNamespace(is_connected=True)),
            patch("app.caches.instrument_cache.size", return_value=123),
        ):
            response = await main.health()

        self.assertEqual(response["status"], "ok")
        self.assertTrue(response["kiteConnected"])
        self.assertTrue(response["instrumentCacheReady"])
        self.assertEqual(response["instrumentCacheSize"], 123)

    async def test_instrument_cache_warm_runs_when_kite_connected(self) -> None:
        scheduled = []
        kite = object()

        def capture_task(coro):
            scheduled.append(coro)
            return SimpleNamespace(done=lambda: False)

        with (
            patch("app.core.kite_client.kite_state", SimpleNamespace(is_connected=True, kite=kite)),
            patch("app.caches.instrument_cache.load_instruments", return_value=5000) as load_instruments,
            patch("asyncio.create_task", side_effect=capture_task) as create_task,
        ):
            main._schedule_instrument_cache_warm()
            self.assertEqual(len(scheduled), 1)
            await scheduled[0]

        create_task.assert_called_once()
        load_instruments.assert_called_once_with(kite)

    async def test_instrument_cache_warm_skips_without_kite(self) -> None:
        with (
            patch("app.core.kite_client.kite_state", SimpleNamespace(is_connected=False, kite=None)),
            patch("app.caches.instrument_cache.load_instruments") as load_instruments,
        ):
            await main._warm_instrument_cache("test")

        load_instruments.assert_not_called()

    async def test_instrument_cache_refresh_job_is_registered(self) -> None:
        sched = SimpleNamespace(add_job=Mock())

        with (
            patch("app.core.scheduler.get_scheduler", return_value=sched),
            patch("app.core.scheduler.start_scheduler") as start_scheduler,
        ):
            main._register_instrument_cache_jobs()

        sched.add_job.assert_called_once()
        kwargs = sched.add_job.call_args.kwargs
        self.assertEqual(kwargs["id"], "instrument_cache_refresh")
        self.assertEqual(kwargs["max_instances"], 1)
        self.assertTrue(kwargs["coalesce"])
        start_scheduler.assert_called_once()

    async def test_snapshot_warmer_registers_forced_swing_refresh(self) -> None:
        sched = SimpleNamespace(add_job=Mock())

        with (
            patch("app.core.scheduler.get_scheduler", return_value=sched),
            patch("app.core.scheduler.start_scheduler") as start_scheduler,
        ):
            main._register_snapshot_warm_jobs()

        ids = [call.kwargs["id"] for call in sched.add_job.call_args_list]
        self.assertIn("snapshot_replay_warmer", ids)
        self.assertIn("snapshot_market_context_warmer", ids)
        self.assertIn("snapshot_replay_warmer_close", ids)
        self.assertIn("snapshot_replay_warmer_startup", ids)
        self.assertIn("snapshot_swing_warmer_market", ids)
        self.assertIn("snapshot_swing_warmer_startup", ids)
        self.assertIn("snapshot_surveillance_warmer_market", ids)
        self.assertIn("snapshot_surveillance_warmer_startup", ids)

        market_call = next(
            call for call in sched.add_job.call_args_list
            if call.kwargs["id"] == "snapshot_market_context_warmer"
        )
        self.assertEqual(
            market_call.kwargs["args"][1],
            [
                "indices",
                "top_movers",
                "breadth",
                "pulse",
                "quote_sectors",
                "hot_cold_indices",
                "live_signals",
                "orb_signals",
            ],
        )
        self.assertEqual(market_call.kwargs["args"][2], 80)
        self.assertEqual(market_call.kwargs["max_instances"], 1)
        self.assertTrue(market_call.kwargs["coalesce"])

        market_call = next(
            call for call in sched.add_job.call_args_list
            if call.kwargs["id"] == "snapshot_swing_warmer_market"
        )
        self.assertEqual(market_call.kwargs["args"][1], ["swing_spectrum", "sector_momentum"])
        self.assertEqual(market_call.kwargs["args"][2], 160)
        self.assertIn("minute='5,35'", str(market_call.kwargs["trigger"]))
        self.assertEqual(market_call.kwargs["max_instances"], 1)
        self.assertTrue(market_call.kwargs["coalesce"])

        surveillance_call = next(
            call for call in sched.add_job.call_args_list
            if call.kwargs["id"] == "snapshot_surveillance_warmer_market"
        )
        self.assertEqual(surveillance_call.kwargs["args"][1], ["abnormal_live"])
        self.assertEqual(surveillance_call.kwargs["args"][2], 160)
        self.assertEqual(surveillance_call.kwargs["max_instances"], 1)
        self.assertTrue(surveillance_call.kwargs["coalesce"])

        surveillance_startup_call = next(
            call for call in sched.add_job.call_args_list
            if call.kwargs["id"] == "snapshot_surveillance_warmer_startup"
        )
        self.assertEqual(surveillance_startup_call.kwargs["args"][1], ["abnormal_live"])
        start_scheduler.assert_called_once()

    async def test_shared_market_refresh_worker_is_registered(self) -> None:
        sched = SimpleNamespace(add_job=Mock())

        with (
            patch("app.core.scheduler.get_scheduler", return_value=sched),
            patch("app.core.scheduler.start_scheduler") as start_scheduler,
        ):
            main._register_shared_market_snapshot_jobs()

        sched.add_job.assert_called_once()
        kwargs = sched.add_job.call_args.kwargs
        self.assertEqual(kwargs["id"], "shared_market_snapshot_refresh")
        self.assertEqual(kwargs["max_instances"], 1)
        self.assertTrue(kwargs["coalesce"])
        start_scheduler.assert_called_once()


if __name__ == "__main__":
    unittest.main()
