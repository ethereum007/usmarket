"""Arrow Trade market-data adapter.

This module intentionally normalizes Arrow responses into a Kite-like shape so
Alpha Radar can benchmark Arrow without rewriting existing scanner logic.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx
from fastapi import HTTPException, status

from app.config import settings
from app.core.symbols import arrow_equity_symbol, canonical_equity_symbol
from app.services.provider_gateway import provider_gateway

ArrowQuoteMode = Literal["ltp", "ohlcv", "full"]
ARROW_TOKEN_PATH = settings.DATA_DIR / "arrow_token.json"
ARROW_QUOTES_BATCH_SIZE = 25
ARROW_OPTION_CHAIN_COUNT = 20
ARROW_TOKEN_LIFETIME = timedelta(hours=24)

logger = logging.getLogger("alpha_radar.arrow")
_auto_login_lock = asyncio.Lock()
_auto_login_state: dict[str, str | None] = {
    "lastAttemptAt": None,
    "lastSuccessAt": None,
    "lastStatus": None,
    "lastError": None,
    "lastReason": None,
}


@dataclass(frozen=True)
class ArrowInstrument:
    symbol: str
    exchange: str = "NSE"

    @property
    def arrow_symbol(self) -> str:
        return arrow_equity_symbol(self.symbol, self.exchange)

    @property
    def canonical_symbol(self) -> str:
        return canonical_equity_symbol(self.symbol)

    @property
    def kite_key(self) -> str:
        return f"{self.exchange.upper()}:{self.canonical_symbol}"


def arrow_login_url() -> str:
    if not settings.ARROW_APP_ID:
        raise HTTPException(status_code=503, detail="ARROW_APP_ID is not configured")
    return f"{settings.ARROW_LOGIN_URL}?appID={settings.ARROW_APP_ID}"


def make_auth_checksum(request_token: str) -> str:
    if not settings.ARROW_APP_ID or not settings.ARROW_APP_SECRET:
        raise HTTPException(status_code=503, detail="ARROW_APP_ID/ARROW_APP_SECRET are not configured")
    raw = f"{settings.ARROW_APP_ID}:{settings.ARROW_APP_SECRET}:{request_token}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _extract_access_token(payload: dict[str, Any]) -> str:
    candidates = [
        payload.get("accessToken"),
        payload.get("access_token"),
        payload.get("token"),
        payload.get("data", {}).get("accessToken") if isinstance(payload.get("data"), dict) else None,
        payload.get("data", {}).get("access_token") if isinstance(payload.get("data"), dict) else None,
        payload.get("data", {}).get("token") if isinstance(payload.get("data"), dict) else None,
    ]
    return next((str(token) for token in candidates if token), "")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _write_token(access_token: str, *, auth_mode: str, user_id: str = "") -> dict[str, Any]:
    """Persist a token atomically with enough metadata to judge freshness."""
    now = _utc_now()
    payload: dict[str, Any] = {
        "access_token": access_token,
        "saved_at": now.isoformat(),
        "expires_at": (now + ARROW_TOKEN_LIFETIME).isoformat(),
        "auth_mode": auth_mode,
    }
    if user_id:
        payload["user_id"] = user_id

    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path = ARROW_TOKEN_PATH.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(payload), encoding="utf-8")
    try:
        temporary_path.chmod(0o600)
    except OSError:
        logger.warning("Could not restrict Arrow token file permissions")
    temporary_path.replace(ARROW_TOKEN_PATH)
    return payload


def save_access_token_response(payload: dict[str, Any], *, auth_mode: str = "manual") -> str:
    """Persist an Arrow auth response and return the extracted access token."""
    access_token = _extract_access_token(payload)
    if not access_token:
        raise HTTPException(status_code=502, detail="Arrow auth response did not include an access token")

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    user_id = str(data.get("userID") or data.get("userId") or "")
    _write_token(access_token, auth_mode=auth_mode, user_id=user_id)
    return access_token


def arrow_error_message(payload: Any) -> str:
    """Return a concise Arrow error without leaking raw upstream JSON."""
    if isinstance(payload, dict):
        data_message = payload.get("data", {}).get("message") if isinstance(payload.get("data"), dict) else None
        message = (
            payload.get("message")
            or payload.get("error")
            or payload.get("detail")
            or data_message
        )
        error_type = payload.get("error_type") or payload.get("type")
        if message and error_type:
            return f"{message} ({error_type})"
        if message:
            return str(message)
    if isinstance(payload, str) and payload.strip():
        try:
            return arrow_error_message(json.loads(payload))
        except Exception:
            return payload.strip()[:300]
    return "Arrow rejected the login request"


def get_saved_access_token() -> str:
    if not ARROW_TOKEN_PATH.exists():
        return ""
    try:
        payload = json.loads(ARROW_TOKEN_PATH.read_text())
        return str(payload.get("access_token") or "")
    except Exception:
        return ""


def get_saved_access_token_metadata() -> dict[str, Any]:
    """Return non-secret persisted token metadata for health/status views."""
    if not ARROW_TOKEN_PATH.exists():
        return {}
    try:
        payload = json.loads(ARROW_TOKEN_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}

    saved_at = _parse_timestamp(payload.get("saved_at"))
    expires_at = _parse_timestamp(payload.get("expires_at"))
    if not expires_at and saved_at:
        expires_at = saved_at + ARROW_TOKEN_LIFETIME
    return {
        "savedAt": saved_at.isoformat() if saved_at else None,
        "expiresAt": expires_at.isoformat() if expires_at else None,
        "authMode": payload.get("auth_mode") or "manual",
        "userId": payload.get("user_id") or None,
        "fresh": bool(expires_at and expires_at > _utc_now()),
    }


def saved_access_token_is_fresh(*, minimum_remaining: timedelta = timedelta()) -> bool:
    metadata = get_saved_access_token_metadata()
    expires_at = _parse_timestamp(metadata.get("expiresAt"))
    return bool(get_saved_access_token() and expires_at and expires_at > _utc_now() + minimum_remaining)


def get_active_access_token() -> tuple[str, str | None]:
    """Resolve the token source, preferring fresh auto-login output when enabled."""
    saved_token = get_saved_access_token()
    if settings.ARROW_AUTO_LOGIN_ENABLED and saved_access_token_is_fresh():
        return saved_token, "saved"
    if settings.ARROW_ACCESS_TOKEN:
        return settings.ARROW_ACCESS_TOKEN, "env"
    if saved_token:
        return saved_token, "saved"
    return "", None


def auto_login_missing_settings() -> list[str]:
    required = {
        "ARROW_APP_ID": settings.ARROW_APP_ID,
        "ARROW_APP_SECRET": settings.ARROW_APP_SECRET,
        "ARROW_USER_ID": settings.ARROW_USER_ID,
        "ARROW_PASSWORD": settings.ARROW_PASSWORD,
        "ARROW_TOTP_SECRET": settings.ARROW_TOTP_SECRET,
    }
    return [name for name, value in required.items() if not str(value).strip()]


def get_auto_login_status() -> dict[str, Any]:
    missing = auto_login_missing_settings()
    return {
        "enabled": settings.ARROW_AUTO_LOGIN_ENABLED,
        "configured": settings.ARROW_AUTO_LOGIN_ENABLED and not missing,
        "missingSettings": missing if settings.ARROW_AUTO_LOGIN_ENABLED else [],
        "schedule": {
            "hour": settings.ARROW_AUTO_LOGIN_HOUR,
            "minute": settings.ARROW_AUTO_LOGIN_MINUTE,
            "timezone": str(settings.TIMEZONE),
            "days": "mon-fri",
        },
        **_auto_login_state,
    }


def _safe_auto_login_error(exc: Exception) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    for secret in (
        settings.ARROW_PASSWORD,
        settings.ARROW_TOTP_SECRET,
        settings.ARROW_APP_SECRET,
    ):
        if secret:
            message = message.replace(secret, "[redacted]")
    return message[:300]


def _run_sdk_auto_login() -> dict[str, Any]:
    """Run Arrow's supported synchronous SDK login and persist its token."""
    from pyarrow_client import ArrowClient

    client = ArrowClient(app_id=settings.ARROW_APP_ID, root_url=settings.ARROW_BASE_URL)
    response = client.auto_login(
        user_id=settings.ARROW_USER_ID,
        password=settings.ARROW_PASSWORD,
        app_secret=settings.ARROW_APP_SECRET,
        totp_secret=settings.ARROW_TOTP_SECRET,
    )
    payload = response if isinstance(response, dict) else {}
    access_token = client.get_token() or _extract_access_token(payload)
    if not access_token:
        raise RuntimeError("Arrow auto-login response did not include an access token")

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    user_id = str(data.get("userID") or data.get("userId") or settings.ARROW_USER_ID)
    token_metadata = _write_token(access_token, auth_mode="auto", user_id=user_id)
    return {
        "success": True,
        "provider": "arrow",
        "userId": user_id,
        "savedAt": token_metadata["saved_at"],
        "expiresAt": token_metadata["expires_at"],
    }


