"""Five-minute OI history, shared option-chain cache, and explainability.

The browser never refreshes the broker feed directly through this service. A
single scheduled worker captures one chain per configured index, writes the
latest chain and rolling history to Redis, and optionally persists normalized
rows to the dedicated Alpha Radar Supabase project.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

from app.config import settings
from app.core.session_cache import is_market_hours, load_session, save_session
from app.core.shared_store import shared_store


logger = logging.getLogger("alpha_radar.oi_history")

TABLE_NAME = "option_oi_snapshots"
BLOCKED_SUPABASE_PROJECT_REFS = {"yhqnsuoynvifwaipqjzk"}
ALPHA_RADAR_PROJECT_REF = "xphrxbmvavrbqgmldbak"


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value)) if value is not None else default
    except (TypeError, ValueError):
        return default


def _pct_change(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return round(((current - previous) / previous) * 100, 4)


def _format_oi(value: int) -> str:
    sign = "+" if value > 0 else ""
    absolute = abs(value)
    if absolute >= 10_000_000:
        return f"{sign}{value / 10_000_000:.1f}Cr"
    if absolute >= 100_000:
        return f"{sign}{value / 100_000:.1f}L"
    if absolute >= 1_000:
        return f"{sign}{value / 1_000:.1f}K"
    return f"{sign}{value}"


def _bucket_at(captured_at: datetime, interval_minutes: int) -> datetime:
    interval = max(1, interval_minutes)
    localized = captured_at.astimezone(settings.TIMEZONE)
    minute = localized.minute - (localized.minute % interval)
    return localized.replace(minute=minute, second=0, microsecond=0)


def _leg_action(oi_change: int, premium_change_pct: float, *, has_previous: bool) -> str:
    if not has_previous:
        return "BASELINE"
    if oi_change == 0:
        return "UNCHANGED"
    if oi_change > 0 and premium_change_pct > 0.25:
        return "LONG_BUILDUP"
    if oi_change > 0 and premium_change_pct < -0.25:
        return "SHORT_BUILDUP"
    if oi_change < 0 and premium_change_pct > 0.25:
        return "SHORT_COVERING"
    if oi_change < 0 and premium_change_pct < -0.25:
        return "LONG_UNWINDING"
    return "OI_ADDED" if oi_change > 0 else "OI_REDUCED"


def _action_phrase(side: str, action: str, oi_change: int, premium_change_pct: float) -> str:
    action_text = {
        "BASELINE": "baseline captured",
        "UNCHANGED": "OI was unchanged",
        "LONG_BUILDUP": "long buildup (buyers added as premium rose)",
        "SHORT_BUILDUP": "short buildup (writers added as premium fell)",
        "SHORT_COVERING": "short covering (writers exited as premium rose)",
        "LONG_UNWINDING": "long unwinding (buyers exited as premium fell)",
        "OI_ADDED": "OI increased while premium stayed nearly flat",
        "OI_REDUCED": "OI decreased while premium stayed nearly flat",
    }.get(action, action.replace("_", " ").lower())
    if action == "BASELINE":
        return f"{side} {action_text}"
    return f"{side} {action_text}: {_format_oi(oi_change)} OI, premium {premium_change_pct:+.2f}%"


def _directional_read(call_change: int, put_change: int, *, has_previous: bool) -> tuple[str, str]:
    if not has_previous:
        return "NEUTRAL", "Baseline"

    # PE addition/removal changes support; CE addition/removal changes resistance.
    score = put_change - call_change
    activity = abs(call_change) + abs(put_change)
    noise = max(1, round(activity * 0.12))
    if abs(score) <= noise:
        if call_change > 0 and put_change > 0:
            return "NEUTRAL", "Two-sided buildup"
        if call_change < 0 and put_change < 0:
            return "NEUTRAL", "Two-sided unwinding"
        return "NEUTRAL", "Balanced OI"

    if score > 0:
        if put_change > 0 and call_change < 0:
            return "BULLISH", "Bullish rotation"
        if put_change > 0:
            return "BULLISH", "Support building"
        return "BULLISH", "Resistance unwinding"

    if call_change > 0 and put_change < 0:
        return "BEARISH", "Bearish rotation"
    if call_change > 0:
        return "BEARISH", "Resistance building"
    return "BEARISH", "Support unwinding"


def _reason(
    *,
    scope: str,
    call_change: int,
    put_change: int,
    net_change: int,
    spot_change_pct: float,
    call_action: str,
    put_action: str,
    call_ltp_change_pct: float,
    put_ltp_change_pct: float,
    has_previous: bool,
) -> str:
    if not has_previous:
        return "First five-minute snapshot for this expiry; the next capture will explain the change from this baseline."
    if scope == "overall":
        return (
            f"PE OI {_format_oi(put_change)} versus CE OI {_format_oi(call_change)}; "
            f"net support (PE minus CE) changed {_format_oi(net_change)} over five minutes. "
            f"Spot moved {spot_change_pct:+.2f}%."
        )
    return "; ".join(
        (
            _action_phrase("CE", call_action, call_change, call_ltp_change_pct),
            _action_phrase("PE", put_action, put_change, put_ltp_change_pct),
        )
    ) + "."


def _provider_name(chain_data: dict[str, Any]) -> str:
    provider = chain_data.get("provider")
    if isinstance(provider, dict):
        return str(provider.get("provider") or "unknown")
    return str(provider or "unknown")


def _previous_map(rows: list[dict[str, Any]] | None) -> dict[tuple[str, float], dict[str, Any]]:
    result: dict[tuple[str, float], dict[str, Any]] = {}
    for row in rows or []:
        scope = str(row.get("scope") or "")
        strike = _as_float(row.get("strike_price"))
        result[(scope, strike)] = row
    return result


def build_oi_snapshot_rows(
    index_key: str,
    chain_data: dict[str, Any],
    previous_rows: list[dict[str, Any]] | None = None,
    *,
    captured_at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Normalize one option chain into an overall row plus every strike row."""
    captured = captured_at or datetime.now(settings.TIMEZONE)
    bucket = _bucket_at(captured, settings.OI_HISTORY_INTERVAL_MINUTES)
    expiry = str(chain_data.get("expiry") or "").strip()
    if not expiry:
        raise ValueError("Option chain is missing expiry")
    chain = chain_data.get("chain") or []
    if not isinstance(chain, list) or not chain:
        raise ValueError("Option chain is empty")

    previous = _previous_map(previous_rows)
    spot = _as_float(chain_data.get("spot"))
    source = _provider_name(chain_data)
    underlying = str(chain_data.get("name") or chain_data.get("index") or index_key).upper()
    bucket_iso = bucket.astimezone(timezone.utc).isoformat()
    captured_iso = captured.astimezone(timezone.utc).isoformat()

    rows: list[dict[str, Any]] = []
    for item in chain:
        strike = _as_float(item.get("strike"))
        if strike <= 0:
            continue
        call = item.get("call") or {}
        put = item.get("put") or {}
        call_oi = _as_int(call.get("oi"))
        put_oi = _as_int(put.get("oi"))
        call_ltp = _as_float(call.get("ltp"))
        put_ltp = _as_float(put.get("ltp"))
        prior = previous.get(("strike", strike))
        has_previous = prior is not None
        prior_call_oi = _as_int(prior.get("call_oi")) if prior else call_oi
        prior_put_oi = _as_int(prior.get("put_oi")) if prior else put_oi
        prior_call_ltp = _as_float(prior.get("call_ltp")) if prior else call_ltp
        prior_put_ltp = _as_float(prior.get("put_ltp")) if prior else put_ltp
        prior_spot = _as_float(prior.get("spot_price")) if prior else spot
        call_change = call_oi - prior_call_oi
        put_change = put_oi - prior_put_oi
        call_ltp_change_pct = _pct_change(call_ltp, prior_call_ltp)
        put_ltp_change_pct = _pct_change(put_ltp, prior_put_ltp)
        spot_change_pct = _pct_change(spot, prior_spot)
        call_action = _leg_action(call_change, call_ltp_change_pct, has_previous=has_previous)
        put_action = _leg_action(put_change, put_ltp_change_pct, has_previous=has_previous)
        direction, label = _directional_read(call_change, put_change, has_previous=has_previous)
        net_change = put_change - call_change

        rows.append({
            "bucket_at": bucket_iso,
            "captured_at": captured_iso,
            "index_key": index_key,
            "underlying": underlying,
            "expiry": expiry,
            "scope": "strike",
            "strike_price": strike,
            "spot_price": spot,
            "spot_change_pct": spot_change_pct,
            "call_oi": call_oi,
            "put_oi": put_oi,
            "total_oi": call_oi + put_oi,
            "call_oi_change": call_change,
            "put_oi_change": put_change,
            "total_oi_change": call_change + put_change,
            "net_oi": put_oi - call_oi,
            "net_oi_change": net_change,
            "pcr": round(put_oi / call_oi, 4) if call_oi > 0 else None,
            "call_ltp": call_ltp,
            "put_ltp": put_ltp,
            "call_ltp_change_pct": call_ltp_change_pct,
            "put_ltp_change_pct": put_ltp_change_pct,
            "call_action": call_action,
            "put_action": put_action,
            "change_direction": direction,
            "change_label": label,
            "change_reason": _reason(
                scope="strike",
                call_change=call_change,
                put_change=put_change,
                net_change=net_change,
                spot_change_pct=spot_change_pct,
                call_action=call_action,
                put_action=put_action,
                call_ltp_change_pct=call_ltp_change_pct,
                put_ltp_change_pct=put_ltp_change_pct,
                has_previous=has_previous,
            ),
            "source": source,
        })

    if not rows:
        raise ValueError("Option chain did not contain valid strikes")

    call_oi = sum(row["call_oi"] for row in rows)
    put_oi = sum(row["put_oi"] for row in rows)
    prior_overall = previous.get(("overall", 0.0))
    has_previous = prior_overall is not None
    prior_call_oi = _as_int(prior_overall.get("call_oi")) if prior_overall else call_oi
    prior_put_oi = _as_int(prior_overall.get("put_oi")) if prior_overall else put_oi
    prior_spot = _as_float(prior_overall.get("spot_price")) if prior_overall else spot
    call_change = call_oi - prior_call_oi
    put_change = put_oi - prior_put_oi
    net_change = put_change - call_change
    spot_change_pct = _pct_change(spot, prior_spot)
    direction, label = _directional_read(call_change, put_change, has_previous=has_previous)
    overall = {
        "bucket_at": bucket_iso,
        "captured_at": captured_iso,
        "index_key": index_key,
        "underlying": underlying,
        "expiry": expiry,
        "scope": "overall",
        "strike_price": 0,
        "spot_price": spot,
        "spot_change_pct": spot_change_pct,
        "call_oi": call_oi,
        "put_oi": put_oi,
        "total_oi": call_oi + put_oi,
        "call_oi_change": call_change,
        "put_oi_change": put_change,
        "total_oi_change": call_change + put_change,
        "net_oi": put_oi - call_oi,
        "net_oi_change": net_change,
        "pcr": round(put_oi / call_oi, 4) if call_oi > 0 else None,
        "call_ltp": None,
        "put_ltp": None,
        "call_ltp_change_pct": 0,
        "put_ltp_change_pct": 0,
        "call_action": (
            "BASELINE" if not has_previous
            else "OI_ADDED" if call_change > 0
            else "OI_REDUCED" if call_change < 0
            else "UNCHANGED"
        ),
        "put_action": (
            "BASELINE" if not has_previous
            else "OI_ADDED" if put_change > 0
            else "OI_REDUCED" if put_change < 0
            else "UNCHANGED"
        ),
        "change_direction": direction,
        "change_label": label,
        "change_reason": _reason(
            scope="overall",
            call_change=call_change,
            put_change=put_change,
            net_change=net_change,
            spot_change_pct=spot_change_pct,
            call_action="",
            put_action="",
            call_ltp_change_pct=0,
            put_ltp_change_pct=0,
            has_previous=has_previous,
        ),
        "source": source,
    }
    return [overall, *rows]


