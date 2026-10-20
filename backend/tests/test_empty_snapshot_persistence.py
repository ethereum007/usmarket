from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.routes import bounce, signals


class EmptySnapshotPersistenceTest(unittest.IsolatedAsyncioTestCase):
    async def test_52w_bounce_saves_zero_candidate_snapshot(self) -> None:
        bounce._bounce_cache = None
        bounce._bounce_cache_ts = 0
        kite = SimpleNamespace(
            quote=lambda _symbols: {
                "NSE:TEST": {
                    "last_price": 100,
                    "ohlc": {"close": 99, "open": 99, "high": 101, "low": 98},
                    "volume": 1000,
                }
            }
        )

        with (
            patch("app.routes.bounce._get_nifty500", return_value=["TEST"]),
            patch("app.routes.bounce.save_session") as save_session,
        ):
            response = await bounce.bounce_52w(kite=kite, user={"is_premium": True})

        self.assertEqual(response["count"], 0)
        self.assertEqual(response["scannedSymbols"], 1)
        self.assertIn("No 52W bounce candidate", response["noTradeReason"])
        save_session.assert_called_once_with("52w_bounce", response)

    async def test_live_signals_saves_zero_signal_snapshot(self) -> None:
        with (
            patch("app.routes.signals.is_market_hours", return_value=True),
            patch("app.routes.signals.save_session") as save_session,
        ):
            response = await signals.live_signals(user={"id": "user"})

        self.assertIn("pdhCrossCount", response)
        save_session.assert_called_once_with("live_signals", response)

    async def test_orb_signals_saves_zero_loaded_snapshot(self) -> None:
        with (
            patch("app.routes.signals.is_market_hours", return_value=True),
            patch("app.routes.signals.load_session", return_value=None),
            patch("app.routes.signals.save_session") as save_session,
        ):
            response = await signals.orb_signals(user={"is_premium": True})

        self.assertIn("orbLoaded", response)
        save_session.assert_called_once_with("orb_signals", response)


if __name__ == "__main__":
    unittest.main()
