from __future__ import annotations

import unittest
from datetime import date

from app.engines.nifty_pulse_index import calculate_nifty_pulse, classify_score
from app.routes.nifty_pulse import _normalise_history


class NiftyPulseIndexTest(unittest.TestCase):
    @staticmethod
    def _series(start: float, daily_change: float, length: int = 180) -> list[float]:
        values = [start]
        for _ in range(length - 1):
            values.append(values[-1] * (1 + daily_change))
        return values

    def test_falling_market_and_rising_vix_produce_fear(self) -> None:
        nifty = self._series(24000, -0.004)
        broad = self._series(20000, -0.005)
        vix = self._series(12, 0.006)

        result = calculate_nifty_pulse(nifty, broad, vix)

        self.assertGreater(result["daily"]["score"], 50)
        self.assertGreater(result["weekly"]["score"], 50)
        self.assertGreater(result["monthly"]["score"], 50)
        self.assertEqual(len(result["daily"]["components"]), 5)

    def test_rising_market_and_falling_vix_produce_greed(self) -> None:
        nifty = self._series(18000, 0.004)
        broad = self._series(16000, 0.005)
        vix = self._series(32, -0.006)

        result = calculate_nifty_pulse(nifty, broad, vix)

        self.assertLess(result["weekly"]["score"], 50)
        self.assertLess(result["monthly"]["score"], 50)

    def test_classification_boundaries_follow_product_scale(self) -> None:
        self.assertEqual(classify_score(19.9)[0], "Extreme Greed")
        self.assertEqual(classify_score(20)[0], "Greed")
        self.assertEqual(classify_score(35)[0], "Neutral")
        self.assertEqual(classify_score(50)[0], "Fear")
        self.assertEqual(classify_score(65)[0], "Extreme Fear")

    def test_live_quote_appends_when_latest_candle_is_prior_day(self) -> None:
        candles = [{"date": "2026-09-10T00:00:00+05:30", "close": 25000}]
        self.assertEqual(
            _normalise_history(candles, 25100, date(2026, 9, 11)),
            [25000.0, 25100.0],
        )

    def test_live_quote_replaces_todays_partial_candle(self) -> None:
        candles = [{"date": "2026-09-11T00:00:00+05:30", "close": 25000}]
        self.assertEqual(
            _normalise_history(candles, 25100, date(2026, 9, 11)),
            [25100.0],
        )


if __name__ == "__main__":
    unittest.main()
