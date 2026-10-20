from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routes import alerts


class AlertRulesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._original_file = alerts.ALERT_RULES_FILE
        self._original_evaluations_file = alerts.ALERT_EVALUATIONS_FILE
        alerts.ALERT_RULES_FILE = Path(self._tmp.name) / "alert_rules.json"
        alerts.ALERT_EVALUATIONS_FILE = Path(self._tmp.name) / "alert_evaluations.json"

    async def asyncTearDown(self) -> None:
        alerts.ALERT_RULES_FILE = self._original_file
        alerts.ALERT_EVALUATIONS_FILE = self._original_evaluations_file
        self._tmp.cleanup()

    async def test_upsert_replaces_existing_symbol_source_rule(self) -> None:
        user = {"id": "trader-1", "email": "trader@example.com"}

        first = await alerts.upsert_alert_rule(
            alerts.AlertRuleBody(symbol="NSE:ICICIGI", bias="SHORT", entry=1687.4, stop=1710.0),
            user,
        )
        second = await alerts.upsert_alert_rule(
            alerts.AlertRuleBody(symbol="ICICIGI", bias="SHORT", entry=1682.0, stop=1702.0),
            user,
        )
        listed = await alerts.list_alert_rules(user)

        self.assertTrue(first["success"])
        self.assertEqual(second["count"], 1)
        self.assertEqual(listed["count"], 1)
        self.assertEqual(listed["rules"][0]["symbol"], "ICICIGI")
        self.assertEqual(listed["rules"][0]["entry"], 1682.0)

    async def test_delete_is_scoped_to_rule_owner(self) -> None:
        owner = {"id": "trader-1", "email": "trader@example.com"}
        other = {"id": "trader-2", "email": "other@example.com"}

        created = await alerts.upsert_alert_rule(
            alerts.AlertRuleBody(symbol="RELIANCE", bias="LONG", entry=1420.0),
            owner,
        )

        with self.assertRaises(HTTPException):
            await alerts.delete_alert_rule(created["rule"]["id"], other)

        deleted = await alerts.delete_alert_rule(created["rule"]["id"], owner)
        listed = await alerts.list_alert_rules(owner)

        self.assertTrue(deleted["success"])
        self.assertEqual(listed["count"], 0)

    async def test_evaluate_long_rule_marks_live_trigger_actionable(self) -> None:
        rule = {
            "id": "r1",
            "symbol": "RELIANCE",
            "bias": "LONG",
            "entry": 100.0,
            "stop": 96.0,
            "target1": 108.0,
            "maxSpreadPct": 0.2,
        }
        quote = {
            "last_price": 101.0,
            "source": "arrow",
            "depth": {"buy": [{"price": 100.95}], "sell": [{"price": 101.0}]},
        }

        result = alerts._evaluate_alert_rule(rule, quote)

        self.assertEqual(result["status"], "TRIGGERED")
        self.assertTrue(result["actionable"])
        self.assertEqual(result["quoteSource"], "arrow")
        self.assertLess(result["spreadPct"], 0.2)

    async def test_evaluate_short_rule_respects_stop_invalidation(self) -> None:
        rule = {
            "id": "r2",
            "symbol": "ICICIGI",
            "bias": "SHORT",
            "entry": 1687.4,
            "stop": 1710.0,
            "target1": 1620.0,
        }
        quote = {"last_price": 1712.0}

        result = alerts._evaluate_alert_rule(rule, quote)

        self.assertEqual(result["status"], "INVALIDATED")
        self.assertFalse(result["actionable"])

    async def test_evaluate_short_rule_marks_near_before_trigger(self) -> None:
        rule = {
            "id": "r3",
            "symbol": "ICICIGI",
            "bias": "SHORT",
            "entry": 1687.4,
            "stop": 1710.0,
        }
        quote = {"last_price": 1690.0}

        result = alerts._evaluate_alert_rule(rule, quote, max_near_pct=0.25)

        self.assertEqual(result["status"], "NEAR")
        self.assertFalse(result["actionable"])

    async def test_evaluate_all_alert_rules_persists_latest_results(self) -> None:
        owner = {"id": "trader-1", "email": "trader@example.com"}
        other = {"id": "trader-2", "email": "other@example.com"}
        await alerts.upsert_alert_rule(alerts.AlertRuleBody(symbol="RELIANCE", bias="LONG", entry=100.0), owner)
        await alerts.upsert_alert_rule(alerts.AlertRuleBody(symbol="ICICIGI", bias="SHORT", entry=1700.0), other)

        quotes = {
            "NSE:RELIANCE": {"last_price": 101.0},
            "NSE:ICICIGI": {"last_price": 1699.0},
        }
        provider = {"provider": "arrow", "requested": 2, "returned": 2, "fallback": False}
        with patch.object(alerts, "_fetch_alert_quotes", AsyncMock(return_value=(quotes, provider))) as fetch_quotes:
            result = await alerts.evaluate_all_alert_rules()

        fetch_quotes.assert_awaited_once()
        self.assertEqual(result["summary"]["total"], 2)
        self.assertEqual(result["summary"]["triggered"], 2)
        self.assertTrue(alerts.ALERT_EVALUATIONS_FILE.exists())

        latest = await alerts.latest_alert_evaluations(owner)
        self.assertEqual(latest["summary"]["total"], 1)
        self.assertEqual(latest["evaluations"][0]["symbol"], "RELIANCE")
        self.assertEqual(latest["evaluations"][0]["status"], "TRIGGERED")

    async def test_trigger_notifications_send_once_after_success(self) -> None:
        evaluations = [
            {
                "id": "rule-1",
                "symbol": "RELIANCE",
                "bias": "LONG",
                "status": "TRIGGERED",
                "actionable": True,
                "ltp": 101.0,
                "entry": 100.0,
                "stop": 96.0,
                "target1": 108.0,
                "spreadPct": 0.04,
                "source": "decision-cockpit",
                "userEmail": "trader@example.com",
            }
        ]

        with (
            patch.object(alerts, "_telegram_configured", return_value=True),
            patch("app.core.telegram.send_message", AsyncMock(return_value={"ok": True})) as send_message,
        ):
            first = await alerts._send_trigger_notifications(evaluations, {"evaluations": []})

        self.assertEqual(first["attempted"], 1)
        self.assertEqual(first["sent"], 1)
        self.assertEqual(first["_sentRuleIds"], ["rule-1"])
        send_message.assert_awaited_once()

        alerts._mark_sent_trigger_notifications(evaluations, first["_sentRuleIds"])

        with (
            patch.object(alerts, "_telegram_configured", return_value=True),
            patch("app.core.telegram.send_message", AsyncMock(return_value={"ok": True})) as send_message,
        ):
            second = await alerts._send_trigger_notifications(evaluations, {"evaluations": evaluations})

        self.assertEqual(second["attempted"], 0)
        self.assertEqual(second["sent"], 0)
        send_message.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
