from __future__ import annotations

import unittest
from unittest.mock import patch

from app.caches import instrument_cache


class FakeKite:
    def instruments(self, exchange: str) -> list[dict]:
        return [
            {
                "exchange": exchange,
                "tradingsymbol": f"{exchange}TEST",
                "instrument_token": len(exchange),
            }
        ]


class InstrumentCacheTest(unittest.TestCase):
    def tearDown(self) -> None:
        instrument_cache.clear()

    def test_instrument_master_stays_hot_after_close_window(self) -> None:
        with patch("app.core.cache.time.time", return_value=1_800_000_000):
            loaded = instrument_cache.load_instruments(FakeKite())

        with patch("app.core.cache.time.time", return_value=1_800_000_000 + (2 * 60 * 60)):
            self.assertEqual(loaded, 3)
            self.assertEqual(instrument_cache.size(), 3)
            self.assertEqual(
                instrument_cache.get_all_tokens(),
                {"NSETEST": 3, "NFOTEST": 3, "BFOTEST": 3},
            )


if __name__ == "__main__":
    unittest.main()
