from __future__ import annotations

import unittest
from datetime import date, timedelta

import pandas as pd

from app.engines.cpr.swing_detector import scan_swing_spectrum


def _base_rows(days: int = 58) -> list[dict]:
    rows: list[dict] = []
    start = date(2026, 4, 1)
    price = 100.0
    for idx in range(days):
        price *= 1.003
        rows.append(
            {
                "date": str(start + timedelta(days=idx)),
                "open": price * 0.99,
                "high": price * 1.01,
                "low": price * 0.98,
                "close": price,
                "volume": 100000,
            }
        )
    return rows


class SwingAccelerationTest(unittest.TestCase):
    def test_extended_multi_day_move_is_identified_as_acceleration_watch(self) -> None:
        rows = _base_rows()
        base = rows[-6]["close"]
        closes = [base * 1.01, base * 1.03, base * 1.07, base * 1.12, base * 1.25]
        for offset, close in enumerate(closes):
            rows[-5 + offset].update(
                {
                    "open": close * 0.94 if offset == 4 else close * 0.99,
                    "high": close * 1.04 if offset == 4 else close * 1.01,
                    "low": close * 0.86 if offset == 4 else close * 0.98,
                    "close": close,
                    "volume": 350000 if offset >= 2 else 150000,
                }
            )

        signals = scan_swing_spectrum(pd.DataFrame(rows), "CARTRADE")
        acceleration = next((signal for signal in signals if signal.strategy == "ACCELERATION"), None)

        self.assertIsNotNone(acceleration)
        assert acceleration is not None
        self.assertEqual(acceleration.setup_phase, "EXTENDED_WAIT")
        self.assertEqual(acceleration.quality, "WATCH")
        self.assertIn("wait for pullback", acceleration.notes)
        self.assertGreaterEqual(acceleration.strength, 80)

    def test_quiet_trend_does_not_raise_acceleration_watch(self) -> None:
        signals = scan_swing_spectrum(pd.DataFrame(_base_rows()), "SLOWCO")

        self.assertFalse(any(signal.strategy == "ACCELERATION" for signal in signals))


if __name__ == "__main__":
    unittest.main()
