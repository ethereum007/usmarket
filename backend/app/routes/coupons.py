"""
Coupon routes -- generate, list, redeem, revert coupon codes.

Ported from Alpha-Radar-backend/routes/coupons.js
"""

from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel
from supabase import Client

from app.config import settings
from app.dependencies import get_current_user, get_supabase, require_admin_request

logger = logging.getLogger("alpha_radar.routes.coupons")

router = APIRouter(prefix="/api/coupons", tags=["coupons"])

# ── Helpers ──────────────────────────────────────────────────────────────────
COUPON_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # No 0/O/1/I confusion


def _generate_code() -> str:
    """Generate a coupon code in format AR-XXXX-XXXX."""
    part1 = "".join(secrets.choice(COUPON_CHARS) for _ in range(4))
    part2 = "".join(secrets.choice(COUPON_CHARS) for _ in range(4))
    return f"AR-{part1}-{part2}"


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    """Parse a Supabase timestamp into an aware UTC datetime."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _coupon_extension_base(sub: Optional[dict], now: datetime) -> datetime:
    """Return the date from which a new coupon should add days."""
    if not sub or sub.get("plan") != "premium" or sub.get("status") != "active":
        return now

    current_end = _parse_datetime(sub.get("current_period_end"))
    if current_end and current_end > now:
        return current_end
    return now


# ── Request models ───────────────────────────────────────────────────────────
class GenerateBody(BaseModel):
    count: int = 5
    duration_days: int = 90
    label: str = ""


class RedeemBody(BaseModel):
    code: str


# ── POST /api/coupons/generate ───────────────────────────────────────────────
@router.post("/generate")
async def generate_coupons(
    body: GenerateBody,
    request: Request,
    sb: Client = Depends(get_supabase),
) -> dict:
    """Admin: generate a batch of unique coupon codes."""
    await require_admin_request(request)

    batch_size = min(body.count, 100)
    codes: list[str] = []
    for _ in range(batch_size):
        code = _generate_code()
        attempts = 0
        while code in codes and attempts < 10:
            code = _generate_code()
            attempts += 1
        codes.append(code)

    label = body.label or f"Batch {datetime.now(settings.TIMEZONE).strftime('%d/%m/%Y')}"
    rows = [{"code": c, "duration_days": body.duration_days, "label": label} for c in codes]

    try:
        result = sb.table("coupons").insert(rows).execute()
        data = result.data or rows
        return {
            "generated": len(data),
            "codes": [d["code"] for d in data if d.get("code")],
            "label": label,
            "duration_days": body.duration_days,
        }
    except Exception as exc:
        logger.exception("Coupon generate error")
        raise HTTPException(status_code=500, detail="Failed to generate coupons")


# ── GET /api/coupons/list ────────────────────────────────────────────────────
@router.get("/list")
async def list_coupons(
    request: Request,
    sb: Client = Depends(get_supabase),
) -> dict:
    """Admin: list all coupons with usage info."""
    await require_admin_request(request)

    try:
        result = sb.table("coupons").select("*").order("created_at", desc=True).execute()
        data = result.data or []
        unused = [c for c in data if not c.get("used_by")]
        used = [c for c in data if c.get("used_by")]

        return {
            "total": len(data),
            "unused": len(unused),
            "used": len(used),
            "coupons": data,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to fetch coupons")


# ── POST /api/coupons/redeem ────────────────────────────────────────────────
@router.post("/redeem")
async def redeem_coupon(
    body: RedeemBody,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase),
) -> dict:
    """User: redeem a coupon code to activate premium."""
    if not body.code or not isinstance(body.code, str):
        raise HTTPException(status_code=400, detail="Please enter a coupon code")

    clean_code = body.code.strip().upper()

    # Read the existing subscription so coupon days can extend active premium.
    try:
        sub_result = (
            sb.table("subscriptions")
            .select("*")
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
        sub = sub_result.data
    except Exception:
        sub = None

    # Find coupon
    try:
        coupon_result = sb.table("coupons").select("*").eq("code", clean_code).single().execute()
        coupon = coupon_result.data
    except Exception:
        coupon = None

    if not coupon:
        raise HTTPException(status_code=404, detail="Invalid coupon code")

    if coupon.get("used_by"):
        raise HTTPException(status_code=400, detail="This coupon has already been used")

    # Mark as used
    try:
        sb.table("coupons").update({
            "used_by": user["id"],
            "used_by_email": user.get("email", ""),
            "used_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", coupon["id"]).execute()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to redeem coupon")

    # Activate or extend premium. If the user is already active premium, add
    # coupon days from their current expiry instead of starting over from today.
    now = datetime.now(timezone.utc)
    duration_days = int(coupon["duration_days"])
    extension_base = _coupon_extension_base(sub, now)
    expiry = extension_base + timedelta(days=duration_days)
    existing_active_premium = bool(sub and sub.get("plan") == "premium" and sub.get("status") == "active")
    current_period_start = (
        sub.get("current_period_start")
        if existing_active_premium and sub and sub.get("current_period_start")
        else now.isoformat()
    )

    try:
        sb.table("subscriptions").upsert({
            "user_id": user["id"],
            "plan": "premium",
            "status": "active",
            "current_period_start": current_period_start,
            "current_period_end": expiry.isoformat(),
            "updated_at": now.isoformat(),
        }, on_conflict="user_id").execute()
    except Exception as exc:
        logger.exception("Failed to activate premium via coupon")
        raise HTTPException(status_code=500, detail="Failed to activate premium")

    logger.info(
        "Coupon %s redeemed by %s -- premium until %s",
        clean_code,
        user.get("email"),
        expiry.strftime("%Y-%m-%d"),
    )

    return {
        "success": True,
        "plan": "premium",
        "expiresAt": expiry.isoformat(),
        "duration_days": duration_days,
        "extended_from": extension_base.isoformat(),
    }


# ── POST /api/coupons/{id}/revert ───────────────────────────────────────────
@router.post("/{coupon_id}/revert")
async def revert_coupon(
    request: Request,
    coupon_id: str = Path(..., alias="coupon_id"),
    sb: Client = Depends(get_supabase),
) -> dict:
    """Admin: revert a used coupon (mark unused, downgrade user to free)."""
    await require_admin_request(request)

    try:
        coupon_result = sb.table("coupons").select("*").eq("id", coupon_id).single().execute()
        coupon = coupon_result.data
    except Exception:
        coupon = None

    if not coupon:
        raise HTTPException(status_code=404, detail="Coupon not found")
    if not coupon.get("used_by"):
        raise HTTPException(status_code=400, detail="Coupon has not been used")

    # Revert user subscription
    try:
        sb.table("subscriptions").update({
            "plan": "free",
            "status": "active",
            "current_period_start": None,
            "current_period_end": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("user_id", coupon["used_by"]).execute()
    except Exception:
        pass

    # Reset coupon
    try:
        sb.table("coupons").update({
            "used_by": None,
            "used_by_email": None,
            "used_at": None,
        }).eq("id", coupon_id).execute()
    except Exception:
        pass

    logger.info("Coupon %s reverted -- %s downgraded to free", coupon["code"], coupon.get("used_by_email"))
    return {"success": True, "revertedUser": coupon.get("used_by_email")}


# ── DELETE /api/coupons/{id} ──────────────────────────────────────────────
@router.delete("/{coupon_id}")
async def delete_coupon(
    request: Request,
    coupon_id: str = Path(..., alias="coupon_id"),
    sb: Client = Depends(get_supabase),
) -> dict:
    """Admin: delete an unused coupon."""
    await require_admin_request(request)

    try:
        coupon_result = sb.table("coupons").select("*").eq("id", coupon_id).single().execute()
        coupon = coupon_result.data
    except Exception:
        coupon = None

    if not coupon:
        raise HTTPException(status_code=404, detail="Coupon not found")
    if coupon.get("used_by"):
        raise HTTPException(status_code=400, detail="Cannot delete a used coupon. Revert it first.")

    try:
        sb.table("coupons").delete().eq("id", coupon_id).execute()
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to delete coupon")

    logger.info("Coupon %s deleted", coupon["code"])
    return {"success": True, "deleted": coupon["code"]}
