import unittest
from datetime import date, timedelta

import pandas as pd

from app.engines.cpr.swing_detector import scan_swing_spectrum, swing_signal_to_dict


def make_base(symbol_move: str = "bull_compression") -> pd.DataFrame:
    rows = []
    start = date(2026, 1, 1)
    price = 100.0
    for i in range(59):
        if i < 45:
            price += 0.18
            high = price * 1.01
            low = price * 0.99
        else:
            price += 0.03
            high = price * 1.006
            low = price * 0.994
        rows.append(
            {
                "date": (start + timedelta(days=i)).isoformat(),
                "open": price * 0.998,
                "high": high,
                "low": low,
                "close": price,
                "volume": 100000,
            }
        )

    prev = rows[-1]["close"]
    if symbol_move == "bull_compression":
        rows.append(
            {
                "date": (start + timedelta(days=59)).isoformat(),
                "open": prev * 1.018,
                "high": prev * 1.082,
                "low": prev * 1.012,
                "close": prev * 1.074,
                "volume": 220000,
            }
        )
    else:
        rows.append(
            {
                "date": (start + timedelta(days=59)).isoformat(),
                "open": prev * 0.982,
                "high": prev * 0.988,
                "low": prev * 0.918,
                "close": prev * 0.926,
                "volume": 230000,
            }
        )
    return pd.DataFrame(rows)


class SwingDetectorTest(unittest.TestCase):
    def test_catches_netweb_style_live_bull_momentum(self):
        signals = scan_swing_spectrum(make_base("bull_compression"), "NETWEB")
        payload = [swing_signal_to_dict(signal) for signal in signals]

        self.assertTrue(payload)
        best = payload[0]
        self.assertEqual(best["strategy"], "MOMENTUM_BURST")
        self.assertEqual(best["signal"], "BULL")
        self.assertIn("LIVE_MOMENTUM", best["setup_phase"])
        self.assertGreaterEqual(best["rvol"], 1.8)
        self.assertTrue(any("20D high" in reason or "compressed" in reason for reason in best["reasons"]))

    def test_catches_live_bear_momentum_breakdown(self):
        signals = scan_swing_spectrum(make_base("bear"), "TESTSHORT")
        payload = [swing_signal_to_dict(signal) for signal in signals]

        self.assertTrue(payload)
        best = payload[0]
        self.assertEqual(best["strategy"], "MOMENTUM_BURST")
        self.assertEqual(best["signal"], "BEAR")
        self.assertGreaterEqual(best["rvol"], 1.8)

    def test_enriches_signals_with_benchmark_weekly_and_lifecycle_context(self):
        stock = make_base("bull_compression")
        benchmark = stock.copy()
        benchmark["close"] = [100 + idx * 0.03 for idx in range(len(benchmark))]
        benchmark["open"] = benchmark["close"] * 0.999
        benchmark["high"] = benchmark["close"] * 1.003
        benchmark["low"] = benchmark["close"] * 0.997

        signals = scan_swing_spectrum(stock, "NETWEB", benchmark_df=benchmark)
        payload = [swing_signal_to_dict(signal) for signal in signals]

        self.assertTrue(payload)
        best = payload[0]
        self.assertGreater(best["benchmark_rs_20"], 0)
        self.assertIn(best["weekly_trend"], {"BULLISH", "MIXED"})
        self.assertIn(
            best["lifecycle_state"],
            {"FORMING", "READY", "TRIGGERED", "PULLBACK_ENTRY", "EXTENDED_AVOID"},
        )
        self.assertGreaterEqual(best["extension_atr"], 0)
        self.assertTrue(any("Nifty 500 RS" in reason for reason in best["reasons"]))


if __name__ == "__main__":
    unittest.main()
