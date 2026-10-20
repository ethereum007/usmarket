"""
Subscription routes -- Razorpay monthly membership payment integration.

Ported from Alpha-Radar-backend/routes/subscription.js
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from supabase import Client

from app.config import settings
from app.dependencies import get_current_user, get_supabase
from app.services.payment_notifications import (
    PaymentCaptureNotification,
    PaymentNotificationConfigurationError,
    PaymentNotificationDeliveryError,
    notification_recipients,
    send_payment_capture_notification,
)

logger = logging.getLogger("alpha_radar.routes.subscription")

router = APIRouter(prefix="/api/subscription", tags=["subscription"])

# ── Constants ────────────────────────────────────────────────────────────────
MONTHLY_PRICE_PAISE = 99_900  # Rs 999
PLAN_DURATION_DAYS = 30


def _auth_user_contact(sb: Client, user_id: str, fallback_email: str | None) -> tuple[str | None, str | None]:
    """Fetch only the recipient contact fields needed for an admin alert."""
    try:
        response = sb.auth.admin.get_user_by_id(user_id)
        auth_user = getattr(response, "user", response)
        email = getattr(auth_user, "email", None) or fallback_email
        phone = getattr(auth_user, "phone", None)
        metadata = getattr(auth_user, "user_metadata", {}) or {}
        if not phone and isinstance(metadata, dict):
            phone = metadata.get("mobile") or metadata.get("phone")
        return email, phone
    except Exception:
        logger.warning("Could not load customer contact for payment notification")
        return fallback_email, None


def _claim_payment_notification(
    sb: Client,
    *,
    payment_id: str,
    order_id: str | None,
    user_id: str,
    now: datetime,
) -> bool:
    """Claim a failed-or-new payment alert; sent alerts are never sent again."""
    try:
        existing_result = (
            sb.table("payment_notification_outbox")
            .select("status,attempts")
            .eq("razorpay_payment_id", payment_id)
            .limit(1)
            .execute()
        )
        existing = (existing_result.data or [None])[0]
        if existing:
            if existing.get("status") != "failed":
                return False
            attempts = int(existing.get("attempts") or 0) + 1
            (
                sb.table("payment_notification_outbox")
                .update({
                    "status": "pending",
                    "attempts": attempts,
                    "last_error": None,
                    "updated_at": now.isoformat(),
                })
                .eq("razorpay_payment_id", payment_id)
                .execute()
            )
            return True

        inserted = (
            sb.table("payment_notification_outbox")
            .upsert(
                {
                    "razorpay_payment_id": payment_id,
                    "razorpay_order_id": order_id,
                    "user_id": user_id,
                    "status": "pending",
                    "attempts": 1,
                    "updated_at": now.isoformat(),
                },
                on_conflict="razorpay_payment_id",
                ignore_duplicates=True,
            )
            .execute()
        )
        return bool(inserted.data)
    except Exception:
        logger.exception("Could not claim payment notification outbox record")
        return False


def _mark_payment_notification(
    sb: Client,
    *,
    payment_id: str,
    status: str,
    now: datetime,
    resend_email_id: str | None = None,
    last_error: str | None = None,
) -> None:
    try:
        values = {
            "status": status,
            "updated_at": now.isoformat(),
            "resend_email_id": resend_email_id,
            "last_error": last_error[:500] if last_error else None,
        }
        if status == "sent":
            values["sent_at"] = now.isoformat()
            values["recipient_count"] = len(notification_recipients())
        (
            sb.table("payment_notification_outbox")
            .update(values)
            .eq("razorpay_payment_id", payment_id)
            .execute()
        )
    except Exception:
        logger.exception("Could not update payment notification outbox record")


async def _notify_admins_of_captured_payment(
    sb: Client,
    *,
    payment: dict,
    user_id: str,
    paid_at: datetime,
    valid_until: datetime,
) -> None:
    """Deliver an idempotent admin alert without affecting paid access."""
    payment_id = str(payment.get("id") or "").strip()
    if not payment_id:
        logger.warning("Skipping payment email because Razorpay did not include a payment id")
        return

    order_id = str(payment.get("order_id") or "").strip() or None
    now = datetime.now(timezone.utc)
    if not _claim_payment_notification(
        sb,
        payment_id=payment_id,
        order_id=order_id,
        user_id=user_id,
        now=now,
    ):
        return

    notes = payment.get("notes") if isinstance(payment.get("notes"), dict) else {}
    customer_email, customer_mobile = _auth_user_contact(sb, user_id, notes.get("email"))
    try:
        amount = payment.get("amount")
        resend_email_id = await send_payment_capture_notification(
            PaymentCaptureNotification(
                payment_id=payment_id,
                order_id=order_id,
                user_id=user_id,
                customer_email=customer_email,
                customer_mobile=customer_mobile,
                amount_paise=int(amount) if amount is not None else None,
                currency=payment.get("currency"),
                paid_at=paid_at,
                valid_until=valid_until,
            )
        )
    except (
        PaymentNotificationConfigurationError,
        PaymentNotificationDeliveryError,
        ValueError,
        TypeError,
    ) as exc:
        logger.warning("Payment notification was not delivered: %s", exc)
        _mark_payment_notification(
            sb,
            payment_id=payment_id,
            status="failed",
            now=datetime.now(timezone.utc),
            last_error=str(exc),
        )
        return
    except Exception:
        logger.exception("Unexpected payment notification failure")
        _mark_payment_notification(
            sb,
            payment_id=payment_id,
            status="failed",
            now=datetime.now(timezone.utc),
            last_error="Unexpected notification failure",
        )
        return

    _mark_payment_notification(
        sb,
        payment_id=payment_id,
        status="sent",
        now=datetime.now(timezone.utc),
        resend_email_id=resend_email_id,
    )


def _payment_captured_at(payment: dict, fallback: datetime) -> datetime:
    """Use Razorpay's payment timestamp when present, otherwise webhook receipt time."""
    try:
        return datetime.fromtimestamp(int(payment.get("created_at")), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return fallback


def _get_razorpay():
    """Lazy import razorpay client."""
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        return None
    try:
        import razorpay
        return razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))
    except ImportError:
        logger.warning("razorpay package not installed")
        return None


