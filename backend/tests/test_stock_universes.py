from __future__ import annotations

import unittest

from app.caches import stock_universes
from app.routes import scanner, snapshots


class StockUniverseTest(unittest.TestCase):
    def test_core_nifty_universes_use_explicit_index_order(self) -> None:
        self.assertEqual(stock_universes.resolve_universe("nifty50", limit=3), ["RELIANCE", "TCS", "HDFCBANK"])
        self.assertEqual(len(stock_universes.resolve_universe("nifty100")), 100)
        self.assertEqual(len(stock_universes.resolve_universe("nifty200")), 200)
        self.assertIn("BATAINDIA", stock_universes.resolve_universe("nifty500"))
        self.assertIn("KPRMILL", stock_universes.resolve_universe("nifty500"))

    def test_smallcap_universe_is_explicit_and_limited(self) -> None:
        symbols = stock_universes.resolve_universe("smallcap", limit=5)

        self.assertEqual(len(stock_universes.resolve_universe("smallcap")), 250)
        self.assertEqual(symbols, ["5PAISA", "AARTIDRUGS", "AARTIPHARM", "ABFRL", "ADANITOTAL"])
        self.assertIn("ANANTRAJ", stock_universes.SMALLCAP_250)
        self.assertNotEqual(symbols, stock_universes.NIFTY500_STOCKS[:5])

    def test_microcap_universe_is_explicit_and_limited(self) -> None:
        symbols = stock_universes.resolve_universe("microcap", limit=5)

        self.assertEqual(len(stock_universes.resolve_universe("microcap")), 98)
        self.assertEqual(symbols, ["5PAISA", "AARTIDRUGS", "AARTIPHARM", "AGARIND", "AJMERA"])
        self.assertIn("PRICOLLTD", stock_universes.MICROCAP_WATCH)

    def test_runner_discovery_additions_and_recent_ipos_are_monitored(self) -> None:
        broad = stock_universes.resolve_universe("broad")

        self.assertIn("MTARTECH", broad)
        self.assertIn("LALITHAA", broad)
        self.assertIn("DHOOTTRANS", broad)
        for symbol in stock_universes.RECENT_IPO_WATCH_STOCKS:
            with self.subTest(symbol=symbol):
                self.assertIn(symbol, broad[:500])

    def test_swing_warm_uses_resolved_smallcap_source(self) -> None:
        symbols = scanner._warm_swing_symbols(scanner.SwingWarmRequest(universe="smallcap", limit=4))

        self.assertEqual(symbols, ["NETWEB", "DATAPATTNS", "CARTRADE", "KAYNES"])

    def test_swing_warm_prioritizes_live_quote_movers(self) -> None:
        quote_map = {
            "NSE:BATAINDIA": {
                "last_price": 786.05,
                "volume": 9_626_370,
                "ohlc": {"high": 803.3, "low": 676.05, "close": 678.5},
            },
            "NSE:KPRMILL": {
                "last_price": 1189.8,
                "volume": 3_782_583,
                "ohlc": {"high": 1208.7, "low": 1047.3, "close": 1043.25},
            },
        }

        symbols = scanner._warm_swing_symbols(
            scanner.SwingWarmRequest(universe="nifty500", limit=4),
            quote_map=quote_map,
        )

        self.assertIn("BATAINDIA", symbols)
        self.assertIn("KPRMILL", symbols)
        self.assertLess(symbols.index("BATAINDIA"), 4)
        self.assertLess(symbols.index("KPRMILL"), 4)

    def test_snapshot_warm_uses_resolved_microcap_source(self) -> None:
        symbols = snapshots._warm_symbols("microcap", 4)

        self.assertEqual(symbols, ["5PAISA", "AARTIDRUGS", "AARTIPHARM", "AGARIND"])


if __name__ == "__main__":
    unittest.main()