async def auto_login(*, reason: str = "scheduled") -> dict[str, Any]:
    """Generate a fresh Arrow token without exposing credentials or token data."""
    async with _auto_login_lock:
        attempted_at = datetime.now(settings.TIMEZONE).isoformat()
        _auto_login_state.update({
            "lastAttemptAt": attempted_at,
            "lastStatus": "running",
            "lastError": None,
            "lastReason": reason,
        })
        missing = auto_login_missing_settings()
        if not settings.ARROW_AUTO_LOGIN_ENABLED or missing:
            error = (
                "Arrow auto-login is disabled"
                if not settings.ARROW_AUTO_LOGIN_ENABLED
                else f"Missing settings: {', '.join(missing)}"
            )
            _auto_login_state.update({"lastStatus": "error", "lastError": error})
            return {"success": False, "error": error, "missingSettings": missing}

        try:
            result = await asyncio.to_thread(_run_sdk_auto_login)
        except Exception as exc:
            error = _safe_auto_login_error(exc)
            _auto_login_state.update({"lastStatus": "error", "lastError": error})
            logger.exception("Arrow auto-login failed (%s): %s", reason, error)
            return {"success": False, "error": error}

        success_at = datetime.now(settings.TIMEZONE).isoformat()
        _auto_login_state.update({
            "lastSuccessAt": success_at,
            "lastStatus": "success",
            "lastError": None,
        })
        logger.info("Arrow auto-login succeeded (%s); token valid until %s", reason, result["expiresAt"])
        return result