# ── GET /api/subscription/status ─────────────────────────────────────────────
@router.get("/status")
async def subscription_status(
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase),
) -> dict:
    """Current subscription info."""
    try:
        result = (
            sb.table("subscriptions")
            .select("*")
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
        data = result.data
    except Exception:
        data = None

    if not data:
        return {"plan": "free", "status": "active"}

    # Check if premium has expired
    if data.get("plan") == "premium" and data.get("status") == "active" and data.get("current_period_end"):
        try:
            end_dt = datetime.fromisoformat(data["current_period_end"].replace("Z", "+00:00"))
            if end_dt < datetime.now(timezone.utc):
                sb.table("subscriptions").update({
                    "status": "expired",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("user_id", user["id"]).execute()
                return {"plan": "premium", "status": "expired", "currentPeriodEnd": data["current_period_end"]}
        except (ValueError, TypeError):
            pass

    return {
        "plan": data.get("plan", "free"),
        "status": data.get("status", "active"),
        "currentPeriodEnd": data.get("current_period_end"),
    }


# ── POST /api/subscription/create ───────────────────────────────────────────
@router.post("/create")
async def create_order(
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase),
) -> dict:
    """Create a Razorpay order for 30 days of Premium access."""
    rp = _get_razorpay()
    if not rp:
        raise HTTPException(status_code=500, detail="Payment system not configured")

    # Check existing active subscription
    try:
        result = sb.table("subscriptions").select("*").eq("user_id", user["id"]).single().execute()
        existing = result.data
    except Exception:
        existing = None

    if existing and existing.get("plan") == "premium" and existing.get("status") == "active":
        end = existing.get("current_period_end")
        if end:
            try:
                end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
                if end_dt > datetime.now(timezone.utc):
                    raise HTTPException(status_code=400, detail="Already subscribed")
            except (ValueError, TypeError):
                pass

    try:
        order = rp.order.create({
            "amount": MONTHLY_PRICE_PAISE,
            "currency": "INR",
            "receipt": f"alpha_month_{user['id'][:8]}_{int(time.time())}",
            "notes": {
                "supabase_user_id": user["id"],
                "plan": "premium_monthly",
                "email": user.get("email", ""),
            },
        })

        # Save order ID
        try:
            sb.table("subscriptions").update({
                "razorpay_subscription_id": order["id"],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("user_id", user["id"]).execute()
        except Exception:
            pass

        return {
            "orderId": order["id"],
            "amount": MONTHLY_PRICE_PAISE,
            "currency": "INR",
            "razorpayKeyId": settings.RAZORPAY_KEY_ID,
            "billingPeriod": "monthly",
            "accessDays": PLAN_DURATION_DAYS,
        }
    except Exception as exc:
        logger.exception("Order create error")
        raise HTTPException(status_code=500, detail="Failed to create payment order")


# ── POST /api/subscription/verify ────────────────────────────────────────────
class VerifyBody(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


@router.post("/verify")
async def verify_payment(
    body: VerifyBody,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase),
) -> dict:
    """Verify Razorpay payment signature and activate premium."""
    # Verify signature
    expected = hmac.new(
        key=settings.RAZORPAY_KEY_SECRET.encode(),
        msg=f"{body.razorpay_order_id}|{body.razorpay_payment_id}".encode(),
        digestmod=hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, body.razorpay_signature):
        raise HTTPException(status_code=400, detail="Invalid payment signature")

    try:
        now = datetime.now(timezone.utc)
        expiry = now + timedelta(days=PLAN_DURATION_DAYS)

        sb.table("subscriptions").update({
            "plan": "premium",
            "status": "active",
            "razorpay_subscription_id": body.razorpay_order_id,
            "razorpay_customer_id": body.razorpay_payment_id,
            "current_period_start": now.isoformat(),
            "current_period_end": expiry.isoformat(),
            "updated_at": now.isoformat(),
        }).eq("user_id", user["id"]).execute()

        logger.info("Premium activated for user %s until %s", user["id"], expiry.strftime("%Y-%m-%d"))
        return {
            "success": True,
            "plan": "premium",
            "expiresAt": expiry.isoformat(),
            "billingPeriod": "monthly",
        }
    except Exception as exc:
        logger.exception("Payment verify error")
        raise HTTPException(status_code=500, detail="Payment verification failed")


# ── POST /api/subscription/webhook ───────────────────────────────────────────
@router.post("/webhook")
async def razorpay_webhook(
    request: Request,
    sb: Client = Depends(get_supabase),
) -> dict:
    """Razorpay webhook handler for monthly membership payments."""
    body_bytes = await request.body()
    body_str = body_bytes.decode("utf-8")

    # Payment email is eligible only from a signed Razorpay webhook. The
    # client-side verify route activates access quickly, but is not an email
    # source because it may be retried by the browser.
    webhook_secret = settings.RAZORPAY_WEBHOOK_SECRET
    webhook_verified = False
    if webhook_secret:
        signature = request.headers.get("x-razorpay-signature", "")
        expected = hmac.new(
            key=webhook_secret.encode(),
            msg=body_str.encode(),
            digestmod=hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            logger.warning("Webhook signature mismatch")
            raise HTTPException(status_code=400, detail="Invalid webhook signature")
        webhook_verified = True
    else:
        logger.warning("Razorpay webhook secret is not configured; payment email notifications are disabled")

    import json
    try:
        payload = json.loads(body_str)
    except Exception:
        return {"received": True}

    event = payload.get("event", "")
    logger.info("Razorpay webhook: %s", event)

    try:
        if event == "payment.captured":
            payment = payload.get("payload", {}).get("payment", {}).get("entity", {})
            user_id = payment.get("notes", {}).get("supabase_user_id")
            if user_id:
                now = datetime.now(timezone.utc)
                expiry = now + timedelta(days=PLAN_DURATION_DAYS)
                sb.table("subscriptions").update({
                    "plan": "premium",
                    "status": "active",
                    "razorpay_subscription_id": payment.get("order_id"),
                    "razorpay_customer_id": payment.get("id"),
                    "current_period_start": now.isoformat(),
                    "current_period_end": expiry.isoformat(),
                    "updated_at": now.isoformat(),
                }).eq("user_id", user_id).execute()
                logger.info("Webhook: Premium activated for %s", user_id)
                if webhook_verified:
                    await _notify_admins_of_captured_payment(
                        sb,
                        payment=payment,
                        user_id=user_id,
                        paid_at=_payment_captured_at(payment, now),
                        valid_until=expiry,
                    )

        elif event == "payment.failed":
            payment = payload.get("payload", {}).get("payment", {}).get("entity", {})
            user_id = payment.get("notes", {}).get("supabase_user_id")
            if user_id:
                logger.info("Webhook: Payment failed for %s", user_id)

    except Exception as exc:
        logger.exception("Webhook processing error")

    return {"received": True}
