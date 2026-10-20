"""
Alert rule persistence for trader decision cockpit.

These rules are screening alerts only. They intentionally do not contain broker
order payloads, product types, or execution instructions.
"""

from __future__ import annotations

import json
import logging
import asyncio
import time
from html import escape
from datetime import datetime
from threading import Lock
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Request
from kiteconnect import KiteConnect
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies import get_current_user, get_optional_kite, get_supabase
from app.services import arrow_market_data_service as arrow

logger = logging.getLogger("alpha_radar.routes.alerts")

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

ALERT_RULES_FILE = settings.DATA_DIR / "alert_rules.json"
ALERT_EVALUATIONS_FILE = settings.DATA_DIR / "alert_evaluations.json"
MAX_ALERT_RULES_PER_USER = 100
MAX_ALERT_NOTIFICATIONS_PER_RUN = 10
_alert_lock = Lock()


class AlertRuleBody(BaseModel):
    id: Optional[str] = None
    symbol: str = Field(..., min_length=1, max_length=32)
    bias: Literal["LONG", "SHORT", "NEUTRAL"]
    entry: float = Field(..., ge=0)
    stop: Optional[float] = Field(None, ge=0)
    target1: Optional[float] = Field(None, ge=0)
    minScore: int = Field(70, ge=0, le=100)
    maxSpreadPct: float = Field(0.12, ge=0, le=5)
    source: str = Field("decision-cockpit", min_length=1, max_length=64)
    enabled: bool = True


class AlertEvaluateBody(BaseModel):
    quoteProvider: Literal["arrow_first", "arrow", "kite"] = "arrow_first"
    maxNearPct: float = Field(0.5, ge=0, le=5)


def _now_iso() -> str:
    return datetime.now(settings.TIMEZONE).isoformat()


def _safe_symbol(symbol: str) -> str:
    return symbol.upper().strip().replace("NSE:", "").replace("BSE:", "")


def _user_key(user: dict[str, Any]) -> str:
    return str(user.get("id") or user.get("email") or "anonymous")


def _rule_id(user: dict[str, Any], symbol: str, source: str) -> str:
    raw = f"{source}:{_user_key(user)}:{symbol}"
    return "".join(ch if ch.isalnum() or ch in {":", "-", "_"} else "-" for ch in raw)


def _is_local_request(request: Request) -> bool:
    host = request.headers.get("host", "")
    origin = request.headers.get("origin", "")
    return "localhost" in host or "127.0.0.1" in host or "localhost" in origin or "127.0.0.1" in origin


