from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.routes.intraday import IntradayRadarRequest, _cached_intraday_response, build_live_intraday_radar, intraday_radar


class IntradayRouteCacheTest(unittest.IsolatedAsyncioTestCase):
    async def test_customer_radar_reads_shared_snapshot_without_broker_access(self) -> None:
        body = IntradayRadarRequest(symbols=["TCS"])
        snapshot = {
            "success": True,
            "cached": True,
            "candidates": [{"symbol": "TCS", "score": 76}],
            "freshness": {"status": "fresh", "ageSeconds": 4},
        }

        with (
            patch(
                "app.services.market_snapshot_service.market_snapshot_service.read_intraday",
                new=AsyncMock(return_value=snapshot),
            ) as read_snapshot,
            patch(
                "app.services.market_snapshot_service.market_snapshot_service.queue_intraday",
                new=AsyncMock(),
            ) as queue_snapshot,
        ):
            response = await intraday_radar(body, kite=SimpleNamespace())

        self.assertEqual(response, snapshot)
        read_snapshot.assert_awaited_once_with(body.model_dump())
        queue_snapshot.assert_not_awaited()

    async def test_customer_radar_cold_start_only_queues_one_shared_refresh(self) -> None:
        body = IntradayRadarRequest(symbols=["TCS"])

        with (
            patch(
                "app.services.market_snapshot_service.market_snapshot_service.read_intraday",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "app.services.market_snapshot_service.market_snapshot_service.has_paid_activity",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "app.services.market_snapshot_service.market_snapshot_service.queue_intraday",
                new=AsyncMock(return_value=True),
            ) as queue_snapshot,
            patch("app.routes.intraday._cached_intraday_response", return_value=None),
        ):
            response = await intraday_radar(body, kite=SimpleNamespace())

        self.assertTrue(response["success"])
        self.assertTrue(response["refreshQueued"])
        self.assertEqual(response["freshness"]["status"], "pending")
        queue_snapshot.assert_awaited_once_with(body.model_dump())

    def test_cached_replay_is_filtered_to_requested_symbols(self) -> None:
        cached_payload = {
            "data": {
                "success": True,
                "candidates": [
                    {
                        "symbol": "ICICIBANK",
                        "bias": "SHORT",
                        "score": 72,
                        "sector": "Finance",
                        "changePct": -1.2,
                        "volRatio": 1.8,
                        "freshness": {"status": "fresh"},
                    },
                    {
                        "symbol": "TCS",
                        "bias": "LONG",
                        "score": 66,
                        "sector": "IT",
                        "changePct": 0.9,
                        "volRatio": 1.1,
                        "freshness": {"status": "stale"},
                    },
                ],
                "actionable": [{"symbol": "ICICIBANK", "bias": "SHORT", "score": 72}],
                "watchlist": [{"symbol": "TCS", "bias": "LONG", "score": 66}],
                "summary": {"total": 2, "long": 1, "short": 1, "neutral": 0, "actionable": 1, "avgScore": 69},
                "sectors": [],
                "dataQuality": {"fresh": 1, "stale": 1, "unknown": 0, "missingStats": 4},
                "filters": {"inputSymbols": 2, "returnedCandidates": 2},
                "provider": {"provider": "kite"},
            },
            "timestamp": "2026-06-16T01:28:49+05:30",
        }

        with patch("app.routes.intraday.load_session", return_value=cached_payload):
            response = _cached_intraday_response("Replay", ["ICICIBANK"])

        self.assertIsNotNone(response)
        assert response is not None
        self.assertEqual([item["symbol"] for item in response["candidates"]], ["ICICIBANK"])
        self.assertEqual(response["watchlist"], [])
        self.assertEqual(response["summary"]["total"], 1)
        self.assertEqual(response["summary"]["short"], 1)
        self.assertEqual(response["summary"]["actionable"], 1)
        self.assertEqual(response["dataQuality"]["fresh"], 1)
        self.assertEqual(response["filters"]["inputSymbols"], 1)
        self.assertEqual(response["filters"]["returnedCandidates"], 1)
        self.assertEqual(response["sectors"][0]["name"], "Finance")
        self.assertTrue(response["provider"]["fallback"])

    async def test_after_hours_empty_live_scan_replays_last_successful_radar(self) -> None:
        cached_response = {
            "success": True,
            "cached": True,
            "candidates": [{"symbol": "ICICIBANK", "score": 82}],
            "summary": {"total": 1},
            "provider": {"fallback": True},
        }

        with (
            patch("app.routes.intraday.build_intraday_radar", return_value={"success": True, "candidates": []}),
            patch("app.routes.intraday.is_market_hours", return_value=False),
            patch("app.routes.intraday._cached_intraday_response", return_value=cached_response) as cached,
        ):
            response = await build_live_intraday_radar(
                IntradayRadarRequest(symbols=["ICICIBANK"], quoteProvider="kite").model_dump(),
                kite=SimpleNamespace(),
            )

        cached.assert_called_once()
        self.assertTrue(response["cached"])
        self.assertEqual(response["candidates"][0]["symbol"], "ICICIBANK")

    async def test_market_hours_empty_live_scan_stays_empty(self) -> None:
        empty_response = {"success": True, "candidates": [], "summary": {"total": 0}}

        with (
            patch("app.routes.intraday.build_intraday_radar", return_value=empty_response),
            patch("app.routes.intraday.is_market_hours", return_value=True),
            patch("app.routes.intraday._cached_intraday_response") as cached,
        ):
            response = await build_live_intraday_radar(
                IntradayRadarRequest(symbols=["ICICIBANK"], quoteProvider="kite").model_dump(),
                kite=SimpleNamespace(),
            )

        cached.assert_not_called()
        self.assertEqual(response["candidates"], [])

    async def test_arrow_quotes_build_when_kite_is_disconnected(self) -> None:
        quote = {"NSE:ICICIBANK": {"last_price": 1200}, "_meta": {"mode": "ohlcv"}}
        built = {"success": True, "candidates": [{"symbol": "ICICIBANK"}]}
        with (
            patch("app.routes.intraday.arrow.fetch_quotes", new=AsyncMock(return_value=quote)),
            patch("app.routes.intraday.build_intraday_radar", return_value=built) as build,
        ):
            response = await build_live_intraday_radar(
                IntradayRadarRequest(symbols=["ICICIBANK"], quoteProvider="arrow").model_dump(),
                kite=None,
            )

        self.assertEqual(response, built)
        self.assertEqual(build.call_args.args[0], None)
        self.assertEqual(build.call_args.kwargs["quote_map"], {"NSE:ICICIBANK": {"last_price": 1200}})


if __name__ == "__main__":
    unittest.main()
