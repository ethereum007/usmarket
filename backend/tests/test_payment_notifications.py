from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.services.payment_notifications import (
    PaymentCaptureNotification,
    PaymentNotificationConfigurationError,
    _payment_email_content,
    send_payment_capture_notification,
)


class _FakeResponse:
    status_code = 200

    @staticmethod
    def json() -> dict:
        return {"id": "email_123"}


class _FakeAsyncClient:
    def __init__(self, **_: object) -> None:
        self.request: dict | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def post(self, _: str, *, json: dict, headers: dict) -> _FakeResponse:
        self.request = {"json": json, "headers": headers}
        _FakeAsyncClient.last_request = self.request
        return _FakeResponse()


_FakeAsyncClient.last_request: dict | None = None


class PaymentNotificationServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.notification = PaymentCaptureNotification(
            payment_id="pay_123",
            order_id="order_123",
            user_id="user_123",
            customer_email="member@example.com",
            customer_mobile="+919876543210",
            amount_paise=99_900,
            currency="INR",
            paid_at=datetime(2026, 7, 23, 8, 30, tzinfo=timezone.utc),
            valid_until=datetime(2026, 8, 22, 8, 30, tzinfo=timezone.utc),
        )
        self.settings = SimpleNamespace(
            ADMIN_EMAILS=("admin@example.com", "admin@example.com", "ops@example.com"),
            RESEND_API_KEY="re_test",
            PAYMENT_EMAIL_FROM="Alpha Radar <payments@alpha-radar.in>",
            TIMEZONE=timezone.utc,
        )

    def test_email_content_includes_operational_payment_details(self) -> None:
        text, body = _payment_email_content(self.notification)

        self.assertIn("member@example.com", text)
        self.assertIn("₹999.00", text)
        self.assertIn("pay_123", body)
        self.assertIn("Premium valid until", body)

    def test_resend_request_uses_admins_and_idempotency_key(self) -> None:
        with patch("app.services.payment_notifications.settings", self.settings), patch(
            "app.services.payment_notifications.httpx.AsyncClient", _FakeAsyncClient
        ):
            email_id = asyncio.run(send_payment_capture_notification(self.notification))

        self.assertEqual(email_id, "email_123")
        request = _FakeAsyncClient.last_request
        assert request is not None
        self.assertEqual(request["json"]["to"], ["admin@example.com", "ops@example.com"])
        self.assertEqual(request["headers"]["Idempotency-Key"], "alpha-radar/payment-captured/pay_123")

    def test_missing_resend_configuration_is_rejected(self) -> None:
        missing_key = SimpleNamespace(
            ADMIN_EMAILS=("admin@example.com",),
            RESEND_API_KEY="",
            PAYMENT_EMAIL_FROM="Alpha Radar <payments@alpha-radar.in>",
            TIMEZONE=timezone.utc,
        )
        with patch("app.services.payment_notifications.settings", missing_key):
            with self.assertRaises(PaymentNotificationConfigurationError):
                asyncio.run(send_payment_capture_notification(self.notification))


if __name__ == "__main__":
    unittest.main()
