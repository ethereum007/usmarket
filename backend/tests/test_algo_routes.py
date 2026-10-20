from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from app.routes import algos


class AlgoRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._original_file = algos.ALGO_PAPER_WATCHES_FILE
        algos.ALGO_PAPER_WATCHES_FILE = Path(self._tmp.name) / "algo_paper_watches.json"

    async def asyncTearDown(self) -> None:
        algos.ALGO_PAPER_WATCHES_FILE = self._original_file
        self._tmp.cleanup()

    def _body(self, strategy_id: str = "orb-vwap") -> algos.PaperWatchBody:
        return algos.PaperWatchBody(
            strategyId=strategy_id,
            strategyName="ORB VWAP",
            side="BUY",
            quantity=100,
            entry=100.0,
            stop=98.0,
            target=104.0,
            exposure=10000.0,
            maxLoss=200.0,
            riskReward=2.0,
        )

    async def test_strategy_registry_returns_paper_modes(self) -> None:
        response = await algos.list_algo_strategies(user={"id": "trader-1"})

        self.assertTrue(response["success"])
        self.assertGreaterEqual(response["count"], 6)
        self.assertIn("orb-vwap", {item["id"] for item in response["strategies"]})
        self.assertTrue(all(item["mode"] == "paper" for item in response["strategies"]))

    async def test_create_and_list_paper_watch_is_owner_scoped(self) -> None:
        owner = {"id": "trader-1", "email": "trader@example.com"}
        other = {"id": "trader-2", "email": "other@example.com"}

        created = await algos.create_paper_watch(self._body(), owner)
        owner_list = await algos.list_paper_watches(owner)
        other_list = await algos.list_paper_watches(other)

        self.assertTrue(created["success"])
        self.assertEqual(created["paperWatch"]["status"], "WATCHING")
        self.assertFalse(created["paperWatch"]["executionAllowed"])
        self.assertEqual(owner_list["count"], 1)
        self.assertEqual(other_list["count"], 0)
        self.assertEqual(owner_list["summary"]["totalMaxLoss"], 200.0)

    async def test_rejects_unknown_strategy(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await algos.create_paper_watch(self._body("unknown-strategy"), {"id": "trader-1"})

        self.assertEqual(ctx.exception.status_code, 400)

    async def test_rejects_low_reward_risk(self) -> None:
        body = self._body()
        body.riskReward = 0.8

        with self.assertRaises(HTTPException) as ctx:
            await algos.create_paper_watch(body, {"id": "trader-1"})

        self.assertEqual(ctx.exception.status_code, 400)

    async def test_delete_is_owner_scoped(self) -> None:
        owner = {"id": "trader-1", "email": "trader@example.com"}
        other = {"id": "trader-2", "email": "other@example.com"}
        created = await algos.create_paper_watch(self._body(), owner)
        watch_id = created["paperWatch"]["id"]

        with self.assertRaises(HTTPException):
            await algos.delete_paper_watch(watch_id, other)

        deleted = await algos.delete_paper_watch(watch_id, owner)
        listed = await algos.list_paper_watches(owner)

        self.assertTrue(deleted["success"])
        self.assertEqual(listed["count"], 0)

    async def test_records_outcome_and_performance_summary(self) -> None:
        owner = {"id": "trader-1", "email": "trader@example.com"}
        created = await algos.create_paper_watch(self._body(), owner)
        watch_id = created["paperWatch"]["id"]

        outcome = await algos.record_paper_watch_outcome(
            algos.PaperWatchOutcomeBody(outcome="WIN", exit=104.0),
            watch_id,
            owner,
        )
        performance = await algos.algo_performance(owner)

        self.assertTrue(outcome["success"])
        self.assertEqual(outcome["paperWatch"]["status"], "CLOSED")
        self.assertEqual(outcome["paperWatch"]["realizedR"], 2.0)
        self.assertEqual(performance["summary"]["resolved"], 1)
        self.assertEqual(performance["summary"]["winRatePct"], 100.0)
        self.assertEqual(performance["summary"]["totalR"], 2.0)

    async def test_outcome_is_owner_scoped_and_validates_direction(self) -> None:
        owner = {"id": "trader-1", "email": "trader@example.com"}
        other = {"id": "trader-2", "email": "other@example.com"}
        created = await algos.create_paper_watch(self._body(), owner)
        watch_id = created["paperWatch"]["id"]

        with self.assertRaises(HTTPException) as owner_ctx:
            await algos.record_paper_watch_outcome(
                algos.PaperWatchOutcomeBody(outcome="LOSS", exit=104.0),
                watch_id,
                owner,
            )
        with self.assertRaises(HTTPException) as other_ctx:
            await algos.record_paper_watch_outcome(
                algos.PaperWatchOutcomeBody(outcome="WIN", exit=104.0),
                watch_id,
                other,
            )

        self.assertEqual(owner_ctx.exception.status_code, 400)
        self.assertEqual(other_ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
