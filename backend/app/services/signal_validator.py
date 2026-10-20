"""
Signal Validation Tracker — services for the 15-day shadow-mode experiment.

Logs every signal fire to Supabase (signal_fires table) and provides outcome-
check routines for the scheduled jobs. Swing signals also receive multi-session
outcomes so a 5-20 day thesis is not judged like an intraday call.

This module is import-safe: if Supabase isn't configured, log_signal_fire
silently no-ops so callers don't crash.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from datetime import datetime, timedelta
from threading import RLock
from time import monotonic
from typing import Any, Optional

from kiteconnect import KiteConnect

from app.config import settings
from app.core.supabase_client import get_supabase_client

logger = logging.getLogger("alpha_radar.signal_validator")

# ── Configuration ───────────────────────────────────────────────────────────
BASE_HORIZONS = ["15m", "1h", "eod", "next_day_eod"]
SWING_HORIZONS = ["3d", "5d", "10d", "20d"]
HORIZONS = [*BASE_HORIZONS, *SWING_HORIZONS]

HORIZON_MINUTES = {
    "15m": 15,
    "1h": 60,
}

MARKET_OPEN = {"hour": 9, "minute": 15, "second": 0, "microsecond": 0}
MARKET_CLOSE = {"hour": 15, "minute": 30, "second": 0, "microsecond": 0}

# Asymmetric win/loss thresholds — covers ~0.1-0.15% slippage + brokerage
WIN_LOSS_THRESHOLDS = {
    "15m":          {"win": 0.5, "loss": -0.3},
    "1h":           {"win": 1.0, "loss": -0.5},
    "eod":          {"win": 1.5, "loss": -0.8},
    "next_day_eod": {"win": 2.0, "loss": -1.0},
    "3d":            {"win": 2.0, "loss": -1.2},
    "5d":            {"win": 3.0, "loss": -1.8},
    "10d":           {"win": 4.5, "loss": -2.5},
    "20d":           {"win": 6.0, "loss": -3.5},
}

# Don't log the same (symbol, signal_type, direction) within this window
DEDUPE_COOLDOWN_MINUTES = 30
_DEDUPE_CACHE_MAX_ENTRIES = 4096

# Database-backed dedupe remains the source of truth across processes.  This
# bounded reservation cache prevents every polling route from repeating the
# same SELECT while a signal is inside the cooldown window.
_recent_signal_fires: OrderedDict[tuple[str, str, str], float] = OrderedDict()
_recent_signal_fires_lock = RLock()

# Token cache to avoid repeated kite.ltp lookups
_token_cache: dict[str, int] = {}


def _reserve_signal_fire(key: tuple[str, str, str]) -> bool:
    """Reserve a fire key for one cooldown window; return False if still active."""
    now = monotonic()
    with _recent_signal_fires_lock:
        expires_at = _recent_signal_fires.get(key)
        if expires_at is not None and expires_at > now:
            _recent_signal_fires.move_to_end(key)
            return False
        _recent_signal_fires.pop(key, None)
        _recent_signal_fires[key] = now + DEDUPE_COOLDOWN_MINUTES * 60
        while len(_recent_signal_fires) > _DEDUPE_CACHE_MAX_ENTRIES:
            _recent_signal_fires.popitem(last=False)
    return True


def _release_signal_fire(key: tuple[str, str, str]) -> None:
    """Release a reservation when no durable fire was created or found."""
    with _recent_signal_fires_lock:
        _recent_signal_fires.pop(key, None)


# ── Public: log a signal fire ───────────────────────────────────────────────

def log_signal_fire(
    *,
    symbol: str,
    signal_type: str,
    trigger_price: float,
    strength: float,
    direction: str,
    confidence: str | None = None,
    category: str = "stock",
    metadata: dict | None = None,
    context: dict | None = None,
) -> Optional[str]:
    """
    Persist a signal fire and seed PENDING outcome rows for all horizons.

    Returns the fire_id (UUID string) on success, None if Supabase isn't
    configured, the signal direction is NEUTRAL, or the fire was deduped.
    """
    if direction not in ("BULLISH", "BEARISH"):
        return None  # nothing to validate

    dedupe_key = (
        str(symbol).strip().upper(),
        str(signal_type).strip().upper(),
        direction,
    )
    if not _reserve_signal_fire(dedupe_key):
        return None

    try:
        sb = get_supabase_client()
    except Exception:
        _release_signal_fire(dedupe_key)
        logger.debug("signal_validator: Supabase not configured — skipping log")
        return None

    # Dedupe: skip if same setup logged recently
    try:
        cutoff = (
            datetime.now(settings.TIMEZONE)
            - timedelta(minutes=DEDUPE_COOLDOWN_MINUTES)
        ).isoformat()
        existing = (
            sb.table("signal_fires")
            .select("id")
            .eq("symbol", symbol)
            .eq("signal_type", signal_type)
            .eq("direction", direction)
            .gte("fired_at", cutoff)
            .limit(1)
            .execute()
        )
        if existing.data:
            return None
    except Exception:
        # If dedupe check fails, still proceed (better to over-log than miss)
        logger.debug("signal_validator: dedupe check failed", exc_info=True)

    fired_at = datetime.now(settings.TIMEZONE)

    try:
        result = (
            sb.table("signal_fires")
            .insert(
                {
                    "signal_type": signal_type,
                    "symbol": symbol,
                    "category": category,
                    "fired_at": fired_at.isoformat(),
                    "trigger_price": trigger_price,
                    "strength": strength,
                    "direction": direction,
                    "confidence": confidence,
                    "metadata": metadata or {},
                    "context": context or {},
                }
            )
            .execute()
        )
    except Exception:
        logger.exception(
            "signal_validator: insert failed for %s/%s", symbol, signal_type
        )
        _release_signal_fire(dedupe_key)
        return None

    if not result.data:
        _release_signal_fire(dedupe_key)
        return None

    fire_id = result.data[0]["id"]

    # Seed swing-length outcomes only for Swing signals. Other scanners retain
    # the existing intraday/EOD validation contract.
    outcome_horizons = list(BASE_HORIZONS)
    if str(signal_type or "").upper().startswith("SWING_"):
        outcome_horizons.extend(SWING_HORIZONS)

    try:
        sb.table("signal_outcomes").insert(
            [
                {"signal_fire_id": fire_id, "horizon": h, "status": "PENDING"}
                for h in outcome_horizons
            ]
        ).execute()
    except Exception:
        logger.exception(
            "signal_validator: failed to seed outcomes for %s", fire_id
        )

    logger.info(
        "[signal_validator] logged fire %s for %s %s %s (strength=%.1f)",
        fire_id, symbol, signal_type, direction, strength,
    )
    return fire_id


# ── Market context snapshot ─────────────────────────────────────────────────

def compute_market_context() -> dict:
    """
    Best-effort snapshot of market state. Returns whatever's available.
    For v1 we just capture pulse regime; breadth/VIX added in a later iteration.
    """
    ctx: dict[str, Any] = {}
    try:
        # Lazy import — pulse cache may not exist on all deployments
        from app.caches import market_pulse_cache  # type: ignore
        pulse = getattr(market_pulse_cache, "current_pulse", None)
        if pulse:
            ctx["regime"] = pulse.get("signal", "NEUTRAL")
    except Exception:
        pass
    return ctx


# ── Outcome checks ──────────────────────────────────────────────────────────

def _resolve_token(kite: KiteConnect, symbol: str) -> Optional[int]:
    """Resolve NSE symbol to instrument token, cached in-process."""
    if symbol in _token_cache:
        return _token_cache[symbol]
    try:
        ltp_data = kite.ltp([f"NSE:{symbol}"])
        token = ltp_data[f"NSE:{symbol}"]["instrument_token"]
        _token_cache[symbol] = token
        return token
    except Exception:
        return None


def _classify_outcome(direction: str, return_pct: float, horizon: str) -> str:
    """Classify a signed return as WIN / LOSS / FLAT for the given horizon."""
    thresholds = WIN_LOSS_THRESHOLDS[horizon]
    # For BEARISH signals a price drop is a "win" — flip the sign
    signed_return = return_pct if direction == "BULLISH" else -return_pct
    if signed_return >= thresholds["win"]:
        return "WIN"
    if signed_return <= thresholds["loss"]:
        return "LOSS"
    return "FLAT"


def _horizon_target_dt(fired_at: datetime, horizon: str) -> datetime:
    """When should this horizon be evaluated?"""
    if horizon in HORIZON_MINUTES:
        target = fired_at + timedelta(minutes=HORIZON_MINUTES[horizon])
        # Cap intraday horizons at market close
        market_close = fired_at.replace(**MARKET_CLOSE)
        if target > market_close:
            target = market_close
        return target
    if horizon == "eod":
        return fired_at.replace(**MARKET_CLOSE)
    if horizon == "next_day_eod":
        return _next_market_day(fired_at).replace(**MARKET_CLOSE)
    if horizon in SWING_HORIZONS:
        sessions = int(horizon.removesuffix("d"))
        return _market_day_after(fired_at, sessions).replace(**MARKET_CLOSE)
    raise ValueError(f"unknown horizon: {horizon}")


def _next_market_day(dt: datetime) -> datetime:
    """Return the next non-weekend, non-configured-holiday market day."""
    holidays = _market_holiday_dates()
    next_day = dt + timedelta(days=1)
    while next_day.weekday() >= 5 or next_day.date().isoformat() in holidays:
        next_day += timedelta(days=1)
    return next_day


def _market_day_after(dt: datetime, sessions: int) -> datetime:
    """Return the market day reached after ``sessions`` trading sessions."""
    target = dt
    for _ in range(max(1, sessions)):
        target = _next_market_day(target)
    return target


def _market_holiday_dates() -> set[str]:
    """Return configured market holidays as ISO date strings."""
    return {
        item
        for item in getattr(settings, "MARKET_HOLIDAYS", ())
        if isinstance(item, str) and item
    }


def _fetch_window(
    kite: KiteConnect,
    token: int,
    from_dt: datetime,
    to_dt: datetime,
    interval: str = "5minute",
) -> list[dict]:
    """Fetch OHLC candles between from_dt and to_dt."""
    try:
        return kite.historical_data(token, from_dt, to_dt, interval) or []
    except Exception:
        logger.debug(
            "signal_validator: historical_data failed for token=%s", token,
            exc_info=True,
        )
        return []


def check_outcomes_for_horizon(horizon: str, kite: KiteConnect) -> dict:
    """
    Find PENDING outcomes for this horizon whose target time has passed,
    fetch price data, compute returns, and update rows.

    Returns a summary dict {checked, updated, skipped, errors}.
    """
    if horizon not in HORIZONS:
        raise ValueError(f"unknown horizon: {horizon}")

    summary = {"checked": 0, "updated": 0, "skipped": 0, "errors": 0}

    try:
        sb = get_supabase_client()
    except Exception:
        logger.debug("signal_validator: Supabase not configured")
        return summary

    try:
        result = (
            sb.table("signal_outcomes")
            .select(
                "id, horizon, signal_fire_id, "
                "signal_fires(symbol, fired_at, direction, trigger_price)"
            )
            .eq("horizon", horizon)
            .eq("status", "PENDING")
            .limit(500)
            .execute()
        )
        rows = result.data or []
    except Exception:
        logger.exception(
            "signal_validator: failed to fetch pending outcomes for %s", horizon
        )
        return summary

    now = datetime.now(settings.TIMEZONE)

    for row in rows:
        summary["checked"] += 1
        fire = row.get("signal_fires") or {}
        symbol = fire.get("symbol")
        direction = fire.get("direction")
        trigger_price = fire.get("trigger_price")
        fired_at_str = fire.get("fired_at")

        if not (symbol and direction and trigger_price and fired_at_str):
            summary["skipped"] += 1
            continue

        try:
            fired_at = datetime.fromisoformat(
                fired_at_str.replace("Z", "+00:00")
            ).astimezone(settings.TIMEZONE)
        except Exception:
            summary["errors"] += 1
            continue

        target_dt = _horizon_target_dt(fired_at, horizon)
        if now < target_dt:
            summary["skipped"] += 1
            continue

        token = _resolve_token(kite, symbol)
        if not token:
            summary["errors"] += 1
            continue

        # Window to query for entry/exit/high/low
        if horizon in SWING_HORIZONS:
            first_session = _next_market_day(fired_at)
            from_dt = first_session.replace(**MARKET_OPEN)
            to_dt = target_dt
        elif horizon == "next_day_eod":
            next_session = _next_market_day(fired_at)
            from_dt = next_session.replace(**MARKET_OPEN)
            to_dt = next_session.replace(**MARKET_CLOSE)
        elif horizon == "eod":
            from_dt = fired_at + timedelta(minutes=1)
            to_dt = fired_at.replace(**MARKET_CLOSE)
        else:  # 15m, 1h
            from_dt = fired_at + timedelta(minutes=1)
            to_dt = target_dt

        if to_dt <= from_dt:
            summary["skipped"] += 1
            continue

        interval = "day" if horizon in SWING_HORIZONS else "5minute"
        candles = _fetch_window(kite, token, from_dt, to_dt, interval)
        if not candles:
            summary["errors"] += 1
            continue

        entry_price = float(trigger_price) if horizon in SWING_HORIZONS else candles[0]["open"]
        exit_price = candles[-1]["close"]
        high_during = max(c["high"] for c in candles)
        low_during = min(c["low"] for c in candles)
        return_pct = (
            round((exit_price - entry_price) / entry_price * 100, 3)
            if entry_price > 0
            else 0
        )

        if direction == "BULLISH":
            mfe = round((high_during - entry_price) / entry_price * 100, 3)
            mae = round((low_during - entry_price) / entry_price * 100, 3)
        else:  # BEARISH — favorable means price went DOWN
            mfe = round((entry_price - low_during) / entry_price * 100, 3)
            mae = round((entry_price - high_during) / entry_price * 100, 3)

        status = _classify_outcome(direction, return_pct, horizon)

        try:
            sb.table("signal_outcomes").update(
                {
                    "status": status,
                    "entry_price": entry_price,
                    "exit_price": exit_price,
                    "high_during": high_during,
                    "low_during": low_during,
                    "return_pct": return_pct,
                    "mfe_pct": mfe,
                    "mae_pct": mae,
                    "checked_at": now.isoformat(),
                }
            ).eq("id", row["id"]).execute()
            summary["updated"] += 1
        except Exception:
            logger.exception(
                "signal_validator: update failed for outcome %s", row["id"]
            )
            summary["errors"] += 1

    if summary["updated"] > 0 or summary["errors"] > 0:
        logger.info(
            "[signal_validator] horizon=%s checked=%d updated=%d skipped=%d errors=%d",
            horizon, summary["checked"], summary["updated"],
            summary["skipped"], summary["errors"],
        )

    return summary


# ── Stats query (used by /api/admin/signal-stats) ───────────────────────────

SIGNAL_FAMILIES: dict[str, tuple[str, int]] = {
    "intraday": ("Intraday", 1),
    "swing": ("Swing", 2),
    "abnormal": ("Abnormal", 3),
    "options": ("Options OI", 4),
    "positional": ("Positional", 5),
    "other": ("Other", 99),
}

SWING_STRATEGY_LABELS: dict[str, str] = {
    "EARLY_MOMENTUM": "Early Momentum",
    "LIQUIDITY_SHOCK": "Liquidity Shock",
    "VOL_SQUEEZE": "Vol Squeeze",
    "RS_PULLBACK": "RS Pullback",
    "ACCELERATION": "Acceleration",
    "MOMENTUM_BURST": "Momentum Burst",
    "10D_BO": "10D Breakout",
    "50D_BO": "50D Breakout",
    "REVERSAL": "Pullback Reversal",
    "CHANNEL_BO": "Channel Breakout",
}

SWING_STRATEGY_ORDER: dict[str, int] = {
    "EARLY_MOMENTUM": 1,
    "LIQUIDITY_SHOCK": 2,
    "VOL_SQUEEZE": 3,
    "RS_PULLBACK": 4,
    "ACCELERATION": 5,
    "MOMENTUM_BURST": 6,
    "10D_BO": 7,
    "50D_BO": 8,
    "REVERSAL": 9,
    "CHANNEL_BO": 10,
}

SWING_PREFERRED_HORIZONS = ["5d", "10d", "3d", "20d", "next_day_eod", "eod", "1h", "15m"]


def build_edge_verdict(stats: dict[str, Any]) -> dict[str, Any]:
    """Translate resolved outcome stats into a simple sizing/readiness verdict."""
    resolved = int(stats.get("resolved") or 0)
    win_rate = stats.get("win_rate")
    avg_return = stats.get("avg_return_pct")
    avg_mfe = stats.get("avg_mfe_pct")
    avg_mae = stats.get("avg_mae_pct")

    if resolved < 5:
        return {
            "label": "NEEDS_SAMPLE",
            "action": "Keep shadow-mode",
            "score": None,
            "sample": "thin",
            "reason": f"Only {resolved} resolved outcome{'s' if resolved != 1 else ''}; wait for at least 5.",
        }

    score = 50.0
    reasons: list[str] = []

    if win_rate is not None:
        if win_rate >= 60:
            score += 20
            reasons.append(f"{win_rate:.1f}% win rate")
        elif win_rate >= 50:
            score += 10
            reasons.append(f"{win_rate:.1f}% win rate is acceptable")
        elif win_rate < 40:
            score -= 20
            reasons.append(f"{win_rate:.1f}% win rate is weak")
        else:
            score -= 5
            reasons.append(f"{win_rate:.1f}% win rate is mixed")

    if avg_return is not None:
        if avg_return >= 0.4:
            score += 20
            reasons.append(f"{avg_return:+.2f}% average return")
        elif avg_return > 0:
            score += 10
            reasons.append(f"{avg_return:+.2f}% average return")
        elif avg_return < -0.2:
            score -= 20
            reasons.append(f"{avg_return:+.2f}% average return")
        else:
            score -= 5
            reasons.append(f"{avg_return:+.2f}% average return is flat")

    if avg_mfe is not None and avg_mae is not None:
        adverse = abs(float(avg_mae or 0))
        if avg_mfe > 0 and adverse > 0 and avg_mfe >= adverse * 1.5:
            score += 10
            reasons.append("favorable excursion dominates adverse move")
        elif adverse > 0 and avg_mfe < adverse:
            score -= 10
            reasons.append("adverse move is larger than favorable excursion")

    if resolved >= 20:
        score += 5
        sample = "strong"
    elif resolved >= 10:
        sample = "usable"
    else:
        sample = "early"

    score = max(0, min(100, round(score)))
    if score >= 75 and resolved >= 10:
        label = "SIZE_UP"
        action = "Trust with defined risk"
    elif score >= 60:
        label = "TRADE_SMALL"
        action = "Use smaller size"
    elif score >= 45:
        label = "WATCH"
        action = "Wait for more proof"
    else:
        label = "PAUSE"
        action = "Do not size this engine"

    return {
        "label": label,
        "action": action,
        "score": score,
        "sample": sample,
        "reason": "; ".join(reasons[:3]) or "Outcome profile is not resolved enough.",
    }


def signal_family(signal_type: str | None) -> str:
    st = (signal_type or "").upper()
    if st.startswith("SWING_"):
        return "swing"
    if st.startswith("ABNORMAL_"):
        return "abnormal"
    if st.startswith("OI_"):
        return "options"
    if st == "52W_BOUNCE" or st.startswith("ACCUM_"):
        return "positional"
    if (
        st.startswith("INTRADAY_RADAR_")
        or st.startswith("PULSE_")
        or st.startswith("PDH_")
        or st.startswith("PDL_")
        or st.startswith("COMBO_")
        or st.startswith("ORB_")
        or st.startswith("BUYING_SCORE")
        or st.startswith("BEAR_SCORE")
    ):
        return "intraday"
    return "other"


def _safe_metadata(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _strategy_from_signal_type(signal_type: str) -> str:
    st = (signal_type or "").upper()
    if not st.startswith("SWING_"):
        return "UNKNOWN"
    body = st.removeprefix("SWING_")
    for suffix in ("_BULL", "_BEAR", "_BULLISH", "_BEARISH"):
        if body.endswith(suffix):
            return body.removesuffix(suffix)
    return body or "UNKNOWN"


def _swing_strategy_key(fire: dict[str, Any]) -> str:
    metadata = _safe_metadata(fire.get("metadata"))
    strategy = str(metadata.get("strategy") or "").upper().replace(" ", "_")
    return strategy or _strategy_from_signal_type(str(fire.get("signal_type") or ""))


def _new_swing_horizon_bucket() -> dict[str, Any]:
    return {
        "total": 0,
        "resolved": 0,
        "pending": 0,
        "wins": 0,
        "losses": 0,
        "flats": 0,
        "sum_return": 0.0,
        "sum_mfe": 0.0,
        "sum_mae": 0.0,
    }


def _finalize_swing_horizon(bucket: dict[str, Any]) -> dict[str, Any]:
    resolved = int(bucket.get("resolved") or 0)
    wins = int(bucket.get("wins") or 0)
    losses = int(bucket.get("losses") or 0)
    wl_count = wins + losses
    return {
        "total": int(bucket.get("total") or 0),
        "resolved": resolved,
        "pending": int(bucket.get("pending") or 0),
        "wins": wins,
        "losses": losses,
        "flats": int(bucket.get("flats") or 0),
        "win_rate": round(wins / resolved * 100, 1) if resolved else None,
        "win_rate_excl_flat": round(wins / wl_count * 100, 1) if wl_count else None,
        "avg_return_pct": round(float(bucket.get("sum_return") or 0) / resolved, 2) if resolved else None,
        "avg_mfe_pct": round(float(bucket.get("sum_mfe") or 0) / resolved, 2) if resolved else None,
        "avg_mae_pct": round(float(bucket.get("sum_mae") or 0) / resolved, 2) if resolved else None,
    }


def _preferred_swing_horizon(horizons: dict[str, dict[str, Any]]) -> str:
    for horizon in SWING_PREFERRED_HORIZONS:
        if horizons.get(horizon, {}).get("resolved", 0) >= 5:
            return horizon
    for horizon in SWING_PREFERRED_HORIZONS:
        if horizons.get(horizon, {}).get("resolved", 0) > 0:
            return horizon
    for horizon in SWING_PREFERRED_HORIZONS:
        if horizons.get(horizon, {}).get("total", 0) > 0:
            return horizon
    return "next_day_eod"


def build_swing_strategy_health(rows: list[dict]) -> dict[str, Any]:
    """Summarize swing playbook health from resolved validator outcomes."""
    buckets: dict[str, dict[str, Any]] = {}

    for row in rows:
        fire = row.get("signal_fires") or {}
        if not isinstance(fire, dict):
            continue
        signal_type = str(fire.get("signal_type") or "").upper()
        metadata = _safe_metadata(fire.get("metadata"))
        strategy = _swing_strategy_key(fire)
        if signal_family(signal_type) != "swing" and strategy == "UNKNOWN":
            continue

        bucket = buckets.setdefault(
            strategy,
            {
                "key": strategy,
                "label": SWING_STRATEGY_LABELS.get(strategy, strategy.replace("_", " ").title()),
                "order": SWING_STRATEGY_ORDER.get(strategy, 99),
                "signal_types": set(),
                "symbols": set(),
                "fires_seen": set(),
                "roles": {},
                "readiness": {},
                "quality_mix": {},
                "horizons": {},
            },
        )
        bucket["signal_types"].add(signal_type)
        symbol = str(fire.get("symbol") or "").upper()
        if symbol:
            bucket["symbols"].add(symbol)

        fire_id = str(fire.get("id") or f"{signal_type}:{symbol}:{fire.get('fired_at')}")
        if fire_id not in bucket["fires_seen"]:
            bucket["fires_seen"].add(fire_id)
            role = str(metadata.get("tracking_role") or "TRADE_SIGNAL").upper()
            readiness = str(metadata.get("trade_readiness") or "TRADE_READY").upper()
            quality = str(metadata.get("quality") or "WATCH").upper()
            bucket["roles"][role] = int(bucket["roles"].get(role, 0)) + 1
            bucket["readiness"][readiness] = int(bucket["readiness"].get(readiness, 0)) + 1
            bucket["quality_mix"][quality] = int(bucket["quality_mix"].get(quality, 0)) + 1

        horizon = str(row.get("horizon") or "")
        if horizon not in HORIZONS:
            continue
        h_bucket = bucket["horizons"].setdefault(horizon, _new_swing_horizon_bucket())
        h_bucket["total"] += 1
        status = str(row.get("status") or "").upper()
        if status in {"WIN", "LOSS", "FLAT"}:
            h_bucket["resolved"] += 1
            h_bucket["sum_return"] += float(row.get("return_pct") or 0)
            h_bucket["sum_mfe"] += float(row.get("mfe_pct") or 0)
            h_bucket["sum_mae"] += float(row.get("mae_pct") or 0)
            if status == "WIN":
                h_bucket["wins"] += 1
            elif status == "LOSS":
                h_bucket["losses"] += 1
            else:
                h_bucket["flats"] += 1
        else:
            h_bucket["pending"] += 1

    strategies: list[dict[str, Any]] = []
    for strategy, bucket in buckets.items():
        finalized_horizons = {
            horizon: _finalize_swing_horizon(h_bucket)
            for horizon, h_bucket in bucket["horizons"].items()
        }
        preferred_horizon = _preferred_swing_horizon(finalized_horizons)
        preferred_stats = finalized_horizons.get(preferred_horizon) or _finalize_swing_horizon({})
        edge = build_edge_verdict(preferred_stats)
        strategies.append(
            {
                "key": strategy,
                "label": bucket["label"],
                "order": bucket["order"],
                "fires": len(bucket["fires_seen"]),
                "symbol_count": len(bucket["symbols"]),
                "signal_types": sorted(bucket["signal_types"]),
                "roles": dict(sorted(bucket["roles"].items())),
                "readiness": dict(sorted(bucket["readiness"].items())),
                "quality_mix": dict(sorted(bucket["quality_mix"].items())),
                "preferred_horizon": preferred_horizon,
                "preferred": {**preferred_stats, "edge": edge},
                "horizons": finalized_horizons,
            }
        )

    strategies.sort(
        key=lambda item: (
            item["order"],
            -(item["preferred"].get("resolved") or 0),
            item["label"],
        )
    )

    trusted = [
        item for item in strategies
        if item["preferred"].get("edge", {}).get("label") in {"SIZE_UP", "TRADE_SMALL"}
    ]
    paused = [
        item for item in strategies
        if item["preferred"].get("edge", {}).get("label") == "PAUSE"
    ]
    needs_sample = [
        item for item in strategies
        if item["preferred"].get("edge", {}).get("label") == "NEEDS_SAMPLE"
    ]
    return {
        "preferred_horizons": SWING_PREFERRED_HORIZONS,
        "strategies": strategies,
        "summary": {
            "strategies": len(strategies),
            "trusted": len(trusted),
            "paused": len(paused),
            "needs_sample": len(needs_sample),
            "best": trusted[0]["key"] if trusted else (strategies[0]["key"] if strategies else None),
        },
    }


def build_signal_family_stats(by_signal_type: dict) -> dict:
    buckets: dict[str, dict] = {}
    for signal_type, horizons in by_signal_type.items():
        family_key = signal_family(signal_type)
        label, order = SIGNAL_FAMILIES[family_key]
        bucket = buckets.setdefault(
            family_key,
            {
                "key": family_key,
                "label": label,
                "order": order,
                "signal_types": set(),
                "horizons": {},
            },
        )
        bucket["signal_types"].add(signal_type)

        for horizon, stats in (horizons or {}).items():
            h_bucket = bucket["horizons"].setdefault(
                horizon,
                {
                    "total": 0,
                    "resolved": 0,
                    "pending": 0,
                    "wins": 0,
                    "losses": 0,
                    "flats": 0,
                    "sum_return": 0.0,
                    "sum_mfe": 0.0,
                    "sum_mae": 0.0,
                    "top_signal": signal_type,
                    "top_signal_resolved": -1,
                },
            )
            resolved = int(stats.get("resolved") or 0)
            h_bucket["total"] += int(stats.get("total") or 0)
            h_bucket["resolved"] += resolved
            h_bucket["pending"] += int(stats.get("pending") or 0)
            h_bucket["wins"] += int(stats.get("wins") or 0)
            h_bucket["losses"] += int(stats.get("losses") or 0)
            h_bucket["flats"] += int(stats.get("flats") or 0)
            if resolved > 0:
                h_bucket["sum_return"] += float(stats.get("avg_return_pct") or 0) * resolved
                h_bucket["sum_mfe"] += float(stats.get("avg_mfe_pct") or 0) * resolved
                h_bucket["sum_mae"] += float(stats.get("avg_mae_pct") or 0) * resolved
            if resolved > h_bucket["top_signal_resolved"]:
                h_bucket["top_signal"] = signal_type
                h_bucket["top_signal_resolved"] = resolved

    out: dict[str, dict] = {}
    for key, bucket in sorted(buckets.items(), key=lambda item: item[1]["order"]):
        horizons = {}
        for horizon, h_bucket in bucket["horizons"].items():
            resolved = h_bucket["resolved"]
            wl_count = h_bucket["wins"] + h_bucket["losses"]
            horizons[horizon] = {
                "total": h_bucket["total"],
                "resolved": resolved,
                "pending": h_bucket["pending"],
                "wins": h_bucket["wins"],
                "losses": h_bucket["losses"],
                "flats": h_bucket["flats"],
                "win_rate": round(h_bucket["wins"] / resolved * 100, 1) if resolved > 0 else None,
                "win_rate_excl_flat": round(h_bucket["wins"] / wl_count * 100, 1) if wl_count > 0 else None,
                "avg_return_pct": round(h_bucket["sum_return"] / resolved, 2) if resolved > 0 else None,
                "avg_mfe_pct": round(h_bucket["sum_mfe"] / resolved, 2) if resolved > 0 else None,
                "avg_mae_pct": round(h_bucket["sum_mae"] / resolved, 2) if resolved > 0 else None,
                "top_signal": h_bucket["top_signal"],
            }
            horizons[horizon]["edge"] = build_edge_verdict(horizons[horizon])
        out[key] = {
            "label": bucket["label"],
            "order": bucket["order"],
            "signal_count": len(bucket["signal_types"]),
            "signal_types": sorted(bucket["signal_types"]),
            "horizons": horizons,
        }
    return out


def build_outcome_health(rows: list[dict], now: datetime | None = None) -> dict[str, Any]:
    """Summarize pending outcome maturity so stalled validation is visible."""
    now = now or datetime.now(settings.TIMEZONE)
    by_horizon: dict[str, dict[str, Any]] = {
        horizon: {
            "pending": 0,
            "due": 0,
            "overdue": 0,
            "next_due_at": None,
            "oldest_due_at": None,
        }
        for horizon in HORIZONS
    }

    for row in rows:
        if row.get("status") != "PENDING":
            continue
        horizon = row.get("horizon")
        if horizon not in by_horizon:
            continue
        fire = row.get("signal_fires") or {}
        fired_at_str = fire.get("fired_at")
        if not fired_at_str:
            continue
        try:
            fired_at = datetime.fromisoformat(
                str(fired_at_str).replace("Z", "+00:00")
            ).astimezone(settings.TIMEZONE)
            target_dt = _horizon_target_dt(fired_at, str(horizon))
        except Exception:
            continue

        bucket = by_horizon[str(horizon)]
        bucket["pending"] += 1
        if target_dt <= now:
            bucket["due"] += 1
            if (now - target_dt) >= timedelta(minutes=30):
                bucket["overdue"] += 1
            if bucket["oldest_due_at"] is None or target_dt < bucket["oldest_due_at"]:
                bucket["oldest_due_at"] = target_dt
        elif bucket["next_due_at"] is None or target_dt < bucket["next_due_at"]:
            bucket["next_due_at"] = target_dt

    total_pending = sum(item["pending"] for item in by_horizon.values())
    total_due = sum(item["due"] for item in by_horizon.values())
    total_overdue = sum(item["overdue"] for item in by_horizon.values())
    serialized = {
        horizon: {
            **item,
            "next_due_at": item["next_due_at"].isoformat() if item["next_due_at"] else None,
            "oldest_due_at": item["oldest_due_at"].isoformat() if item["oldest_due_at"] else None,
        }
        for horizon, item in by_horizon.items()
    }
    status_label = "blocked" if total_overdue else "due" if total_due else "waiting" if total_pending else "clear"
    return {
        "status": status_label,
        "pending": total_pending,
        "due": total_due,
        "overdue": total_overdue,
        "kite_required": total_due > 0,
        "by_horizon": serialized,
    }


def get_signal_stats(days: int = 15) -> dict:
    """
    Aggregate win/loss stats per signal_type per horizon over the last N days.
    """
    summary: dict = {"days": days, "by_signal_type": {}}

    try:
        sb = get_supabase_client()
    except Exception:
        return summary

    cutoff = (
        datetime.now(settings.TIMEZONE) - timedelta(days=days)
    ).isoformat()

    try:
        rows_result = (
            sb.table("signal_outcomes")
            .select(
                "status, horizon, return_pct, mfe_pct, mae_pct, "
                "signal_fires!inner(id, signal_type, symbol, fired_at, direction, metadata, trigger_price, strength)"
            )
            .gte("signal_fires.fired_at", cutoff)
            .limit(10000)
            .execute()
        )
        rows = rows_result.data or []
    except Exception:
        logger.exception("signal_validator: stats query failed")
        return summary

    agg: dict = {}
    summary["outcome_health"] = build_outcome_health(rows)

    for r in rows:
        fire = r.get("signal_fires") or {}
        st = fire.get("signal_type") or "UNKNOWN"
        h = r.get("horizon")
        status = r.get("status")
        ret = r.get("return_pct") or 0
        mfe = r.get("mfe_pct") or 0
        mae = r.get("mae_pct") or 0

        bucket = agg.setdefault(st, {}).setdefault(
            h,
            {
                "total": 0, "resolved": 0, "pending": 0,
                "wins": 0, "losses": 0, "flats": 0,
                "sum_return": 0.0, "sum_mfe": 0.0, "sum_mae": 0.0,
            },
        )
        bucket["total"] += 1
        if status in ("WIN", "LOSS", "FLAT"):
            bucket["resolved"] += 1
            bucket["sum_return"] += ret
            bucket["sum_mfe"] += mfe
            bucket["sum_mae"] += mae
            if status == "WIN":
                bucket["wins"] += 1
            elif status == "LOSS":
                bucket["losses"] += 1
            else:
                bucket["flats"] += 1
        else:
            bucket["pending"] += 1

    for st, horizons in agg.items():
        out_h = {}
        for h, b in horizons.items():
            r_count = b["resolved"]
            wl_count = b["wins"] + b["losses"]
            out_h[h] = {
                "total": b["total"],
                "resolved": r_count,
                "pending": b["pending"],
                "wins": b["wins"],
                "losses": b["losses"],
                "flats": b["flats"],
                "win_rate": round(b["wins"] / r_count * 100, 1) if r_count > 0 else None,
                "win_rate_excl_flat": round(b["wins"] / wl_count * 100, 1) if wl_count > 0 else None,
                "avg_return_pct": round(b["sum_return"] / r_count, 2) if r_count > 0 else None,
                "avg_mfe_pct": round(b["sum_mfe"] / r_count, 2) if r_count > 0 else None,
                "avg_mae_pct": round(b["sum_mae"] / r_count, 2) if r_count > 0 else None,
            }
        summary["by_signal_type"][st] = out_h

    summary["by_family"] = build_signal_family_stats(summary["by_signal_type"])
    summary["swing_strategy_health"] = build_swing_strategy_health(rows)
    return summary


# ── Daily digest (sent via Telegram) ────────────────────────────────────────

def _format_pct(v: Optional[float], with_sign: bool = False) -> str:
    if v is None:
        return "—"
    sign = "+" if (with_sign and v >= 0) else ""
    return f"{sign}{v:.1f}%"


def _signal_distinct_fires(stats: dict) -> int:
    """Count distinct fires (each fire shows up under all 4 horizons in stats)."""
    total = 0
    for horizons in stats.get("by_signal_type", {}).values():
        if "15m" in horizons:
            total += horizons["15m"]["total"]
    return total


def build_daily_digest_text() -> str:
    """
    Compose the HTML body for the daily Telegram digest.
    Compares yesterday (1d) vs the trailing week (7d) at the 1h horizon.
    """
    today = datetime.now(settings.TIMEZONE).strftime("%d %b %Y")
    day_stats = get_signal_stats(days=1)
    week_stats = get_signal_stats(days=7)

    day_fires = _signal_distinct_fires(day_stats)
    week_fires = _signal_distinct_fires(week_stats)

    lines: list[str] = []
    lines.append("<b>Signal Validator — Daily Digest</b>")
    lines.append(f"<i>{today}</i>")
    lines.append("")

    if day_fires == 0:
        lines.append("<b>No signals fired in the last 24h.</b>")
        lines.append(
            "Either market was closed, validator hadn't been deployed, "
            "or no engine produced a STRONG/MODERATE setup."
        )
        lines.append(f"\n7-day total: <b>{week_fires}</b> fires")
        lines.append("\n#AlphaRadar #SignalValidator")
        return "\n".join(lines)

    lines.append(f"<b>Yesterday's activity:</b> {day_fires} distinct fires")
    lines.append("")

    # Per-engine performance at 1h horizon
    rows: list[tuple[str, Optional[float], Optional[float], int, int]] = []
    for st, horizons in day_stats.get("by_signal_type", {}).items():
        h1 = horizons.get("1h")
        if not h1:
            continue
        rows.append((
            st,
            h1.get("win_rate"),
            h1.get("avg_return_pct"),
            h1.get("resolved", 0),
            h1.get("total", 0),
        ))

    # Sort by win rate desc, with None last
    rows.sort(key=lambda r: (r[1] is None, -(r[1] or 0)))

    if rows:
        lines.append("<b>1-hour horizon, by signal type:</b>")
        for st, wr, ret, resolved, total in rows:
            wr_s = _format_pct(wr)
            ret_s = _format_pct(ret, with_sign=True)
            sample = f"{resolved}/{total}" if resolved < total else f"{total}"
            lines.append(f"  {st}: <b>{wr_s}</b> win, {ret_s} avg ({sample})")
        lines.append("")

    # 7-day rollup at 1h
    week_resolved = 0
    week_wins = 0
    for horizons in week_stats.get("by_signal_type", {}).values():
        h1 = horizons.get("1h")
        if h1:
            week_resolved += h1.get("resolved", 0)
            week_wins += h1.get("wins", 0)
    week_winrate = (week_wins / week_resolved * 100) if week_resolved > 0 else 0
    lines.append(
        f"<b>7-day rollup (1h):</b> {week_fires} fires, "
        f"{week_resolved} resolved, "
        f"<b>{week_winrate:.1f}%</b> win rate"
    )

    lines.append("")
    lines.append("Full dashboard: /admin/signals")
    lines.append("")
    lines.append("#AlphaRadar #SignalValidator")
    return "\n".join(lines)


async def send_daily_digest() -> dict:
    """
    Build and send the daily Telegram digest.
    Returns a status dict {sent, message_chars, telegram_ok}.
    """
    from app.core.telegram import send_message  # local import — avoids circular

    text = build_daily_digest_text()
    result = await send_message(text)
    return {
        "sent": bool(result and result.get("ok")),
        "message_chars": len(text),
        "telegram_ok": bool(result and result.get("ok")),
    }
