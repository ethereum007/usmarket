"""
Scanner routes -- CPR, patterns, VCP, volume profile, NR/squeeze, swing.

Each endpoint accepts pre-fetched OHLC data from the frontend:
    POST body: { symbols: [ {symbol, daily, weekly?, monthly?, ...}, ... ] }

The frontend fetches OHLC from /api/quotes/history for each symbol,
then POSTs the data here for analysis by the CPR engine modules.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any, Literal

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from kiteconnect import KiteConnect
from pydantic import BaseModel

from app.core.session_cache import save_session
from app.dependencies import get_current_user, get_kite, require_premium
from app.routes.swing_research import router as swing_research_router

logger = logging.getLogger("alpha_radar.routes.scanner")

router = APIRouter(prefix="/api/scanner", tags=["scanner"])
router.include_router(swing_research_router)

SWING_STRATEGIES = (
    "EARLY_MOMENTUM",
    "LIQUIDITY_SHOCK",
    "VOL_SQUEEZE",
    "RS_PULLBACK",
    "ACCELERATION",
    "MOMENTUM_BURST",
    "10D_BO",
    "50D_BO",
    "REVERSAL",
    "CHANNEL_BO",
)
SWING_MOMENTUM_WATCH = (
    "NETWEB",
    "DATAPATTNS",
    "CARTRADE",
    "KAYNES",
    "PGEL",
    "ZENTEC",
    "IDEAFORGE",
    "TITAGARH",
    "BEML",
    "COCHINSHIP",
    "MAZDOCK",
    "OLECTRA",
    "TEJASNET",
)

SWING_PHASE_ORDER = (
    "READY_BREAKOUT",
    "EARLY_ACCUMULATION",
    "LIVE_MOMENTUM",
    "PULLBACK_WATCH",
    "EXTENDED_AVOID",
)

SWING_PHASE_WEIGHT = {
    "READY_BREAKOUT": 14,
    "EARLY_ACCUMULATION": 10,
    "LIVE_MOMENTUM": 7,
    "PULLBACK_WATCH": 3,
    "EXTENDED_AVOID": -18,
}

SWING_STRATEGY_WEIGHT = {
    "EARLY_MOMENTUM": 12,
    "LIQUIDITY_SHOCK": 11,
    "VOL_SQUEEZE": 10,
    "RS_PULLBACK": 9,
    "ACCELERATION": 6,
    "MOMENTUM_BURST": 3,
    "10D_BO": 8,
    "50D_BO": 10,
    "REVERSAL": 6,
    "CHANNEL_BO": 7,
}


class SwingWarmRequest(BaseModel):
    universe: str = "nifty200"
    symbols: list[str] | None = None
    limit: int = 120
    scope_mode: Literal["strict", "blended"] = "blended"


# ── Shared helpers ──────────────────────────────────────────────────────────

def _to_df(candles: list[dict] | None) -> pd.DataFrame:
    """Convert a list of OHLC candle dicts to a pandas DataFrame."""
    if not candles:
        return pd.DataFrame()
    df = pd.DataFrame(candles)
    for col in ["open", "high", "low", "close"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    if "volume" in df.columns:
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype(int)
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return df


def _parse_symbols_payload(body_data: dict | list) -> list[dict]:
    """
    Extract the list of symbol items from the request body.
    Handles both {symbols: [...]} and bare [...] formats.
    """
    if isinstance(body_data, list):
        return body_data
    return body_data.get("symbols", [])


def _make_response(results: list[dict], **extra) -> dict:
    return {
        "success": True,
        "results": results,
        "count": len(results),
        "timestamp": int(time.time() * 1000),
        **extra,
    }


def _log_swing_signal_fires(signals: list[dict]) -> dict[str, int]:
    """Feed qualified Swing Spectrum setups into the shadow performance tracker."""
    summary = {"eligible": 0, "logged": 0}
    if not signals:
        return summary

    try:
        from app.services.signal_validator import compute_market_context, log_signal_fire
    except Exception:
        logger.debug("[swing] signal_validator unavailable", exc_info=True)
        return summary

    context = {**compute_market_context(), "scanner": "swing_spectrum"}
    for signal in signals:
        if not _is_trackable_swing_signal(signal):
            continue

        direction = _swing_direction(signal)
        if not direction:
            continue

        trigger_price = _num(signal.get("entry_price")) or _num(signal.get("current_price"))
        if not trigger_price:
            continue

        summary["eligible"] += 1
        strategy = str(signal.get("strategy") or "UNKNOWN").upper().replace(" ", "_")
        strength = _num(signal.get("strength")) or 0.0
        is_discovery = _is_discovery_swing_signal(signal)
        try:
            fire_id = log_signal_fire(
                symbol=str(signal.get("symbol") or "").upper(),
                signal_type=f"SWING_{strategy}_{signal.get('signal')}",
                trigger_price=trigger_price,
                strength=strength,
                direction=direction,
                confidence=_swing_confidence(signal, strength, is_discovery),
                category="stock",
                metadata={
                    "strategy": strategy,
                    "quality": signal.get("quality"),
                    "setup_phase": signal.get("setup_phase"),
                    "tracking_role": "DISCOVERY" if is_discovery else "TRADE_SIGNAL",
                    "trade_readiness": _swing_trade_readiness(signal, is_discovery),
                    "rr": _num(signal.get("rr")),
                    "risk_pct": _num(signal.get("risk_pct")),
                    "reward_pct": _num(signal.get("reward_pct")),
                    "rvol": _num(signal.get("rvol")),
                    "change_pct": _num(signal.get("change_pct")),
                    "breakout_level": _num(signal.get("breakout_level")),
                    "stop_loss": _num(signal.get("stop_loss")),
                    "target": _num(signal.get("target")),
                    "notes": signal.get("notes"),
                    "reasons": (signal.get("reasons") or [])[:5],
                },
                context=context,
            )
            if fire_id:
                summary["logged"] += 1
        except Exception:
            logger.debug("[swing] signal_validator log failed for %s", signal.get("symbol"), exc_info=True)

    return summary


def _is_trackable_swing_signal(signal: dict) -> bool:
    if _is_discovery_swing_signal(signal):
        return True

    quality = signal.get("quality")
    strength = _num(signal.get("strength")) or 0.0
    rr = _num(signal.get("rr")) or 0.0
    risk_pct = _num(signal.get("risk_pct"))
    risk_pct = 99.0 if risk_pct is None else risk_pct
    return quality in {"A+", "A"} and strength >= 70 and rr >= 1.5 and risk_pct <= 10


def _is_discovery_swing_signal(signal: dict) -> bool:
    strategy = str(signal.get("strategy") or "").upper()
    setup_phase = str(signal.get("setup_phase") or "").upper()
    strength = _num(signal.get("strength")) or 0.0
    rvol = _num(signal.get("rvol")) or 0.0
    change_pct = abs(_num(signal.get("change_pct")) or 0.0)
    if strategy in {"EARLY_MOMENTUM", "LIQUIDITY_SHOCK", "VOL_SQUEEZE", "RS_PULLBACK"} and setup_phase in {
        "FIRST_RECLAIM",
        "EARLY_IGNITION",
        "LIQUIDITY_ABSORPTION",
        "SQUEEZE_READY",
        "RS_PULLBACK",
    }:
        risk_pct = _num(signal.get("risk_pct"))
        risk_pct = 99.0 if risk_pct is None else risk_pct
        return strength >= 68 and risk_pct <= 9.5

    return (
        strategy == "ACCELERATION"
        and setup_phase == "EXTENDED_WAIT"
        and strength >= 75
        and (rvol >= 1.2 or change_pct >= 4.0)
    )


def _swing_confidence(signal: dict, strength: float, is_discovery: bool = False) -> str:
    if is_discovery:
        return "MODERATE"
    return "STRONG" if signal.get("quality") == "A+" or strength >= 86 else "MODERATE"


def _swing_trade_readiness(signal: dict, is_discovery: bool) -> str:
    if not is_discovery:
        return "TRADE_READY"
    strategy = str(signal.get("strategy") or "").upper()
    if strategy in {"EARLY_MOMENTUM", "LIQUIDITY_SHOCK", "VOL_SQUEEZE"}:
        return "EARLY_ENTRY_ZONE"
    if strategy == "RS_PULLBACK":
        return "WAIT_FOR_RECLAIM"
    return "WAIT_FOR_PULLBACK"


def _swing_direction(signal: dict) -> str | None:
    side = str(signal.get("signal") or "").upper()
    if side == "BULL":
        return "BULLISH"
    if side == "BEAR":
        return "BEARISH"
    return None


def _num(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _empty_swing_strategies() -> dict[str, list[dict]]:
    return {strategy: [] for strategy in SWING_STRATEGIES}


def _pick(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        value = data.get(key)
        if value is not None:
            return value
    return default


def _normalize_swing_signal(signal: dict[str, Any]) -> dict[str, Any]:
    """Normalize scanner-service output to the existing SwingContent API shape."""
    notes = _pick(signal, "notes", default="")
    if isinstance(notes, list):
        notes = ", ".join(str(item) for item in notes if item)
    raw_reasons = _pick(signal, "reasons", default=[]) or []
    reasons = raw_reasons if isinstance(raw_reasons, list) else [str(raw_reasons)]

    return {
        "symbol": str(_pick(signal, "symbol", default="")).upper(),
        "strategy": str(_pick(signal, "strategy", default="")),
        "signal": str(_pick(signal, "signal", default="")).upper(),
        "current_price": round(_num(_pick(signal, "current_price", "currentPrice")) or 0, 2),
        "change_pct": round(_num(_pick(signal, "change_pct", "changePct")) or 0, 2),
        "trigger_date": str(_pick(signal, "trigger_date", "triggerDate", default=""))[:10],
        "breakout_level": round(_num(_pick(signal, "breakout_level", "breakoutLevel")) or 0, 2),
        "stop_loss": round(_num(_pick(signal, "stop_loss", "stopLoss")) or 0, 2),
        "target": round(_num(_pick(signal, "target")) or 0, 2),
        "strength": round(_num(_pick(signal, "strength")) or 0, 2),
        "notes": str(notes or ""),
        "entry_price": round(_num(_pick(signal, "entry_price", "entryPrice", "current_price", "currentPrice")) or 0, 2),
        "risk_pct": round(_num(_pick(signal, "risk_pct", "riskPct")) or 0, 2),
        "reward_pct": round(_num(_pick(signal, "reward_pct", "rewardPct")) or 0, 2),
        "rr": round(_num(_pick(signal, "rr")) or 0, 2),
        "hold_days": str(_pick(signal, "hold_days", "holdDays", default="2-10D")),
        "trend_score": round(_num(_pick(signal, "trend_score", "trendScore")) or 0, 2),
        "volume_score": round(_num(_pick(signal, "volume_score", "volumeScore")) or 0, 2),
        "pattern_score": round(_num(_pick(signal, "pattern_score", "patternScore")) or 0, 2),
        "quality": _pick(signal, "quality", default="WATCH"),
        "rvol": round(_num(_pick(signal, "rvol")) or 0, 2),
        "setup_phase": str(_pick(signal, "setup_phase", "setupPhase", default="UNKNOWN")),
        "reasons": reasons,
        "benchmark_rs_20": _num(_pick(signal, "benchmark_rs_20", "benchmarkRs20")),
        "benchmark_rs_60": _num(_pick(signal, "benchmark_rs_60", "benchmarkRs60")),
        "weekly_trend": str(_pick(signal, "weekly_trend", "weeklyTrend", default="MIXED")).upper(),
        "distance_to_trigger_pct": round(
            _num(_pick(signal, "distance_to_trigger_pct", "distanceToTriggerPct")) or 0,
            2,
        ),
        "extension_atr": round(_num(_pick(signal, "extension_atr", "extensionAtr")) or 0, 2),
        "lifecycle_state": str(
            _pick(signal, "lifecycle_state", "lifecycleState", default="UNKNOWN")
        ).upper(),
    }


def _swing_phase(signal: dict[str, Any]) -> str:
    strategy = str(signal.get("strategy") or "").upper()
    setup_phase = str(signal.get("setup_phase") or "").upper()
    lifecycle = str(signal.get("lifecycle_state") or "").upper()
    if lifecycle in {"", "UNKNOWN"} and setup_phase in {"", "UNKNOWN"}:
        return "UNKNOWN"
    change_pct = abs(_num(signal.get("change_pct")) or 0.0)
    risk_pct = _num(signal.get("risk_pct")) or 0.0
    rr = _num(signal.get("rr")) or 0.0
    rvol = _num(signal.get("rvol")) or 0.0
    trend_score = _num(signal.get("trend_score")) or 0.0
    pattern_score = _num(signal.get("pattern_score")) or 0.0
    strength = _num(signal.get("strength")) or 0.0

    if lifecycle == "EXTENDED_AVOID" or setup_phase == "EXTENDED_WAIT" or change_pct >= 9 or risk_pct >= 7 or rr < 1.1:
        return "EXTENDED_AVOID"

    if lifecycle == "TRIGGERED" or setup_phase == "LIVE_MOMENTUM" or strategy == "MOMENTUM_BURST":
        return "LIVE_MOMENTUM" if change_pct <= 6 and rr >= 1.4 else "EXTENDED_AVOID"

    if (
        lifecycle == "FORMING"
        or setup_phase in {"EARLY_IGNITION", "FIRST_RECLAIM", "LIQUIDITY_ABSORPTION", "SQUEEZE_READY"}
        or strategy in {"EARLY_MOMENTUM", "LIQUIDITY_SHOCK", "VOL_SQUEEZE"}
        or (change_pct <= 3.5 and rvol >= 1.2 and trend_score >= 55)
    ):
        return "EARLY_ACCUMULATION"

    if lifecycle == "PULLBACK_ENTRY" or strategy in {"REVERSAL", "ACCELERATION", "RS_PULLBACK"} or setup_phase == "RS_PULLBACK" or (change_pct <= 2.5 and pattern_score >= 55):
        return "PULLBACK_WATCH"

    if lifecycle == "READY" or signal.get("quality") in {"A+", "A"} or strength >= 72:
        if rr >= 1.4 and risk_pct <= 6:
            return "READY_BREAKOUT"

    return "PULLBACK_WATCH" if rr >= 1.4 else "EXTENDED_AVOID"


def _swing_signal_score(signal: dict[str, Any]) -> float:
    phase = _swing_phase(signal)
    strength = _num(signal.get("strength")) or 0.0
    rr = _num(signal.get("rr")) or 0.0
    risk_pct = _num(signal.get("risk_pct")) or 0.0
    rvol = _num(signal.get("rvol")) or 0.0
    change_pct = abs(_num(signal.get("change_pct")) or 0.0)
    strategy = str(signal.get("strategy") or "").upper()
    quality = str(signal.get("quality") or "WATCH").upper()
    direction = str(signal.get("signal") or "").upper()
    rs_60 = _num(signal.get("benchmark_rs_60")) or 0.0
    directional_rs = rs_60 if direction == "BULL" else -rs_60
    weekly_trend = str(signal.get("weekly_trend") or "MIXED").upper()
    weekly_aligned = (
        (direction == "BULL" and weekly_trend == "BULLISH")
        or (direction == "BEAR" and weekly_trend == "BEARISH")
    )
    extension_atr = _num(signal.get("extension_atr")) or 0.0

    quality_bonus = {"A+": 8, "A": 5, "B": 2}.get(quality, 0)
    rr_bonus = min(9.0, rr * 3.0)
    rvol_bonus = min(6.0, max(0.0, rvol - 1.0) * 2.0)
    rs_bonus = min(6.0, max(-7.0, directional_rs * 0.6))
    weekly_bonus = 3.0 if weekly_aligned else -4.0 if weekly_trend != "MIXED" else 0.0
    extension_penalty = max(0.0, change_pct - 5.0) * 2.5
    extension_penalty += max(0.0, extension_atr - 1.8) * 5.0
    risk_penalty = max(0.0, risk_pct - 4.5) * 2.0

    return round(
        min(
            100.0,
            max(
                0.0,
                strength
                + SWING_PHASE_WEIGHT.get(phase, 0)
                + SWING_STRATEGY_WEIGHT.get(strategy, 0)
                + quality_bonus
                + rr_bonus
                + rvol_bonus
                + rs_bonus
                + weekly_bonus
                - extension_penalty
                - risk_penalty,
            ),
        ),
        2,
    )


def _swing_action(phase: str, score: float, direction: str, signals: list[dict[str, Any]]) -> str:
    has_conflict = len({str(s.get("signal") or "").upper() for s in signals if s.get("signal")}) > 1
    if has_conflict:
        return "WAIT_CONFLICT"
    if phase == "EXTENDED_AVOID":
        return "AVOID_CHASE"
    if phase == "EARLY_ACCUMULATION":
        return "BUILD_WATCH"
    if phase == "PULLBACK_WATCH":
        return "WAIT_TRIGGER"
    if phase == "LIVE_MOMENTUM":
        return "CONFIRM_TAPE"
    if phase == "READY_BREAKOUT" and score >= 82 and direction in {"LONG", "SHORT"}:
        return "PLAN_ENTRY"
    return "WATCH"


def _unique_text(items: list[Any], limit: int = 8) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        output.append(text)
        if len(output) >= limit:
            break
    return output


def _build_swing_radar(all_signals: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for signal in all_signals:
        symbol = str(signal.get("symbol") or "").upper()
        if symbol:
            grouped.setdefault(symbol, []).append(signal)

    rows: list[dict[str, Any]] = []
    for symbol, signals in grouped.items():
        scored = sorted(
            signals,
            key=lambda item: (_swing_signal_score(item), _num(item.get("strength")) or 0.0),
            reverse=True,
        )
        primary = scored[0]
        # Entry, stop, direction and lifecycle must describe the same thesis.
        # Other scanners remain evidence; their votes cannot replace its geometry.
        primary_side = str(primary.get("signal") or "").upper()
        direction = {"BULL": "LONG", "BEAR": "SHORT"}.get(primary_side, "NEUTRAL")
        phase = _swing_phase(primary)
        strategy_count = len({str(s.get("strategy") or "").upper() for s in scored})
        confluence_bonus = min(10.0, max(0, strategy_count - 1) * 4.0)
        conflict_penalty = 12.0 if direction == "NEUTRAL" else 0.0
        composite_score = round(
            min(100.0, max(0.0, _swing_signal_score(primary) + confluence_bonus - conflict_penalty)),
            2,
        )
        evidence = _unique_text(
            [
                primary.get("notes"),
                *[reason for signal in scored for reason in (signal.get("reasons") or [])],
                *[signal.get("notes") for signal in scored[1:]],
            ],
            limit=7,
        )
        risks: list[str] = []
        risk_pct = _num(primary.get("risk_pct")) or 0.0
        rr = _num(primary.get("rr")) or 0.0
        change_pct = abs(_num(primary.get("change_pct")) or 0.0)
        if risk_pct >= 6:
            risks.append("Wide stop; reduce size or wait for tighter entry.")
        if rr < 1.4:
            risks.append("Reward/risk is not strong enough for fresh swing entry.")
        if phase == "EXTENDED_AVOID" or change_pct >= 7:
            risks.append("Move is extended; avoid chasing late prints.")
        if direction == "NEUTRAL":
            risks.append("Strategy votes conflict; wait for cleaner alignment.")
        if not risks:
            risks.append("Needs trigger confirmation and clean market context.")

        votes = [
            {
                "strategy": signal.get("strategy"),
                "signal": signal.get("signal"),
                "phase": _swing_phase(signal),
                "score": _swing_signal_score(signal),
                "strength": signal.get("strength"),
                "quality": signal.get("quality"),
                "rr": signal.get("rr"),
                "risk_pct": signal.get("risk_pct"),
            }
            for signal in scored
        ]

        row = {
            "symbol": symbol,
            "direction": direction,
            "phase": phase,
            "action": _swing_action(phase, composite_score, direction, scored),
            "score": composite_score,
            "confidence": min(99, max(25, round(composite_score))),
            "strategy_count": strategy_count,
            "strategies": [vote["strategy"] for vote in votes],
            "votes": votes,
            "primary_signal": primary,
            "entry": primary.get("entry_price") or primary.get("current_price"),
            "stop": primary.get("stop_loss"),
            "target": primary.get("target"),
            "risk_reward": primary.get("rr"),
            "risk_pct": primary.get("risk_pct"),
            "reward_pct": primary.get("reward_pct"),
            "change_pct": primary.get("change_pct"),
            "current_price": primary.get("current_price"),
            "hold_days": primary.get("hold_days"),
            "evidence": evidence,
            "risks": _unique_text(risks, limit=5),
        }
        rows.append(row)

    rows.sort(
        key=lambda row: (
            SWING_PHASE_WEIGHT.get(row.get("phase"), -99),
            row.get("score") or 0,
            row.get("strategy_count") or 0,
        ),
        reverse=True,
    )
    summary = {
        "symbols": len(rows),
        "long": sum(1 for row in rows if row.get("direction") == "LONG"),
        "short": sum(1 for row in rows if row.get("direction") == "SHORT"),
        "neutral": sum(1 for row in rows if row.get("direction") == "NEUTRAL"),
        "ready": sum(1 for row in rows if row.get("phase") == "READY_BREAKOUT"),
        "early": sum(1 for row in rows if row.get("phase") == "EARLY_ACCUMULATION"),
        "live": sum(1 for row in rows if row.get("phase") == "LIVE_MOMENTUM"),
        "pullback": sum(1 for row in rows if row.get("phase") == "PULLBACK_WATCH"),
        "avoid": sum(1 for row in rows if row.get("phase") == "EXTENDED_AVOID"),
    }
    best = next((row for row in rows if row.get("action") in {"PLAN_ENTRY", "BUILD_WATCH", "CONFIRM_TAPE"}), rows[0] if rows else None)
    return {"rows": rows, "best": best, "summary": summary}


def _group_swing_signals(signals: list[dict[str, Any]]) -> dict[str, list[dict]]:
    strategies = _empty_swing_strategies()
    for raw_signal in signals:
        signal = _normalize_swing_signal(raw_signal)
        strategy_key = signal.get("strategy", "")
        if strategy_key in strategies and signal.get("symbol"):
            strategies[strategy_key].append(signal)
    return strategies


def _finalize_swing_response(strategies: dict[str, list[dict]], **extra: Any) -> dict[str, Any]:
    for strategy_signals in strategies.values():
        for signal in strategy_signals:
            signal["research_phase"] = _swing_phase(signal)
        strategy_signals.sort(
            key=lambda s: (s.get("strength", 0), s.get("rr", 0)),
            reverse=True,
        )

    all_signals = []
    for signals in strategies.values():
        all_signals.extend(signals)
    all_signals.sort(
        key=lambda s: (
            s.get("strength", 0),
            s.get("rr", 0),
            -s.get("risk_pct", 99),
        ),
        reverse=True,
    )

    bullish = sum(1 for s in all_signals if s.get("signal") == "BULL")
    bearish = sum(1 for s in all_signals if s.get("signal") == "BEAR")
    best_trade = next(
        (
            s for s in all_signals
            if s.get("quality") in {"A+", "A"}
            and s.get("strength", 0) >= 76
            and s.get("rr", 0) >= 1.8
            and s.get("risk_pct", 99) <= 7.5
        ),
        None,
    )
    radar = _build_swing_radar(all_signals)
    validation = _log_swing_signal_fires(all_signals)

    return {
        "success": True,
        "count": len(all_signals),
        "summary": {
            "total": len(all_signals),
            "bullish": bullish,
            "bearish": bearish,
            "a_plus": sum(1 for s in all_signals if s.get("quality") == "A+"),
            "a": sum(1 for s in all_signals if s.get("quality") == "A"),
        },
        "strategies": strategies,
        "results": all_signals,
        "radar": radar,
        "composite": radar["rows"],
        "best_trade": best_trade,
        "best_swing": radar["best"],
        "no_trade_reason": None if best_trade else "No A/A+ swing setup passed trend, volume, risk, and reward checks.",
        "validation": validation,
        "timestamp": int(time.time() * 1000),
        **extra,
    }


def _warm_swing_quote_symbols(payload: SwingWarmRequest) -> list[str]:
    if payload.symbols:
        return _dedupe_symbols(payload.symbols, limit=500)

    try:
        from app.caches import stock_universes

        source = stock_universes.resolve_universe(payload.universe, limit=500)
    except Exception:
        logger.debug("Could not resolve swing quote universe", exc_info=True)
        source = []

    return _dedupe_symbols(source if payload.scope_mode == "strict" else [*SWING_MOMENTUM_WATCH, *source], limit=500)


async def _fetch_warm_quote_map(kite: KiteConnect, symbols: list[str]) -> dict[str, Any]:
    if not symbols:
        return {}

    quotes: dict[str, Any] = {}
    for idx in range(0, len(symbols), 300):
        batch = [f"NSE:{symbol}" for symbol in symbols[idx : idx + 300]]
        try:
            result = await asyncio.to_thread(kite.quote, batch)
            if isinstance(result, dict):
                quotes.update(result)
        except Exception:
            logger.debug("Swing warm quote prefilter failed for batch %d", idx, exc_info=True)
    return quotes


def _warm_swing_symbols(payload: SwingWarmRequest, quote_map: dict[str, Any] | None = None) -> list[str]:
    limit = max(1, min(int(payload.limit or 120), 500))
    if payload.symbols:
        return _dedupe_symbols(payload.symbols, limit=limit)

    try:
        from app.caches import stock_universes

        source = stock_universes.resolve_universe(payload.universe, limit=500)
    except Exception:
        logger.debug("Could not resolve swing warm universe", exc_info=True)
        source = []

    live_movers = _rank_quote_movers(source, quote_map or {}, max_symbols=min(90, max(20, limit // 2)))
    watch = [] if payload.scope_mode == "strict" else SWING_MOMENTUM_WATCH
    return _dedupe_symbols([*live_movers, *watch, *source], limit=limit)


def _dedupe_symbols(source: list[str] | tuple[str, ...], *, limit: int) -> list[str]:
    symbols: list[str] = []
    seen: set[str] = set()
    for symbol in source:
        clean = str(symbol or "").strip().upper()
        if clean and clean not in seen:
            symbols.append(clean)
            seen.add(clean)
        if len(symbols) >= limit:
            break
    return symbols


def _rank_quote_movers(symbols: list[str], quote_map: dict[str, Any], *, max_symbols: int) -> list[str]:
    scored: list[tuple[float, float, float, int, str]] = []
    for index, symbol in enumerate(symbols):
        quote = _quote_for_symbol(symbol, quote_map)
        if not quote:
            continue

        change_pct = _quote_change_pct(quote)
        volume = _num(quote.get("volume")) or 0.0
        if abs(change_pct) < 1.2 and volume < 250000:
            continue

        ohlc = quote.get("ohlc") or {}
        ltp = _num(quote.get("last_price")) or 0.0
        high = _num(ohlc.get("high")) or ltp
        low = _num(ohlc.get("low")) or ltp
        range_position = 0.5
        if high > low and ltp > 0:
            range_position = max(0.0, min(1.0, (ltp - low) / (high - low)))

        direction_quality = range_position if change_pct >= 0 else 1 - range_position
        score = abs(change_pct) * 10 + min(25.0, volume / 250000) + direction_quality * 8
        scored.append((score, abs(change_pct), volume, -index, symbol))

    scored.sort(reverse=True)
    return [symbol for *_rest, symbol in scored[:max_symbols]]


def _quote_for_symbol(symbol: str, quote_map: dict[str, Any]) -> dict[str, Any] | None:
    value = quote_map.get(f"NSE:{symbol}") or quote_map.get(symbol)
    return value if isinstance(value, dict) else None


def _quote_change_pct(quote: dict[str, Any]) -> float:
    ltp = _num(quote.get("last_price")) or 0.0
    ohlc = quote.get("ohlc") or {}
    prev_close = _num(ohlc.get("close")) or 0.0
    if ltp <= 0 or prev_close <= 0:
        return 0.0
    return (ltp - prev_close) / prev_close * 100


# ── POST /api/scanner/cpr ──────────────────────────────────────────────────

@router.post("/cpr")
async def scan_cpr(
    request: Request,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    CPR multi-timeframe scan.

    Frontend sends:
        { symbols: [
            { symbol, daily: [...candles], weekly?: [...], monthly?: [...], current_price? },
            ...
        ] }

    Returns:
        { results: [ { symbol, total_score, alert_tier, direction, monthly, weekly, daily, ... } ] }
    """
    body_data = await request.json()
    results: list[dict] = []

    try:
        items = _parse_symbols_payload(body_data)

        for item in items:
            if isinstance(item, str):
                # Plain symbol string -- skip, we need OHLC data
                continue

            symbol = item.get("symbol", "")
            daily = item.get("daily", [])
            weekly = item.get("weekly") or []
            monthly = item.get("monthly") or []
            current_price = item.get("current_price")

            if not daily or len(daily) < 5:
                continue

            try:
                from app.engines.cpr.cpr_calculator import (
                    get_cpr_analysis, CPRSequenceResult, CPRDirection,
                )
                from app.engines.cpr.pema_calculator import (
                    compute_pema, PEMAResult, PEMAStack, PEMASlope,
                )
                from app.engines.cpr.signal_scorer import score_symbol

                daily_df = _to_df(daily)
                weekly_df = _to_df(weekly) if weekly else pd.DataFrame()
                monthly_df = _to_df(monthly) if monthly else pd.DataFrame()

                price = current_price or float(daily_df.iloc[-1]["close"])

                def _empty_seq():
                    return CPRSequenceResult(
                        n_periods=0, n_ascending=0, n_descending=0, n_parallel=0,
                        consecutive_ascending=0, consecutive_descending=0,
                        overall_direction=CPRDirection.UNKNOWN,
                        is_long_valid=False, is_short_valid=False,
                        latest_cpr=None, previous_cpr=None,
                    )

                def _empty_pema():
                    return PEMAResult(
                        fast=0, mid=0, slow=0,
                        fast_prev=0, mid_prev=0, slow_prev=0,
                        stack=PEMAStack.TANGLED, slope=PEMASlope.MIXED,
                        fast_slope_pct=0, mid_slope_pct=0, slow_slope_pct=0,
                        pullback_zone_upper=0, pullback_zone_lower=0,
                        is_bullish_stack=False, is_bearish_stack=False,
                        is_rising=False, is_falling=False,
                        price_in_pullback_zone=False,
                        price_below_fast_ema=False, price_above_fast_ema=False,
                    )

                # Compute CPR sequence for each timeframe
                if len(daily_df) >= 5:
                    _, daily_seq = get_cpr_analysis(daily_df)
                else:
                    daily_seq = _empty_seq()

                if not weekly_df.empty and len(weekly_df) >= 3:
                    _, weekly_seq = get_cpr_analysis(weekly_df)
                else:
                    weekly_seq = _empty_seq()

                if not monthly_df.empty and len(monthly_df) >= 3:
                    _, monthly_seq = get_cpr_analysis(monthly_df)
                else:
                    monthly_seq = _empty_seq()

                # Compute PEMA for each timeframe (needs >= 55 rows for the slow EMA)
                daily_pema = compute_pema(daily_df, price) if len(daily_df) >= 55 else _empty_pema()
                weekly_pema = compute_pema(weekly_df, price) if not weekly_df.empty and len(weekly_df) >= 55 else _empty_pema()
                monthly_pema = compute_pema(monthly_df, price) if not monthly_df.empty and len(monthly_df) >= 55 else _empty_pema()

                # Intraday placeholders (we don't have intraday data from this scanner)
                intraday_seq = _empty_seq()
                intraday_pema = _empty_pema()

                signal = score_symbol(
                    symbol=symbol,
                    current_price=price,
                    monthly_seq=monthly_seq,
                    weekly_seq=weekly_seq,
                    daily_seq=daily_seq,
                    monthly_pema=monthly_pema,
                    weekly_pema=weekly_pema,
                    daily_pema=daily_pema,
                    intraday_pema=intraday_pema,
                    intraday_seq=intraday_seq,
                    trigger_15min={"triggered": False},
                )

                # Serialize SignalResult to dict for JSON
                if signal:
                    result_dict = _signal_result_to_dict(signal)
                    results.append(result_dict)

            except Exception as e:
                logger.debug("CPR engine failed for %s: %s, falling back to basic", symbol, e)
                # Fallback: compute basic CPR levels
                try:
                    if daily and len(daily) >= 2:
                        prev = daily[-2]
                        h, l, c = float(prev["high"]), float(prev["low"]), float(prev["close"])
                        pivot = (h + l + c) / 3
                        bc = (h + l) / 2
                        tc = 2 * pivot - bc
                        ltp = current_price or float(daily[-1]["close"])
                        width = abs(tc - bc)
                        width_pct = (width / ltp * 100) if ltp else 0
                        results.append({
                            "symbol": symbol,
                            "current_price": ltp,
                            "total_score": 0,
                            "alert_tier": "None",
                            "direction": "NEUTRAL",
                            "monthly": _empty_tf_detail("monthly"),
                            "weekly": _empty_tf_detail("weekly"),
                            "daily": _empty_tf_detail("daily"),
                            "entry_price": None,
                            "stop_loss": None,
                            "target_1r2": None,
                            "target_1r3": None,
                            "notes": [f"CPR: P={pivot:.2f} BC={min(bc,tc):.2f} TC={max(bc,tc):.2f} Width={width_pct:.2f}%"],
                        })
                except Exception:
                    pass

        results.sort(key=lambda r: abs(r.get("total_score", 0)), reverse=True)
        return _make_response(results)

    except Exception as exc:
        logger.exception("CPR scan error")
        raise HTTPException(status_code=500, detail=str(exc))