def _project_ref(url: str) -> str:
    try:
        host = urlparse(url).hostname or ""
        return host.split(".", 1)[0].lower()
    except ValueError:
        return ""


def _row_for_api(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "bucketAt": row.get("bucket_at"),
        "capturedAt": row.get("captured_at"),
        "scope": row.get("scope"),
        "strike": _as_float(row.get("strike_price")),
        "spot": _as_float(row.get("spot_price")),
        "spotChangePct": _as_float(row.get("spot_change_pct")),
        "callOi": _as_int(row.get("call_oi")),
        "putOi": _as_int(row.get("put_oi")),
        "totalOi": _as_int(row.get("total_oi")),
        "callOiChange": _as_int(row.get("call_oi_change")),
        "putOiChange": _as_int(row.get("put_oi_change")),
        "totalOiChange": _as_int(row.get("total_oi_change")),
        "netOi": _as_int(row.get("net_oi")),
        "netOiChange": _as_int(row.get("net_oi_change")),
        "pcr": _as_float(row.get("pcr")) if row.get("pcr") is not None else None,
        "callLtp": _as_float(row.get("call_ltp")) if row.get("call_ltp") is not None else None,
        "putLtp": _as_float(row.get("put_ltp")) if row.get("put_ltp") is not None else None,
        "callLtpChangePct": _as_float(row.get("call_ltp_change_pct")),
        "putLtpChangePct": _as_float(row.get("put_ltp_change_pct")),
        "callAction": row.get("call_action"),
        "putAction": row.get("put_action"),
        "direction": row.get("change_direction"),
        "label": row.get("change_label"),
        "reason": row.get("change_reason"),
        "source": row.get("source"),
    }


