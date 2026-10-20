"""
Alpha Radar backend -- FastAPI application entry point.
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.request_rate_limiter import request_identity, request_rate_limiter

logger = logging.getLogger("alpha_radar")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# ---------------------------------------------------------------------------
# Kite session persistence helpers
# ---------------------------------------------------------------------------
KITE_TOKEN_PATH = settings.DATA_DIR / "kite_token.json"

SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cache-Control": "no-store",
}

RATE_LIMIT_EXEMPT_PATHS = (
    "/api/health",
    "/docs",
    "/openapi.json",
)
RATE_LIMIT_REFRESH_PATHS = (
    "/api/market-snapshots/rescan",
    "/api/snapshots/warm",
    "/api/performance/run-outcome-check",
)


def _rate_limit_for_path(request: Request) -> tuple[int, str] | None:
    """Return an identity-aware cap; normal cached feed reads stay lightweight."""
    path = request.url.path
    if any(path == exempt or path.startswith(f"{exempt}/") for exempt in RATE_LIMIT_EXEMPT_PATHS):
        return None
    if not path.startswith("/api/"):
        return None
    if request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"} and any(
        path.startswith(prefix) for prefix in RATE_LIMIT_REFRESH_PATHS
    ):
        return settings.API_REFRESH_RATE_LIMIT_MAX_REQUESTS, "refresh"
    return settings.API_RATE_LIMIT_MAX_REQUESTS, "api"


async def _check_rate_limit(request: Request) -> JSONResponse | None:
    """Apply a Redis-backed per-user limiter without penalising cached feeds."""
    path_limit = _rate_limit_for_path(request)
    if path_limit is None:
        return None

    max_requests, bucket_class = path_limit
    result = await request_rate_limiter.allow(
        identity=request_identity(request),
        bucket=bucket_class,
        limit=max_requests,
        window_seconds=settings.API_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not result.allowed:
        return JSONResponse(
            status_code=429,
            content={"detail": "This action is temporarily busy. Your latest saved market view remains available; please retry shortly."},
            headers={"Retry-After": str(result.retry_after)},
        )
    return None


def _load_saved_kite_token() -> None:
    """Attempt to restore a previously saved Kite access token."""
    if not KITE_TOKEN_PATH.exists():
        logger.info("No saved Kite token found at %s", KITE_TOKEN_PATH)
        return
    try:
        data = json.loads(KITE_TOKEN_PATH.read_text())
        access_token: str = data.get("access_token", "")
        saved_date: str = data.get("date", "")
        today = datetime.now(settings.TIMEZONE).strftime("%Y-%m-%d")
        if access_token and saved_date == today:
            # Lazy import to avoid circular deps at module level
            from app.core.kite_client import kite_state  # noqa: WPS433
            kite_state.set_access_token(access_token)
            logger.info("Restored Kite access token from %s", saved_date)
        else:
            logger.info("Saved Kite token is stale (%s vs %s), skipping", saved_date, today)
    except Exception:
        logger.exception("Failed to load saved Kite token")


def _save_kite_token() -> None:
    """Persist the current Kite access token to disk so it survives restarts."""
    try:
        from app.core.kite_client import kite_state  # noqa: WPS433
        token = kite_state.access_token
        if not token:
            return
        settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
        today = datetime.now(settings.TIMEZONE).strftime("%Y-%m-%d")
        KITE_TOKEN_PATH.write_text(json.dumps({"access_token": token, "date": today}))
        logger.info("Saved Kite access token to disk")
    except Exception:
        logger.exception("Failed to save Kite token")


async def _warm_instrument_cache(reason: str = "scheduled") -> None:
    """Refresh Kite instrument master without blocking the event loop."""
    try:
        import asyncio
        from app.caches import instrument_cache  # noqa: WPS433
        from app.core.kite_client import kite_state  # noqa: WPS433

        if not kite_state.is_connected:
            logger.info("Instrument cache warm skipped (%s); Kite is not connected", reason)
            return

        loop = asyncio.get_running_loop()
        loaded = await loop.run_in_executor(None, instrument_cache.load_instruments, kite_state.kite)
        logger.info("Instrument cache warmed (%s): %d instruments", reason, loaded)
    except Exception:
        logger.exception("Instrument cache warm failed (%s)", reason)


def _schedule_instrument_cache_warm() -> None:
    """Warm Kite instrument master in the background after token restore."""
    try:
        import asyncio

        asyncio.create_task(_warm_instrument_cache("startup"))
    except RuntimeError:
        logger.exception("Instrument cache warm could not be scheduled")
    except Exception:
        logger.exception("Instrument cache warm setup failed")


def _register_instrument_cache_jobs() -> None:
    """Keep scanner token lookup hot before and during market hours."""
    try:
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler

        IST = str(settings.TIMEZONE)
        sched = get_scheduler()
        sched.add_job(
            _warm_instrument_cache,
            args=["scheduled"],
            trigger=CronTrigger(minute="*/45", hour="7-16", day_of_week="mon-fri", timezone=IST),
            id="instrument_cache_refresh",
            name="Refresh Kite instrument cache",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        start_scheduler()
        logger.info("Instrument cache refresh registered (every 45 min, 07-16 IST)")
    except Exception:
        logger.exception("Failed to register instrument cache refresh")


# ---------------------------------------------------------------------------
# Arrow automated login
# ---------------------------------------------------------------------------
async def _run_arrow_auto_login(reason: str = "scheduled") -> dict:
    """Refresh Arrow credentials and notify admins only when unattended login fails."""
    from html import escape

    from app.services import arrow_market_data_service as arrow  # noqa: WPS433

    result = await arrow.auto_login(reason=reason)
    if result.get("success"):
        return result

    error = str(result.get("error") or "Unknown Arrow login error")
    logger.error("Arrow auto-login did not complete (%s): %s", reason, error)
    if reason in {"scheduled", "startup"} and settings.TELEGRAM_TOKEN and settings.TELEGRAM_CHAT_ID:
        try:
            from app.core.telegram import send_message  # noqa: WPS433

            await send_message(
                "<b>Alpha Radar: Arrow login failed</b>\n"
                f"Reason: {escape(reason)}\n"
                f"Error: {escape(error)}\n"
                "Open Alpha Login and use the manual Arrow login fallback."
            )
        except Exception:
            logger.exception("Could not send Arrow auto-login failure alert")
    return result


def _register_arrow_auto_login_job() -> None:
    """Register Arrow's supported TOTP auto-login for weekday mornings."""
    if not settings.ARROW_AUTO_LOGIN_ENABLED:
        logger.info("Arrow auto-login is disabled")
        return
    if not 0 <= settings.ARROW_AUTO_LOGIN_HOUR <= 23 or not 0 <= settings.ARROW_AUTO_LOGIN_MINUTE <= 59:
        logger.error("Arrow auto-login schedule is invalid")
        return

    try:
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler

        sched = get_scheduler()
        sched.add_job(
            _run_arrow_auto_login,
            kwargs={"reason": "scheduled"},
            trigger=CronTrigger(
                hour=settings.ARROW_AUTO_LOGIN_HOUR,
                minute=settings.ARROW_AUTO_LOGIN_MINUTE,
                day_of_week="mon-fri",
                timezone=str(settings.TIMEZONE),
            ),
            id="arrow_auto_login",
            name="Refresh Arrow access token",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=30 * 60,
        )
        start_scheduler()
        logger.info(
            "Arrow auto-login registered (%02d:%02d IST Mon-Fri)",
            settings.ARROW_AUTO_LOGIN_HOUR,
            settings.ARROW_AUTO_LOGIN_MINUTE,
        )
    except Exception:
        logger.exception("Failed to register Arrow auto-login")


