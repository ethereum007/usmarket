import unittest
from unittest.mock import patch

from app.services import abnormal_radar_service as service


class AbnormalRadarServiceTest(unittest.IsolatedAsyncioTestCase):
    def test_default_live_scan_prioritizes_recent_ipos(self):
        symbols = service._symbols_for_live_scan(None)

        self.assertLessEqual(len(symbols), service._MAX_SYMBOLS)
        self.assertIn("DHOOTTRANS", symbols)
        self.assertIn("DEEPA", symbols)
        self.assertLess(symbols.index("DHOOTTRANS"), len(service.MOMENTUM_WATCH) + 25)

    async def test_live_scan_relaxes_volume_filter_when_avg_volume_cache_is_cold(self):
        service._response_cache.clear()
        service._quote_cache.update({"ts": 0.0, "key": "", "data": {}, "meta": {}})

        async def fake_fetch_quotes(_kite, symbols, _quote_provider):
            return (
                {
                    "NSE:AAA": {
                        "last_price": 110,
                        "volume": 1_000_000,
                        "ohlc": {"open": 101, "high": 112, "low": 99, "close": 100},
                    }
                },
                {"provider": "kite", "requested": len(symbols), "returned": 1, "fallback": False},
            )

        with (
            patch.object(service, "_symbols_for_live_scan", return_value=["AAA"]),
            patch.object(service, "_fetch_quotes", new=fake_fetch_quotes),
            patch.object(service, "_cache_value", return_value=None),
        ):
            result = await service.build_live_abnormal_radar(
                object(),
                filters={"minVolumeSpike": 2, "minPriceChange": 2},
                use_cache=False,
            )

        self.assertEqual(result["count"], 1)
        self.assertTrue(result["meta"]["filters"]["relaxedVolumeFilter"])
        self.assertEqual(result["meta"]["dataQuality"]["avgVolumeCoveragePct"], 0)
        self.assertIn("volume confirmation", result["meta"]["warning"])


if __name__ == "__main__":
    unittest.main()
