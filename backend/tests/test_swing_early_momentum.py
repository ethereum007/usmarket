from __future__ import annotations

import unittest
from datetime import date, timedelta

import pandas as pd

from app.engines.cpr.swing_detector import scan_swing_spectrum


def _early_base_rows() -> list[dict]:
    rows: list[dict] = []
    start = date(2026, 4, 1)
    price = 130.0
    for idx in range(62):
        if idx < 28:
            price *= 0.994
            volume = 160000
            spread = 0.022
        elif idx < 52:
            price = 105 + ((idx % 5) - 2) * 0.35
            volume = 85000
            spread = 0.014
        else:
            price *= 1.002
            volume = 95000
            spread = 0.012

        rows.append(
            {
                "date": str(start + timedelta(days=idx)),
                "open": price * 0.997,
                "high": price * (1 + spread),
                "low": price * (1 - spread),
                "close": price,
                "volume": volume,
            }
        )

    base = rows[-6]["close"]
    closes = [base * 1.000, base * 1.006, base * 1.011, base * 1.018, base * 1.036]
    for offset, close in enumerate(closes):
        rows[-5 + offset].update(
            {
                "open": close * 0.992,
                "high": close * 1.012,
                "low": close * 0.988,
                "close": close,
                "volume": 125000 + offset * 12000,
            }
        )
    return rows


class SwingEarlyMomentumTest(unittest.TestCase):
    def test_base_reclaim_is_identified_before_extension(self) -> None:
        signals = scan_swing_spectrum(pd.DataFrame(_early_base_rows()), "NETWEB")
        early = next((signal for signal in signals if signal.strategy == "EARLY_MOMENTUM"), None)

        self.assertIsNotNone(early)
        assert early is not None
        self.assertEqual(early.signal, "BULL")
        self.assertIn(early.setup_phase, {"FIRST_RECLAIM", "EARLY_IGNITION"})
        self.assertLessEqual(early.change_pct, 5.5)
        self.assertLessEqual(early.risk_pct, 9.5)
        self.assertGreaterEqual(early.strength, 68)
        self.assertTrue(any("base" in reason.lower() or "reclaim" in reason.lower() for reason in early.reasons))

    def test_extended_jump_stays_out_of_early_momentum(self) -> None:
        rows = _early_base_rows()
        rows[-1].update(
            {
                "open": rows[-2]["close"] * 1.06,
                "high": rows[-2]["close"] * 1.14,
                "low": rows[-2]["close"] * 1.04,
                "close": rows[-2]["close"] * 1.12,
                "volume": 320000,
            }
        )

        signals = scan_swing_spectrum(pd.DataFrame(rows), "CARTRADE")

        self.assertFalse(any(signal.strategy == "EARLY_MOMENTUM" for signal in signals))


if __name__ == "__main__":
    unittest.main()
