import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.routes.abnormal import _cached_live_response, abnormal_radar


class AbnormalRouteCacheTest(unittest.TestCase):
    def test_cached_live_response_marks_session_fallback(self):
        cached_payload = {
            "data": {
                "success": True,
                "source": "live",
                "count": 1,
                "totalScored": 1,
                "results": [{"symbol": "AAA"}],
                "summary": {"cleanMomentum": 1, "watchCarefully": 0, "avoid": 0, "avgScore": 7},
                "meta": {"cache": {"hit": False}, "warning": None},
            },
            "timestamp": "2026-06-12T15:00:00+05:30",
        }
        with patch("app.routes.abnormal.load_session", return_value=cached_payload):
            response = _cached_live_response("Live broker quote fetch failed.")

        self.assertIsNotNone(response)
        self.assertEqual(response["source"], "live-cache")
        self.assertTrue(response["cached"])
        self.assertTrue(response["meta"]["cache"]["sessionFallback"])
        self.assertIn("last successful", response["meta"]["warning"])


class AbnormalRouteLiveFallbackTest(unittest.IsolatedAsyncioTestCase):
    async def test_live_request_without_broker_uses_cached_live_before_sample(self):
        cached_response = {
            "success": True,
            "source": "live-cache",
            "count": 1,
            "totalScored": 1,
            "results": [{"symbol": "AAA"}],
            "summary": {"cleanMomentum": 1, "watchCarefully": 0, "avoid": 0, "avgScore": 7},
            "meta": {"warning": "cached"},
        }
        with (
            patch("app.routes.abnormal.kite_state", SimpleNamespace(is_connected=False)),
            patch("app.routes.abnormal._cached_live_response", return_value=cached_response),
        ):
            response = await abnormal_radar({"source": "live"}, user={"id": "u1"})

        self.assertEqual(response["source"], "live-cache")
        self.assertEqual(response["results"][0]["symbol"], "AAA")


if __name__ == "__main__":
    unittest.main()
