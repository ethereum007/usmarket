from __future__ import annotations

import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pandas as pd

from app.config import settings
from app.routes import scanner
from app.services.scanner_service import _merge_live_daily_candle


class SwingWarmTest(unittest.IsolatedAsyncioTestCase):
    def test_live_quote_appends_today_daily_candle_for_server_warm_scan(self) -> None:
        df = pd.DataFrame(
            [
                {
                    "date": "2026-06-15",
                    "open": 100,
                    "high": 105,
                    "low": 98,
                    "close": 104,
                    "volume": 1000,
                }
            ]
        )
        quote = {
            "timestamp": "2026-06-16T09:30:00+05:30",
            "last_price": 111,
            "ohlc": {"open": 106, "high": 112, "low": 105, "close": 104},
            "volume": 2500,
        }

        merged = _merge_live_daily_candle(
            df,
            quote,
            datetime(2026, 6, 16, 9, 30, tzinfo=settings.TIMEZONE),
        )

        self.assertEqual(len(merged), 2)
        self.assertEqual(float(merged.iloc[-1]["close"]), 111)
        self.assertEqual(int(merged.iloc[-1]["volume"]), 2500)
        self.assertEqual(str(merged.iloc[-1]["date"])[:10], "2026-06-16")

    def test_live_quote_updates_existing_today_daily_candle(self) -> None:
        df = pd.DataFrame(
            [
                {
                    "date": "2026-06-16",
                    "open": 100,
                    "high": 108,
                    "low": 97,
                    "close": 106,
                    "volume": 1200,
                }
            ]
        )
        quote = {
            "timestamp": "2026-06-16T10:15:00+05:30",
            "last_price": 111,
            "ohlc": {"open": 102, "high": 113, "low": 99, "close": 106},
            "volume": 2600,
        }

        merged = _merge_live_daily_candle(
            df,
            quote,
            datetime(2026, 6, 16, 10, 15, tzinfo=settings.TIMEZONE),
        )

        self.assertEqual(len(merged), 1)
        self.assertEqual(float(merged.iloc[-1]["open"]), 100)
        self.assertEqual(float(merged.iloc[-1]["high"]), 113)
        self.assertEqual(float(merged.iloc[-1]["low"]), 97)
        self.assertEqual(float(merged.iloc[-1]["close"]), 111)
        self.assertEqual(int(merged.iloc[-1]["volume"]), 2600)

    async def test_warm_swing_snapshot_saves_normalized_payload(self) -> None:
        raw_signal = {
            "symbol": "netweb",
            "strategy": "MOMENTUM_BURST",
            "signal": "BULL",
            "currentPrice": 2500,
            "changePct": 8.4,
            "triggerDate": "2026-06-15T15:30:00+05:30",
            "breakoutLevel": 2400,
            "stopLoss": 2325,
            "target": 2885,
            "strength": 88,
            "notes": "Live momentum burst with strong RVOL.",
            "entry_price": 2500,
            "risk_pct": 7,
            "reward_pct": 15.4,
            "rr": 2.2,
            "hold_days": "2-10D",
            "trend_score": 90,
            "volume_score": 95,
            "pattern_score": 82,
            "quality": "A+",
            "rvol": 3.1,
            "setup_phase": "LIVE_MOMENTUM",
            "reasons": ["price above 20 DMA"],
        }

        with (
            patch("app.services.scanner_service.scan_swing", new=AsyncMock(return_value=[raw_signal])) as scan,
            patch("app.routes.scanner.save_session") as save_session,
            patch("app.routes.scanner._log_swing_signal_fires", return_value={"eligible": 1, "logged": 0}),
        ):
            response = await scanner.warm_swing_snapshot(
                scanner.SwingWarmRequest(symbols=["netweb"], limit=1),
                kite=object(),
                user={"is_premium": True},
            )

        scan.assert_awaited_once()
        self.assertEqual(response["source"], "server_warm")
        self.assertEqual(response["scannedSymbols"], 1)
        self.assertEqual(response["count"], 1)
        self.assertEqual(response["best_trade"]["symbol"], "NETWEB")
        self.assertEqual(response["radar"]["best"]["symbol"], "NETWEB")
        self.assertEqual(response["radar"]["summary"]["symbols"], 1)
        self.assertEqual(response["composite"][0]["direction"], "LONG")
        self.assertEqual(response["best_trade"]["current_price"], 2500)
        self.assertEqual(response["summary"]["a_plus"], 1)
        save_session.assert_called_once_with("swing_spectrum", response)

    def test_swing_radar_combines_strategy_votes_per_symbol(self) -> None:
        signals = [
            scanner._normalize_swing_signal({
                "symbol": "NETWEB",
                "strategy": "EARLY_MOMENTUM",
                "signal": "BULL",
                "current_price": 2450,
                "change_pct": 2.4,
                "breakout_level": 2480,
                "stop_loss": 2320,
                "target": 2750,
                "strength": 76,
                "notes": "Base reclaim with improving delivery.",
                "entry_price": 2480,
                "risk_pct": 5.3,
                "reward_pct": 11.0,
                "rr": 2.1,
                "trend_score": 72,
                "volume_score": 70,
                "pattern_score": 74,
                "quality": "A",
                "rvol": 1.5,
                "setup_phase": "FIRST_RECLAIM",
                "reasons": ["base reclaim", "volume lift"],
            }),
            scanner._normalize_swing_signal({
                "symbol": "NETWEB",
                "strategy": "50D_BO",
                "signal": "BULL",
                "current_price": 2450,
                "change_pct": 2.4,
                "breakout_level": 2520,
                "stop_loss": 2320,
                "target": 2810,
                "strength": 74,
                "notes": "Close near 50D breakout shelf.",
                "entry_price": 2520,
                "risk_pct": 5.3,
                "reward_pct": 14.6,
                "rr": 2.7,
                "trend_score": 75,
                "volume_score": 68,
                "pattern_score": 72,
                "quality": "A",
                "rvol": 1.4,
                "setup_phase": "CONFIRMED_CLOSE",
                "reasons": ["range pressure"],
            }),
        ]

        radar = scanner._build_swing_radar(signals)

        self.assertEqual(radar["summary"]["symbols"], 1)
        row = radar["rows"][0]
        self.assertEqual(row["symbol"], "NETWEB")
        self.assertEqual(row["direction"], "LONG")
        self.assertGreaterEqual(row["strategy_count"], 2)
        self.assertIn(row["phase"], {"READY_BREAKOUT", "EARLY_ACCUMULATION"})
        self.assertGreaterEqual(row["score"], 80)
        self.assertIn(row["action"], {"PLAN_ENTRY", "BUILD_WATCH"})
        self.assertEqual(len(row["votes"]), 2)

    def test_warm_symbols_deduplicates_and_caps(self) -> None:
        payload = scanner.SwingWarmRequest(symbols=["netweb", "NETWEB", " kaynes "], limit=2)

        self.assertEqual(scanner._warm_swing_symbols(payload), ["NETWEB", "KAYNES"])

    def test_universe_warm_prioritizes_momentum_watchlist(self) -> None:
        payload = scanner.SwingWarmRequest(universe="smallcap", limit=3)

        self.assertEqual(scanner._warm_swing_symbols(payload), ["NETWEB", "DATAPATTNS", "CARTRADE"])


if __name__ == "__main__":
    unittest.main()