def clear_saved_access_token() -> None:
    """Remove the persisted Arrow token after Arrow confirms it is no longer valid."""
    try:
        if ARROW_TOKEN_PATH.exists():
            ARROW_TOKEN_PATH.unlink()
    except Exception:
        # Token cleanup should not mask the upstream auth error.
        pass


def _looks_like_expired_token(resp: httpx.Response) -> bool:
    if resp.status_code != 401:
        return False
    body = resp.text.lower()
    return "expired" in body or "invalid" in body or "unauthorized" in body


def _headers() -> dict[str, str]:
    token, _ = get_active_access_token()
    if not settings.ARROW_APP_ID:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Arrow is not configured. Set ARROW_APP_ID.",
        )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Arrow token missing or expired. Re-login with Arrow.",
        )
    return {
        "appID": settings.ARROW_APP_ID,
        "token": token,
        "Content-Type": "application/json",
    }


async def _guarded_arrow_request(operation):
    """Run one Arrow HTTP request through the shared budget and retry guard."""
    async def guarded():
        resp = await operation()
        # Let the gateway retry provider-side throttles/5xx responses. Client
        # validation errors still return to the normal response parser.
        if resp.status_code == 429:
            raise HTTPException(status_code=429, detail="Arrow rate limit reached")
        if resp.status_code >= 500:
            raise HTTPException(status_code=resp.status_code, detail=_short_arrow_error(resp))
        return resp

    return await provider_gateway.run("arrow", guarded)


