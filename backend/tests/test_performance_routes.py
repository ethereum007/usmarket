from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app.routes import performance


def make_request(host: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/performance/signal-stats",
            "headers": [(b"host", host.encode("utf-8"))],
        }
    )


class _Query:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.filters: list[tuple[str, str, object]] = []

    def select(self, *_: object, **__: object) -> "_Query":
        return self

    def gte(self, column: str, value: object) -> "_Query":
        self.filters.append(("gte", column, value))
        return self

    def eq(self, column: str, value: object) -> "_Query":
        self.filters.append(("eq", column, value))
        return self

    def order(self, *_: object, **__: object) -> "_Query":
        return self

    def limit(self, *_: object, **__: object) -> "_Query":
        return self

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self.rows)


class _Supabase:
    def __init__(self, rows: list[dict]) -> None:
        self.query = _Query(rows)

    def table(self, name: str) -> _Query:
        assert name == "signal_fires"
        return self.query


class PerformanceRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def test_localhost_gets_dev_performance_access(self) -> None:
        user = await performance.require_performance_access(make_request("localhost:9000"))

        self.assertTrue(user["is_premium"])
        self.assertTrue(user["is_admin"])

    async def test_production_guest_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await performance.require_performance_access(make_request("alpha-radar.in"))

        self.assertEqual(ctx.exception.status_code, 401)

    async def test_signal_stats_uses_product_namespace_payload(self) -> None:
        with patch(
            "app.routes.performance.get_signal_stats",
            return_value={"days": 7, "by_signal_type": {"SWING_BREAKOUT_A": {}}},
        ):
            response = await performance.performance_signal_stats(
                days=7,
                user={"id": "premium-user", "is_premium": True},
            )

        self.assertTrue(response["success"])
        self.assertEqual(response["days"], 7)
        self.assertIn("SWING_BREAKOUT_A", response["by_signal_type"])

    async def test_signal_fires_applies_filters_and_returns_rows(self) -> None:
        sb = _Supabase([
            {
                "symbol": "NETWEB",
                "signal_type": "SWING_EARLY_MOMENTUM_BULL",
                "metadata": {
                    "tracking_role": "DISCOVERY",
                    "trade_readiness": "EARLY_ENTRY_ZONE",
                    "strategy": "EARLY_MOMENTUM",
                },
                "signal_outcomes": [{"horizon": "1h", "status": "WIN"}],
            },
            {
                "symbol": "CARTRADE",
                "signal_type": "SWING_ACCELERATION_BULL",
                "metadata": {
                    "tracking_role": "DISCOVERY",
                    "trade_readiness": "WAIT_FOR_PULLBACK",
                    "strategy": "ACCELERATION",
                },
                "signal_outcomes": [{"horizon": "1h", "status": "LOSS"}],
            },
        ])

        response = await performance.performance_signal_fires(
            days=15,
            limit=25,
            symbol="netweb",
            signal_type="swing_breakout_a",
            user={"id": "premium-user", "is_premium": True},
            sb=sb,
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["count"], 2)
        self.assertEqual(response["fires"][0]["symbol"], "NETWEB")
        self.assertEqual(response["summary"]["discovery"], 2)
        self.assertEqual(response["summary"]["early_entry_zone"], 1)
        self.assertEqual(response["summary"]["wait_for_pullback"], 1)
        self.assertEqual(response["summary"]["by_role"]["DISCOVERY"]["resolved"], 2)
        self.assertEqual(response["summary"]["by_role"]["DISCOVERY"]["win_rate"], 50.0)
        self.assertEqual(response["summary"]["by_strategy"]["EARLY_MOMENTUM"], 1)
        self.assertIn(("eq", "symbol", "NETWEB"), sb.query.filters)
        self.assertIn(("eq", "signal_type", "SWING_BREAKOUT_A"), sb.query.filters)

    async def test_run_outcome_check_rejects_unknown_horizon(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await performance.performance_run_outcome_check(
                horizon="weekly",
                user={"id": "premium-user", "is_premium": True},
                kite=SimpleNamespace(),
            )

        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