async def _maybe_auto_login_arrow_on_startup() -> None:
    """Catch up after a market-hours restart when the morning job was missed."""
    if not settings.ARROW_AUTO_LOGIN_ENABLED:
        return

    now = datetime.now(settings.TIMEZONE)
    scheduled_at = now.replace(
        hour=settings.ARROW_AUTO_LOGIN_HOUR,
        minute=settings.ARROW_AUTO_LOGIN_MINUTE,
        second=0,
        microsecond=0,
    )
    market_closed_at = now.replace(
        hour=settings.MARKET_CLOSE.hour,
        minute=settings.MARKET_CLOSE.minute,
        second=0,
        microsecond=0,
    )
    if now.weekday() >= 5 or now < scheduled_at or now > market_closed_at:
        return

    from app.services import arrow_market_data_service as arrow  # noqa: WPS433

    if arrow.saved_access_token_is_fresh(minimum_remaining=timedelta(minutes=30)):
        logger.info("Arrow startup auto-login skipped; saved token is still fresh")
        return
    await _run_arrow_auto_login("startup")


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
def _register_signal_validator_jobs() -> None:
    """Register outcome-check cron jobs for the signal validation tracker."""
    try:
        import asyncio
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler

        from app.services.signal_validator import check_outcomes_for_horizon

        IST = str(settings.TIMEZONE)

        async def _run_check(horizon: str) -> None:
            from app.core.kite_client import kite_state  # noqa: WPS433
            if not kite_state.is_connected:
                return
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None, check_outcomes_for_horizon, horizon, kite_state.kite
            )

        sched = get_scheduler()

        # 15m outcomes — every 5 min during 09:30–16:00 IST
        sched.add_job(
            _run_check, args=["15m"],
            trigger=CronTrigger(minute="*/5", hour="9-16", timezone=IST),
            id="validate_15m", name="Validate 15m outcomes",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        # 1h outcomes — every 15 min during 10:00–17:00 IST
        sched.add_job(
            _run_check, args=["1h"],
            trigger=CronTrigger(minute="0,15,30,45", hour="10-17", timezone=IST),
            id="validate_1h", name="Validate 1h outcomes",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        # EOD outcomes — daily at 15:35 IST
        sched.add_job(
            _run_check, args=["eod"],
            trigger=CronTrigger(hour=15, minute=35, timezone=IST),
            id="validate_eod", name="Validate EOD outcomes",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        # Next-day-EOD outcomes — daily at 15:40 IST (yesterday's fires)
        sched.add_job(
            _run_check, args=["next_day_eod"],
            trigger=CronTrigger(hour=15, minute=40, timezone=IST),
            id="validate_next_day_eod", name="Validate next-day-EOD outcomes",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        for offset, horizon in enumerate(("3d", "5d", "10d", "20d")):
            sched.add_job(
                _run_check,
                args=[horizon],
                trigger=CronTrigger(
                    hour=15,
                    minute=45 + offset,
                    day_of_week="mon-fri",
                    timezone=IST,
                ),
                id=f"validate_swing_{horizon}",
                name=f"Validate {horizon} Swing outcomes",
                replace_existing=True,
                max_instances=1,
                coalesce=True,
            )

        # Daily Telegram digest — 16:00 IST weekdays, after EOD validations finish
        from app.services.signal_validator import send_daily_digest

        async def _run_daily_digest() -> None:
            try:
                await send_daily_digest()
            except Exception:
                logger.exception("Daily digest failed")

        sched.add_job(
            _run_daily_digest,
            trigger=CronTrigger(hour=16, minute=0, day_of_week="mon-fri", timezone=IST),
            id="signal_daily_digest", name="Daily signal validator digest (Telegram)",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )

        start_scheduler()
        logger.info("Signal validator scheduler started with %d jobs",
                    len(sched.get_jobs()))
    except Exception:
        logger.exception("Failed to register signal validator jobs")


def _register_rrg_jobs() -> None:
    """Register the RRG end-of-day recompute job (16:15 IST Mon-Fri).

    Runs after NSE close. Idempotent — re-runs upsert the latest bars and
    recompute the rolling window. The job no-ops if Kite isn't connected.
    """
    try:
        import asyncio
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler

        from app.services.rrg_service import run_eod

        IST = str(settings.TIMEZONE)

        async def _run_rrg_eod() -> None:
            from app.core.kite_client import kite_state  # noqa: WPS433
            if not kite_state.is_connected:
                logger.info("RRG: skipping scheduled EOD — Kite not connected")
                return
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, run_eod, 400)
            except Exception:
                logger.exception("RRG: scheduled EOD run failed")

        sched = get_scheduler()
        sched.add_job(
            _run_rrg_eod,
            trigger=CronTrigger(
                hour=16, minute=15, day_of_week="mon-fri", timezone=IST
            ),
            id="rrg_eod", name="RRG end-of-day recompute",
            replace_existing=True,
        )

        start_scheduler()
        logger.info("RRG EOD job registered (16:15 IST Mon-Fri)")
    except Exception:
        logger.exception("Failed to register RRG jobs")


def _register_snapshot_warm_jobs() -> None:
    """Keep replay snapshots usable without forcing traders to click warmers."""
    try:
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler
        from app.routes.snapshots import warm_next_replay_snapshots

        IST = str(settings.TIMEZONE)

        close_snapshot_keys = [
            "indices",
            "top_movers",
            "intraday_radar",
            "abnormal_live",
            "swing_spectrum",
            "sector_momentum",
        ]
        market_context_keys = [
            "indices",
            "top_movers",
            "breadth",
            "pulse",
            "quote_sectors",
            "hot_cold_indices",
            "live_signals",
            "orb_signals",
        ]
        swing_snapshot_keys = [
            "swing_spectrum",
            "sector_momentum",
        ]
        surveillance_snapshot_keys = [
            "abnormal_live",
        ]

        async def _run_snapshot_warmer(
            limit: int = 2,
            keys: list[str] | None = None,
            symbol_limit: int = 120,
        ) -> None:
            try:
                result = await warm_next_replay_snapshots(
                    limit=limit,
                    universe="nifty200",
                    symbol_limit=symbol_limit,
                    keys=keys,
                )
                if result.get("requested") or result.get("failed"):
                    logger.info(
                        "Snapshot replay warmer: requested=%s warmed=%s failed=%s skipped=%s",
                        result.get("requested"),
                        result.get("warmed"),
                        result.get("failed"),
                        result.get("skipped"),
                    )
            except Exception:
                logger.exception("Snapshot replay warmer failed")

        async def _run_full_swing_warmer() -> None:
            """Build one complete Nifty 500 swing snapshot after the close."""
            try:
                result = await warm_next_replay_snapshots(
                    limit=1,
                    universe="nifty500",
                    symbol_limit=500,
                    keys=["swing_spectrum"],
                )
                logger.info(
                    "Full Swing warmer: requested=%s warmed=%s failed=%s",
                    result.get("requested"),
                    result.get("warmed"),
                    result.get("failed"),
                )
            except Exception:
                logger.exception("Full Nifty 500 Swing warmer failed")

        sched = get_scheduler()
        sched.add_job(
            _run_snapshot_warmer,
            trigger=CronTrigger(minute="*/30", hour="9-15", day_of_week="mon-fri", timezone=IST),
            id="snapshot_replay_warmer",
            name="Warm stale replay snapshots",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger=CronTrigger(minute="2,12,22,32,42,52", hour="9-15", day_of_week="mon-fri", timezone=IST),
            args=[len(market_context_keys), market_context_keys, 80],
            id="snapshot_market_context_warmer",
            name="Refresh market context replay snapshots",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger=CronTrigger(hour=15, minute=45, day_of_week="mon-fri", timezone=IST),
            args=[len(close_snapshot_keys), close_snapshot_keys, 160],
            id="snapshot_replay_warmer_close",
            name="Refresh priority replay snapshots after close",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        sched.add_job(
            _run_full_swing_warmer,
            trigger=CronTrigger(hour=16, minute=30, day_of_week="mon-fri", timezone=IST),
            id="snapshot_swing_warmer_full_close",
            name="Refresh complete Nifty 500 Swing snapshot after close",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger=CronTrigger(minute="5,35", hour="10-14", day_of_week="mon-fri", timezone=IST),
            args=[len(swing_snapshot_keys), swing_snapshot_keys, 160],
            id="snapshot_swing_warmer_market",
            name="Refresh Swing replay snapshots during market",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger=CronTrigger(minute="17,47", hour="9-15", day_of_week="mon-fri", timezone=IST),
            args=[len(surveillance_snapshot_keys), surveillance_snapshot_keys, 160],
            id="snapshot_surveillance_warmer_market",
            name="Refresh surveillance replay snapshots during market",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger="date",
            run_date=datetime.now(settings.TIMEZONE) + timedelta(seconds=45),
            args=[4],
            id="snapshot_replay_warmer_startup",
            name="Warm stale replay snapshots after startup",
            replace_existing=True,
            max_instances=1,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger="date",
            run_date=datetime.now(settings.TIMEZONE) + timedelta(seconds=90),
            args=[len(swing_snapshot_keys), swing_snapshot_keys, 160],
            id="snapshot_swing_warmer_startup",
            name="Refresh Swing replay snapshots after startup",
            replace_existing=True,
            max_instances=1,
        )
        sched.add_job(
            _run_snapshot_warmer,
            trigger="date",
            run_date=datetime.now(settings.TIMEZONE) + timedelta(seconds=120),
            args=[len(surveillance_snapshot_keys), surveillance_snapshot_keys, 160],
            id="snapshot_surveillance_warmer_startup",
            name="Refresh surveillance replay snapshots after startup",
            replace_existing=True,
            max_instances=1,
        )

        start_scheduler()
        logger.info("Snapshot replay warmer registered (startup kick + market context + swing + surveillance + close refresh)")
    except Exception:
        logger.exception("Failed to register snapshot replay warmer")


def _register_alert_evaluator_jobs() -> None:
    """Evaluate saved cockpit alert rules during market hours."""
    try:
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler
        from app.routes.alerts import evaluate_all_alert_rules

        IST = str(settings.TIMEZONE)

        async def _run_alert_evaluator() -> None:
            try:
                from app.core.kite_client import kite_state  # noqa: WPS433
                result = await evaluate_all_alert_rules(
                    quote_provider="arrow_first",
                    max_near_pct=0.5,
                    kite=kite_state.kite if kite_state.is_connected else None,
                )
                summary = result.get("summary") or {}
                if summary.get("total"):
                    logger.info(
                        "Alert evaluator: total=%s triggered=%s near=%s",
                        summary.get("total"),
                        summary.get("triggered"),
                        summary.get("near"),
                    )
            except Exception:
                logger.exception("Alert evaluator failed")

        sched = get_scheduler()
        sched.add_job(
            _run_alert_evaluator,
            trigger=CronTrigger(minute="*/2", hour="9-15", day_of_week="mon-fri", timezone=IST),
            id="alert_rule_evaluator",
            name="Evaluate saved cockpit alert rules",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )

        start_scheduler()
        logger.info("Alert evaluator registered (every 2 min, market hours)")
    except Exception:
        logger.exception("Failed to register alert evaluator")


def _register_shared_market_snapshot_jobs() -> None:
    """Run the single low-cost market refresh worker inside the API process."""
    try:
        from apscheduler.triggers.interval import IntervalTrigger
        from app.core.scheduler import get_scheduler, start_scheduler
        from app.services.market_snapshot_service import market_snapshot_service

        async def _refresh_due_market_snapshots() -> None:
            result = await market_snapshot_service.refresh_due_snapshots()
            if result.get("queued"):
                logger.info("Shared market refresh worker queued: %s", ", ".join(result["queued"]))

        sched = get_scheduler()
        sched.add_job(
            _refresh_due_market_snapshots,
            trigger=IntervalTrigger(seconds=5, timezone=str(settings.TIMEZONE)),
            id="shared_market_snapshot_refresh",
            name="Refresh active shared market snapshots",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        start_scheduler()
        logger.info("Shared market refresh worker registered (5s due check; 30/60s feed cadence)")
    except Exception:
        logger.exception("Failed to register shared market snapshot worker")


def _register_oi_history_jobs() -> None:
    """Capture one shared, durable option-chain snapshot every five minutes."""
    if not settings.OI_HISTORY_ENABLED:
        logger.info("Five-minute OI history is disabled")
        return
    try:
        from apscheduler.triggers.cron import CronTrigger
        from app.core.scheduler import get_scheduler, start_scheduler
        from app.services.oi_history_service import oi_history_service

        database = oi_history_service.database_status(require_enabled=True)
        if not database["ready"]:
            logger.error("Five-minute OI history not registered: %s", database["reason"])
            return

        async def _capture_oi_history() -> None:
            result = await oi_history_service.capture_due_indices()
            completed = [
                row["index"]
                for row in result.get("captured") or []
                if row.get("captured")
            ]
            if completed:
                logger.info("Five-minute OI history captured: %s", ", ".join(completed))

        sched = get_scheduler()
        sched.add_job(
            _capture_oi_history,
            trigger=CronTrigger(
                minute=f"*/{max(1, settings.OI_HISTORY_INTERVAL_MINUTES)}",
                hour="9-15",
                day_of_week="mon-fri",
                timezone=str(settings.TIMEZONE),
            ),
            id="option_oi_history_capture",
            name="Capture overall and strike OI history",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=120,
        )
        start_scheduler()
        logger.info(
            "Five-minute OI history registered (%s; every %d min)",
            ", ".join(settings.OI_HISTORY_INDICES),
            settings.OI_HISTORY_INTERVAL_MINUTES,
        )
    except Exception:
        logger.exception("Failed to register five-minute OI history")


def _register_intraday_breakout_jobs() -> None:
    """Evaluate premium retracement breakouts from the existing Runner stream."""
    try:
        from apscheduler.triggers.interval import IntervalTrigger
        from app.core.scheduler import get_scheduler, start_scheduler
        from app.services.intraday_breakout_service import intraday_breakout_service

        sched = get_scheduler()
        sched.add_job(
            intraday_breakout_service.refresh,
            trigger=IntervalTrigger(
                seconds=max(15, settings.INTRADAY_BREAKOUT_REFRESH_SECONDS),
                timezone=str(settings.TIMEZONE),
            ),
            id="intraday_breakout_refresh",
            name="Evaluate premium intraday retracement breakouts",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        start_scheduler()
        logger.info(
            "Intraday breakout evaluator registered (every %ds; shared Runner feed)",
            max(15, settings.INTRADAY_BREAKOUT_REFRESH_SECONDS),
        )
    except Exception:
        logger.exception("Failed to register intraday breakout evaluator")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Startup / shutdown lifecycle."""
    # -- startup --
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Data directory ensured at %s", settings.DATA_DIR.resolve())
    from app.services.market_snapshot_service import market_snapshot_service
    await market_snapshot_service.start()
    _load_saved_kite_token()
    _register_arrow_auto_login_job()
    await _maybe_auto_login_arrow_on_startup()
    _schedule_instrument_cache_warm()
    _register_instrument_cache_jobs()
    _register_signal_validator_jobs()
    _register_rrg_jobs()
    _register_snapshot_warm_jobs()
    _register_alert_evaluator_jobs()
    _register_shared_market_snapshot_jobs()
    _register_oi_history_jobs()
    try:
        from app.services.runner_service import runner_service  # noqa: WPS433
        await runner_service.start()
    except Exception:
        logger.exception("Runner startup failed; existing Alpha Radar services remain available")
    try:
        from app.services.intraday_breakout_service import intraday_breakout_service  # noqa: WPS433
        await intraday_breakout_service.start()
        _register_intraday_breakout_jobs()
    except Exception:
        logger.exception("Intraday breakout startup failed; Alpha Radar remains available")
    logger.info("Alpha Radar backend started")
    yield
    # -- shutdown --
    _save_kite_token()
    try:
        from app.services.intraday_breakout_service import intraday_breakout_service  # noqa: WPS433
        await intraday_breakout_service.stop()
    except Exception:
        logger.debug("Intraday breakout shutdown failed", exc_info=True)
    try:
        from app.services.runner_service import runner_service  # noqa: WPS433
        await runner_service.stop()
    except Exception:
        logger.exception("Runner shutdown flush failed")
    try:
        await market_snapshot_service.stop()
    except Exception:
        logger.debug("Shared market snapshot shutdown failed", exc_info=True)
    try:
        from app.core.scheduler import stop_scheduler  # noqa: WPS433
        stop_scheduler()
    except Exception:
        pass
    try:
        from app.dependencies import close_auth_http_client  # noqa: WPS433
        await close_auth_http_client()
    except Exception:
        logger.exception("Supabase Auth client shutdown failed")
    logger.info("Alpha Radar backend stopped")


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Alpha Radar API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers_and_rate_limit(request: Request, call_next):
    """Attach browser security headers and throttle hot API paths."""
    if request.method != "OPTIONS":
        rate_limited = await _check_rate_limit(request)
        if rate_limited is not None:
            for key, value in SECURITY_HEADERS.items():
                rate_limited.headers.setdefault(key, value)
            return rate_limited

    response = await call_next(request)
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health() -> dict:
    """Health-check endpoint."""
    from app.core.kite_client import kite_state  # noqa: WPS433
    from app.core.shared_store import shared_store  # noqa: WPS433
    try:
        from app.caches import instrument_cache  # noqa: WPS433
        instrument_count = instrument_cache.size()
    except Exception:
        logger.debug("Could not read instrument cache size", exc_info=True)
        instrument_count = 0

    return {
        "status": "ok",
        "kiteConnected": kite_state.is_connected,
        "instrumentCacheReady": instrument_count > 0,
        "instrumentCacheSize": instrument_count,
        "redisConnected": shared_store.available,
        "timestamp": datetime.now(settings.TIMEZONE).isoformat(),
    }


# ---------------------------------------------------------------------------
# WebSocket hub -- delegates to core.websocket_hub for full functionality
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Real-time market data WebSocket with options subscription support."""
    from app.core.websocket_hub import ws_hub  # noqa: WPS433

    await ws_hub.connect(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            await ws_hub.handle_message(websocket, raw)
    except WebSocketDisconnect:
        ws_hub.disconnect(websocket)


# ---------------------------------------------------------------------------
# Mount routers (imported lazily so missing modules don't break startup)
# ---------------------------------------------------------------------------
def _mount_routers() -> None:
    """Import and include all API routers."""
    import importlib

    router_modules = [
        "app.routes.auth",
        "app.routes.health",
        "app.routes.quotes",
        "app.routes.options",
        "app.routes.signals",
        "app.routes.signal_stats",
        "app.routes.admin_subscribers",
        "app.routes.performance",
        "app.routes.scanner",
        "app.routes.us_research",
        "app.routes.pulse",
        "app.routes.squeeze",
        "app.routes.bounce",
        "app.routes.institutional",
        "app.routes.market",
        "app.routes.analysis",
        "app.routes.fno",
        "app.routes.subscription",
        "app.routes.coupons",
        "app.routes.feedback",
        "app.routes.user",
        "app.routes.history",
        "app.routes.rrg",
        "app.routes.intraday",
        "app.routes.arrow",
        "app.routes.abnormal",
        "app.routes.alerts",
        "app.routes.algos",
        "app.routes.snapshots",
        "app.routes.market_snapshots",
        "app.routes.runner",
        "app.routes.nifty_pulse",
    ]
    for module_path in router_modules:
        try:
            mod = importlib.import_module(module_path)
            router = getattr(mod, "router")
            app.include_router(router)
            logger.info("✅ Mounted %s", module_path)
        except ModuleNotFoundError:
            logger.warning("⚠️  Router module %s not found -- skipped", module_path)
        except Exception:
            logger.exception("❌ Failed to mount %s", module_path)


_mount_routers()