def _scale(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    scale = settings.ARROW_PRICE_SCALE or 100
    return number / scale


def _normalise_quote(
    requested: ArrowInstrument,
    payload: dict[str, Any],
    *,
    mode: ArrowQuoteMode,
) -> dict[str, Any]:
    ltp = _scale(payload.get("ltp"))
    prev_close = _scale(payload.get("close")) or ltp
    open_ = _scale(payload.get("open")) or ltp
    high = _scale(payload.get("high")) or ltp
    low = _scale(payload.get("low")) or ltp

    quote = {
        "instrument_token": payload.get("token"),
        "timestamp": payload.get("time") or payload.get("ltt") or int(time.time()),
        "last_price": ltp,
        "volume": int(payload.get("volume") or 0),
        "ohlc": {
            "open": open_,
            "high": high,
            "low": low,
            "close": prev_close,
        },
        "source": "arrow",
        "tradingsymbol": payload.get("symbol") or requested.arrow_symbol,
        "exchange": requested.exchange.upper(),
    }

    if mode == "full":
        quote.update({
            "average_price": _scale(payload.get("avgPrice")),
            "last_quantity": int(payload.get("ltq") or 0),
            "oi": int(payload.get("oi") or 0),
            "oi_day_low": int(payload.get("oiDayLow") or payload.get("oi_day_low") or 0),
            "implied_volatility": _as_optional_float(
                payload.get("iv") or payload.get("IV") or payload.get("impliedVolatility")
            ),
            "total_buy_quantity": int(payload.get("totalBuyQty") or 0),
            "total_sell_quantity": int(payload.get("totalSellQty") or 0),
            "depth": {
                "buy": payload.get("bids") or [],
                "sell": payload.get("asks") or [],
            },
            "lower_circuit_limit": _scale(payload.get("lowerLimit")),
            "upper_circuit_limit": _scale(payload.get("upperLimit")),
        })

    return quote


async def exchange_request_token(request_token: str) -> dict[str, Any]:
    """Exchange Arrow request-token for a 24-hour access token."""
    url = f"{settings.ARROW_BASE_URL.rstrip('/')}/auth/app/authenticate-token"
    body = {
        "checkSum": make_auth_checksum(request_token),
        "token": request_token,
        "appID": settings.ARROW_APP_ID,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await _guarded_arrow_request(
            lambda: client.post(url, json=body, headers={"Content-Type": "application/json"})
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=arrow_error_message(resp.text))
    payload = resp.json()
    if isinstance(payload, dict) and payload.get("status") == "error":
        raise HTTPException(status_code=400, detail=arrow_error_message(payload))
    save_access_token_response(payload)
    return payload


async def fetch_quotes(
    symbols: list[str],
    *,
    exchange: str = "NSE",
    mode: ArrowQuoteMode = "ohlcv",
) -> dict[str, dict[str, Any]]:
    """Fetch Arrow quotes and return a Kite-like dict keyed by exchange:symbol."""
    if not symbols:
        return {}
    if mode not in {"ltp", "ohlcv", "full"}:
        raise HTTPException(status_code=400, detail=f"Unsupported Arrow quote mode: {mode}")

    instruments = [ArrowInstrument(symbol=s, exchange=exchange) for s in symbols]
    started = time.perf_counter()
    quotes: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    headers = _headers()
    url = f"{settings.ARROW_BASE_URL.rstrip('/')}/info/quotes/{mode}"
    async with httpx.AsyncClient(timeout=20) as client:
        for idx in range(0, len(instruments), ARROW_QUOTES_BATCH_SIZE):
            batch = instruments[idx : idx + ARROW_QUOTES_BATCH_SIZE]
            batch_quotes, batch_errors = await _fetch_quote_batch(client, url, headers, batch, mode)
            quotes.update(batch_quotes)
            errors.extend(batch_errors)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)

    if not quotes and errors:
        first = errors[0]
        raise HTTPException(
            status_code=int(first.get("statusCode") or 502),
            detail=str(first.get("error") or "Arrow quote fetch failed")[:500],
        )

    return {
        "_meta": {
            "source": "arrow",
            "mode": mode,
            "requested": len(symbols),
            "returned": len(quotes),
            "elapsedMs": elapsed_ms,
            "partial": bool(errors),
            "errors": errors[:10],
        },
        **quotes,
    }


async def fetch_option_chain(
    *,
    underlying: str,
    exchange: str,
    expiry: str,
    count: int = ARROW_OPTION_CHAIN_COUNT,
    index_key: str | None = None,
    name: str | None = None,
    lot_size: int = 0,
    strike_step: int = 0,
    quote_exchange: str | None = None,
) -> dict[str, Any]:
    """Fetch Arrow option-chain data and normalize it to Alpha Radar's chain shape."""
    started = time.perf_counter()
    url = f"{settings.ARROW_BASE_URL.rstrip('/')}/info/option-chain"
    body = {
        "underlying": underlying.strip().upper(),
        "exchange": exchange.strip().upper(),
        "count": str(count),
        "expiry": expiry.strip().upper(),
    }

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await _guarded_arrow_request(lambda: client.post(url, json=body, headers=_headers()))

    if _looks_like_expired_token(resp):
        clear_saved_access_token()
        raise HTTPException(status_code=401, detail="Arrow token expired. Re-login with Arrow.")
    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="Arrow rate limit reached")
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_short_arrow_error(resp))

    payload = resp.json()
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    chain_data = _normalise_option_chain_response(
        payload,
        request_body=body,
        elapsed_ms=elapsed_ms,
        index_key=index_key,
        name=name or underlying,
        lot_size=lot_size,
        strike_step=strike_step,
    )
    await _enrich_option_chain_quotes(
        chain_data,
        quote_exchange=quote_exchange or _infer_option_quote_exchange(body),
    )
    return chain_data


