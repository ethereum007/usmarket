"""Premium intraday retracement-breakout detection on the shared Runner feed."""

from __future__ import annotations

import asyncio
import logging
from copy import deepcopy
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from app.config import settings
from app.core.kite_client import kite_state
from app.core.session_cache import is_market_hours, load_session
from app.core.supabase_client import get_supabase_client
from app.engines.runner.providers import KiteProvider
from app.engines.runner.schemas import MinuteBar
from app.services.provider_gateway import provider_gateway
from app.services.runner_service import runner_service
from app.services.intraday_monitoring import MONITOR_SESSION_KEY
from app.services.intraday_entry_assessment import assess_entry, complete_session, timestamp
from app.services.intraday_events import event_envelope, event_records, previous_day_events, retracement_events

logger = logging.getLogger("alpha_radar.intraday_breakouts")
IST = ZoneInfo("Asia/Kolkata")
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)
FIVE_MINUTES = 5
FIFTEEN_MINUTES = 15
DEFINITION_VERSION = "intraday-retracement-v3"
HISTORY_RESYNC_SECONDS = 180


def can_evaluate_session(now: datetime) -> bool:
    """Allow live evaluation and same-day post-market history backfill."""
    local = now.astimezone(IST) if now.tzinfo else now.replace(tzinfo=IST)
    return local.weekday() < 5 and local.time() >= MARKET_OPEN


