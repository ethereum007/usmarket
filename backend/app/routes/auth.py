"""
Kite Connect authentication routes.

Handles OAuth login flow: generate login URL, exchange request_token,
persist session, and check auth status.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.config import settings
from app.core.kite_client import kite_state
from app.dependencies import require_admin_request
from app.services import arrow_market_data_service as arrow

logger = logging.getLogger("alpha_radar.routes.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

KITE_TOKEN_PATH = settings.DATA_DIR / "kite_token.json"


def _save_token_to_disk(access_token: str, user_name: str) -> None:
    """Persist Kite access token so it survives server restarts."""
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(settings.TIMEZONE).strftime("%Y-%m-%d")
    payload = {
        "access_token": access_token,
        "date": today,
        "user": user_name,
    }
    KITE_TOKEN_PATH.write_text(json.dumps(payload))
    logger.info("Kite token saved to disk for %s", user_name)


# ── GET /api/auth/login-url ──────────────────────────────────────────────────
@router.get("/login-url")
async def login_url(request: Request) -> dict:
    """Return the Kite Connect OAuth login URL."""
    await require_admin_request(request)
    return {"url": kite_state.get_login_url()}


# ── GET /api/auth/callback ───────────────────────────────────────────────────
@router.get("/callback")
async def callback(
    request: Request,
    request_token: str | None = Query(None, description="Kite OAuth request_token"),
):
    """
    Exchange the request_token for an access_token, persist it,
    and redirect the user to the frontend dashboard.
    """
    arrow_request_token = request.query_params.get("request-token")
    checksum = request.query_params.get("checksum")
    if arrow_request_token or checksum:
        token = arrow_request_token or request_token
        if not token:
            return JSONResponse(status_code=400, content={"error": "No Arrow request-token"})
        try:
            result = await arrow.exchange_request_token(token)
            logger.info("Arrow login successful")
            return RedirectResponse(url=f"{settings.AUTH_REDIRECT_URL}/alpha-login?arrow=success")
        except HTTPException as exc:
            detail = str(exc.detail or "Arrow login failed")
            logger.warning("Arrow auth callback rejected: %s", detail)
            query = urlencode({"arrow": "error", "message": detail})
            return RedirectResponse(url=f"{settings.AUTH_REDIRECT_URL}/alpha-login?{query}")
        except Exception as exc:
            logger.exception("Arrow auth callback failed")
            query = urlencode({"arrow": "error", "message": "Arrow login failed. Generate a fresh Arrow login and try again."})
            return RedirectResponse(url=f"{settings.AUTH_REDIRECT_URL}/alpha-login?{query}")

    if not request_token:
        return JSONResponse(status_code=400, content={"error": "No request_token"})

    try:
        session = kite_state.generate_session(request_token)
        user_name = session.get("user_name", "unknown")
        access_token = session.get("access_token", "")

        _save_token_to_disk(access_token, user_name)
        logger.info("Kite login successful for %s", user_name)
        try:
            from app.services.runner_service import runner_service
            await runner_service.start()
        except Exception:
            logger.exception("Runner did not start after Kite login")

        # Redirect to frontend with success flag
        redirect_url = settings.AUTH_REDIRECT_URL
        return RedirectResponse(url=f"{redirect_url}/alpha-login?auth=success")

    except Exception as exc:
        logger.exception("Kite auth callback failed")
        return JSONResponse(status_code=500, content={"error": str(exc)})


# ── GET /api/auth/status ─────────────────────────────────────────────────────
@router.get("/status")
async def status(request: Request) -> dict:
    """Return current Kite authentication status."""
    await require_admin_request(request)
    token_date: str | None = None
    user: str | None = None

    if KITE_TOKEN_PATH.exists():
        try:
            data = json.loads(KITE_TOKEN_PATH.read_text())
            token_date = data.get("date")
            user = data.get("user")
        except Exception:
            pass

    return {
        "authenticated": kite_state.is_connected,
        "user": user,
        "tokenDate": token_date,
        "loginUrl": kite_state.get_login_url(),
    }