async def require_alert_access(
    request: Request,
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Premium guard for alert rules.

    This avoids resolving Supabase before the localhost dev bypass, which keeps
    local cockpit testing fast even when Supabase env vars are not present.
    """
    admin_header = request.headers.get("X-Admin-Secret", "")
    if admin_header and admin_header == settings.ADMIN_SECRET:
        user["is_premium"] = True
        user["is_admin"] = True
        return user

    if user.get("is_dev"):
        if _is_local_request(request):
            user["is_premium"] = True
            user["is_admin"] = True
            return user
        raise HTTPException(status_code=401, detail="Authentication required")

    try:
        result = (
            get_supabase()
            .table("subscriptions")
            .select("plan, status, current_period_end")
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
        sub = result.data
    except HTTPException:
        raise
    except Exception:
        sub = None

    if not sub or sub.get("plan") != "premium" or sub.get("status") != "active":
        raise HTTPException(status_code=403, detail="Premium subscription required")

    if sub.get("current_period_end"):
        try:
            end_dt = datetime.fromisoformat(str(sub["current_period_end"]).replace("Z", "+00:00"))
            if end_dt < datetime.now(settings.TIMEZONE):
                raise HTTPException(status_code=403, detail="Premium subscription expired")
        except HTTPException:
            raise
        except (ValueError, TypeError):
            pass

    user["is_premium"] = True
    return user


def _empty_store() -> dict[str, list[dict[str, Any]]]:
    return {"rules": []}


def _empty_evaluation_store() -> dict[str, Any]:
    return {"evaluations": [], "summary": _evaluation_summary([]), "provider": {}, "updatedAt": None}


def _load_store() -> dict[str, list[dict[str, Any]]]:
    if not ALERT_RULES_FILE.exists():
        return _empty_store()
    try:
        data = json.loads(ALERT_RULES_FILE.read_text(encoding="utf-8"))
        rules = data.get("rules")
        if isinstance(rules, list):
            return {"rules": [rule for rule in rules if isinstance(rule, dict)]}
    except Exception:
        logger.exception("Failed to load alert rules")
    return _empty_store()


def _save_store(data: dict[str, list[dict[str, Any]]]) -> None:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = ALERT_RULES_FILE.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp_path.replace(ALERT_RULES_FILE)


def _load_evaluation_store() -> dict[str, Any]:
    if not ALERT_EVALUATIONS_FILE.exists():
        return _empty_evaluation_store()
    try:
        data = json.loads(ALERT_EVALUATIONS_FILE.read_text(encoding="utf-8"))
        evaluations = data.get("evaluations")
        if isinstance(evaluations, list):
            return {
                "evaluations": [item for item in evaluations if isinstance(item, dict)],
                "summary": data.get("summary") if isinstance(data.get("summary"), dict) else _evaluation_summary(evaluations),
                "provider": data.get("provider") if isinstance(data.get("provider"), dict) else {},
                "updatedAt": data.get("updatedAt"),
                "timestamp": data.get("timestamp"),
            }
    except Exception:
        logger.exception("Failed to load alert evaluations")
    return _empty_evaluation_store()


def _save_evaluation_store(data: dict[str, Any]) -> None:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = ALERT_EVALUATIONS_FILE.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp_path.replace(ALERT_EVALUATIONS_FILE)


def _visible_rules(data: dict[str, list[dict[str, Any]]], user: dict[str, Any]) -> list[dict[str, Any]]:
    owner = _user_key(user)
    return [
        rule
        for rule in data.get("rules", [])
        if rule.get("userId") == owner and rule.get("enabled", True)
    ]


def _enabled_rules(data: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return [rule for rule in data.get("rules", []) if rule.get("enabled", True)]


@router.get("/rules")
async def list_alert_rules(user: dict = Depends(require_alert_access)) -> dict:
    """Return persisted alert rules for the current trader."""
    with _alert_lock:
        rules = _visible_rules(_load_store(), user)
    rules.sort(key=lambda item: item.get("updatedAt") or item.get("createdAt") or "", reverse=True)
    return {"success": True, "count": len(rules), "rules": rules}


@router.post("/rules")
async def upsert_alert_rule(body: AlertRuleBody, user: dict = Depends(require_alert_access)) -> dict:
    """Create or update one alert rule for the current trader."""
    symbol = _safe_symbol(body.symbol)
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol required")

    source = body.source.strip() or "decision-cockpit"
    rule_id = _rule_id(user, symbol, source)
    owner = _user_key(user)
    now = _now_iso()

    incoming = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    incoming.update(
        {
            "id": rule_id,
            "symbol": symbol,
            "bias": body.bias.upper(),
            "source": source,
            "userId": owner,
            "userEmail": user.get("email"),
            "updatedAt": now,
        }
    )

    with _alert_lock:
        data = _load_store()
        rules = data.get("rules", [])
        existing = next((rule for rule in rules if rule.get("id") == rule_id), None)
        if existing:
            incoming["createdAt"] = existing.get("createdAt") or now
            rules = [incoming if rule.get("id") == rule_id else rule for rule in rules]
        else:
            incoming["createdAt"] = now
            user_rule_count = len([rule for rule in rules if rule.get("userId") == owner])
            if user_rule_count >= MAX_ALERT_RULES_PER_USER:
                raise HTTPException(status_code=429, detail="Alert rule limit reached")
            rules.append(incoming)

        data["rules"] = rules
        _save_store(data)
        visible = _visible_rules(data, user)

    return {"success": True, "rule": incoming, "count": len(visible)}


@router.delete("/rules/{rule_id}")
async def delete_alert_rule(
    rule_id: str = PathParam(..., min_length=1, max_length=160),
    user: dict = Depends(require_alert_access),
) -> dict:
    """Delete an alert rule owned by the current trader."""
    owner = _user_key(user)
    with _alert_lock:
        data = _load_store()
        rules = data.get("rules", [])
        before = len(rules)
        data["rules"] = [rule for rule in rules if not (rule.get("id") == rule_id and rule.get("userId") == owner)]
        if len(data["rules"]) == before:
            raise HTTPException(status_code=404, detail="Alert rule not found")
        _save_store(data)
        visible = _visible_rules(data, user)
    return {"success": True, "count": len(visible)}


@router.post("/evaluate")
async def evaluate_alert_rules(
    body: AlertEvaluateBody | None = None,
    user: dict = Depends(require_alert_access),
    kite: KiteConnect | None = Depends(get_optional_kite),
) -> dict:
    """Evaluate saved server-side alert rules against current quote data."""
    body = body or AlertEvaluateBody()
    with _alert_lock:
        rules = _visible_rules(_load_store(), user)

    result = await _evaluate_rules(rules, body.quoteProvider, kite, body.maxNearPct)
    _merge_saved_evaluations(result["evaluations"], result["provider"], result["timestamp"])
    summary = result["summary"]
    return {
        "success": True,
        "timestamp": result["timestamp"],
        "provider": result["provider"],
        "summary": summary,
        "evaluations": result["evaluations"],
    }


@router.get("/evaluations")
async def latest_alert_evaluations(user: dict = Depends(require_alert_access)) -> dict:
    """Return the last saved server-side alert evaluation for the current trader."""
    with _alert_lock:
        rules = _visible_rules(_load_store(), user)
        rule_ids = {str(rule.get("id") or "") for rule in rules}
        saved = _load_evaluation_store()

    evaluations = [
        item
        for item in saved.get("evaluations", [])
        if str(item.get("id") or "") in rule_ids
    ]
    evaluations.sort(key=_evaluation_rank)
    return {
        "success": True,
        "timestamp": saved.get("timestamp"),
        "updatedAt": saved.get("updatedAt"),
        "provider": saved.get("provider") or {},
        "summary": _evaluation_summary(evaluations),
        "evaluations": evaluations,
    }


async def evaluate_all_alert_rules(
    *,
    quote_provider: str = "arrow_first",
    max_near_pct: float = 0.5,
    kite: KiteConnect | None = None,
) -> dict[str, Any]:
    """Evaluate all enabled server-side alert rules for scheduler usage."""
    with _alert_lock:
        rules = _enabled_rules(_load_store())
        previous = _load_evaluation_store()

    result = await _evaluate_rules(rules, quote_provider, kite, max_near_pct)
    _carry_trigger_notification_marks(result["evaluations"], previous)
    notifications = await _send_trigger_notifications(result["evaluations"], previous)
    _mark_sent_trigger_notifications(result["evaluations"], notifications.pop("_sentRuleIds", []))
    with _alert_lock:
        _save_evaluation_store({
            "evaluations": result["evaluations"],
            "summary": result["summary"],
            "provider": result["provider"],
            "timestamp": result["timestamp"],
            "updatedAt": _now_iso(),
        })
    if result["summary"]["total"]:
        logger.info(
            "[alerts] evaluated %d rules: triggered=%d near=%d noQuote=%d notifications=%d/%d",
            result["summary"]["total"],
            result["summary"]["triggered"],
            result["summary"]["near"],
            result["summary"]["noQuote"],
            notifications["sent"],
            notifications["attempted"],
        )
    return {"success": True, **result, "notifications": notifications}


async def _evaluate_rules(
    rules: list[dict[str, Any]],
    quote_provider: str,
    kite: KiteConnect | None,
    max_near_pct: float,
) -> dict[str, Any]:
    symbols = sorted({_safe_symbol(str(rule.get("symbol") or "")) for rule in rules if rule.get("symbol")})
    quotes, provider = await _fetch_alert_quotes(symbols, quote_provider, kite)
    timestamp = int(time.time() * 1000)
    evaluations = [
        {
            **_evaluate_alert_rule(rule, quotes.get(f"NSE:{_safe_symbol(str(rule.get('symbol') or ''))}"), max_near_pct),
            "userId": rule.get("userId"),
            "userEmail": rule.get("userEmail"),
            "evaluatedAt": _now_iso(),
        }
        for rule in rules
    ]
    evaluations.sort(key=_evaluation_rank)
    return {
        "timestamp": timestamp,
        "provider": provider,
        "summary": _evaluation_summary(evaluations),
        "evaluations": evaluations,
    }


def _merge_saved_evaluations(evaluations: list[dict[str, Any]], provider: dict[str, Any], timestamp: int) -> None:
    with _alert_lock:
        saved = _load_evaluation_store()
        by_id = {str(item.get("id") or ""): item for item in saved.get("evaluations", [])}
        for item in evaluations:
            rule_id = str(item.get("id") or "")
            if rule_id:
                by_id[rule_id] = item
        merged = sorted(by_id.values(), key=_evaluation_rank)
        _save_evaluation_store({
            "evaluations": merged,
            "summary": _evaluation_summary(merged),
            "provider": provider,
            "timestamp": timestamp,
            "updatedAt": _now_iso(),
        })


def _carry_trigger_notification_marks(evaluations: list[dict[str, Any]], previous_store: dict[str, Any]) -> None:
    previous_by_id = {
        str(item.get("id") or ""): item
        for item in previous_store.get("evaluations", [])
        if isinstance(item, dict)
    }
    for item in evaluations:
        previous = previous_by_id.get(str(item.get("id") or ""))
        notified_at = previous.get("triggerNotifiedAt") if previous else None
        if (
            notified_at
            and item.get("status") == "TRIGGERED"
            and item.get("actionable")
        ):
            item["triggerNotifiedAt"] = notified_at


def _mark_sent_trigger_notifications(evaluations: list[dict[str, Any]], sent_rule_ids: list[str]) -> None:
    if not sent_rule_ids:
        return
    sent = set(sent_rule_ids)
    now = _now_iso()
    for item in evaluations:
        if str(item.get("id") or "") in sent:
            item["triggerNotifiedAt"] = now


async def _send_trigger_notifications(
    evaluations: list[dict[str, Any]],
    previous_store: dict[str, Any],
) -> dict[str, Any]:
    """Notify once when an alert transitions into actionable TRIGGERED state."""
    if not _telegram_configured():
        return {"attempted": 0, "sent": 0, "skipped": 0}

    previous_by_id = {
        str(item.get("id") or ""): item
        for item in previous_store.get("evaluations", [])
        if isinstance(item, dict)
    }
    candidates = [
        item
        for item in evaluations
        if _should_notify_trigger(item, previous_by_id.get(str(item.get("id") or "")))
    ]
    due = candidates[:MAX_ALERT_NOTIFICATIONS_PER_RUN]
    if not due:
        return {"attempted": 0, "sent": 0, "skipped": 0}

    from app.core.telegram import send_message  # local import avoids startup coupling

    sent = 0
    sent_rule_ids: list[str] = []
    for item in due:
        result = await send_message(_format_trigger_notification(item))
        if result and result.get("ok"):
            sent += 1
            sent_rule_ids.append(str(item.get("id") or ""))

    return {
        "attempted": len(due),
        "sent": sent,
        "skipped": max(0, len(candidates) - len(due)),
        "_sentRuleIds": sent_rule_ids,
    }


def _telegram_configured() -> bool:
    return bool(settings.TELEGRAM_TOKEN and settings.TELEGRAM_CHAT_ID)


def _should_notify_trigger(current: dict[str, Any], previous: dict[str, Any] | None) -> bool:
    if current.get("status") != "TRIGGERED" or not current.get("actionable"):
        return False
    if not previous:
        return True
    if previous.get("status") == "TRIGGERED" and previous.get("actionable") and previous.get("triggerNotifiedAt"):
        return False
    return True


def _format_trigger_notification(item: dict[str, Any]) -> str:
    side = escape(str(item.get("bias") or "-"))
    symbol = escape(str(item.get("symbol") or "-"))
    owner = escape(str(item.get("userEmail") or item.get("userId") or ""))
    source = escape(str(item.get("source") or "alert"))
    lines = [
        "<b>Alpha Radar Alert Triggered</b>",
        f"<b>{symbol}</b> {side}",
        f"LTP: {_fmt_price(item.get('ltp'))} | Entry: {_fmt_price(item.get('entry'))}",
        f"Stop: {_fmt_price(item.get('stop'))} | Target: {_fmt_price(item.get('target1'))}",
        f"Spread: {_fmt_pct(item.get('spreadPct'))} | Source: {source}",
    ]
    if owner:
        lines.append(f"Rule owner: {owner}")
    lines.append("")
    lines.append("Screening alert only. Confirm liquidity, spread, and risk before execution.")
    return "\n".join(lines)


def _fmt_price(value: Any) -> str:
    num = _num(value)
    return "-" if num <= 0 else f"{num:,.2f}"


def _fmt_pct(value: Any) -> str:
    try:
        if value is None:
            return "-"
        return f"{float(value):.3f}%"
    except (TypeError, ValueError):
        return "-"


def _evaluation_summary(evaluations: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(evaluations),
        "triggered": len([item for item in evaluations if item.get("status") == "TRIGGERED"]),
        "near": len([item for item in evaluations if item.get("status") == "NEAR"]),
        "invalidated": len([item for item in evaluations if item.get("status") == "INVALIDATED"]),
        "noQuote": len([item for item in evaluations if item.get("status") == "NO_QUOTE"]),
    }


async def _fetch_alert_quotes(
    symbols: list[str],
    quote_provider: str,
    kite: KiteConnect | None,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if not symbols:
        return {}, {"provider": quote_provider, "requested": 0, "returned": 0, "fallback": False}

    provider = quote_provider if quote_provider in {"arrow_first", "arrow", "kite"} else "arrow_first"
    meta: dict[str, Any] = {"provider": provider, "requested": len(symbols), "returned": 0, "fallback": False}

    if provider in {"arrow_first", "arrow"}:
        try:
            arrow_quotes = await arrow.fetch_quotes(symbols, exchange="NSE", mode="full")
            arrow_meta = arrow_quotes.pop("_meta", {})
            if arrow_quotes or provider == "arrow":
                return arrow_quotes, {
                    "provider": "arrow",
                    "requested": len(symbols),
                    "returned": len(arrow_quotes),
                    "elapsedMs": arrow_meta.get("elapsedMs"),
                    "mode": arrow_meta.get("mode", "full"),
                    "partial": bool(arrow_meta.get("partial")),
                    "errors": arrow_meta.get("errors", []),
                    "fallback": False,
                }
            meta = {
                "provider": "kite",
                "requested": len(symbols),
                "returned": 0,
                "fallback": True,
                "fallbackReason": "Arrow returned no alert quotes",
            }
        except Exception as exc:
            if provider == "arrow":
                raise
            logger.warning("[alerts] Arrow evaluation quotes failed; falling back to Kite: %s", exc)
            meta = {
                "provider": "kite",
                "requested": len(symbols),
                "returned": 0,
                "fallback": True,
                "fallbackReason": _exception_detail(exc)[:180],
            }

    if not kite:
        meta.update({"returned": 0, "fallback": True, "fallbackReason": meta.get("fallbackReason") or "No quote provider connected"})
        return {}, meta

    instruments = [f"NSE:{symbol}" for symbol in symbols]
    try:
        quotes = await asyncio.to_thread(kite.quote, instruments)
        return quotes, {**meta, "provider": "kite", "returned": len(quotes)}
    except Exception as exc:
        logger.warning("[alerts] Kite evaluation quotes failed: %s", exc)
        return {}, {**meta, "provider": "kite", "returned": 0, "fallback": True, "fallbackReason": _exception_detail(exc)[:180]}


def _evaluate_alert_rule(rule: dict[str, Any], quote: dict[str, Any] | None, max_near_pct: float = 0.5) -> dict[str, Any]:
    symbol = _safe_symbol(str(rule.get("symbol") or ""))
    bias = str(rule.get("bias") or "NEUTRAL").upper()
    entry = _num(rule.get("entry"))
    stop = _num(rule.get("stop"))
    target = _num(rule.get("target1"))
    max_spread_pct = _num(rule.get("maxSpreadPct"), 0.12)
    base = {
        "id": rule.get("id"),
        "symbol": symbol,
        "source": rule.get("source") or "decision-cockpit",
        "bias": bias,
        "entry": entry,
        "stop": stop,
        "target1": target,
        "maxSpreadPct": max_spread_pct,
    }

    if entry <= 0 or bias not in {"LONG", "SHORT", "NEUTRAL"}:
        return {**base, "status": "INVALID_RULE", "actionable": False, "message": "Alert rule is missing a valid side or entry."}
    if not quote:
        return {**base, "status": "NO_QUOTE", "actionable": False, "message": "No live quote is available for this rule."}

    ltp = _quote_ltp(quote)
    if ltp <= 0:
        return {**base, "status": "NO_QUOTE", "actionable": False, "message": "Quote did not include a valid last price."}

    spread_pct = _quote_spread_pct(quote)
    spread_ok = spread_pct is None or spread_pct <= max_spread_pct
    distance_pct = ((ltp - entry) / entry) * 100
    trigger_progress_pct = distance_pct if bias == "LONG" else -distance_pct
    distance_to_entry_pct = abs(distance_pct)
    stop_invalidated = bool(stop and ((bias == "LONG" and ltp <= stop) or (bias == "SHORT" and ltp >= stop)))
    target_hit = bool(target and ((bias == "LONG" and ltp >= target) or (bias == "SHORT" and ltp <= target)))
    trigger_hit = bias != "NEUTRAL" and trigger_progress_pct >= 0

    if stop_invalidated:
        status_text = "INVALIDATED"
        message = "Stop/invalidation level has been breached."
    elif target_hit:
        status_text = "TARGET_HIT"
        message = "Target level has already been reached."
    elif trigger_hit:
        status_text = "TRIGGERED"
        message = "Entry trigger is live now." if spread_ok else "Entry trigger is live, but spread is wider than rule."
    elif distance_to_entry_pct <= max_near_pct:
        status_text = "NEAR"
        message = "Price is near the saved entry trigger."
    else:
        status_text = "WAIT"
        message = "Price is not near the saved trigger yet."

    return {
        **base,
        "status": status_text,
        "actionable": status_text == "TRIGGERED" and spread_ok,
        "message": message,
        "ltp": round(ltp, 2),
        "distancePct": round(trigger_progress_pct, 2),
        "distanceToEntryPct": round(distance_to_entry_pct, 2),
        "spreadPct": round(spread_pct, 4) if spread_pct is not None else None,
        "spreadOk": spread_ok,
        "quoteSource": quote.get("source") or "kite",
    }


def _evaluation_rank(item: dict[str, Any]) -> tuple[int, float, str]:
    order = {"TRIGGERED": 0, "NEAR": 1, "WAIT": 2, "TARGET_HIT": 3, "INVALIDATED": 4, "NO_QUOTE": 5, "INVALID_RULE": 6}
    return (order.get(str(item.get("status")), 99), -float(item.get("distancePct") or 0), str(item.get("symbol") or ""))


def _exception_detail(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return str(exc.detail)
    return str(exc)


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value or default)
    except (TypeError, ValueError):
        return default


def _quote_ltp(quote: dict[str, Any]) -> float:
    return _num(quote.get("last_price") or quote.get("lastPrice") or quote.get("ltp"))


def _quote_spread_pct(quote: dict[str, Any]) -> float | None:
    depth = quote.get("depth") or {}
    buy = depth.get("buy") or depth.get("bids") or []
    sell = depth.get("sell") or depth.get("asks") or []
    bid = _depth_price(buy[0] if buy else None, "buy")
    ask = _depth_price(sell[0] if sell else None, "sell")
    if bid <= 0 or ask <= 0 or ask < bid:
        return None
    mid = (bid + ask) / 2
    return ((ask - bid) / mid) * 100 if mid > 0 else None


def _depth_price(level: Any, side: str) -> float:
    if not isinstance(level, dict):
        return 0.0
    keys = ["price", "p", "bidPrice" if side == "buy" else "askPrice", "bid" if side == "buy" else "ask"]
    return next((_num(level.get(key)) for key in keys if _num(level.get(key)) > 0), 0.0)
