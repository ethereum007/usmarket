"""Server-side Resend notifications for captured Alpha Radar payments."""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger("alpha_radar.services.payment_notifications")

RESEND_EMAILS_URL = "https://api.resend.com/emails"


class PaymentNotificationConfigurationError(RuntimeError):
    """Raised when transactional email has not been configured on the server."""


class PaymentNotificationDeliveryError(RuntimeError):
    """Raised when Resend rejects or cannot accept a notification request."""


@dataclass(frozen=True)
class PaymentCaptureNotification:
    payment_id: str
    order_id: str | None
    user_id: str
    customer_email: str | None
    customer_mobile: str | None
    amount_paise: int | None
    currency: str | None
    paid_at: datetime
    valid_until: datetime


def notification_recipients() -> list[str]:
    """Return the Alpha Login administrators once each, preserving config order."""
    return list(dict.fromkeys(email for email in settings.ADMIN_EMAILS if email))


def _format_amount(amount_paise: int | None, currency: str | None) -> str:
    if amount_paise is None:
        return "Amount unavailable"
    if (currency or "INR").upper() == "INR":
        return f"₹{amount_paise / 100:,.2f}"
    return f"{(currency or 'INR').upper()} {amount_paise / 100:,.2f}"


def _format_time(value: datetime) -> str:
    return value.astimezone(settings.TIMEZONE).strftime("%d %b %Y, %I:%M %p %Z")


def _payment_email_content(notification: PaymentCaptureNotification) -> tuple[str, str]:
    customer_email = notification.customer_email or "Not available"
    customer_mobile = notification.customer_mobile or "Not available"
    order_id = notification.order_id or "Not available"
    amount = _format_amount(notification.amount_paise, notification.currency)
    paid_at = _format_time(notification.paid_at)
    valid_until = _format_time(notification.valid_until)

    text = (
        "Alpha Radar premium payment received\n\n"
        f"Customer email: {customer_email}\n"
        f"Customer mobile: {customer_mobile}\n"
        f"Amount: {amount}\n"
        f"Payment ID: {notification.payment_id}\n"
        f"Order ID: {order_id}\n"
        f"Paid at: {paid_at}\n"
        f"Premium valid until: {valid_until}\n"
    )
    rows = [
        ("Customer email", customer_email),
        ("Customer mobile", customer_mobile),
        ("Amount", amount),
        ("Payment ID", notification.payment_id),
        ("Order ID", order_id),
        ("Paid at", paid_at),
        ("Premium valid until", valid_until),
    ]
    html_rows = "".join(
        f"<tr><td style=\"padding:8px 12px;color:#64748b\">{html.escape(label)}</td>"
        f"<td style=\"padding:8px 12px;color:#0f172a;font-weight:600\">{html.escape(value)}</td></tr>"
        for label, value in rows
    )
    body = (
        "<div style=\"font-family:Arial,sans-serif;max-width:620px\">"
        "<h2 style=\"color:#0f766e\">Alpha Radar premium payment received</h2>"
        "<p>A customer has successfully subscribed to Alpha Radar Premium.</p>"
        f"<table style=\"border-collapse:collapse;width:100%;border:1px solid #e2e8f0\">{html_rows}</table>"
        "</div>"
    )
    return text, body


async def send_payment_capture_notification(
    notification: PaymentCaptureNotification,
) -> str:
    """Send one idempotent admin alert and return the Resend email id."""
    recipients = notification_recipients()
    if not settings.RESEND_API_KEY:
        raise PaymentNotificationConfigurationError("RESEND_API_KEY is not configured")
    if not settings.PAYMENT_EMAIL_FROM:
        raise PaymentNotificationConfigurationError("PAYMENT_EMAIL_FROM is not configured")
    if not recipients:
        raise PaymentNotificationConfigurationError("ADMIN_EMAILS is not configured")

    text, body = _payment_email_content(notification)
    payload: dict[str, Any] = {
        "from": settings.PAYMENT_EMAIL_FROM,
        "to": recipients,
        "subject": "Alpha Radar: premium payment received",
        "text": text,
        "html": body,
    }
    headers = {
        "Authorization": f"Bearer {settings.RESEND_API_KEY}",
        "Content-Type": "application/json",
        "Idempotency-Key": f"alpha-radar/payment-captured/{notification.payment_id}",
    }

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.post(RESEND_EMAILS_URL, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise PaymentNotificationDeliveryError("Resend request failed") from exc

    if response.status_code >= 400:
        logger.warning("Resend rejected payment notification: status=%s", response.status_code)
        raise PaymentNotificationDeliveryError("Resend rejected the notification request")

    email_id = response.json().get("id")
    if not isinstance(email_id, str) or not email_id:
        raise PaymentNotificationDeliveryError("Resend did not return an email id")
    return email_id
