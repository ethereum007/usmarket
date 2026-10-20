from __future__ import annotations

import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from app import main
from app.services import arrow_market_data_service as arrow


def _settings(data_dir: Path, **overrides):
    values = {
        "DATA_DIR": data_dir,
        "TIMEZONE": ZoneInfo("Asia/Kolkata"),
        "ARROW_BASE_URL": "https://edge.arrow.trade",
        "ARROW_APP_ID": "app-id",
        "ARROW_APP_SECRET": "test-secret",
        "ARROW_ACCESS_TOKEN": "",
        "ARROW_AUTO_LOGIN_ENABLED": True,
        "ARROW_USER_ID": "ARROW001",
        "ARROW_PASSWORD": "test-password-123",
        "ARROW_TOTP_SECRET": "JBSWY3DPEHPK3PXP",
        "ARROW_AUTO_LOGIN_HOUR": 8,
        "ARROW_AUTO_LOGIN_MINUTE": 30,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class ArrowAutoLoginTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.token_path = self.data_dir / "arrow_token.json"

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_sdk_auto_login_persists_only_required_token_metadata(self) -> None:
        fake_client = Mock()
        fake_client.auto_login.return_value = {
            "token": "fresh-access-token",
            "userID": "ARROW001",
            "name": "Alpha User",
        }
        fake_client.get_token.return_value = "fresh-access-token"
        test_settings = _settings(self.data_dir)

        with (
            patch.object(arrow, "settings", test_settings),
            patch.object(arrow, "ARROW_TOKEN_PATH", self.token_path),
            patch("pyarrow_client.ArrowClient", return_value=fake_client),
        ):
            result = arrow._run_sdk_auto_login()

        fake_client.auto_login.assert_called_once_with(
            user_id="ARROW001",
            password="test-password-123",
            app_secret="test-secret",
            totp_secret="JBSWY3DPEHPK3PXP",
        )
        payload = json.loads(self.token_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["access_token"], "fresh-access-token")
        self.assertEqual(payload["auth_mode"], "auto")
        self.assertEqual(payload["user_id"], "ARROW001")
        self.assertNotIn("test-password-123", self.token_path.read_text(encoding="utf-8"))
        self.assertNotIn("JBSWY3DPEHPK3PXP", self.token_path.read_text(encoding="utf-8"))
        self.assertNotIn("token", result)
        self.assertEqual(self.token_path.stat().st_mode & 0o777, 0o600)

    async def test_fresh_saved_token_wins_over_stale_environment_token_in_auto_mode(self) -> None:
        test_settings = _settings(self.data_dir, ARROW_ACCESS_TOKEN="old-env-token")
        with (
            patch.object(arrow, "settings", test_settings),
            patch.object(arrow, "ARROW_TOKEN_PATH", self.token_path),
        ):
            arrow._write_token("fresh-saved-token", auth_mode="auto", user_id="ARROW001")
            token, source = arrow.get_active_access_token()
            self.assertTrue(arrow.saved_access_token_is_fresh(minimum_remaining=timedelta(hours=23)))

        self.assertEqual(token, "fresh-saved-token")
        self.assertEqual(source, "saved")

    async def test_auto_login_reports_missing_settings_without_exposing_values(self) -> None:
        test_settings = _settings(
            self.data_dir,
            ARROW_PASSWORD="",
            ARROW_TOTP_SECRET="",
        )
        with patch.object(arrow, "settings", test_settings):
            result = await arrow.auto_login(reason="test")
            status = arrow.get_auto_login_status()

        self.assertFalse(result["success"])
        self.assertEqual(result["missingSettings"], ["ARROW_PASSWORD", "ARROW_TOTP_SECRET"])
        self.assertEqual(status["lastStatus"], "error")
        self.assertNotIn("ARROW001", str(result))

    async def test_auto_login_redacts_credentials_from_sdk_errors(self) -> None:
        test_settings = _settings(self.data_dir)
        with (
            patch.object(arrow, "settings", test_settings),
            patch.object(arrow, "_run_sdk_auto_login", side_effect=RuntimeError("bad test-password-123")),
        ):
            result = await arrow.auto_login(reason="test")

        self.assertFalse(result["success"])
        self.assertNotIn("test-password-123", result["error"])
        self.assertIn("[redacted]", result["error"])

    async def test_scheduler_registers_weekday_arrow_refresh(self) -> None:
        scheduler = SimpleNamespace(add_job=Mock())
        test_settings = _settings(self.data_dir)
        with (
            patch.object(main, "settings", test_settings),
            patch("app.core.scheduler.get_scheduler", return_value=scheduler),
            patch("app.core.scheduler.start_scheduler") as start_scheduler,
        ):
            main._register_arrow_auto_login_job()

        scheduler.add_job.assert_called_once()
        kwargs = scheduler.add_job.call_args.kwargs
        self.assertEqual(kwargs["id"], "arrow_auto_login")
        self.assertEqual(kwargs["kwargs"], {"reason": "scheduled"})
        self.assertEqual(kwargs["max_instances"], 1)
        self.assertTrue(kwargs["coalesce"])
        self.assertIn("day_of_week='mon-fri'", str(kwargs["trigger"]))
        self.assertIn("hour='8'", str(kwargs["trigger"]))
        self.assertIn("minute='30'", str(kwargs["trigger"]))
        start_scheduler.assert_called_once()


if __name__ == "__main__":
    unittest.main()