def _empty_tf_detail(name: str) -> dict:
    """Return an empty timeframe detail dict matching the frontend interface."""
    return {
        "name": name,
        "total": 0,
        "cpr_direction": "unknown",
        "cpr_width_class": "normal",
        "pema_stack": "tangled",
        "pema_slope": "flat",
        "consecutive_ascending": 0,
        "consecutive_descending": 0,
        "price_vs_cpr": "inside",
        "is_valid_for_long": False,
        "is_valid_for_short": False,
    }


def _signal_result_to_dict(sr) -> dict:
    """Convert a SignalResult dataclass to a JSON-serializable dict matching the frontend."""
    def _tf_to_dict(tf) -> dict:
        return {
            "name": tf.name if hasattr(tf, "name") else "",
            "total": tf.total if hasattr(tf, "total") else 0,
            "cpr_direction": tf.cpr_direction.value if hasattr(tf.cpr_direction, "value") else str(tf.cpr_direction),
            "cpr_width_class": tf.cpr_width_class.value if hasattr(tf.cpr_width_class, "value") else str(tf.cpr_width_class),
            "pema_stack": tf.pema_stack.value if hasattr(tf.pema_stack, "value") else str(tf.pema_stack),
            "pema_slope": tf.pema_slope.value if hasattr(tf.pema_slope, "value") else str(tf.pema_slope),
            "consecutive_ascending": tf.consecutive_ascending if hasattr(tf, "consecutive_ascending") else 0,
            "consecutive_descending": tf.consecutive_descending if hasattr(tf, "consecutive_descending") else 0,
            "price_vs_cpr": tf.price_vs_cpr if hasattr(tf, "price_vs_cpr") else "inside",
            "is_valid_for_long": tf.is_valid_for_long if hasattr(tf, "is_valid_for_long") else False,
            "is_valid_for_short": tf.is_valid_for_short if hasattr(tf, "is_valid_for_short") else False,
        }

    return {
        "symbol": sr.symbol,
        "current_price": sr.current_price,
        "total_score": sr.total_score,
        "alert_tier": sr.alert_tier.value if hasattr(sr.alert_tier, "value") else str(sr.alert_tier),
        "direction": sr.direction.value if hasattr(sr.direction, "value") else str(sr.direction),
        "monthly": _tf_to_dict(sr.monthly),
        "weekly": _tf_to_dict(sr.weekly),
        "daily": _tf_to_dict(sr.daily),
        "entry_price": sr.entry_price,
        "stop_loss": sr.stop_loss,
        "target_1r2": sr.target_1r2,
        "target_1r3": sr.target_1r3,
        "notes": sr.notes if hasattr(sr, "notes") else [],
    }


