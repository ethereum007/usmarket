from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from app.config import settings
from app.routes.subscription import razorpay_webhook


class _FakeRequest:
    def __init__(self, body: bytes, signature: str) -> None:
        self._body = body
        self.headers = {"x-razorpay-signature": signature}

    async def body(self) -> bytes:
        return self._body


class _FakeTable:
    def __init__(self) -> None:
        self.updated: dict | None = None

    def update(self, values: dict):
        self.updated = values
        return self

    def eq(self, *_: object):
        return self

    def execute(self):
        return SimpleResult()


class SimpleResult:
    data: list = []


class _FakeSupabase:
    def __init__(self) -> None:
        self.subscription_table = _FakeTable()

    def table(self, name: str) -> _FakeTable:
        assert name == "subscriptions"
        return self.subscription_table


class SubscriptionWebhookNotificationTest(unittest.TestCase):
    def test_signed_capture_updates_payment_reference_and_notifies_admins(self) -> None:
        payload = {
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": "pay_123",
                        "order_id": "order_123",
                        "amount": 99_900,
                        "currency": "INR",
                        "notes": {"supabase_user_id": "user_123", "email": "member@example.com"},
                    }
                }
            },
        }
        body = json.dumps(payload).encode()
        secret = "webhook-secret"
        signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        supabase = _FakeSupabase()
        notify = AsyncMock()
        original_secret = settings.RAZORPAY_WEBHOOK_SECRET
        object.__setattr__(settings, "RAZORPAY_WEBHOOK_SECRET", secret)

        try:
            with patch("app.routes.subscription._notify_admins_of_captured_payment", notify):
                result = asyncio.run(razorpay_webhook(_FakeRequest(body, signature), supabase))
        finally:
            object.__setattr__(settings, "RAZORPAY_WEBHOOK_SECRET", original_secret)

        self.assertEqual(result, {"received": True})
        self.assertEqual(supabase.subscription_table.updated["razorpay_subscription_id"], "order_123")
        self.assertEqual(supabase.subscription_table.updated["razorpay_customer_id"], "pay_123")
        notify.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
