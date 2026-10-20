import unittest
from datetime import date, timedelta

import pandas as pd

from app.engines.cpr.swing_detector import scan_swing_spectrum, swing_signal_to_dict


def _liquidity_base() -> pd.DataFrame:
    rows = []
    start = date(2026, 1, 1)
    price = 100.0
    for i in range(58):
        if i < 45:
            price += 0.12
            volume = 100000
        else:
            price += 0.05 if i % 2 == 0 else -0.02
            volume = 120000 if i % 3 == 0 else 95000
        rows.append(
            {
                "date": (start + timedelta(days=i)).isoformat(),
                "open": price * 0.998,
                "high": price * 1.010,
                "low": price * 0.990,
                "close": price,
                "volume": volume,
            }
        )

    prev = rows[-1]["close"]
    rows.append(
        {
            "date": (start + timedelta(days=58)).isoformat(),
            "open": prev * 1.002,
            "high": prev * 1.028,
            "low": prev * 0.992,
            "close": prev * 1.022,
            "volume": 280000,
        }
    )
    return pd.DataFrame(rows)


def _relative_strength_pullback() -> pd.DataFrame:
    rows = []
    start = date(2026, 1, 1)
    price = 90.0
    for i in range(52):
        price *= 1.0045
        rows.append(
            {
                "date": (start + timedelta(days=i)).isoformat(),
                "open": price * 0.997,
                "high": price * 1.012,
                "low": price * 0.988,
                "close": price,
                "volume": 100000,
            }
        )

    for j, multiplier in enumerate([1.018, 1.012, 0.985, 0.982, 1.004, 1.006, 1.003, 1.004]):
        price *= multiplier
        rows.append(
            {
                "date": (start + timedelta(days=52 + j)).isoformat(),
                "open": price * 0.996,
                "high": price * 1.012,
                "low": price * 0.988,
                "close": price,
                "volume": 115000 if j in (0, 1, 5, 7) else 90000,
            }
        )
    return pd.DataFrame(rows)


class InstitutionalSwingSetupTest(unittest.TestCase):
    def test_detects_liquidity_shock_and_vol_squeeze_before_obvious_chase(self) -> None:
        signals = [swing_signal_to_dict(signal) for signal in scan_swing_spectrum(_liquidity_base(), "ABSORB")]
        strategies = {signal["strategy"]: signal for signal in signals}

        self.assertIn("LIQUIDITY_SHOCK", strategies)
        self.assertIn("VOL_SQUEEZE", strategies)
        self.assertEqual(strategies["LIQUIDITY_SHOCK"]["setup_phase"], "LIQUIDITY_ABSORPTION")
        self.assertEqual(strategies["VOL_SQUEEZE"]["setup_phase"], "SQUEEZE_READY")
        self.assertLessEqual(abs(strategies["LIQUIDITY_SHOCK"]["change_pct"]), 4.8)
        self.assertTrue(any("RVOL" in reason or "liquidity shock" in reason for reason in strategies["LIQUIDITY_SHOCK"]["reasons"]))

    def test_detects_relative_strength_pullback_into_support(self) -> None:
        signals = [swing_signal_to_dict(signal) for signal in scan_swing_spectrum(_relative_strength_pullback(), "LEADER")]
        rs_signal = next((signal for signal in signals if signal["strategy"] == "RS_PULLBACK"), None)

        self.assertIsNotNone(rs_signal)
        assert rs_signal is not None
        self.assertEqual(rs_signal["signal"], "BULL")
        self.assertEqual(rs_signal["setup_phase"], "RS_PULLBACK")
        self.assertGreaterEqual(rs_signal["strength"], 76)
        self.assertTrue(any("support held" in reason for reason in rs_signal["reasons"]))


if __name__ == "__main__":
    unittest.main()