def _normalise_option_chain_response(
    payload: dict[str, Any],
    *,
    request_body: dict[str, str],
    elapsed_ms: float,
    index_key: str | None,
    name: str,
    lot_size: int,
    strike_step: int,
) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if data is None:
        data = payload

    rows = _extract_option_chain_rows(data)
    strike_map: dict[float, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        strike = _extract_strike(row)
        call_raw = _extract_leg(row, "call")
        put_raw = _extract_leg(row, "put")

        option_type = str(_pick(row, "optionType", "option_type", "instrument_type", "type") or "").upper()
        if option_type in {"CE", "CALL"}:
            call_raw = call_raw or row
        elif option_type in {"PE", "PUT"}:
            put_raw = put_raw or row

        if strike is None:
            strike = _extract_strike(call_raw) if isinstance(call_raw, dict) else None
        if strike is None:
            strike = _extract_strike(put_raw) if isinstance(put_raw, dict) else None
        if strike is None:
            continue

        bucket = strike_map.setdefault(strike, {"strike": strike, "call": None, "put": None})
        if call_raw:
            bucket["call"] = _normalise_option_leg(call_raw, "CE", lot_size=lot_size)
        if put_raw:
            bucket["put"] = _normalise_option_leg(put_raw, "PE", lot_size=lot_size)

    chain = sorted(
        [row for row in strike_map.values() if row.get("call") and row.get("put")],
        key=lambda row: row["strike"],
    )
    if not chain:
        raise HTTPException(status_code=502, detail="Arrow option-chain response did not include usable CE/PE rows")

    spot = _extract_chain_spot(data) or _infer_spot_from_chain(chain)
    prev_close = _extract_chain_prev_close(data) or spot
    expiry = _extract_chain_expiry(data) or _arrow_expiry_to_iso(request_body["expiry"])
    analytics = _build_options_analytics(chain, spot)

    return {
        "index": index_key or request_body["underlying"].lower().replace("-eq", ""),
        "name": name,
        "spot": round(spot, 2),
        "prevClose": round(prev_close, 2),
        "expiry": expiry,
        "expiries": [expiry],
        "lotSize": lot_size,
        "strikeStep": strike_step,
        "chain": chain,
        "analytics": analytics,
        "timestamp": int(time.time() * 1000),
        "provider": {
            "provider": "arrow",
            "endpoint": "option-chain",
            "underlying": request_body["underlying"],
            "exchange": request_body["exchange"],
            "requested": int(request_body["count"]),
            "returned": len(chain),
            "elapsedMs": elapsed_ms,
            "expiry": request_body["expiry"],
        },
    }


def _infer_option_quote_exchange(request_body: dict[str, str]) -> str:
    underlying = request_body.get("underlying", "").upper()
    if underlying == "SENSEX" or request_body.get("exchange", "").upper() == "BFO":
        return "BFO"
    return "NFO"


async def _enrich_option_chain_quotes(chain_data: dict[str, Any], *, quote_exchange: str) -> None:
    chain = chain_data.get("chain") or []
    spot = float(chain_data.get("spot") or 0)
    ranked = sorted(chain, key=lambda row: abs(float(row.get("strike") or 0) - spot))
    quote_rows = ranked[:11]
    symbols: list[str] = []
    for row in quote_rows:
        for side in ("call", "put"):
            leg = row.get(side)
            if isinstance(leg, dict) and leg.get("tradingsymbol"):
                symbol = str(leg["tradingsymbol"]).strip().upper()
                if symbol and symbol not in symbols:
                    symbols.append(symbol)

    if not symbols:
        return

    provider = chain_data.setdefault("provider", {})
    provider["quoteExchange"] = quote_exchange
    provider["quoteScope"] = "ATM ±5"
    provider["quoteStrikes"] = sorted(float(row.get("strike") or 0) for row in quote_rows)
    try:
        quote_map = await fetch_quotes(symbols, exchange=quote_exchange, mode="full")
    except Exception as exc:
        provider["partial"] = True
        provider["quoteError"] = str(exc)[:240]
        return

    meta = quote_map.pop("_meta", {})
    provider["quoteRequested"] = meta.get("requested", len(symbols))
    provider["quoteReturned"] = meta.get("returned", 0)
    provider["quoteElapsedMs"] = meta.get("elapsedMs")
    if meta.get("partial"):
        provider["partial"] = True
        provider["quoteErrors"] = meta.get("errors", [])

    for row in chain_data.get("chain") or []:
        for side in ("call", "put"):
            leg = row.get(side)
            if not isinstance(leg, dict):
                continue
            symbol = str(leg.get("tradingsymbol") or "").upper()
            quote = quote_map.get(f"{quote_exchange}:{symbol}")
            if quote:
                _apply_quote_to_option_leg(leg, quote)

    chain_data["analytics"] = _build_options_analytics(
        chain_data.get("chain") or [],
        float(chain_data.get("spot") or 0),
    )


def _apply_quote_to_option_leg(leg: dict[str, Any], quote: dict[str, Any]) -> None:
    leg["token"] = quote.get("instrument_token") or leg.get("token")
    leg["ltp"] = quote.get("last_price") or leg.get("ltp") or 0
    leg["volume"] = quote.get("volume") or leg.get("volume") or 0
    leg["oi"] = quote.get("oi") or leg.get("oi") or 0
    oi_day_low = quote.get("oi_day_low") or 0
    if quote.get("oi") is not None and oi_day_low:
        leg["oiChange"] = int(quote.get("oi") or 0) - int(oi_day_low or 0)
    leg["iv"] = quote.get("implied_volatility") or leg.get("iv")

    depth = quote.get("depth") if isinstance(quote.get("depth"), dict) else {}
    buy_depth = depth.get("buy") or []
    sell_depth = depth.get("sell") or []
    if buy_depth and isinstance(buy_depth[0], dict):
        leg["bidQty"] = _as_int(_pick(buy_depth[0], "quantity", "qty", "volume"))
    if sell_depth and isinstance(sell_depth[0], dict):
        leg["askQty"] = _as_int(_pick(sell_depth[0], "quantity", "qty", "volume"))


def _extract_option_chain_rows(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if not isinstance(data, dict):
        return []
    for key in ("chain", "optionChain", "option_chain", "records", "rows", "items"):
        value = data.get(key)
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
        if isinstance(value, dict):
            nested = _extract_option_chain_rows(value)
            if nested:
                return nested
    filtered = []
    for value in data.values():
        if isinstance(value, list):
            filtered.extend(row for row in value if isinstance(row, dict))
    return filtered


def _extract_leg(row: dict[str, Any], side: Literal["call", "put"]) -> dict[str, Any] | None:
    keys = (
        ("call", "ce", "CE", "CALL", "callOption", "callData")
        if side == "call"
        else ("put", "pe", "PE", "PUT", "putOption", "putData")
    )
    for key in keys:
        value = row.get(key)
        if isinstance(value, dict):
            return value
    return None


def _normalise_option_leg(raw: dict[str, Any], option_type: str, *, lot_size: int) -> dict[str, Any]:
    oi = _as_int(_pick(raw, "oi", "openInterest", "open_interest", "openInt"))
    oi_change = _as_int(_pick(raw, "oiChange", "oi_change", "changeInOI", "changeinOpenInterest", "oiDayChange"))
    if oi_change == 0:
        oi_day_low = _as_int(_pick(raw, "oi_day_low", "oiDayLow", "openInterestDayLow"))
        if oi_day_low:
            oi_change = oi - oi_day_low

    return {
        "token": _as_int(_pick(raw, "token", "instrumentToken", "instrument_token")),
        "oi": oi,
        "oiChange": oi_change,
        "volume": _as_int(_pick(raw, "volume", "vol", "tradedVolume")),
        "ltp": _arrow_price(_pick(raw, "ltp", "lastPrice", "last_price", "lastTradedPrice")),
        "iv": _as_optional_float(_pick(raw, "iv", "IV", "impliedVolatility", "implied_volatility")),
        "tradingsymbol": str(_pick(raw, "symbol", "tradingsymbol", "tradingSymbol") or ""),
        "bidQty": _best_depth_qty(raw, "buy"),
        "askQty": _best_depth_qty(raw, "sell"),
        "lotSize": lot_size,
        "optionType": option_type,
        "delta": _as_optional_float(_pick(raw, "delta")),
        "gamma": _as_optional_float(_pick(raw, "gamma")),
        "vega": _as_optional_float(_pick(raw, "vega")),
        "theta": _as_optional_float(_pick(raw, "theta")),
    }


def _build_options_analytics(chain: list[dict[str, Any]], spot: float) -> dict[str, Any]:
    total_call_oi = sum(row["call"]["oi"] for row in chain)
    total_put_oi = sum(row["put"]["oi"] for row in chain)
    pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi > 0 else 0

    min_loss = float("inf")
    max_pain_strike = chain[0]["strike"] if chain else 0
    for pivot in chain:
        total_loss = 0
        for row in chain:
            if row["strike"] < pivot["strike"]:
                total_loss += (pivot["strike"] - row["strike"]) * row["call"]["oi"]
            if row["strike"] > pivot["strike"]:
                total_loss += (row["strike"] - pivot["strike"]) * row["put"]["oi"]
        if total_loss < min_loss:
            min_loss = total_loss
            max_pain_strike = pivot["strike"]

    top_call_strikes = [
        row["strike"] for row in sorted(chain, key=lambda row: row["call"]["oi"], reverse=True)[:3]
    ]
    top_put_strikes = [
        row["strike"] for row in sorted(chain, key=lambda row: row["put"]["oi"], reverse=True)[:3]
    ]

    atm_row = min(chain, key=lambda row: abs(row["strike"] - spot)) if chain else None
    atm_iv = 0.0
    if atm_row:
        ce_iv = atm_row["call"].get("iv") or 0
        pe_iv = atm_row["put"].get("iv") or 0
        atm_iv = (ce_iv + pe_iv) / 2

    return {
        "pcr": pcr,
        "pcrSentiment": "BULLISH" if pcr > 1.3 else ("BEARISH" if pcr < 0.7 else "NEUTRAL"),
        "maxPainStrike": max_pain_strike,
        "maxPainDistance": round(spot - max_pain_strike),
        "totalCallOI": total_call_oi,
        "totalPutOI": total_put_oi,
        "resistance": top_call_strikes,
        "support": top_put_strikes,
        "atmIV": round(atm_iv, 1),
    }


def _pick(raw: dict[str, Any] | None, *keys: str) -> Any:
    if not isinstance(raw, dict):
        return None
    for key in keys:
        if key in raw and raw[key] not in (None, ""):
            return raw[key]
    return None


def _extract_strike(raw: dict[str, Any] | None) -> float | None:
    value = _pick(raw, "strike", "strikePrice", "strike_price", "strikeprice")
    if value is None:
        return None
    number = _as_float(value)
    return number if number > 0 else None


def _extract_chain_spot(data: Any) -> float:
    if not isinstance(data, dict):
        return 0.0
    for key in ("spot", "spotPrice", "spot_price", "underlyingValue", "underlying_price", "ltp"):
        value = data.get(key)
        if value not in (None, ""):
            return _arrow_price(value)
    return 0.0


def _extract_chain_prev_close(data: Any) -> float:
    if not isinstance(data, dict):
        return 0.0
    return _arrow_price(_pick(data, "prevClose", "previousClose", "close", "underlyingClose"))


def _extract_chain_expiry(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    value = _pick(data, "expiry", "expiryDate", "expiry_date")
    if not value:
        return None
    text = str(value)
    try:
        return datetime.fromisoformat(text[:10]).strftime("%Y-%m-%d")
    except ValueError:
        return _arrow_expiry_to_iso(text)


def _infer_spot_from_chain(chain: list[dict[str, Any]]) -> float:
    if not chain:
        return 0.0
    return float(chain[len(chain) // 2]["strike"])


def _arrow_expiry_to_iso(expiry: str) -> str:
    text = expiry.strip()
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text


def _as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _as_optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    number = _as_float(value)
    return number if number != 0 else None


def _as_int(value: Any) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return 0


def _arrow_price(value: Any) -> float:
    if value in (None, ""):
        return 0.0
    if isinstance(value, str) and "." in value:
        return _as_float(value)
    return _scale(value)


def _best_depth_qty(raw: dict[str, Any], side: Literal["buy", "sell"]) -> int:
    direct_keys = ("bidQty", "buyQty", "bestBidQty") if side == "buy" else ("askQty", "sellQty", "bestAskQty")
    direct = _as_int(_pick(raw, *direct_keys))
    if direct:
        return direct

    depth = raw.get("depth") if isinstance(raw.get("depth"), dict) else {}
    rows = (
        raw.get("bids")
        or raw.get("buy")
        or depth.get("buy")
        if side == "buy"
        else raw.get("asks") or raw.get("sell") or depth.get("sell")
    )
    if isinstance(rows, list) and rows:
        first = rows[0]
        if isinstance(first, dict):
            return _as_int(_pick(first, "quantity", "qty", "volume"))
    return 0


async def _fetch_quote_batch(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    instruments: list[ArrowInstrument],
    mode: ArrowQuoteMode,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    body = [{"exchange": item.exchange.upper(), "symbol": item.arrow_symbol} for item in instruments]
    resp = await _guarded_arrow_request(lambda: client.post(url, json=body, headers=headers))
    if _looks_like_expired_token(resp):
        clear_saved_access_token()
        raise HTTPException(status_code=401, detail="Arrow token expired. Re-login with Arrow.")
    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="Arrow rate limit reached")
    if resp.status_code >= 400:
        if len(instruments) == 1:
            item = instruments[0]
            return {}, [{
                "symbol": item.symbol,
                "arrowSymbol": item.arrow_symbol,
                "statusCode": resp.status_code,
                "error": _short_arrow_error(resp),
            }]
        mid = len(instruments) // 2
        left_quotes, left_errors = await _fetch_quote_batch(client, url, headers, instruments[:mid], mode)
        right_quotes, right_errors = await _fetch_quote_batch(client, url, headers, instruments[mid:], mode)
        return {**left_quotes, **right_quotes}, [*left_errors, *right_errors]

    payload = resp.json()
    rows = payload.get("data") or []
    if isinstance(rows, dict):
        rows = [rows]

    quotes: dict[str, dict[str, Any]] = {}
    by_arrow_symbol = {item.arrow_symbol: item for item in instruments}
    by_canonical_symbol = {item.canonical_symbol: item for item in instruments}
    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        requested = instruments[idx] if idx < len(instruments) else instruments[0]
        symbol_from_row = str(row.get("symbol") or "").upper()
        if symbol_from_row:
            requested = (
                by_arrow_symbol.get(symbol_from_row)
                or by_canonical_symbol.get(canonical_equity_symbol(symbol_from_row))
            )
            if requested is None:
                errors.append(
                    {
                        "symbol": canonical_equity_symbol(symbol_from_row),
                        "arrowSymbol": symbol_from_row,
                        "statusCode": 502,
                        "error": "Arrow returned an unmapped symbol",
                    }
                )
                continue
        quotes[requested.kite_key] = _normalise_quote(requested, row, mode=mode)

    return quotes, errors


def _short_arrow_error(resp: httpx.Response) -> str:
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            return str(payload.get("message") or payload.get("detail") or resp.text)[:240]
    except Exception:
        pass
    return resp.text[:240]


async def fetch_historical(
    *,
    exchange: str,
    token: str,
    interval: str,
    from_dt: datetime,
    to_dt: datetime,
    include_oi: bool = False,
) -> dict[str, Any]:
    """Fetch Arrow historical candles by exchange/token."""
    url = f"{settings.ARROW_BASE_URL.rstrip('/')}/candle/{exchange.lower()}/{token}/{interval}"
    params = {
        "from": from_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "to": to_dt.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if include_oi:
        params["oi"] = "1"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await _guarded_arrow_request(lambda: client.get(url, params=params, headers=_headers()))
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
    return resp.json()
