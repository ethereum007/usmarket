from __future__ import annotations

import unittest
from unittest.mock import patch

from app.routes.abnormal import _log_abnormal_signal_fires


class AbnormalSignalValidationTest(unittest.TestCase):
    def test_logs_only_qualified_abnormal_momentum(self) -> None:
        results = [
            {
                "symbol": "NETWEB",
                "last_price": 4533,
                "change_pct": 8.1,
                "volume_vs_avg": 3.4,
                "delivery_pct": 54,
                "breakout_status": "50D Breakout",
                "liquidity_score": 10,
                "risk_flag": "Clean Momentum",
                "alpha_score": 8.5,
                "market_cap_bucket": "mid",
                "sector": "IT",
                "turnover_lakh": 140523,
                "invalidation_level": 4310,
                "tags": [],
                "reasons": ["Volume expanded", "Price cleared 50D high"],
            },
            {
                "symbol": "TRAP",
                "last_price": 18.4,
                "change_pct": 9.5,
                "volume_vs_avg": 6.0,
                "liquidity_score": 0,
                "risk_flag": "Liquidity Trap",
                "alpha_score": 7.0,
                "turnover_lakh": 77,
            },
            {
                "symbol": "SHORTY",
                "last_price": 120,
                "change_pct": -4.2,
                "volume_vs_avg": 2.8,
                "breakout_status": "PDL Breakdown",
                "liquidity_score": 5,
                "risk_flag": "Watch Carefully",
                "alpha_score": 6.7,
                "turnover_lakh": 900,
            },
        ]

        with (
            patch("app.services.signal_validator.compute_market_context", return_value={"regime": "RISK_ON"}) as context_mock,
            patch("app.services.signal_validator.log_signal_fire", side_effect=["fire-1", None]) as log_mock,
        ):
            summary = _log_abnormal_signal_fires(results)

        self.assertEqual(summary, {"eligible": 2, "logged": 1})
        context_mock.assert_called_once()
        self.assertEqual(log_mock.call_count, 2)

        first_call = log_mock.call_args_list[0].kwargs
        self.assertEqual(first_call["symbol"], "NETWEB")
        self.assertEqual(first_call["signal_type"], "ABNORMAL_CLEAN_MOMENTUM_BULL")
        self.assertEqual(first_call["direction"], "BULLISH")
        self.assertEqual(first_call["confidence"], "STRONG")
        self.assertEqual(first_call["strength"], 85.0)
        self.assertEqual(first_call["metadata"]["alpha_score"], 8.5)
        self.assertEqual(first_call["context"]["scanner"], "abnormal_moves")

        second_call = log_mock.call_args_list[1].kwargs
        self.assertEqual(second_call["symbol"], "SHORTY")
        self.assertEqual(second_call["signal_type"], "ABNORMAL_WATCH_CAREFULLY_BEAR")
        self.assertEqual(second_call["direction"], "BEARISH")
        self.assertEqual(second_call["confidence"], "MODERATE")


if __name__ == "__main__":
    unittest.main()
