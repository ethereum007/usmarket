"""
FastAPI dependency injection functions.

Usage in routers:
    from app.dependencies import get_kite, get_supabase, get_current_user, require_premium

    @router.get("/something")
    async def something(kite=Depends(get_kite), user=Depends(get_current_user)):
        ...
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections import OrderedDict
from datetime import datetime, timezone
from threading import RLock
from time import monotonic
from typing import Any

import httpx
from fastapi import Depends, HTTPException, Request, status
from kiteconnect import KiteConnect
from supabase import Client

from app.config import settings
from app.core.kite_client import kite_state
from app.core.supabase_client import get_supabase_client

logger = logging.getLogger("alpha_radar.deps")

_AUTH_USER_CACHE_TTL_SECONDS = 30.0
_AUTH_USER_CACHE_MAX_ENTRIES = 2048
_auth_user_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_auth_inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}
_auth_http_client: httpx.AsyncClient | None = None
_auth_state_lock = RLock()


# ---------------------------------------------------------------------------
# Kite
# ---------------------------------------------------------------------------
def get_kite() -> KiteConnect:
    """
    Return the active KiteConnect instance.
    Raises 503 if no access token has been set yet.
    """
    if not kite_state.is_connected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Kite is not connected. Please authenticate via /api/auth/kite/login.",
        )
    return kite_state.kite


def get_optional_kite() -> KiteConnect | None:
    """
    Return Kite when connected, otherwise ``None``.

    Cache-backed market routes use this so they can serve the last successful
    session instead of failing in dependency resolution before route logic runs.
    """
    if not kite_state.is_connected:
        return None
    return kite_state.kite


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------
def get_supabase() -> Client:
    """Return the Supabase service-role client."""
    try:
        return get_supabase_client()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------
def _auth_cache_key(token: str) -> str:
    """Use a non-reversible key so bearer tokens never live in the cache index."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _get_auth_http_client() -> httpx.AsyncClient:
    """Return one bounded keep-alive pool for Supabase Auth verification."""
    global _auth_http_client
    with _auth_state_lock:
        if _auth_http_client is None or _auth_http_client.is_closed:
            _auth_http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(5.0),
                limits=httpx.Limits(
                    max_connections=20,
                    max_keepalive_connections=10,
                    keepalive_expiry=30.0,
                ),
            )
        return _auth_http_client


async def close_auth_http_client() -> None:
    """Close the shared Auth pool during FastAPI shutdown."""
    global _auth_http_client
    with _auth_state_lock:
        client = _auth_http_client
        _auth_http_client = None
        _auth_user_cache.clear()
        _auth_inflight.clear()
    if client is not None and not client.is_closed:
        await client.aclose()


