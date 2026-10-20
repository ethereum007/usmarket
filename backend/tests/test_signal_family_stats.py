from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from app.config import settings
from app.services.signal_validator import (
    SWING_HORIZONS,
    _horizon_target_dt,
    build_edge_verdict,
    build_outcome_health,
    build_signal_family_stats,
    build_swing_strategy_health,
    signal_family,
)


class SignalFamilyStatsTest(unittest.TestCase):
    def test_signal_family_classifies_core_engines(self) -> None:
        self.assertEqual(signal_family("INTRADAY_RADAR_LONG_A"), "intraday")
        self.assertEqual(signal_family("PDL_BREAK"), "intraday")
        self.assertEqual(signal_family("SWING_BREAKOUT_A"), "swing")
        self.assertEqual(signal_family("ABNORMAL_CLEAN_MOMENTUM"), "abnormal")
        self.assertEqual(signal_family("OI_BEARISH_BUILDUP"), "options")
        self.assertEqual(signal_family("52W_BOUNCE"), "positional")
        self.assertEqual(signal_family("ACCUM_FIVE_STAR"), "positional")
        self.assertEqual(signal_family("CUSTOM_TEST"), "other")

    def test_build_signal_family_stats_weights_by_resolved_outcomes(self) -> None:
        families = build_signal_family_stats(
            {
                "SWING_BREAKOUT_A": {
                    "1h": {
                        "total": 10,
                        "resolved": 8,
                        "pending": 2,
                        "wins": 6,
                        "losses": 2,
                        "flats": 0,
                        "avg_return_pct": 1.0,
                        "avg_mfe_pct": 2.0,
                        "avg_mae_pct": -0.5,
                    }
                },
                "SWING_PULLBACK_A": {
                    "1h": {
                        "total": 5,
                        "resolved": 2,
                        "pending": 3,
                        "wins": 1,
                        "losses": 1,
                        "flats": 0,
                        "avg_return_pct": 3.0,
                        "avg_mfe_pct": 4.0,
                        "avg_mae_pct": -1.5,
                    }
                },
                "ABNORMAL_CLEAN_MOMENTUM": {
                    "1h": {
                        "total": 3,
                        "resolved": 3,
                        "pending": 0,
                        "wins": 1,
                        "losses": 1,
                        "flats": 1,
                        "avg_return_pct": 0.2,
                        "avg_mfe_pct": 1.2,
                        "avg_mae_pct": -0.8,
                    }
                },
            }
        )

        swing = families["swing"]
        swing_1h = swing["horizons"]["1h"]

        self.assertEqual(swing["signal_count"], 2)
        self.assertEqual(swing_1h["total"], 15)
        self.assertEqual(swing_1h["resolved"], 10)
        self.assertEqual(swing_1h["wins"], 7)
        self.assertEqual(swing_1h["losses"], 3)
        self.assertEqual(swing_1h["win_rate"], 70.0)
        self.assertEqual(swing_1h["avg_return_pct"], 1.4)
        self.assertEqual(swing_1h["avg_mfe_pct"], 2.4)
        self.assertEqual(swing_1h["avg_mae_pct"], -0.7)
        self.assertEqual(swing_1h["top_signal"], "SWING_BREAKOUT_A")
        self.assertEqual(swing_1h["edge"]["label"], "SIZE_UP")
        self.assertEqual(swing_1h["edge"]["sample"], "usable")

        abnormal_1h = families["abnormal"]["horizons"]["1h"]
        self.assertEqual(abnormal_1h["win_rate"], 33.3)
        self.assertEqual(abnormal_1h["win_rate_excl_flat"], 50.0)
        self.assertEqual(abnormal_1h["edge"]["label"], "NEEDS_SAMPLE")

    def test_build_edge_verdict_pauses_weak_resolved_engine(self) -> None:
        edge = build_edge_verdict(
            {
                "resolved": 12,
                "win_rate": 25.0,
                "avg_return_pct": -0.6,
                "avg_mfe_pct": 0.4,
                "avg_mae_pct": -1.2,
            }
        )

        self.assertEqual(edge["label"], "PAUSE")
        self.assertEqual(edge["action"], "Do not size this engine")
        self.assertEqual(edge["sample"], "usable")

    def test_build_swing_strategy_health_groups_by_strategy_metadata(self) -> None:
        rows = []
        for idx, status in enumerate(["WIN", "WIN", "LOSS", "WIN", "FLAT", "WIN"], start=1):
            rows.append(
                {
                    "horizon": "next_day_eod",
                    "status": status,
                    "return_pct": 1.2 if status == "WIN" else -0.7 if status == "LOSS" else 0.1,
                    "mfe_pct": 2.4 if status == "WIN" else 0.6,
                    "mae_pct": -0.5 if status == "WIN" else -1.0,
                    "signal_fires": {
                        "id": f"fire-{idx}",
                        "symbol": f"TEST{idx}",
                        "signal_type": "SWING_LIQUIDITY_SHOCK_BULL",
                        "metadata": {
                            "strategy": "LIQUIDITY_SHOCK",
                            "tracking_role": "DISCOVERY",
                            "trade_readiness": "EARLY_ENTRY_ZONE",
                            "quality": "A",
                        },
                    },
                }
            )
        rows.append(
            {
                "horizon": "eod",
                "status": "PENDING",
                "signal_fires": {
                    "id": "fire-pending",
                    "symbol": "WATCH",
                    "signal_type": "SWING_VOL_SQUEEZE_BULL",
                    "metadata": {"strategy": "VOL_SQUEEZE"},
                },
            }
        )

        health = build_swing_strategy_health(rows)

        self.assertEqual(health["summary"]["strategies"], 2)
        liquidity = health["strategies"][0]
        self.assertEqual(liquidity["key"], "LIQUIDITY_SHOCK")
        self.assertEqual(liquidity["fires"], 6)
        self.assertEqual(liquidity["preferred_horizon"], "next_day_eod")
        self.assertEqual(liquidity["preferred"]["resolved"], 6)
        self.assertEqual(liquidity["preferred"]["wins"], 4)
        self.assertEqual(liquidity["preferred"]["win_rate"], 66.7)
        self.assertIn(liquidity["preferred"]["edge"]["label"], {"SIZE_UP", "TRADE_SMALL"})
        self.assertEqual(liquidity["roles"]["DISCOVERY"], 6)
        self.assertEqual(liquidity["readiness"]["EARLY_ENTRY_ZONE"], 6)
        self.assertEqual(health["strategies"][1]["key"], "VOL_SQUEEZE")
        self.assertEqual(health["strategies"][1]["preferred"]["pending"], 1)

    def test_build_outcome_health_marks_due_and_overdue_pending_rows(self) -> None:
        now = datetime(2026, 6, 15, 12, 0, tzinfo=settings.TIMEZONE)
        recent_fire = (now - timedelta(minutes=5)).isoformat()
        due_fire = (now - timedelta(minutes=20)).isoformat()
        overdue_fire = (now - timedelta(hours=2)).isoformat()

        health = build_outcome_health(
            [
                {"status": "PENDING", "horizon": "15m", "signal_fires": {"fired_at": recent_fire}},
                {"status": "PENDING", "horizon": "15m", "signal_fires": {"fired_at": due_fire}},
                {"status": "PENDING", "horizon": "1h", "signal_fires": {"fired_at": overdue_fire}},
                {"status": "WIN", "horizon": "15m", "signal_fires": {"fired_at": overdue_fire}},
            ],
            now=now,
        )

        self.assertEqual(health["pending"], 3)
        self.assertEqual(health["due"], 2)
        self.assertEqual(health["overdue"], 1)
        self.assertEqual(health["status"], "blocked")
        self.assertTrue(health["kite_required"])
        self.assertEqual(health["by_horizon"]["15m"]["pending"], 2)
        self.assertEqual(health["by_horizon"]["1h"]["overdue"], 1)

    def test_next_day_eod_skips_weekend(self) -> None:
        friday_fire = datetime(2026, 6, 12, 14, 45, tzinfo=settings.TIMEZONE)

        target = _horizon_target_dt(friday_fire, "next_day_eod")

        self.assertEqual(target.weekday(), 0)
        self.assertEqual(target.date().isoformat(), "2026-06-15")
        self.assertEqual((target.hour, target.minute), (15, 30))

    def test_next_day_eod_skips_configured_market_holiday(self) -> None:
        friday_fire = datetime(2026, 6, 12, 14, 45, tzinfo=settings.TIMEZONE)

        with patch("app.services.signal_validator._market_holiday_dates", return_value={"2026-06-15"}):
            target = _horizon_target_dt(friday_fire, "next_day_eod")

        self.assertEqual(target.weekday(), 1)
        self.assertEqual(target.date().isoformat(), "2026-06-16")
        self.assertEqual((target.hour, target.minute), (15, 30))

    def test_swing_horizon_counts_market_sessions(self) -> None:
        friday_fire = datetime(2026, 6, 12, 14, 45, tzinfo=settings.TIMEZONE)

        target = _horizon_target_dt(friday_fire, "5d")

        self.assertEqual(SWING_HORIZONS, ["3d", "5d", "10d", "20d"])
        self.assertEqual(target.weekday(), 4)
        self.assertEqual(target.date().isoformat(), "2026-06-19")
        self.assertEqual((target.hour, target.minute), (15, 30))


if __name__ == "__main__":
    unittest.main()