def aggregate_bars(
    bars: Iterable[dict[str, Any]],
    timeframe_minutes: int,
    *,
    require_source_bars: int | None = None,
) -> list[dict[str, Any]]:
    """Aggregate timestamped OHLCV rows into NSE-session-aligned candles."""
    grouped: dict[datetime, list[dict[str, Any]]] = {}
    for raw in bars:
        stamp = _as_ist(raw.get("bar_start") or raw.get("minute_timestamp"))
        if stamp is None or stamp.time() < MARKET_OPEN or stamp.time() >= MARKET_CLOSE:
            continue
        open_at = datetime.combine(stamp.date(), MARKET_OPEN, IST)
        elapsed = int((stamp - open_at).total_seconds() // 60)
        if elapsed < 0:
            continue
        bucket = open_at + timedelta(
            minutes=(elapsed // timeframe_minutes) * timeframe_minutes
        )
        grouped.setdefault(bucket, []).append(raw)

    result: list[dict[str, Any]] = []
    for bucket, rows in sorted(grouped.items()):
        rows.sort(
            key=lambda row: _as_ist(
                row.get("bar_start") or row.get("minute_timestamp")
            )
            or bucket
        )
        if require_source_bars is not None and len(rows) < require_source_bars:
            continue
        result.append(
            {
                "bar_start": bucket,
                "open": float(rows[0]["open"]),
                "high": max(float(row["high"]) for row in rows),
                "low": min(float(row["low"]) for row in rows),
                "close": float(rows[-1]["close"]),
                "volume": sum(int(row.get("volume") or 0) for row in rows),
                "source_bar_count": len(rows),
            }
        )
    return result


def detect_retracement_breakout(
    bars: list[dict[str, Any]], timeframe_minutes: int
) -> dict[str, Any] | None:
    """Find the first green close above every prior high after a red pullback.

    An advance must exist before the red candle. Requiring the breakout candle
    to close above every earlier intraday candle high avoids a transient wick.
    """
    if len(bars) < 3:
        return None
    ordered = sorted(bars, key=lambda row: row["bar_start"])
    session_open = float(ordered[0]["open"])
    prior_high = float(ordered[0]["high"])
    saw_advance = (
        float(ordered[0]["close"]) > float(ordered[0]["open"])
        and float(ordered[0]["close"]) > session_open
    )
    retracement: dict[str, Any] | None = None

    for bar in ordered[1:]:
        open_ = float(bar["open"])
        close = float(bar["close"])
        high = float(bar["high"])
        if saw_advance and close < open_:
            retracement = bar
        elif (
            retracement is not None
            and close > open_
            and close > prior_high
            and bar["bar_start"] > retracement["bar_start"]
        ):
            return {
                "timeframe_minutes": timeframe_minutes,
                "signal_time": bar["bar_start"] + timedelta(minutes=timeframe_minutes),
                "trigger_price": close,
                "prior_intraday_high": prior_high,
                "retracement_bar_start": retracement["bar_start"],
            }
        if close > session_open and close > open_:
            saw_advance = True
        prior_high = max(prior_high, high)
    return None


def detect_previous_day_high_break(
    bars: list[dict[str, Any]], previous_day_high: float | None
) -> dict[str, Any] | None:
    if not previous_day_high or previous_day_high <= 0:
        return None
    for bar in sorted(bars, key=lambda row: row["bar_start"]):
        if float(bar["close"]) > previous_day_high:
            return {
                "timeframe_minutes": 0,
                "signal_time": bar["bar_start"] + timedelta(minutes=FIVE_MINUTES),
                "trigger_price": float(bar["close"]),
                "previous_day_high": previous_day_high,
            }
    return None


def detect_retracement_breakdown(
    bars: list[dict[str, Any]], timeframe_minutes: int
) -> dict[str, Any] | None:
    """Find the first red close below every prior low after a green pullback."""
    if len(bars) < 3:
        return None
    ordered = sorted(bars, key=lambda row: row["bar_start"])
    session_open = float(ordered[0]["open"])
    prior_low = float(ordered[0]["low"])
    saw_decline = (
        float(ordered[0]["close"]) < float(ordered[0]["open"])
        and float(ordered[0]["close"]) < session_open
    )
    retracement: dict[str, Any] | None = None
    for bar in ordered[1:]:
        open_ = float(bar["open"])
        close = float(bar["close"])
        low = float(bar["low"])
        if saw_decline and close > open_:
            retracement = bar
        elif (
            retracement is not None
            and close < open_
            and close < prior_low
            and bar["bar_start"] > retracement["bar_start"]
        ):
            return {
                "timeframe_minutes": timeframe_minutes,
                "signal_time": bar["bar_start"] + timedelta(minutes=timeframe_minutes),
                "trigger_price": close,
                "prior_intraday_low": prior_low,
                "retracement_bar_start": retracement["bar_start"],
            }
        if close < session_open and close < open_:
            saw_decline = True
        prior_low = min(prior_low, low)
    return None


def detect_previous_day_low_break(
    bars: list[dict[str, Any]], previous_day_low: float | None
) -> dict[str, Any] | None:
    if not previous_day_low or previous_day_low <= 0:
        return None
    for bar in sorted(bars, key=lambda row: row["bar_start"]):
        if float(bar["close"]) < previous_day_low:
            return {
                "timeframe_minutes": 0,
                "signal_time": bar["bar_start"] + timedelta(minutes=FIVE_MINUTES),
                "trigger_price": float(bar["close"]),
                "previous_day_low": previous_day_low,
            }
    return None


class IntradayBreakoutService:
    """Tracks bullish Radar setups and F&O-only bearish setups."""

    def __init__(self, client_factory=get_supabase_client) -> None:
        self._client_factory = client_factory
        self._session_date: date | None = None
        self._bars: dict[str, dict[datetime, dict[str, Any]]] = {}
        self._signals: dict[tuple[str, str], dict[str, Any]] = {}
        self._candidate_meta: dict[str, dict[str, Any]] = {}
        self._history_synced_at: dict[str, datetime] = {}
        self._fno_symbols: set[str] = set()
        self._fno_loaded_at: datetime | None = None
        self._lock = asyncio.Lock()
        self._started = False
        self._last_refreshed_at: datetime | None = None
        self._last_failed_at: datetime | None = None
        self._last_good_snapshot: dict[str, Any] | None = None
        self._last_error: str | None = None
        self._symbol_errors: dict[str, str] = {}
        self._database_available = True
        self._coverage: dict[str, Any] = {}
        self._pending_signal_writes: set[tuple[str, str]] = set()

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        now = datetime.now(IST)
        await self._begin_session(now.date())
        if can_evaluate_session(now):
            await self.refresh()

    async def stop(self) -> None:
        self._started = False

    async def refresh(self) -> dict[str, Any]:
        async with self._lock:
            now = datetime.now(IST)
            state_before = {
                "session_date": self._session_date,
                "bars": deepcopy(self._bars),
                "signals": deepcopy(self._signals),
                "candidate_meta": deepcopy(self._candidate_meta),
                "history_synced_at": deepcopy(self._history_synced_at),
                "fno_symbols": set(self._fno_symbols),
                "fno_loaded_at": self._fno_loaded_at,
                "last_refreshed_at": self._last_refreshed_at,
                "symbol_errors": deepcopy(self._symbol_errors),
                "coverage": deepcopy(self._coverage),
                "pending_signal_writes": set(self._pending_signal_writes),
            }
            try:
                if self._session_date != now.date():
                    await self._begin_session(now.date())
                if not can_evaluate_session(now):
                    self._last_refreshed_at = now
                    self._last_error = None
                    self._last_failed_at = None
                    return self._record_good_snapshot(self._snapshot_unlocked(now))

                candidates = await self._tracked_candidates(now)
                self._candidate_meta = {row["symbol"]: row for row in candidates}
                # Keep evaluating outcomes after a name leaves the current shortlist.
                # Stored signal direction must survive a later Radar bias change.
                for (symbol, _), signal in self._signals.items():
                    if symbol not in self._candidate_meta:
                        prior = state_before["candidate_meta"].get(symbol) or (signal.get("metadata") or {}).get("radarContext") or {}
                        self._candidate_meta[symbol] = {**prior, "symbol": symbol, "monitorOnly": True}
                symbols = list(self._candidate_meta)

                hydrate = sorted(
                    (symbol for symbol in symbols if self._needs_history_sync(symbol, now)),
                    key=lambda symbol: (
                        # Round-robin attempts: one unavailable symbol must not
                        # monopolize the bounded history budget for a broad universe.
                        self._history_synced_at.get(symbol, datetime.min.replace(tzinfo=IST)),
                    ),
                )[: settings.INTRADAY_BREAKOUT_HISTORY_FETCHES_PER_CYCLE]
                for symbol in hydrate:
                    await self._hydrate_symbol(symbol, now)

                changed_rows: list[dict[str, Any]] = []
                new_signals: list[dict[str, Any]] = []
                symbol_errors: dict[str, str] = {}
                for symbol in symbols:
                    try:
                        changed_rows.extend(self._merge_runner_bars(symbol, now))
                        if not self._candidate_meta[symbol].get("monitorOnly") and complete_session(list(self._bars.get(symbol, {}).values()), now):
                            new_signals.extend(self._detect_symbol_signals(symbol))
                    except Exception as exc:
                        symbol_errors[symbol] = type(exc).__name__
                        logger.warning(
                            "Intraday symbol evaluation skipped symbol=%s error_type=%s",
                            symbol,
                            type(exc).__name__,
                            exc_info=True,
                        )

                self._symbol_errors = symbol_errors

                if changed_rows:
                    await self._persist_candles(changed_rows)
                self._pending_signal_writes.update((row["symbol"], row["signal_type"]) for row in new_signals)
                if self._pending_signal_writes:
                    pending = [self._signals[key] for key in self._pending_signal_writes]
                    if await self._persist_signals(pending):
                        self._pending_signal_writes.clear()
                self._last_refreshed_at = now
                self._last_error = None
                self._last_failed_at = None
                return self._record_good_snapshot(self._snapshot_unlocked(now))
            except Exception as exc:
                self._session_date = state_before["session_date"]
                self._bars = state_before["bars"]
                self._signals = state_before["signals"]
                self._candidate_meta = state_before["candidate_meta"]
                self._history_synced_at = state_before["history_synced_at"]
                self._fno_symbols = state_before["fno_symbols"]
                self._fno_loaded_at = state_before["fno_loaded_at"]
                self._last_refreshed_at = state_before["last_refreshed_at"]
                self._symbol_errors = state_before["symbol_errors"]
                self._coverage = state_before["coverage"]
                self._pending_signal_writes = state_before["pending_signal_writes"]
                self._last_error = f"{type(exc).__name__}: {str(exc)[:140]}"
                self._last_failed_at = now
                logger.exception("Intraday refresh failed; serving the latest complete snapshot")
                return self._degraded_snapshot(now)

    async def snapshot(self, *, refresh_if_stale: bool = True) -> dict[str, Any]:
        now = datetime.now(IST)
        stale = (
            self._last_refreshed_at is None
            or (now - self._last_refreshed_at).total_seconds()
            > max(45, settings.INTRADAY_BREAKOUT_REFRESH_SECONDS * 2)
        )
        if refresh_if_stale and stale and can_evaluate_session(now):
            return await self.refresh()
        async with self._lock:
            return self._snapshot_unlocked(now)

    def _record_good_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        payload["stale"] = False
        payload.setdefault("dataQuality", {}).update(
            {"stale": False, "lastFailedAt": None}
        )
        self._last_good_snapshot = deepcopy(payload)
        return payload

    def _degraded_snapshot(self, now: datetime) -> dict[str, Any]:
        if self._last_good_snapshot is not None:
            payload = deepcopy(self._last_good_snapshot)
        else:
            payload = {
                "success": True,
                "status": "DEGRADED",
                "sessionDate": self._session_date.isoformat()
                if self._session_date
                else now.date().isoformat(),
                "timestamp": int(now.timestamp() * 1000),
                "generatedAt": None,
                "marketHours": is_market_hours(),
                "summary": {
                    "bullishTracked": 0,
                    "bearishFnoTracked": 0,
                    "signalCandidates": 0,
                    "bullishSignals": 0,
                    "bearishSignals": 0,
                    "fiveMinute": 0,
                    "fifteenMinute": 0,
                    "previousDayHigh": 0,
                    "previousDayLow": 0,
                },
                "candidates": [],
                "dataQuality": {},
                "method": {},
            }
        payload["status"] = "DEGRADED"
        payload["stale"] = True
        payload["timestamp"] = int(now.timestamp() * 1000)
        payload["marketHours"] = is_market_hours()
        for candidate in payload.get("candidates", []):
            for signal in [*candidate.get("signals", []), *candidate.get("events", [])]:
                if signal.get("entryAssessment"):
                    signal["entryAssessment"].update({
                        "status": "DATA_CHECK", "reason": "Live refresh failed; entry checks are unavailable.",
                    })
        payload.setdefault("dataQuality", {}).update(
            {
                "stale": True,
                "lastError": self._last_error,
                "lastFailedAt": self._last_failed_at.isoformat()
                if self._last_failed_at
                else None,
            }
        )
        return payload

    async def _begin_session(self, session_date: date) -> None:
        self._session_date = session_date
        self._bars.clear()
        self._signals.clear()
        self._candidate_meta.clear()
        self._history_synced_at.clear()
        self._symbol_errors.clear()
        self._coverage.clear()
        self._pending_signal_writes.clear()
        await self._delete_prior_candles(session_date)
        await self._load_session(session_date)

    def _bullish_candidates(self) -> list[dict[str, Any]]:
        cached = self._radar_candidates_session()
        cached_at = _as_ist(cached.get("timestamp"))
        if (
            cached_at is not None
            and self._session_date is not None
            and cached_at.date() != self._session_date
        ):
            return []
        response = cached.get("data") or {}
        candidates = [
            row
            for row in response.get("candidates", [])
            if isinstance(row, dict)
            and str(row.get("bias") or "").upper() == "LONG"
            and row.get("symbol")
        ]
        candidates.sort(
            key=lambda row: (
                _float(row.get("score")) or 0,
                _float(row.get("volRatio")) or 0,
            ),
            reverse=True,
        )
        clean: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in candidates:
            symbol = str(row["symbol"]).strip().upper()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            clean.append({**row, "symbol": symbol})
        return clean

    def _radar_candidates_session(self) -> dict[str, Any]:
        """Prefer the full scan; explicitly identify legacy, truncated fallbacks."""
        for key in (MONITOR_SESSION_KEY, "intraday_radar_broad_nifty500", "intraday_radar"):
            cached = load_session(key)
            if not cached:
                continue
            stamp = timestamp((cached.get("data") or {}).get("timestamp") or cached.get("timestamp"))
            if stamp and self._session_date and stamp.date() != self._session_date:
                continue
            return {**cached, "sourceKey": key}
        return {}

    async def _tracked_candidates(self, now: datetime) -> list[dict[str, Any]]:
        cached = self._radar_candidates_session()
        response = cached.get("data") or {}
        all_rows = [row for row in response.get("candidates", []) if isinstance(row, dict)]
        bullish = self._clean_candidates([row for row in all_rows if str(row.get("bias") or "").upper() == "LONG"], 500)
        await self._load_fno_symbols(now)
        bearish = self._clean_candidates(
            [
                row for row in all_rows
                if str(row.get("bias") or "").upper() == "SHORT"
                and str(row.get("symbol") or "").strip().upper() in self._fno_symbols
            ],
            500,
        )
        rows = bearish + [row for row in bullish if row["symbol"] not in {item["symbol"] for item in bearish}]
        radar_at = response.get("timestamp") or cached.get("timestamp")
        self._coverage = {
            "universe": "Radar fallback", "requested": None, "quoted": None,
            "missingQuotes": None, "ranked": len(all_rows), "fullScan": False,
            **(response.get("coverage") or {}),
            "source": cached.get("sourceKey"), "radarAsOf": radar_at,
            "eligible": len(rows), "bullish": len(bullish), "bearishFno": len(bearish),
            "excludedCashShorts": len({str(row.get("symbol") or "").strip().upper() for row in all_rows
                                       if str(row.get("bias") or "").upper() == "SHORT"
                                       and str(row.get("symbol") or "").strip().upper() not in self._fno_symbols}),
        }
        return [{**row, "radarAsOf": row.get("radarAsOf") or radar_at} for row in rows]

    def _clean_candidates(self, rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
        rows.sort(
            key=lambda row: (
                _float(row.get("score")) or 0,
                _float(row.get("volRatio")) or 0,
            ),
            reverse=True,
        )
        clean: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            symbol = str(row.get("symbol") or "").strip().upper()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            clean.append({**row, "symbol": symbol})
            if len(clean) >= limit:
                break
        return clean

    async def _load_fno_symbols(self, now: datetime) -> None:
        if self._fno_loaded_at and (now - self._fno_loaded_at).total_seconds() < 3600:
            return
        if not self._fno_symbols:
            try:
                from app.caches.stock_universes import FNO_STOCKS
                self._fno_symbols = {str(symbol).upper() for symbol in FNO_STOCKS}
            except ImportError:
                pass
        if not kite_state.is_connected or kite_state.kite is None:
            return
        try:
            instruments = await asyncio.to_thread(kite_state.kite.instruments, "NFO")
            self._fno_symbols = {
                str(row.get("name") or "").strip().upper()
                for row in instruments
                if row.get("instrument_type") == "FUT"
                and row.get("segment") == "NFO-FUT"
                and row.get("name")
            }
            self._fno_loaded_at = now
        except Exception as exc:
            logger.warning("Could not refresh F&O universe for intraday breakdowns: %s", exc)

    def _needs_history_sync(self, symbol: str, now: datetime) -> bool:
        synced = self._history_synced_at.get(symbol)
        rows = self._bars.get(symbol) or {}
        latest = max(rows) if rows else None
        return (
            synced is None
            or (now - synced).total_seconds() >= HISTORY_RESYNC_SECONDS
            or latest is None
            or (now - latest).total_seconds() > 10 * 60
        )

    async def _hydrate_symbol(self, symbol: str, now: datetime) -> None:
        open_at = datetime.combine(now.date(), MARKET_OPEN, IST)
        if now < open_at + timedelta(minutes=FIVE_MINUTES):
            return
        providers: list[Any] = []
        if kite_state.is_connected and kite_state.kite is not None:
            providers.append(KiteProvider(kite_state.kite))
        if runner_service.provider is not None:
            runner_name = str(
                getattr(runner_service.provider.name, "value", runner_service.provider.name)
            ).lower()
            if runner_name != "kite":
                providers.append(runner_service.provider)

        for provider in providers:
            provider_name = str(getattr(provider.name, "value", provider.name)).lower()
            try:
                operation = lambda p=provider: p.get_history(
                    symbol, open_at, now, interval="5minute"
                )
                rows = (
                    await operation()
                    if provider_name == "arrow"
                    else await provider_gateway.run(provider_name, operation)
                )
                parsed = [
                    bar
                    for raw in rows
                    if (bar := _provider_bar(raw, now)) is not None
                    and bar["bar_start"].date() == now.date()
                ]
                if not parsed:
                    continue
                changed = self._merge_five_minute_rows(
                    symbol, parsed, source=f"{provider_name}_history"
                )
                if changed:
                    await self._persist_candles(changed)
                self._history_synced_at[symbol] = now
                return
            except Exception as exc:  # provider failures must not stop live tracking
                self._last_error = f"{type(exc).__name__}: {str(exc)[:140]}"
                logger.warning(
                    "Intraday history hydrate failed for %s via %s: %s",
                    symbol,
                    provider_name,
                    exc,
                )
        self._history_synced_at[symbol] = now

    def _merge_runner_bars(
        self, symbol: str, now: datetime
    ) -> list[dict[str, Any]]:
        minute_rows = [
            _minute_bar_row(bar)
            for bar in runner_service.bars.bars(symbol, include_current=False)
            if bar.minute_timestamp.astimezone(IST).date() == now.date()
        ]
        completed = [
            row
            for row in aggregate_bars(minute_rows, FIVE_MINUTES, require_source_bars=5)
            if row["bar_start"] + timedelta(minutes=FIVE_MINUTES) <= now
        ]
        return self._merge_five_minute_rows(
            symbol, completed, source="runner_stream"
        )

    def _merge_five_minute_rows(
        self, symbol: str, rows: list[dict[str, Any]], *, source: str
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        symbol_bars = self._bars.setdefault(symbol, {})
        changed: list[dict[str, Any]] = []
        for row in rows:
            stamp = _as_ist(row.get("bar_start"))
            if stamp is None or stamp.date() != self._session_date:
                continue
            candidate = {
                "session_date": self._session_date.isoformat(),
                "symbol": symbol,
                "exchange": "NSE",
                "timeframe_minutes": FIVE_MINUTES,
                "bar_start": stamp.isoformat(),
                "open": round(float(row["open"]), 4),
                "high": round(float(row["high"]), 4),
                "low": round(float(row["low"]), 4),
                "close": round(float(row["close"]), 4),
                "volume": max(0, int(row.get("volume") or 0)),
                "source": source,
                "source_bar_count": max(1, int(row.get("source_bar_count") or 1)),
            }
            current = symbol_bars.get(stamp)
            # Historical OHLC is authoritative for the hydrated portion of the day.
            if current and str(current.get("source", "")).endswith("_history") and not source.endswith("_history"):
                continue
            if current != candidate:
                symbol_bars[stamp] = candidate
                changed.append(candidate)
        return changed

    def _detect_symbol_signals(self, symbol: str) -> list[dict[str, Any]]:
        five = [
            {**row, "bar_start": _as_ist(row["bar_start"])}
            for _, row in sorted(self._bars.get(symbol, {}).items())
        ]
        if not five:
            return []
        fifteen = aggregate_bars(
            five, FIFTEEN_MINUTES, require_source_bars=3
        )
        meta = self._candidate_meta.get(symbol, {})
        bearish = str(meta.get("bias") or "").upper() == "SHORT"
        definitions = (
            [
                ("FIVE_MIN_BREAKDOWN", retracement_events(five, FIVE_MINUTES, short=True)),
                ("FIFTEEN_MIN_BREAKDOWN", retracement_events(fifteen, FIFTEEN_MINUTES, short=True)),
                ("PREVIOUS_DAY_LOW_BREAK", previous_day_events(five, _float(meta.get("pdl")), short=True)),
            ]
            if bearish
            else [
                ("FIVE_MIN_BREAKOUT", retracement_events(five, FIVE_MINUTES)),
                ("FIFTEEN_MIN_BREAKOUT", retracement_events(fifteen, FIFTEEN_MINUTES)),
                ("PREVIOUS_DAY_HIGH_BREAK", previous_day_events(five, _float(meta.get("pdh")))),
            ]
        )
        created: dict[tuple[str, str], dict[str, Any]] = {}
        for signal_type, detected in ((kind, event) for kind, events in definitions for event in events):
            key = (symbol, signal_type)
            existing = event_records(self._signals[key]) if key in self._signals else []
            if any(row["signal_time"] == detected["signal_time"].isoformat() for row in existing):
                continue
            row = {
                "session_date": self._session_date.isoformat(),
                "symbol": symbol,
                "exchange": "NSE",
                "signal_type": signal_type,
                "timeframe_minutes": detected["timeframe_minutes"],
                "signal_time": detected["signal_time"].isoformat(),
                "trigger_price": round(float(detected["trigger_price"]), 4),
                "prior_intraday_high": _round_or_none(
                    detected.get("prior_intraday_high")
                ),
                "previous_day_high": _round_or_none(
                    detected.get("previous_day_high") or meta.get("pdh")
                ),
                "prior_intraday_low": _round_or_none(detected.get("prior_intraday_low")),
                "previous_day_low": _round_or_none(
                    detected.get("previous_day_low") or meta.get("pdl")
                ),
                "retracement_bar_start": detected.get(
                    "retracement_bar_start"
                ).isoformat()
                if detected.get("retracement_bar_start")
                else None,
                "radar_score": int(_float(meta.get("score")) or 0),
                "radar_quality": meta.get("quality"),
                "definition_version": DEFINITION_VERSION,
                "metadata": {
                    "radarSetups": meta.get("setups") or [],
                    "radarChangePct": meta.get("changePct"),
                    "radarVolRatio": meta.get("volRatio"),
                    "direction": "SHORT" if bearish else "LONG",
                    "fno": bool(bearish),
                    "detectedAt": datetime.now(IST).isoformat(),
                    "radarAsOf": meta.get("radarAsOf"),
                    "radarScoreBreakdown": deepcopy(meta.get("scoreBreakdown")),
                    "radarContext": deepcopy(meta),
                },
            }
            self._signals[key] = event_envelope([*existing, row])
            created[key] = self._signals[key]
        # One upsert per unique DB key, even when backfill finds several events.
        return list(created.values())

    def _snapshot_unlocked(self, now: datetime) -> dict[str, Any]:
        by_symbol: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for (symbol, _), envelope in self._signals.items():
            for sequence, row in enumerate(event_records(envelope), 1):
                direction = "SHORT" if row["signal_type"] in {"FIVE_MIN_BREAKDOWN", "FIFTEEN_MIN_BREAKDOWN", "PREVIOUS_DAY_LOW_BREAK"} else "LONG"
                by_symbol.setdefault((symbol, direction), []).append({**row, "event_number": sequence})

        candidates: list[dict[str, Any]] = []
        market_open = is_market_hours()
        for (symbol, direction), signals in by_symbol.items():
            meta = self._candidate_meta.get(symbol, {})
            five = [
                {**row, "bar_start": stamp}
                for stamp, row in sorted(self._bars.get(symbol, {}).items())
                if MARKET_OPEN <= stamp.time() < MARKET_CLOSE
            ]
            types = {row["signal_type"] for row in signals}
            bearish = direction == "SHORT"
            tag_defs = (
                (("FIVE_MIN_BREAKDOWN", "5M"), ("FIFTEEN_MIN_BREAKDOWN", "15M"), ("PREVIOUS_DAY_LOW_BREAK", "PDL"))
                if bearish
                else (("FIVE_MIN_BREAKOUT", "5M"), ("FIFTEEN_MIN_BREAKOUT", "15M"), ("PREVIOUS_DAY_HIGH_BREAK", "PDH"))
            )
            tags = [
                label
                for key, label in tag_defs
                if key in types
            ]
            signals.sort(key=lambda row: row["signal_time"])
            signal_payloads = []
            for row in signals:
                payload = self._signal_payload(row, five, _float(meta.get("pdh")), _float(meta.get("pdl")))
                payload["entryAssessment"] = assess_entry(
                    payload, meta, five, now, market_open=market_open,
                    feed_healthy=self._last_failed_at is None and symbol not in self._symbol_errors,
                )
                signal_payloads.append(payload)
            latest_by_type = {payload["type"]: payload for payload in signal_payloads}
            for payload in signal_payloads:
                payload["isLatest"] = payload is latest_by_type[payload["type"]]
                if not payload["isLatest"]:
                    payload["entryAssessment"].update({
                        "status": "SUPERSEDED", "reason": "A newer confirmation of this type is available. This event remains in today's history.",
                    })
            candidates.append(
                {
                    "symbol": symbol,
                    "ltp": meta.get("ltp"),
                    "changePct": meta.get("changePct"),
                    "score": meta.get("score"),
                    "scoreBreakdown": meta.get("scoreBreakdown"),
                    "radarAsOf": meta.get("radarAsOf"),
                    "radarBias": meta.get("bias"),
                    "quality": meta.get("quality"),
                    "pdh": meta.get("pdh"),
                    "pdl": meta.get("pdl"),
                    "direction": "SHORT" if bearish else "LONG",
                    "isFno": symbol in self._fno_symbols,
                    "tags": tags,
                    "combination": " + ".join(tags),
                    "latestSignalAt": signals[-1]["signal_time"],
                    "signals": list(latest_by_type.values()),
                    "events": signal_payloads,
                }
            )
        candidates.sort(
            key=lambda row: (
                len(row["tags"]),
                _float(row.get("score")) or 0,
                row["latestSignalAt"],
            ),
            reverse=True,
        )
        signal_types = [row["signal_type"] for envelope in self._signals.values() for row in event_records(envelope)]
        return {
            "success": True,
            "status": "SIGNALS_FOUND" if candidates else "NO_SIGNALS",
            "sessionDate": self._session_date.isoformat()
            if self._session_date
            else now.date().isoformat(),
            "timestamp": int(now.timestamp() * 1000),
            "generatedAt": self._last_refreshed_at.isoformat()
            if self._last_refreshed_at
            else None,
            "marketHours": market_open,
            "coverage": {
                **self._coverage,
                "monitored": len(self._candidate_meta),
                "completeCandles": sum(complete_session(list(self._bars.get(symbol, {}).values()), now) for symbol in self._candidate_meta),
                "pendingCandles": sum(not complete_session(list(self._bars.get(symbol, {}).values()), now) for symbol in self._candidate_meta),
                "retainedSignals": sum(bool(row.get("monitorOnly")) for row in self._candidate_meta.values()),
                "confirmed": len({symbol for symbol, _ in by_symbol}),
            },
            "summary": {
                "bullishTracked": sum(str(row.get("bias") or "").upper() == "LONG" for row in self._candidate_meta.values()),
                "bearishFnoTracked": sum(str(row.get("bias") or "").upper() == "SHORT" for row in self._candidate_meta.values()),
                "signalCandidates": len(candidates),
                "confirmationEvents": len(signal_types),
                "bullishSignals": sum(row["direction"] == "LONG" for row in candidates),
                "bearishSignals": sum(row["direction"] == "SHORT" for row in candidates),
                "fiveMinute": signal_types.count("FIVE_MIN_BREAKOUT") + signal_types.count("FIVE_MIN_BREAKDOWN"),
                "fifteenMinute": signal_types.count("FIFTEEN_MIN_BREAKOUT") + signal_types.count("FIFTEEN_MIN_BREAKDOWN"),
                "previousDayHigh": signal_types.count(
                    "PREVIOUS_DAY_HIGH_BREAK"
                ),
                "previousDayLow": signal_types.count("PREVIOUS_DAY_LOW_BREAK"),
            },
            "candidates": candidates,
            "dataQuality": {
                "databaseAvailable": self._database_available,
                "pendingSignalWrites": len(self._pending_signal_writes),
                "lastError": self._last_error,
                "definitionVersion": DEFINITION_VERSION,
                "storedFiveMinuteBars": sum(
                    len(rows) for rows in self._bars.values()
                ),
                "latestCandleAt": max((stamp.isoformat() for rows in self._bars.values() for stamp in rows), default=None),
                "latestBullishCandleAt": max((stamp.isoformat() for symbol, rows in self._bars.items() if str(self._candidate_meta.get(symbol, {}).get("bias") or "").upper() == "LONG" for stamp in rows), default=None),
                "latestBearishCandleAt": max((stamp.isoformat() for symbol, rows in self._bars.items() if str(self._candidate_meta.get(symbol, {}).get("bias") or "").upper() == "SHORT" for stamp in rows), default=None),
                "historyResyncSeconds": HISTORY_RESYNC_SECONDS,
                "historyFetchesPerCycle": settings.INTRADAY_BREAKOUT_HISTORY_FETCHES_PER_CYCLE,
                "skippedSymbolCount": len(self._symbol_errors),
                "skippedSymbols": sorted(self._symbol_errors),
            },
            "method": {
                "candidateSource": "All eligible bullish and F&O bearish names from the full Nifty 500 scan; legacy fallback is marked as partial coverage",
                "evaluationCadenceSeconds": settings.INTRADAY_BREAKOUT_REFRESH_SECONDS,
                "sourceResolutionMinutes": 1,
                "fiveMinute": "Completed 5-minute candle closes above every prior session high after an earlier advance and a red retracement candle.",
                "fifteenMinute": "Three completed 5-minute candles are aggregated; the same retracement rule is then evaluated on completed 15-minute candles.",
                "previousDayHigh": "A completed 5-minute candle closes above the previous completed session high.",
                "bearishFiveMinute": "Completed 5-minute candle closes below every prior session low after an earlier decline and a green retracement candle.",
                "bearishFifteenMinute": "Three completed 5-minute candles are aggregated; the inverse retracement rule is evaluated on completed 15-minute candles.",
                "previousDayLow": "A completed 5-minute candle closes below the previous completed session low.",
                "repeatSetups": "A new pullback is required for another range breakout; previous-day levels require a completed recross. Every confirmation is retained in today's history.",
            },
        }

    def _signal_payload(
        self,
        row: dict[str, Any],
        five: list[dict[str, Any]],
        previous_day_high: float | None = None,
        previous_day_low: float | None = None,
    ) -> dict[str, Any]:
        """Add level and post-breakout performance without changing stored signals."""
        signal_type = str(row.get("signal_type") or "")
        signal_time = _as_ist(row.get("signal_time"))
        timeframe = int(row.get("timeframe_minutes") or FIVE_MINUTES)
        bearish = signal_type in {"FIVE_MIN_BREAKDOWN", "FIFTEEN_MIN_BREAKDOWN", "PREVIOUS_DAY_LOW_BREAK"}
        if signal_type == "PREVIOUS_DAY_HIGH_BREAK":
            breakout_level = _float(row.get("previous_day_high")) or previous_day_high
        elif signal_type == "PREVIOUS_DAY_LOW_BREAK":
            breakout_level = _float(row.get("previous_day_low")) or previous_day_low
        elif bearish:
            breakout_level = _float(row.get("prior_intraday_low"))
        else:
            breakout_level = _float(row.get("prior_intraday_high"))

        if signal_time is not None:
            breakout_start = signal_time - timedelta(minutes=timeframe)
        else:
            breakout_start = None

        # Older saved rows may predate prior_intraday_high. Reconstruct the
        # actual resistance from candles that closed before the breakout bar.
        if (
            breakout_level is None
            and signal_type in {"FIVE_MIN_BREAKOUT", "FIFTEEN_MIN_BREAKOUT", "FIVE_MIN_BREAKDOWN", "FIFTEEN_MIN_BREAKDOWN"}
            and breakout_start is not None
        ):
            source = (
                aggregate_bars(five, FIFTEEN_MINUTES, require_source_bars=3)
                if signal_type in {"FIFTEEN_MIN_BREAKOUT", "FIFTEEN_MIN_BREAKDOWN"}
                else five
            )
            prior_values = [
                float(bar["low"] if bearish else bar["high"])
                for bar in source
                if (_as_ist(bar.get("bar_start")) or breakout_start) < breakout_start
            ]
            breakout_level = (min(prior_values) if bearish else max(prior_values)) if prior_values else None

        after_breakout = [
            bar
            for bar in five
            if breakout_start is None
            or (_as_ist(bar.get("bar_start")) or breakout_start) >= breakout_start
        ]
        high_after = max(
            (float(bar["high"]) for bar in after_breakout),
            default=None,
        )
        low_after = min((float(bar["low"]) for bar in after_breakout), default=None)
        session_close = (
            float(after_breakout[-1]["close"]) if after_breakout else None
        )

        def return_pct(value: float | None) -> float | None:
            if value is None or breakout_level is None or breakout_level <= 0:
                return None
            return round((((breakout_level - value) / breakout_level) if bearish else ((value - breakout_level) / breakout_level)) * 100, 2)

        best_after = low_after if bearish else high_after
        # Entry-oriented outcomes start AFTER the confirmation candle and use
        # its close. Keep legacy level-based fields for chart compatibility.
        trigger = _float(row.get("trigger_price"))
        post_confirmation = [bar for bar in five if signal_time is not None
                             and (_as_ist(bar.get("bar_start")) or signal_time - timedelta(days=1)) >= signal_time]
        entry_best = (min((float(bar["low"]) for bar in post_confirmation), default=trigger) if bearish
                      else max((float(bar["high"]) for bar in post_confirmation), default=trigger))
        entry_close = float(post_confirmation[-1]["close"]) if post_confirmation else trigger
        def entry_return(value):
            return round(((-1 if bearish else 1) * (value - trigger) / trigger) * 100, 2) if trigger and value is not None else None

        return {
            "type": signal_type,
            "eventId": ":".join(str(row.get(key) or "") for key in ("session_date", "symbol", "signal_type", "signal_time")),
            "eventNumber": row.get("event_number", 1),
            "radarScoreAtDetection": row.get("radar_score"),
            "detectedAt": (row.get("metadata") or {}).get("detectedAt"),
            "radarAsOfAtDetection": (row.get("metadata") or {}).get("radarAsOf"),
            "radarBreakdownAtDetection": (row.get("metadata") or {}).get("radarScoreBreakdown"),
            "postConfirmationBestReturnPct": entry_return(entry_best),
            "postConfirmationCloseReturnPct": entry_return(entry_close),
            "timeframeMinutes": timeframe,
            "signalTime": row.get("signal_time"),
            "triggerPrice": row.get("trigger_price"),
            "breakoutLevel": _round_or_none(breakout_level),
            "highReturnPct": return_pct(best_after),
            "bestReturnPct": return_pct(best_after),
            "closeReturnPct": return_pct(session_close),
            "highAfterBreakout": _round_or_none(high_after),
            "lowAfterBreakout": _round_or_none(low_after),
            "sessionClose": _round_or_none(session_close),
            "priorIntradayHigh": row.get("prior_intraday_high"),
            "priorIntradayLow": row.get("prior_intraday_low"),
            "direction": "SHORT" if bearish else "LONG",
            "retracementBarStart": row.get("retracement_bar_start"),
        }

    async def chart(self, symbol: str, timeframe_minutes: int) -> dict[str, Any]:
        """Return a full-session chart, filling a selected symbol only when needed."""
        await self.snapshot(refresh_if_stale=True)
        now = datetime.now(IST)
        clean_symbol = symbol.strip().upper()
        open_at = datetime.combine(now.date(), MARKET_OPEN, IST)
        close_at = datetime.combine(now.date(), MARKET_CLOSE, IST)
        completed_until = min(now, close_at)
        expected_five = max(
            0,
            int((completed_until - open_at).total_seconds() // (FIVE_MINUTES * 60)),
        )
        session_rows = [
            stamp
            for stamp in self._bars.get(clean_symbol, {})
            if MARKET_OPEN <= stamp.time() < MARKET_CLOSE
        ]
        if expected_five and len(session_rows) < max(1, expected_five - 1):
            await self._hydrate_symbol(clean_symbol, now)

        async with self._lock:
            five_by_start = {
                stamp: {**row, "bar_start": stamp}
                for stamp, row in self._bars.get(clean_symbol, {}).items()
                if MARKET_OPEN <= stamp.time() < MARKET_CLOSE
            }

            minute_rows = [
                _minute_bar_row(bar)
                for bar in runner_service.bars.bars(clean_symbol, include_current=True)
                if bar.minute_timestamp.astimezone(IST).date() == now.date()
                and MARKET_OPEN
                <= bar.minute_timestamp.astimezone(IST).time()
                < MARKET_CLOSE
            ]
            for row in aggregate_bars(minute_rows, FIVE_MINUTES):
                stamp = row["bar_start"]
                if stamp not in five_by_start or stamp + timedelta(minutes=FIVE_MINUTES) > now:
                    five_by_start[stamp] = row

            five = [five_by_start[key] for key in sorted(five_by_start)]
            if timeframe_minutes == FIFTEEN_MINUTES:
                display = aggregate_bars(five, FIFTEEN_MINUTES)
            else:
                display = five

            signals = [
                row
                for (row_symbol, _), row in self._signals.items()
                if row_symbol == clean_symbol
            ]
            signals.sort(key=lambda row: row["signal_time"])
            meta = self._candidate_meta.get(clean_symbol, {})
            previous_day_high = _float(meta.get("pdh"))
            previous_day_low = _float(meta.get("pdl"))
            if previous_day_high is None:
                previous_day_high = next(
                    (
                        _float(row.get("previous_day_high"))
                        for row in signals
                        if _float(row.get("previous_day_high")) is not None
                    ),
                    None,
                )
            if previous_day_low is None:
                previous_day_low = next(
                    (_float(row.get("previous_day_low")) for row in signals if _float(row.get("previous_day_low")) is not None),
                    None,
                )

            chart_rows = []
            for row in display:
                start = _as_ist(row.get("bar_start"))
                if start is None:
                    continue
                forming = bool(
                    is_market_hours()
                    and start + timedelta(minutes=timeframe_minutes) > now
                )
                chart_rows.append(
                    {
                        "time": start.isoformat(),
                        "open": round(float(row["open"]), 4),
                        "high": round(float(row["high"]), 4),
                        "low": round(float(row["low"]), 4),
                        "close": round(float(row["close"]), 4),
                        "volume": max(0, int(row.get("volume") or 0)),
                        "isForming": forming,
                    }
                )

            prior_high = max(
                (float(row["high"]) for row in display[:-1]),
                default=None,
            )
            prior_low = min((float(row["low"]) for row in display[:-1]), default=None)
            last = display[-1] if display else None
            forming_breakout = bool(
                chart_rows
                and chart_rows[-1]["isForming"]
                and last is not None
                and prior_high is not None
                and float(last["high"]) > prior_high
            )
            stored_direction = next((str((row.get("metadata") or {}).get("direction") or "") for row in signals if (row.get("metadata") or {}).get("direction")), "")
            direction = "SHORT" if str(meta.get("bias") or stored_direction).upper() == "SHORT" else "LONG"
            forming_breakdown = bool(
                chart_rows and chart_rows[-1]["isForming"] and last is not None
                and prior_low is not None and float(last["low"]) < prior_low
            )
            return {
                "success": True,
                "symbol": clean_symbol,
                "sessionDate": self._session_date.isoformat()
                if self._session_date
                else now.date().isoformat(),
                "timeframeMinutes": timeframe_minutes,
                "marketHours": is_market_hours(),
                "previousDayHigh": previous_day_high,
                "previousDayLow": previous_day_low,
                "direction": direction,
                "formingBreakout": forming_breakout,
                "formingBreakdown": forming_breakdown,
                "updatedAt": now.isoformat(),
                "candles": chart_rows,
                "signals": [
                    self._signal_payload(row, five, previous_day_high, previous_day_low)
                    for row in signals
                ],
                "method": {
                    "evaluationCadenceSeconds": settings.INTRADAY_BREAKOUT_REFRESH_SECONDS,
                    "sourceResolutionMinutes": 1,
                    "historyProviderPriority": "zerodha_then_runner_fallback",
                    "confirmation": "5-minute and 15-minute signals are saved only after the candle closes.",
                },
            }

    async def _load_session(self, session_date: date) -> None:
        try:
            client = self._client_factory()
            candles, signals = await asyncio.gather(
                asyncio.to_thread(_session_rows, client, "intraday_candles", session_date,
                                  ("symbol", "timeframe_minutes", "bar_start")),
                asyncio.to_thread(_session_rows, client, "intraday_breakout_signals", session_date,
                                  ("symbol", "signal_type")),
            )
            for row in candles:
                stamp = _as_ist(row.get("bar_start"))
                symbol = str(row.get("symbol") or "").upper()
                if stamp and symbol:
                    self._bars.setdefault(symbol, {})[stamp] = row
            for row in signals:
                symbol = str(row.get("symbol") or "").upper()
                signal_type = str(row.get("signal_type") or "")
                if symbol and signal_type:
                    self._signals[(symbol, signal_type)] = row
            self._database_available = True
        except Exception:
            self._database_available = False
            logger.warning(
                "Intraday tables unavailable while loading current session",
                exc_info=True,
            )

    async def _delete_prior_candles(self, session_date: date) -> None:
        """Keep the small signal history for audit while expiring raw bars daily."""
        try:
            client = self._client_factory()
            await asyncio.to_thread(
                lambda: client.table("intraday_candles")
                .delete()
                .lt("session_date", session_date.isoformat())
                .execute()
            )
            self._database_available = True
        except Exception:
            self._database_available = False
            logger.warning("Intraday candle cleanup deferred", exc_info=True)

    async def _persist_candles(self, rows: list[dict[str, Any]]) -> None:
        try:
            client = self._client_factory()
            for offset in range(0, len(rows), 100):
                batch = rows[offset : offset + 100]
                await asyncio.to_thread(
                    lambda b=batch: client.table("intraday_candles")
                    .upsert(
                        b,
                        on_conflict="session_date,symbol,timeframe_minutes,bar_start",
                    )
                    .execute()
                )
            self._database_available = True
        except Exception:
            self._database_available = False
            logger.exception("Intraday candle persistence failed")

    async def _persist_signals(self, rows: list[dict[str, Any]]) -> bool:
        try:
            client = self._client_factory()
            await asyncio.to_thread(
                lambda: client.table("intraday_breakout_signals")
                .upsert(rows, on_conflict="session_date,symbol,signal_type")
                .execute()
            )
            self._database_available = True
            return True
        except Exception:
            self._database_available = False
            logger.exception("Intraday signal persistence failed")
            return False


def _session_rows(client, table: str, session_date: date, order: tuple[str, ...], page_size: int = 500) -> list[dict]:
    """Stable pagination: broad-universe sessions exceed the Data API row cap."""
    rows: list[dict] = []
    while True:
        query = client.table(table).select("*").eq("session_date", session_date.isoformat())
        for column in order:
            query = query.order(column)
        page = query.range(len(rows), len(rows) + page_size - 1).execute().data or []
        if not page:
            return rows
        rows.extend(page)


def _minute_bar_row(bar: MinuteBar) -> dict[str, Any]:
    return {
        "minute_timestamp": bar.minute_timestamp,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
    }


def _provider_bar(raw: Any, now: datetime) -> dict[str, Any] | None:
    if isinstance(raw, dict):
        stamp = raw.get("date", raw.get("timestamp", raw.get("time")))
        values = (
            raw.get("open"),
            raw.get("high"),
            raw.get("low"),
            raw.get("close"),
            raw.get("volume", 0),
        )
    elif isinstance(raw, (list, tuple)) and len(raw) >= 6:
        stamp, *values = raw[:6]
    else:
        return None
    parsed = _as_ist(stamp)
    if parsed is None or parsed + timedelta(minutes=FIVE_MINUTES) > now:
        return None
    try:
        open_, high, low, close, volume = values
        result = {
            "bar_start": parsed,
            "open": float(open_),
            "high": float(high),
            "low": float(low),
            "close": float(close),
            "volume": int(volume or 0),
            "source_bar_count": 1,
        }
    except (TypeError, ValueError):
        return None
    if (
        min(result["open"], result["high"], result["low"], result["close"])
        <= 0
        or result["high"]
        < max(result["open"], result["low"], result["close"])
        or result["low"]
        > min(result["open"], result["high"], result["close"])
    ):
        return None
    return result


def _as_ist(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    return parsed.replace(tzinfo=IST) if parsed.tzinfo is None else parsed.astimezone(IST)


def _float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _round_or_none(value: Any) -> float | None:
    parsed = _float(value)
    return round(parsed, 4) if parsed is not None else None


intraday_breakout_service = IntradayBreakoutService()