async def _fetch_supabase_user(token: str) -> dict[str, Any]:
    """Fetch one user from Supabase Auth with transient failures mapped to 503."""
    url = f"{settings.SUPABASE_URL}/auth/v1/user"
    headers = {
        "Authorization": f"Bearer {token}",
        "apikey": settings.SUPABASE_ANON_KEY,
    }
    try:
        resp = await _get_auth_http_client().get(url, headers=headers)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        logger.warning("Supabase Auth verification unavailable: %s", type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service temporarily unavailable",
        ) from exc
    if (
        resp.status_code == status.HTTP_429_TOO_MANY_REQUESTS
        or resp.status_code >= 500
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service temporarily unavailable",
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    user = resp.json()
    if not isinstance(user, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service returned an invalid response",
        )
    return user


def _extract_bearer_token(request: Request) -> str:
    """Pull the Bearer token from the Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )
    return auth_header[7:]


async def _verify_supabase_jwt(token: str) -> dict[str, Any]:
    """
    Verify a Supabase-issued JWT by calling the Supabase Auth /user endpoint.
    Returns the user object if valid.
    """
    if not settings.SUPABASE_URL:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase is not configured",
        )
    cache_key = _auth_cache_key(token)
    now = monotonic()
    with _auth_state_lock:
        cached = _auth_user_cache.get(cache_key)
        if cached is not None and cached[0] > now:
            _auth_user_cache.move_to_end(cache_key)
            return dict(cached[1])
        _auth_user_cache.pop(cache_key, None)
        task = _auth_inflight.get(cache_key)
        if task is None:
            task = asyncio.create_task(_fetch_supabase_user(token))
            _auth_inflight[cache_key] = task

    try:
        user = await asyncio.shield(task)
    except asyncio.CancelledError:
        raise
    except Exception:
        with _auth_state_lock:
            if _auth_inflight.get(cache_key) is task:
                _auth_inflight.pop(cache_key, None)
        raise

    with _auth_state_lock:
        if _auth_inflight.get(cache_key) is task:
            _auth_inflight.pop(cache_key, None)
        _auth_user_cache[cache_key] = (
            monotonic() + _AUTH_USER_CACHE_TTL_SECONDS,
            dict(user),
        )
        _auth_user_cache.move_to_end(cache_key)
        while len(_auth_user_cache) > _AUTH_USER_CACHE_MAX_ENTRIES:
            _auth_user_cache.popitem(last=False)
    return dict(user)


# ---------------------------------------------------------------------------
# Current user dependency
# ---------------------------------------------------------------------------
_DEV_USER = {
    "id": "dev-local-user",
    "email": "dev@localhost",
    "raw": {},
    "is_dev": True,
}


def _is_localhost(request: Request) -> bool:
    """Check if the request originates from localhost."""
    host = request.headers.get("host", "")
    origin = request.headers.get("origin", "")
    return "localhost" in host or "127.0.0.1" in host or "localhost" in origin


async def get_current_user(request: Request) -> dict[str, Any]:
    """
    Validate the JWT from the request and return a dict with at least
    ``id`` (user UUID) and ``email``.

    If no token is provided, returns a guest user for read-only access.
    This allows the platform to work without requiring login for viewing data.
    Write operations (watchlist, feedback, subscription) should use require_authenticated.
    """
    auth_header = request.headers.get("Authorization", "")

    # Allow unauthenticated access — return guest user for read-only endpoints
    if not auth_header.startswith("Bearer "):
        logger.debug("No auth token — using guest user for read-only access")
        return _DEV_USER

    token = _extract_bearer_token(request)
    user = await _verify_supabase_jwt(token)
    user_id = user.get("id")
    email = user.get("email")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not determine user identity from token",
        )
    return {"id": user_id, "email": email, "raw": user}


async def require_admin_request(request: Request) -> dict[str, Any]:
    """
    Validate an admin request.

    Accepts the server-only ``X-Admin-Secret`` path for scripts/internal tools,
    or a Supabase bearer token whose email is listed in ``ADMIN_EMAILS``.
    """
    admin_header = request.headers.get("X-Admin-Secret", "")
    if settings.ADMIN_SECRET and admin_header and admin_header == settings.ADMIN_SECRET:
        return {"id": "admin-secret", "email": "", "is_admin": True, "auth_method": "secret"}

    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        user = await _verify_supabase_jwt(auth_header[7:])
        email = (user.get("email") or "").lower()
        if email in settings.ADMIN_EMAILS:
            return {
                "id": user.get("id"),
                "email": email,
                "raw": user,
                "is_admin": True,
                "auth_method": "supabase",
            }

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Admin access required",
    )


# ---------------------------------------------------------------------------
# Premium guard dependency
# ---------------------------------------------------------------------------
async def require_premium(
    request: Request,
    sb: Client = Depends(get_supabase),
) -> dict[str, Any]:
    """
    Validate JWT **and** ensure the user has an active premium subscription.
    Returns the same user dict as ``get_current_user``.
    """
    user = await get_current_user(request)
    user_id: str = user["id"]

    # Localhost dev user — grant premium for development
    if user.get("is_dev"):
        if not _is_localhost(request):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
            )
        user["is_premium"] = True
        user["is_admin"] = True
        return user

    # Check admin bypass
    admin_header = request.headers.get("X-Admin-Secret", "")
    if admin_header and admin_header == settings.ADMIN_SECRET:
        user["is_premium"] = True
        user["is_admin"] = True
        return user

    # Query subscription status from Supabase
    try:
        result = (
            sb.table("subscriptions")
            .select("plan, status, current_period_end")
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        sub = result.data
    except Exception:
        sub = None

    if not sub:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Premium subscription required",
        )

    plan = sub.get("plan", "free")
    sub_status = sub.get("status", "")
    period_end = sub.get("current_period_end")

    is_active = plan == "premium" and sub_status == "active"

    # Also check that the period hasn't expired
    if is_active and period_end:
        try:
            end_dt = datetime.fromisoformat(period_end.replace("Z", "+00:00"))
            if end_dt < datetime.now(timezone.utc):
                is_active = False
        except (ValueError, TypeError):
            pass

    if not is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Premium subscription required",
        )

    user["is_premium"] = True
    user["is_admin"] = False
    return user
