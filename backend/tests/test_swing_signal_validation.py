from __future__ import annotations

import unittest
from unittest.mock import patch

from app.routes.scanner import _log_swing_signal_fires


class SwingSignalValidationTest(unittest.TestCase):
    def test_logs_only_qualified_swing_signals(self) -> None:
        signals = [
            {
                "symbol": "NETWEB",
                "strategy": "MOMENTUM_BURST",
                "signal": "BULL",
                "quality": "A+",
                "strength": 88,
                "entry_price": 100.5,
                "current_price": 101.2,
                "rr": 2.2,
                "risk_pct": 4.5,
                "reward_pct": 9.9,
                "rvol": 2.4,
                "change_pct": 7.1,
                "setup_phase": "LIVE_MOMENTUM",
                "reasons": ["broke 20D high", "volume expanded"],
            },
            {
                "symbol": "WEAKROW",
                "strategy": "MOMENTUM_BURST",
                "signal": "BULL",
                "quality": "WATCH",
                "strength": 92,
                "entry_price": 50,
                "rr": 2.0,
                "risk_pct": 3.0,
            },
            {
                "symbol": "CARTRADE",
                "strategy": "ACCELERATION",
                "signal": "BULL",
                "quality": "WATCH",
                "strength": 91,
                "entry_price": 3450,
                "current_price": 3550,
                "rr": 2.4,
                "risk_pct": 12.0,
                "reward_pct": 28.8,
                "rvol": 2.1,
                "change_pct": 8.4,
                "setup_phase": "EXTENDED_WAIT",
                "notes": "Acceleration is extended; wait for pullback or retest before entry.",
                "reasons": ["3D acceleration", "new 50D high", "wait for pullback"],
            },
            {
                "symbol": "DATAPATTNS",
                "strategy": "EARLY_MOMENTUM",
                "signal": "BULL",
                "quality": "B",
                "strength": 74,
                "entry_price": 2980,
                "current_price": 2980,
                "rr": 2.2,
                "risk_pct": 6.0,
                "reward_pct": 13.2,
                "rvol": 1.1,
                "change_pct": 2.8,
                "setup_phase": "EARLY_IGNITION",
                "notes": "Base held and early reclaim is forming.",
                "reasons": ["higher-low structure", "first 5D high reclaim", "volume waking up"],
            },
            {
                "symbol": "TESTSHORT",
                "strategy": "10D_BO",
                "signal": "BEAR",
                "quality": "A",
                "strength": 78,
                "entry_price": 200,
                "rr": 1.8,
                "risk_pct": 8.0,
            },
        ]

        with (
            patch("app.services.signal_validator.compute_market_context", return_value={"regime": "BULL"}) as context_mock,
            patch("app.services.signal_validator.log_signal_fire", side_effect=["fire-1", "fire-2", "fire-3", None]) as log_mock,
        ):
            summary = _log_swing_signal_fires(signals)

        self.assertEqual(summary, {"eligible": 4, "logged": 3})
        context_mock.assert_called_once()
        self.assertEqual(log_mock.call_count, 4)

        first_call = log_mock.call_args_list[0].kwargs
        self.assertEqual(first_call["symbol"], "NETWEB")
        self.assertEqual(first_call["signal_type"], "SWING_MOMENTUM_BURST_BULL")
        self.assertEqual(first_call["direction"], "BULLISH")
        self.assertEqual(first_call["confidence"], "STRONG")
        self.assertEqual(first_call["metadata"]["rr"], 2.2)
        self.assertEqual(first_call["context"]["scanner"], "swing_spectrum")

        second_call = log_mock.call_args_list[1].kwargs
        self.assertEqual(second_call["symbol"], "CARTRADE")
        self.assertEqual(second_call["signal_type"], "SWING_ACCELERATION_BULL")
        self.assertEqual(second_call["direction"], "BULLISH")
        self.assertEqual(second_call["confidence"], "MODERATE")
        self.assertEqual(second_call["metadata"]["tracking_role"], "DISCOVERY")
        self.assertEqual(second_call["metadata"]["trade_readiness"], "WAIT_FOR_PULLBACK")

        third_call = log_mock.call_args_list[2].kwargs
        self.assertEqual(third_call["symbol"], "DATAPATTNS")
        self.assertEqual(third_call["signal_type"], "SWING_EARLY_MOMENTUM_BULL")
        self.assertEqual(third_call["direction"], "BULLISH")
        self.assertEqual(third_call["confidence"], "MODERATE")
        self.assertEqual(third_call["metadata"]["tracking_role"], "DISCOVERY")
        self.assertEqual(third_call["metadata"]["trade_readiness"], "EARLY_ENTRY_ZONE")

        fourth_call = log_mock.call_args_list[3].kwargs
        self.assertEqual(fourth_call["symbol"], "TESTSHORT")
        self.assertEqual(fourth_call["signal_type"], "SWING_10D_BO_BEAR")
        self.assertEqual(fourth_call["direction"], "BEARISH")
        self.assertEqual(fourth_call["confidence"], "MODERATE")
        self.assertEqual(fourth_call["metadata"]["tracking_role"], "TRADE_SIGNAL")


if __name__ == "__main__":
    unittest.main()
