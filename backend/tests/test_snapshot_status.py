from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.config import settings
from app.routes import snapshots
from fastapi import HTTPException


class SnapshotStatusTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._data_dir = Path(self._tmp.name)

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_snapshot_status_reports_available_and_missing(self) -> None:
        now = 1_800_000_000.0
        payload = {
            "data": {"ok": True},
            "timestamp": "2026-06-12T15:30:00+05:30",
            "savedAt": now - 300,
        }
        (self._data_dir / "session_indices.json").write_text(json.dumps(payload), encoding="utf-8")

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=False)),
            patch.object(snapshots, "SNAPSHOT_KEYS", (("indices", "Indices", "Market"), ("pulse", "Pulse", "Intraday"))),
            patch("app.routes.snapshots.time.time", return_value=now),
        ):
            response = await snapshots.snapshot_status()

        self.assertTrue(response["success"])
        self.assertEqual(response["summary"]["tracked"], 2)
        self.assertEqual(response["summary"]["available"], 1)
        self.assertEqual(response["summary"]["missing"], 1)
        self.assertEqual(response["snapshots"][0]["status"], "fresh")
        self.assertEqual(response["snapshots"][0]["ageLabel"], "5m")
        self.assertEqual(response["snapshots"][0]["source"]["endpoint"], "/api/quotes/indices")
        self.assertEqual(response["snapshots"][1]["status"], "missing")
        self.assertEqual(response["snapshots"][1]["source"]["endpoint"], "/api/pulse")
        self.assertTrue(response["summary"]["needsSeeding"])
        self.assertEqual(response["summary"]["nextSeed"]["key"], "pulse")
        self.assertEqual(response["seedQueue"][0]["blockedBy"], ["broker_login"])
        self.assertEqual(response["summary"]["replayReadiness"]["score"], 50)
        self.assertEqual(response["summary"]["replayReadiness"]["mode"], "degraded")
        self.assertEqual(response["summary"]["replayReadiness"]["blocked"], 1)
        self.assertIn("Login to broker", response["summary"]["replayReadiness"]["action"])

    async def test_snapshot_status_returns_ranked_seed_queue(self) -> None:
        now = 1_800_000_000.0
        stale_payload = {
            "data": {"ok": True},
            "timestamp": "2026-06-12T15:30:00+05:30",
            "savedAt": now - (48 * 60 * 60),
        }
        (self._data_dir / "session_indices.json").write_text(json.dumps(stale_payload), encoding="utf-8")

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True)),
            patch.object(
                snapshots,
                "SNAPSHOT_KEYS",
                (
                    ("indices", "Indices", "Market"),
                    ("intraday_radar", "Intraday Radar", "Intraday"),
                    ("swing_spectrum", "Swing Spectrum", "Swing"),
                ),
            ),
            patch("app.routes.snapshots.time.time", return_value=now),
        ):
            response = await snapshots.snapshot_status()

        self.assertEqual([item["key"] for item in response["seedQueue"]], ["intraday_radar", "swing_spectrum", "indices"])
        self.assertTrue(response["seedQueue"][0]["canSeedNow"])
        self.assertEqual(response["seedQueue"][0]["reason"], "No replay snapshot exists yet.")
        self.assertEqual(response["seedQueue"][2]["reason"], "Last replay is stale at 2.0d.")
        self.assertEqual(response["summary"]["replayReadiness"]["canSeedNow"], 3)
        self.assertEqual(response["summary"]["replayReadiness"]["needsAttention"], 3)
        self.assertEqual(response["summary"]["replayReadiness"]["byGroup"][0]["group"], "Intraday")

    async def test_snapshot_status_marks_fresh_replay_ready(self) -> None:
        now = 1_800_000_000.0
        for key in ("indices", "intraday_radar"):
            payload = {
                "data": {"ok": True},
                "timestamp": "2026-06-12T15:30:00+05:30",
                "savedAt": now - 120,
            }
            (self._data_dir / f"session_{key}.json").write_text(json.dumps(payload), encoding="utf-8")

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True)),
            patch.object(
                snapshots,
                "SNAPSHOT_KEYS",
                (("indices", "Indices", "Market"), ("intraday_radar", "Intraday Radar", "Intraday")),
            ),
            patch("app.routes.snapshots.time.time", return_value=now),
        ):
            response = await snapshots.snapshot_status()

        readiness = response["summary"]["replayReadiness"]
        self.assertEqual(readiness["score"], 100)
        self.assertEqual(readiness["label"], "Live ready")
        self.assertEqual(readiness["mode"], "ready")
        self.assertEqual(readiness["ready"], 2)
        self.assertEqual(readiness["needsAttention"], 0)

    async def test_snapshot_detail_returns_cached_payload(self) -> None:
        now = 1_800_000_000.0
        payload = {
            "data": {"indices": [{"symbol": "NIFTY", "changePct": 1.2}]},
            "timestamp": "2026-06-12T15:30:00+05:30",
            "savedAt": now - 900,
        }
        (self._data_dir / "session_indices.json").write_text(json.dumps(payload), encoding="utf-8")

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch.object(snapshots, "SNAPSHOT_KEYS", (("indices", "Indices", "Market"),)),
            patch("app.routes.snapshots.time.time", return_value=now),
        ):
            response = await snapshots.snapshot_detail("indices")

        self.assertTrue(response["success"])
        self.assertEqual(response["snapshot"]["key"], "indices")
        self.assertEqual(response["snapshot"]["status"], "fresh")
        self.assertEqual(response["data"]["indices"][0]["symbol"], "NIFTY")

    async def test_snapshot_detail_rejects_unknown_key(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await snapshots.snapshot_detail("../secret")

        self.assertEqual(ctx.exception.status_code, 404)

    async def test_snapshot_detail_reports_missing_snapshot(self) -> None:
        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch.object(snapshots, "SNAPSHOT_KEYS", (("indices", "Indices", "Market"),)),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await snapshots.snapshot_detail("indices")

        self.assertEqual(ctx.exception.status_code, 404)

    async def test_snapshot_detail_loads_legacy_abnormal_live_alias(self) -> None:
        now = 1_800_000_000.0
        payload = {
            "data": {"source": "live", "results": [{"symbol": "NETWEB"}]},
            "timestamp": "2026-06-12T15:30:00+05:30",
            "savedAt": now - 120,
        }
        (self._data_dir / "session_abnormal_radar_live.json").write_text(json.dumps(payload), encoding="utf-8")

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.time.time", return_value=now),
        ):
            response = await snapshots.snapshot_detail("abnormal_live")

        self.assertTrue(response["success"])
        self.assertEqual(response["snapshot"]["key"], "abnormal_live")
        self.assertEqual(response["snapshot"]["path"], "session_abnormal_radar_live.json")
        self.assertEqual(response["data"]["results"][0]["symbol"], "NETWEB")

    def test_status_for_age_bands(self) -> None:
        self.assertEqual(snapshots._status_for_age(60), "fresh")
        self.assertEqual(snapshots._status_for_age(60 * 60), "last-session")
        self.assertEqual(snapshots._status_for_age(48 * 60 * 60), "stale")
        self.assertEqual(snapshots._status_for_age(None), "unknown")

    def test_status_for_age_uses_feed_specific_fresh_window(self) -> None:
        self.assertEqual(snapshots._status_for_age(30 * 60), "last-session")
        self.assertEqual(snapshots._status_for_age(30 * 60, key="abnormal_live"), "fresh")
        self.assertEqual(snapshots._status_for_age(30 * 60, key="swing_spectrum"), "fresh")

    def test_swing_snapshot_key_is_registered(self) -> None:
        self.assertEqual(
            snapshots._snapshot_meta("swing_spectrum"),
            ("swing_spectrum", "Swing Spectrum", "Swing"),
        )
        self.assertEqual(
            snapshots._snapshot_source("swing_spectrum")["endpoint"],
            "/api/scanner/swing/warm",
        )
        self.assertTrue(snapshots._snapshot_source("swing_spectrum")["requiresBroker"])

    def test_warm_target_keys_uses_ranked_seed_queue(self) -> None:
        request = snapshots.SnapshotWarmRequest(limit=2)
        seed_queue = [
            {"key": "swing_spectrum", "canSeedNow": True},
            {"key": "52w_bounce", "canSeedNow": False},
            {"key": "breadth", "canSeedNow": True},
        ]

        self.assertEqual(
            snapshots._warm_target_keys(request, seed_queue),
            ["swing_spectrum", "breadth"],
        )

    def test_warm_target_keys_dedupes_explicit_keys(self) -> None:
        request = snapshots.SnapshotWarmRequest(keys=["breadth", "breadth", "indices"], limit=5)

        self.assertEqual(
            snapshots._warm_target_keys(request, []),
            ["breadth", "indices"],
        )

    async def test_warm_snapshots_returns_per_key_results(self) -> None:
        async def fake_warm(key: str, **_: object) -> dict:
            if key == "breadth":
                return {"total": 500}
            raise HTTPException(status_code=503, detail="feed unavailable")

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True)),
            patch.object(snapshots, "_warm_snapshot_key", AsyncMock(side_effect=fake_warm)),
            patch.object(snapshots, "SNAPSHOT_KEYS", (("breadth", "Market Breadth", "Market"), ("orb_signals", "ORB Signals", "Signals"))),
        ):
            response = await snapshots.warm_snapshots(
                snapshots.SnapshotWarmRequest(keys=["breadth", "orb_signals"], limit=2),
                kite=SimpleNamespace(),
                user={"id": "premium-user", "is_premium": True},
            )

        self.assertTrue(response["success"])
        self.assertEqual(response["warmed"], 1)
        self.assertEqual(response["failed"], 1)
        self.assertEqual(response["results"][0]["status"], "WARMED")
        self.assertEqual(response["results"][1]["status"], "FAILED")
        self.assertEqual(response["results"][1]["statusCode"], 503)

    async def test_warm_snapshots_timeout_does_not_block_remaining_keys(self) -> None:
        async def fake_warm(key: str, **_: object) -> dict:
            if key == "breadth":
                await asyncio.sleep(0.05)
                return {"total": 500}
            return {"items": [1, 2, 3]}

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True)),
            patch.object(snapshots, "_warm_snapshot_key", AsyncMock(side_effect=fake_warm)),
            patch.object(snapshots, "_warm_timeout_seconds", return_value=0.01),
            patch.object(snapshots, "SNAPSHOT_KEYS", (("breadth", "Market Breadth", "Market"), ("indices", "Indices", "Market"))),
        ):
            response = await snapshots.warm_snapshot_targets(
                request=snapshots.SnapshotWarmRequest(keys=["breadth", "indices"], limit=2),
                kite=SimpleNamespace(),
                user={"id": "system", "is_premium": True},
            )

        self.assertEqual(response["requested"], 2)
        self.assertEqual(response["failed"], 1)
        self.assertEqual(response["warmed"], 1)
        self.assertEqual(response["results"][0]["status"], "FAILED")
        self.assertEqual(response["results"][0]["statusCode"], 504)
        self.assertEqual(response["results"][1]["status"], "WARMED")

    async def test_internal_warmer_uses_system_user_when_called_without_user(self) -> None:
        async def fake_warm(_key: str, **kwargs: object) -> dict:
            user = kwargs["user"]
            self.assertEqual(user["id"], "system:snapshot-warmer")
            self.assertTrue(user["is_premium"])
            return {"signals": [{"symbol": "RELIANCE"}]}

        route_settings = SimpleNamespace(DATA_DIR=self._data_dir, TIMEZONE=settings.TIMEZONE)
        with (
            patch("app.routes.snapshots.settings", route_settings),
            patch("app.core.session_cache.settings", route_settings),
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True)),
            patch.object(snapshots, "_warm_snapshot_key", AsyncMock(side_effect=fake_warm)),
            patch.object(snapshots, "SNAPSHOT_KEYS", (("live_signals", "Live Signals", "Signals"),)),
        ):
            response = await snapshots.warm_snapshot_targets(
                request=snapshots.SnapshotWarmRequest(keys=["live_signals"], limit=1),
            )

        self.assertEqual(response["warmed"], 1)
        self.assertEqual(response["results"][0]["message"], "Warm request completed with 1 signals.")

    async def test_scheduled_warmer_passes_active_kite_and_bounded_request(self) -> None:
        fake_kite = SimpleNamespace(name="kite")
        warm = AsyncMock(return_value={"success": True, "requested": 1, "warmed": 1, "failed": 0, "skipped": 0})

        with (
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True, kite=fake_kite)),
            patch.object(snapshots, "warm_snapshot_targets", warm),
        ):
            response = await snapshots.warm_next_replay_snapshots(limit=2, universe="smallcap", symbol_limit=80)

        self.assertEqual(response["warmed"], 1)
        kwargs = warm.await_args.kwargs
        self.assertIs(kwargs["kite"], fake_kite)
        self.assertEqual(kwargs["request"].limit, 2)
        self.assertEqual(kwargs["request"].universe, "smallcap")
        self.assertEqual(kwargs["request"].symbolLimit, 80)
        self.assertEqual(kwargs["user"]["id"], "system:snapshot-warmer")

    async def test_scheduled_warmer_can_force_priority_keys(self) -> None:
        fake_kite = SimpleNamespace(name="kite")
        warm = AsyncMock(return_value={"success": True, "requested": 2, "warmed": 2, "failed": 0, "skipped": 0})

        with (
            patch("app.routes.snapshots.kite_state", SimpleNamespace(is_connected=True, kite=fake_kite)),
            patch.object(snapshots, "warm_snapshot_targets", warm),
        ):
            response = await snapshots.warm_next_replay_snapshots(
                limit=2,
                universe="nifty200",
                symbol_limit=160,
                keys=["intraday_radar", "swing_spectrum"],
            )

        self.assertEqual(response["warmed"], 2)
        kwargs = warm.await_args.kwargs
        self.assertEqual(kwargs["request"].keys, ["intraday_radar", "swing_spectrum"])
        self.assertEqual(kwargs["request"].limit, 2)
        self.assertEqual(kwargs["request"].symbolLimit, 160)

    async def test_broker_warmer_requires_connected_kite(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            await snapshots._warm_snapshot_key(
                "breadth",
                kite=None,
                user={"id": "premium-user", "is_premium": True},
                universe="nifty200",
                symbol_limit=120,
            )

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("Broker is not connected", str(ctx.exception.detail))

    async def test_non_broker_warmer_runs_without_connected_kite(self) -> None:
        with patch("app.routes.signals.live_signals", AsyncMock(return_value={"pdhCrossCount": 0, "pdlCrossCount": 0})):
            response = await snapshots._warm_snapshot_key(
                "live_signals",
                kite=None,
                user={"id": "premium-user", "is_premium": True},
                universe="nifty200",
                symbol_limit=120,
            )

        self.assertEqual(response["pdhCrossCount"], 0)


if __name__ == "__main__":
    unittest.main()