# ── POST /api/scanner/patterns ─────────────────────────────────────────────

@router.post("/patterns")
async def scan_patterns(
    request: Request,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Pattern detection scan.

    Frontend sends:
        { symbols: [
            { symbol, daily: [...candles], weekly?: [...], lookback?: 60, min_confidence?: 40 },
            ...
        ] }

    Returns:
        { results: [ { symbol, current_price, pattern_count, patterns: [...] } ] }
    """
    body_data = await request.json()
    results: list[dict] = []

    try:
        items = _parse_symbols_payload(body_data)

        for item in items:
            if isinstance(item, str):
                continue

            symbol = item.get("symbol", "")
            daily = item.get("daily", [])
            weekly = item.get("weekly")
            lookback = item.get("lookback", 60)
            min_confidence = item.get("min_confidence", 40)

            if not daily or len(daily) < 20:
                continue

            try:
                from app.engines.cpr.pattern_detector import scan_patterns as engine_scan_patterns, pattern_to_dict

                daily_df = _to_df(daily)
                current_price = float(daily_df.iloc[-1]["close"])

                # Scan daily patterns
                all_patterns = []
                detected = engine_scan_patterns(
                    daily_df,
                    lookback=lookback,
                    min_confidence=min_confidence,
                )
                for p in detected:
                    d = pattern_to_dict(p)
                    d["timeframe"] = "daily"
                    all_patterns.append(d)

                # Scan weekly patterns if provided
                if weekly:
                    weekly_df = _to_df(weekly)
                    if len(weekly_df) >= 20:
                        weekly_detected = engine_scan_patterns(
                            weekly_df,
                            lookback=min(lookback, len(weekly_df)),
                            swing_window=3,
                            min_confidence=min_confidence,
                        )
                        for p in weekly_detected:
                            d = pattern_to_dict(p)
                            d["timeframe"] = "weekly"
                            all_patterns.append(d)

                # Sort by confidence descending
                all_patterns.sort(key=lambda x: x.get("confidence", 0), reverse=True)

                results.append({
                    "symbol": symbol,
                    "current_price": current_price,
                    "pattern_count": len(all_patterns),
                    "patterns": all_patterns,
                })

            except Exception as e:
                logger.debug("Pattern scan failed for %s: %s, using fallback", symbol, e)
                # Fallback: return empty patterns for this symbol
                try:
                    daily_df = _to_df(daily)
                    current_price = float(daily_df.iloc[-1]["close"]) if len(daily_df) > 0 else 0
                    results.append({
                        "symbol": symbol,
                        "current_price": current_price,
                        "pattern_count": 0,
                        "patterns": [],
                    })
                except Exception:
                    pass

        return _make_response(results)

    except Exception as exc:
        logger.exception("Pattern scan error")
        raise HTTPException(status_code=500, detail=str(exc))


# ── POST /api/scanner/vcp ──────────────────────────────────────────────────

@router.post("/vcp")
async def scan_vcp(
    request: Request,
    user: dict = Depends(require_premium),
) -> dict:
    """
    VCP (Volatility Contraction Pattern) scan.

    Frontend sends:
        { symbols: [
            { symbol, daily: [...candles], index_change_pct? },
            ...
          ],
          index_change_pct?: float
        }

    Returns:
        { results: [ { symbol, current_price, vcp_score, stage, ... } ] }
    """
    body_data = await request.json()
    results: list[dict] = []

    try:
        items = _parse_symbols_payload(body_data)
        # Top-level index_change_pct (sent by frontend)
        top_index_change = body_data.get("index_change_pct", 0) if isinstance(body_data, dict) else 0

        for item in items:
            if isinstance(item, str):
                continue

            symbol = item.get("symbol", "")
            daily = item.get("daily", [])
            index_change_pct = item.get("index_change_pct", top_index_change)

            if not daily or len(daily) < 50:
                continue

            try:
                from app.engines.cpr.vcp_detector import analyze_vcp, vcp_result_to_dict

                daily_df = _to_df(daily)

                vcp = analyze_vcp(
                    df=daily_df,
                    symbol=symbol,
                    index_change_pct=index_change_pct,
                )
                results.append(vcp_result_to_dict(vcp))

            except Exception as e:
                logger.debug("VCP scan failed for %s: %s, using fallback", symbol, e)
                # Fallback: return basic result
                try:
                    daily_df = _to_df(daily)
                    current_price = float(daily_df.iloc[-1]["close"]) if len(daily_df) > 0 else 0
                    results.append({
                        "symbol": symbol,
                        "current_price": current_price,
                        "vcp_score": 0,
                        "stage": "Not Ready",
                        "vcp_detected": False,
                        "trend_template_pass": False,
                        "price_above_150ma": False,
                        "price_above_200ma": False,
                        "ma150_above_200ma": False,
                        "ma200_rising": False,
                        "pct_from_52w_high": 0,
                        "pct_from_52w_low": 0,
                        "num_contractions": 0,
                        "contractions": [],
                        "volume_declining": False,
                        "tightening": False,
                        "pivot_price": current_price,
                        "pivot_distance_pct": 0,
                        "pivot_tight_range_pct": 0,
                        "rs_vs_index": 0,
                        "notes": [f"VCP analysis fallback: {e}"],
                    })
                except Exception:
                    pass

        # Sort by vcp_score descending
        results.sort(key=lambda r: r.get("vcp_score", 0), reverse=True)
        return _make_response(results)

    except Exception as exc:
        logger.exception("VCP scan error")
        raise HTTPException(status_code=500, detail=str(exc))


# ── POST /api/scanner/nr-squeeze ───────────────────────────────────────────

@router.post("/nr-squeeze")
async def scan_nr_squeeze(
    request: Request,
    user: dict = Depends(require_premium),
) -> dict:
    """
    NR4/NR7 + Inside Bar + BB Squeeze scan.

    Frontend sends:
        { symbols: [
            { symbol, daily: [...candles] },
            ...
        ] }

    Returns:
        { results: [ { symbol, current_price, is_nr4, is_nr7, squeeze_score, ... } ] }
    """
    body_data = await request.json()
    results: list[dict] = []

    try:
        items = _parse_symbols_payload(body_data)

        for item in items:
            if isinstance(item, str):
                continue

            symbol = item.get("symbol", "")
            daily = item.get("daily", [])

            if not daily or len(daily) < 10:
                continue

            try:
                from app.engines.cpr.nr_squeeze import analyze_nr_squeeze, nr_result_to_dict

                daily_df = _to_df(daily)

                nr = analyze_nr_squeeze(
                    df=daily_df,
                    symbol=symbol,
                )
                results.append(nr_result_to_dict(nr))

            except Exception as e:
                logger.debug("NR squeeze failed for %s: %s, using fallback", symbol, e)
                try:
                    daily_df = _to_df(daily)
                    current_price = float(daily_df.iloc[-1]["close"]) if len(daily_df) > 0 else 0
                    last_bar = daily[-1]
                    bar_high = float(last_bar.get("high", current_price))
                    bar_low = float(last_bar.get("low", current_price))
                    bar_range = bar_high - bar_low
                    results.append({
                        "symbol": symbol,
                        "current_price": current_price,
                        "is_nr4": False,
                        "is_nr7": False,
                        "is_inside_bar": False,
                        "nr_bar_high": bar_high,
                        "nr_bar_low": bar_low,
                        "nr_bar_range": round(bar_range, 2),
                        "nr_bar_range_pct": round(bar_range / current_price * 100, 2) if current_price else 0,
                        "avg_range_7d": 0,
                        "bb_squeeze": False,
                        "bb_width_pct": 0,
                        "bb_width_percentile": 50,
                        "direction": "neutral",
                        "close_position": 0.5,
                        "trend_bias": "flat",
                        "volume_signal": "normal",
                        "buy_above": bar_high,
                        "sell_below": bar_low,
                        "long_sl": bar_low,
                        "short_sl": bar_high,
                        "long_target": round(bar_high + bar_range * 2, 2),
                        "short_target": round(bar_low - bar_range * 2, 2),
                        "squeeze_score": 0,
                        "squeeze_type": "None",
                        "notes": [f"NR analysis fallback: {e}"],
                    })
                except Exception:
                    pass

        # Sort by squeeze_score descending
        results.sort(key=lambda r: r.get("squeeze_score", 0), reverse=True)
        return _make_response(results)

    except Exception as exc:
        logger.exception("NR squeeze scan error")
        raise HTTPException(status_code=500, detail=str(exc))


# ── POST /api/scanner/volume-profile ───────────────────────────────────────

@router.post("/volume-profile")
async def scan_volume_profile(
    request: Request,
    user: dict = Depends(require_premium),
) -> dict:
    """
    Volume Profile scan.

    Frontend sends:
        { symbols: [
            { symbol, daily: [...candles], lookback?: 30 },
            ...
        ] }

    Returns:
        { results: [ { symbol, current_price, poc, vah, val, signal, ... } ] }
    """
    body_data = await request.json()
    results: list[dict] = []

    try:
        items = _parse_symbols_payload(body_data)

        for item in items:
            if isinstance(item, str):
                continue

            symbol = item.get("symbol", "")
            daily = item.get("daily", [])
            lookback = item.get("lookback", 30)

            if not daily or len(daily) < 10:
                continue

            try:
                from app.engines.cpr.volume_profile import analyze_volume_profile, vp_result_to_dict
                from app.engines.cpr.cpr_calculator import compute_cpr_level

                daily_df = _to_df(daily)
                current_price = float(daily_df.iloc[-1]["close"])

                # Compute CPR pivot for confluence check
                if len(daily_df) >= 2:
                    prev = daily_df.iloc[-2]
                    cpr = compute_cpr_level(
                        date=prev.get("date", pd.Timestamp.now()),
                        high=float(prev["high"]),
                        low=float(prev["low"]),
                        close=float(prev["close"]),
                    )
                    cpr_pivot = cpr.pivot
                    cpr_tc = cpr.tc
                    cpr_bc = cpr.bc
                else:
                    cpr_pivot = cpr_tc = cpr_bc = 0

                vp = analyze_volume_profile(
                    df=daily_df,
                    symbol=symbol,
                    lookback=lookback,
                    cpr_pivot=cpr_pivot,
                    cpr_tc=cpr_tc,
                    cpr_bc=cpr_bc,
                )
                results.append(vp_result_to_dict(vp))

            except Exception as e:
                logger.debug("Volume profile failed for %s: %s, using fallback", symbol, e)
                try:
                    daily_df = _to_df(daily)
                    current_price = float(daily_df.iloc[-1]["close"]) if len(daily_df) > 0 else 0
                    results.append({
                        "symbol": symbol,
                        "current_price": current_price,
                        "poc": current_price,
                        "vah": current_price,
                        "val": current_price,
                        "price_vs_profile": "at_poc",
                        "distance_to_poc_pct": 0,
                        "total_volume": 0,
                        "profile_high": current_price,
                        "profile_low": current_price,
                        "poc_near_cpr_pivot": False,
                        "vah_near_cpr_tc": False,
                        "val_near_cpr_bc": False,
                        "signal": "neutral",
                        "signal_strength": 0,
                        "notes": [f"Volume profile fallback: {e}"],
                    })
                except Exception:
                    pass

        # Sort by signal_strength descending
        results.sort(key=lambda r: r.get("signal_strength", 0), reverse=True)
        return _make_response(results)

    except Exception as exc:
        logger.exception("Volume profile scan error")
        raise HTTPException(status_code=500, detail=str(exc))


# ── POST /api/scanner/swing ────────────────────────────────────────────────

@router.post("/swing/warm")
async def warm_swing_snapshot(
    payload: SwingWarmRequest | None = Body(default=None),
    kite: KiteConnect = Depends(get_kite),
    user: dict = Depends(require_premium),
) -> dict:
    """
    Warm the Swing Spectrum replay snapshot server-side.

    This avoids relying on a long browser-driven OHLC fetch before a trader can
    see the last-good swing list outside active market hours.
    """
    request_payload = payload or SwingWarmRequest()
    quote_map = (
        {}
        if request_payload.symbols
        else await _fetch_warm_quote_map(kite, _warm_swing_quote_symbols(request_payload))
    )
    symbols = _warm_swing_symbols(request_payload, quote_map=quote_map)
    if not symbols:
        raise HTTPException(status_code=400, detail="No symbols available for Swing warm scan.")

    try:
        from app.services.scanner_service import scan_swing as service_scan_swing

        raw_signals = await service_scan_swing(kite, symbols)
        response = _finalize_swing_response(
            _group_swing_signals(raw_signals),
            source="server_warm",
            universe=request_payload.universe,
            scannedSymbols=len(symbols),
            scope={"version": 1, "universe": request_payload.universe,
                   "mode": "custom" if request_payload.symbols else request_payload.scope_mode,
                   "attempted_symbols": symbols, "attempted_count": len(symbols)},
        )
        save_session("swing_spectrum", response)
        return response
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Swing warm scan error")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/swing")
async def scan_swing(
    request: Request,
    user: dict = Depends(require_premium),
) -> dict:
    """
    Swing signal detection scan.

    Frontend sends:
        {
          symbols: [
              { symbol, daily: [...candles] },
              ...
          ],
          benchmark: [...Nifty 500 candles],
        }

    Returns:
        {
          count: N,
          summary: { total, bullish, bearish },
          strategies: {
            "MOMENTUM_BURST": [...signals],
            "10D_BO": [...signals],
            "50D_BO": [...signals],
            "REVERSAL": [...signals],
            "CHANNEL_BO": [...signals],
          }
        }
    """
    body_data = await request.json()

    strategies: dict[str, list[dict]] = _empty_swing_strategies()

    try:
        items = _parse_symbols_payload(body_data)
        benchmark_daily_df = pd.DataFrame()
        if isinstance(body_data, dict):
            benchmark_daily_df = _to_df(body_data.get("benchmark", []))

        for item in items:
            if isinstance(item, str):
                continue

            symbol = item.get("symbol", "")
            daily = item.get("daily", [])

            if not daily or len(daily) < 15:
                continue

            try:
                from app.engines.cpr.swing_detector import scan_swing_spectrum, swing_signal_to_dict

                daily_df = _to_df(daily)

                signals = scan_swing_spectrum(
                    daily_df,
                    symbol,
                    benchmark_df=benchmark_daily_df,
                )
                for sig in signals:
                    d = swing_signal_to_dict(sig)
                    strategy_key = d.get("strategy", "")
                    if strategy_key in strategies:
                        strategies[strategy_key].append(d)

            except Exception as e:
                logger.debug("Swing scan failed for %s: %s", symbol, e)
                # Fallback: basic breakout detection
                try:
                    daily_df = _to_df(daily)
                    if len(daily_df) >= 11:
                        current = daily_df.iloc[-1]
                        close = float(current["close"])
                        prev_close = float(daily_df.iloc[-2]["close"])
                        change_pct = ((close - prev_close) / prev_close * 100) if prev_close else 0
                        high_10d = float(daily_df["high"].iloc[-11:-1].max())
                        low_10d = float(daily_df["low"].iloc[-11:-1].min())

                        if close > high_10d:
                            strategies["10D_BO"].append({
                                "symbol": symbol,
                                "strategy": "10D_BO",
                                "signal": "BULL",
                                "current_price": round(close, 2),
                                "change_pct": round(change_pct, 2),
                                "trigger_date": str(current.get("date", ""))[:10],
                                "breakout_level": round(high_10d, 2),
                                "stop_loss": round(float(current["low"]), 2),
                                "target": round(close + (close - float(current["low"])) * 2, 2),
                                "strength": 50,
                                "notes": f"Broke above 10-day high {high_10d:.2f}",
                            })
                        elif close < low_10d:
                            strategies["10D_BO"].append({
                                "symbol": symbol,
                                "strategy": "10D_BO",
                                "signal": "BEAR",
                                "current_price": round(close, 2),
                                "change_pct": round(change_pct, 2),
                                "trigger_date": str(current.get("date", ""))[:10],
                                "breakout_level": round(low_10d, 2),
                                "stop_loss": round(float(current["high"]), 2),
                                "target": round(close - (float(current["high"]) - close) * 2, 2),
                                "strength": 50,
                                "notes": f"Broke below 10-day low {low_10d:.2f}",
                            })
                except Exception:
                    pass

        response = _finalize_swing_response(
            strategies, source="browser_payload",
            scope={"version": 1, "universe": str(body_data.get("universe") or "custom") if isinstance(body_data, dict) else "custom",
                   "mode": str(body_data.get("scope_mode") or "custom") if isinstance(body_data, dict) else "custom",
                   "attempted_symbols": [str(item.get("symbol") or "").upper() for item in items if isinstance(item, dict)],
                   "attempted_count": len(items)},
        )
        save_session("swing_spectrum", response)
        return response

    except Exception as exc:
        logger.exception("Swing scan error")
        raise HTTPException(status_code=500, detail=str(exc))
