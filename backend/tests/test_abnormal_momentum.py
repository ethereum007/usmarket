import unittest

from app.engines.abnormal_momentum import RISK_AVOID, RISK_CLEAN, apply_filters, score_rows


class AbnormalMomentumScoringTest(unittest.TestCase):
    def test_clean_high_volume_breakout_scores_high(self):
        result = score_rows([
            {
                "symbol": "NETWEB",
                "last_price": 4533,
                "prev_close": 4195,
                "volume": 3100000,
                "avg_volume20": 900000,
                "delivery_pct": 54,
                "high20": 4310,
                "high50": 4475,
                "sector": "IT",
                "sector_change_pct": 1.7,
                "market_cap_bucket": "mid",
                "turnover_lakh": 140523,
            }
        ])[0]

        self.assertEqual(result.symbol, "NETWEB")
        self.assertGreaterEqual(result.alpha_score, 8)
        self.assertEqual(result.risk_flag, RISK_CLEAN)
        self.assertEqual(result.breakout_status, "50D Breakout")
        self.assertGreater(result.volume_vs_avg, 3)

    def test_surveillance_low_liquidity_is_avoid(self):
        result = score_rows([
            {
                "symbol": "XYZLOW",
                "last_price": 18,
                "prev_close": 16,
                "volume": 500000,
                "avg_volume20": 50000,
                "delivery_pct": 20,
                "high20": 17,
                "market_cap_bucket": "micro",
                "turnover_lakh": 90,
                "trade_to_trade": True,
            }
        ])[0]

        self.assertEqual(result.risk_flag, RISK_AVOID)
        self.assertIn("T2T", result.tags)

    def test_filters_remove_non_breakouts(self):
        results = score_rows([
            {"symbol": "AAA", "last_price": 110, "prev_close": 100, "volume": 3000, "avg_volume20": 1000, "high20": 108, "turnover_lakh": 500},
            {"symbol": "BBB", "last_price": 101, "prev_close": 100, "volume": 3000, "avg_volume20": 1000, "high20": 120, "turnover_lakh": 500},
        ])
        filtered = apply_filters(results, {"onlyBreakout": True, "minVolumeSpike": 1})

        self.assertEqual([item.symbol for item in filtered], ["AAA"])

    def test_live_pdh_breakout_is_labeled_separately(self):
        result = score_rows([
            {
                "symbol": "AAA",
                "last_price": 104,
                "prev_close": 100,
                "volume": 240000,
                "avg_volume20": 100000,
                "pdh": 103,
                "turnover_lakh": 250,
            }
        ])[0]

        self.assertEqual(result.breakout_status, "PDH Breakout")
        self.assertEqual(result.score_breakdown.breakout, 1)


if __name__ == "__main__":
    unittest.main()