def _group_history_rows(rows: list[dict[str, Any]], strike: float | None) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        bucket = str(row.get("bucket_at") or "")
        if not bucket:
            continue
        entry = buckets.setdefault(bucket, {"bucketAt": bucket, "overall": None, "strike": None})
        if row.get("scope") == "overall":
            entry["overall"] = _row_for_api(row)
        elif strike is not None and abs(_as_float(row.get("strike_price")) - strike) < 0.001:
            entry["strike"] = _row_for_api(row)
    return [buckets[key] for key in sorted(buckets)]


def _latest_session_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    """Keep one NSE session so a partial new day never joins yesterday's chart."""
    dated_rows: list[tuple[str, dict[str, Any]]] = []
    for row in rows:
        raw = str(row.get("bucket_at") or "").strip()
        if not raw:
            continue
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            session_date = parsed.astimezone(settings.TIMEZONE).date().isoformat()
        except ValueError:
            continue
        dated_rows.append((session_date, row))
    if not dated_rows:
        return rows, None
    latest = max(session_date for session_date, _ in dated_rows)
    return [row for session_date, row in dated_rows if session_date == latest], latest


class OIHistoryService:
    def database_status(self, *, require_enabled: bool = False) -> dict[str, Any]:
        actual = _project_ref(settings.SUPABASE_URL)
        expected = settings.ALPHA_RADAR_SUPABASE_PROJECT_REF.strip().lower()
        reason = None
        if require_enabled and not settings.OI_HISTORY_ENABLED:
            reason = "OI history is disabled"
        elif not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
            reason = "Alpha Radar Supabase credentials are not configured"
        elif not expected:
            reason = "ALPHA_RADAR_SUPABASE_PROJECT_REF is not configured"
        elif actual in BLOCKED_SUPABASE_PROJECT_REFS:
            reason = "The configured Supabase project is explicitly blocked for Alpha Radar OI data"
        elif expected != ALPHA_RADAR_PROJECT_REF:
            reason = "ALPHA_RADAR_SUPABASE_PROJECT_REF is not the repository-approved Alpha Radar project"
        elif actual != expected:
            reason = "SUPABASE_URL does not match ALPHA_RADAR_SUPABASE_PROJECT_REF"
        return {
            "ready": reason is None,
            "reason": reason,
            "projectRef": actual or None,
        }

    async def cache_chain(self, index_key: str, chain_data: dict[str, Any]) -> None:
        if not chain_data.get("chain"):
            return
        generated_at = time.time()
        record = {
            "data": copy.deepcopy(chain_data),
            "generatedAt": datetime.fromtimestamp(generated_at, tz=settings.TIMEZONE).isoformat(),
            "generatedAtEpoch": generated_at,
        }
        await shared_store.set_json(
            self._chain_key(index_key),
            record,
            ttl_seconds=max(settings.OI_HISTORY_SHARED_CHAIN_SECONDS * 3, 900),
        )
        save_session(self._chain_session_key(index_key), record)

    async def read_chain(
        self,
        index_key: str,
        *,
        expiry: str | None = None,
        max_age_seconds: int | None = None,
    ) -> tuple[dict[str, Any], int, str | None] | None:
        record = await shared_store.get_json(self._chain_key(index_key))
        if record is None:
            persisted = load_session(self._chain_session_key(index_key))
            record = persisted.get("data") if persisted else None
        if not isinstance(record, dict) or not isinstance(record.get("data"), dict):
            return None
        generated_at = _as_float(record.get("generatedAtEpoch"))
        age = max(0, round(time.time() - generated_at)) if generated_at else 10**9
        if max_age_seconds is not None and age > max_age_seconds:
            return None
        data = copy.deepcopy(record["data"])
        if expiry and str(data.get("expiry") or "").upper() != expiry.upper():
            return None
        return data, age, str(record.get("generatedAt") or "") or None

    async def capture(
        self,
        index_key: str,
        chain_data: dict[str, Any],
        *,
        captured_at: datetime | None = None,
    ) -> dict[str, Any]:
        captured = captured_at or datetime.now(settings.TIMEZONE)
        expiry = str(chain_data.get("expiry") or "").strip()
        bucket = _bucket_at(captured, settings.OI_HISTORY_INTERVAL_MINUTES)
        lock_key = f"alpha:oi:capture:{index_key}:{expiry}:{int(bucket.timestamp())}"
        acquired = await shared_store.set_if_absent(
            lock_key,
            "1",
            ttl_seconds=max(settings.OI_HISTORY_INTERVAL_MINUTES * 60, 60),
        )
        if not acquired:
            return {"captured": False, "reason": "already-captured", "index": index_key, "expiry": expiry}

        await self.cache_chain(index_key, chain_data)
        previous_rows = await self._previous_rows(index_key, expiry)
        rows = build_oi_snapshot_rows(index_key, chain_data, previous_rows, captured_at=captured)
        await shared_store.set_json(
            self._latest_rows_key(index_key, expiry),
            {"rows": rows},
            ttl_seconds=max(settings.OI_HISTORY_RETENTION_DAYS * 86_400, 86_400),
        )
        await self._append_redis_history(index_key, expiry, rows)

        stored = False
        status = self.database_status(require_enabled=True)
        if status["ready"]:
            stored = await asyncio.to_thread(self._persist_rows, rows)
            if stored:
                await self._maybe_apply_retention(captured)
        else:
            logger.warning("OI snapshot kept in Redis only: %s", status["reason"])
        return {
            "captured": True,
            "stored": stored,
            "index": index_key,
            "expiry": expiry,
            "bucketAt": rows[0]["bucket_at"],
            "strikeCount": len(rows) - 1,
            "storage": "supabase+redis" if stored else "redis",
        }

    async def history(
        self,
        index_key: str,
        expiry: str,
        *,
        strike: float | None,
        limit: int,
    ) -> dict[str, Any]:
        safe_limit = min(max(limit, 1), settings.OI_HISTORY_REDIS_SNAPSHOTS)
        requested_expiry = expiry
        resolved_expiry = expiry
        rows: list[dict[str, Any]] = []
        storage = "redis"
        status = self.database_status()
        if status["ready"]:
            try:
                rows = await asyncio.to_thread(
                    self._query_history_rows,
                    index_key,
                    expiry,
                    strike,
                    safe_limit,
                )
                if rows:
                    storage = "supabase"
                else:
                    fallback_rows, latest_expiry = await asyncio.to_thread(
                        self._query_latest_history_rows,
                        index_key,
                        strike,
                        safe_limit,
                    )
                    if fallback_rows and latest_expiry:
                        rows = fallback_rows
                        resolved_expiry = latest_expiry
                        storage = "supabase"
            except Exception:
                logger.warning("OI history database read failed; using Redis history", exc_info=True)
        if not rows:
            rows = await self._redis_history_rows(index_key, expiry, strike, safe_limit)

        rows, session_date = _latest_session_rows(rows)
        snapshots = _group_history_rows(rows, strike)
        if len(snapshots) > safe_limit:
            snapshots = snapshots[-safe_limit:]
        return {
            "success": True,
            "enabled": settings.OI_HISTORY_ENABLED,
            "index": index_key,
            "expiry": resolved_expiry,
            "requestedExpiry": requested_expiry,
            "sessionDate": session_date,
            "strike": strike,
            "intervalMinutes": settings.OI_HISTORY_INTERVAL_MINUTES,
            "storage": storage,
            "snapshots": snapshots,
        }

    async def capture_due_indices(self) -> dict[str, Any]:
        if not settings.OI_HISTORY_ENABLED:
            return {"active": False, "reason": "disabled", "captured": []}
        database = self.database_status(require_enabled=True)
        if not database["ready"]:
            logger.error("OI capture disabled by database safety gate: %s", database["reason"])
            return {"active": False, "reason": database["reason"], "captured": []}
        if not is_market_hours():
            return {"active": False, "reason": "market-closed", "captured": []}

        from app.core.kite_client import kite_state
        from app.routes.options import (
            INDEX_CONFIG,
            _is_arrow_configured,
            get_cached_options_chain,
            get_options_chain,
            get_options_chain_arrow,
        )

        captured: list[dict[str, Any]] = []
        for index_key in settings.OI_HISTORY_INDICES:
            if index_key not in INDEX_CONFIG:
                logger.warning("Skipping unknown OI history index: %s", index_key)
                continue
            try:
                chain_data: dict[str, Any] | None = None
                local = get_cached_options_chain(index_key, 75)
                if local:
                    chain_data = local[0]
                if chain_data is None:
                    shared = await self.read_chain(index_key, max_age_seconds=75)
                    if shared:
                        chain_data = shared[0]
                if chain_data is None and _is_arrow_configured():
                    chain_data = await get_options_chain_arrow(
                        kite=kite_state.kite if kite_state.is_connected else None,
                        index_key=index_key,
                    )
                if chain_data is None and kite_state.is_connected:
                    chain_data = get_options_chain(kite_state.kite, index_key)
                if chain_data is None:
                    raise RuntimeError("Neither Arrow nor Kite is connected")
                captured.append(await self.capture(index_key, chain_data))
            except Exception as exc:
                logger.exception("Five-minute OI capture failed for %s", index_key)
                captured.append({"captured": False, "index": index_key, "reason": str(exc)[:180]})
        return {"active": True, "captured": captured}

    async def _previous_rows(self, index_key: str, expiry: str) -> list[dict[str, Any]]:
        cached = await shared_store.get_json(self._latest_rows_key(index_key, expiry))
        if cached and isinstance(cached.get("rows"), list):
            return cached["rows"]
        status = self.database_status()
        if not status["ready"]:
            return []
        try:
            return await asyncio.to_thread(self._query_previous_rows, index_key, expiry)
        except Exception:
            logger.warning("Could not load previous OI snapshot; starting a new baseline", exc_info=True)
            return []

    async def _append_redis_history(
        self,
        index_key: str,
        expiry: str,
        rows: list[dict[str, Any]],
    ) -> None:
        key = self._history_key(index_key, expiry)
        cached = await shared_store.get_json(key) or {"snapshots": []}
        snapshots = cached.get("snapshots") if isinstance(cached.get("snapshots"), list) else []
        bucket = rows[0]["bucket_at"]
        snapshots = [item for item in snapshots if item.get("bucketAt") != bucket]
        snapshots.append({"bucketAt": bucket, "rows": rows})
        snapshots = sorted(snapshots, key=lambda item: str(item.get("bucketAt") or ""))
        snapshots = snapshots[-settings.OI_HISTORY_REDIS_SNAPSHOTS:]
        await shared_store.set_json(
            key,
            {"snapshots": snapshots},
            ttl_seconds=max(settings.OI_HISTORY_RETENTION_DAYS * 86_400, 86_400),
        )

    async def _redis_history_rows(
        self,
        index_key: str,
        expiry: str,
        strike: float | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        cached = await shared_store.get_json(self._history_key(index_key, expiry)) or {}
        snapshots = cached.get("snapshots") if isinstance(cached.get("snapshots"), list) else []
        rows: list[dict[str, Any]] = []
        for snapshot in snapshots[-limit:]:
            for row in snapshot.get("rows") or []:
                if row.get("scope") == "overall":
                    rows.append(row)
                elif strike is not None and abs(_as_float(row.get("strike_price")) - strike) < 0.001:
                    rows.append(row)
        return rows

    def _persist_rows(self, rows: list[dict[str, Any]]) -> bool:
        from app.core.supabase_client import get_supabase_client

        client = get_supabase_client()
        for start in range(0, len(rows), 250):
            result = (
                client.table(TABLE_NAME)
                .upsert(
                    rows[start:start + 250],
                    on_conflict="index_key,expiry,bucket_at,scope,strike_price",
                )
                .execute()
            )
            if result.data is None:
                raise RuntimeError("Supabase did not acknowledge OI snapshot upsert")
        return True

    def _query_previous_rows(self, index_key: str, expiry: str) -> list[dict[str, Any]]:
        from app.core.supabase_client import get_supabase_client

        result = (
            get_supabase_client().table(TABLE_NAME)
            .select("*")
            .eq("index_key", index_key)
            .eq("expiry", expiry)
            .order("bucket_at", desc=True)
            .limit(250)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return []
        latest_bucket = rows[0].get("bucket_at")
        return [row for row in rows if row.get("bucket_at") == latest_bucket]

    def _query_history_rows(
        self,
        index_key: str,
        expiry: str,
        strike: float | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        from app.core.supabase_client import get_supabase_client

        client = get_supabase_client()
        overall = (
            client.table(TABLE_NAME)
            .select("*")
            .eq("index_key", index_key)
            .eq("expiry", expiry)
            .eq("scope", "overall")
            .order("bucket_at", desc=True)
            .limit(limit)
            .execute()
        ).data or []
        rows = list(overall)
        if strike is not None:
            strike_rows = (
                client.table(TABLE_NAME)
                .select("*")
                .eq("index_key", index_key)
                .eq("expiry", expiry)
                .eq("scope", "strike")
                .eq("strike_price", strike)
                .order("bucket_at", desc=True)
                .limit(limit)
                .execute()
            ).data or []
            rows.extend(strike_rows)
        return rows

    def _query_latest_history_rows(
        self,
        index_key: str,
        strike: float | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """Read the newest stored contract when the live chain has rolled expiry.

        Querying the rows directly avoids a separate expiry lookup that can leave
        the UI empty during the overnight rollover between weekly contracts.
        """
        from app.core.supabase_client import get_supabase_client

        client = get_supabase_client()
        overall = (
            client.table(TABLE_NAME)
            .select("*")
            .eq("index_key", index_key)
            .eq("scope", "overall")
            .order("bucket_at", desc=True)
            .limit(limit)
            .execute()
        ).data or []
        if not overall:
            return [], None

        latest_expiry = str(overall[0].get("expiry") or "").strip()
        if not latest_expiry:
            return [], None
        rows = [
            row
            for row in overall
            if str(row.get("expiry") or "").strip().upper() == latest_expiry.upper()
        ]
        if strike is not None:
            strike_rows = (
                client.table(TABLE_NAME)
                .select("*")
                .eq("index_key", index_key)
                .eq("expiry", latest_expiry)
                .eq("scope", "strike")
                .eq("strike_price", strike)
                .order("bucket_at", desc=True)
                .limit(limit)
                .execute()
            ).data or []
            rows.extend(strike_rows)
        return rows, latest_expiry

    async def _maybe_apply_retention(self, captured_at: datetime) -> None:
        key = f"alpha:oi:retention:{captured_at.date().isoformat()}"
        if not await shared_store.set_if_absent(key, "1", ttl_seconds=86_400):
            return
        cutoff = captured_at.astimezone(timezone.utc) - timedelta(days=settings.OI_HISTORY_RETENTION_DAYS)
        try:
            await asyncio.to_thread(self._delete_before, cutoff.isoformat())
        except Exception:
            logger.warning("OI history retention cleanup failed", exc_info=True)

    def _delete_before(self, cutoff: str) -> None:
        from app.core.supabase_client import get_supabase_client

        get_supabase_client().table(TABLE_NAME).delete().lt("bucket_at", cutoff).execute()

    @staticmethod
    def _chain_key(index_key: str) -> str:
        return f"alpha:oi:chain:{index_key}"

    @staticmethod
    def _chain_session_key(index_key: str) -> str:
        return f"shared_options_{index_key}"

    @staticmethod
    def _latest_rows_key(index_key: str, expiry: str) -> str:
        return f"alpha:oi:latest:{index_key}:{expiry.upper()}"

    @staticmethod
    def _history_key(index_key: str, expiry: str) -> str:
        return f"alpha:oi:history:{index_key}:{expiry.upper()}"


oi_history_service = OIHistoryService()
