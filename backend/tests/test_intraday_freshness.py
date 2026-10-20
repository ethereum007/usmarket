from __future__ import annotations

import time
import unittest
from datetime import datetime, timedelta

from app.config import settings
from app.services.intraday_radar_service import _freshness


class IntradayFreshnessTest(unittest.TestCase):
    def test_numeric_seconds_timestamp_is_fresh(self) -> None:
        result = _freshness({"timestamp": time.time()})

        self.assertEqual(result["status"], "fresh")
        self.assertIsNotNone(result["exchangeTimestamp"])

    def test_numeric_milliseconds_timestamp_is_fresh(self) -> None:
        result = _freshness({"timestamp": int(time.time() * 1000)})

        self.assertEqual(result["status"], "fresh")
        self.assertLessEqual(result["ageSeconds"], 5)

    def test_iso_timestamp_is_parsed(self) -> None:
        timestamp = datetime.now(settings.TIMEZONE).isoformat()
        result = _freshness({"timestamp": timestamp})

        self.assertEqual(result["status"], "fresh")

    def test_old_timestamp_is_stale(self) -> None:
        timestamp = datetime.now(settings.TIMEZONE) - timedelta(minutes=10)
        result = _freshness({"timestamp": timestamp.isoformat()})

        self.assertEqual(result["status"], "stale")

    def test_missing_timestamp_is_unknown(self) -> None:
        result = _freshness({})

        self.assertEqual(result["status"], "unknown")
        self.assertIsNone(result["ageSeconds"])


if __name__ == "__main__":
    unittest.main()
