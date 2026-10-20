"""
Application configuration loaded from environment variables.
"""

import os
from dataclasses import dataclass, field
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

load_dotenv()


def _env_bool(name: str, default: bool = False) -> bool:
    """Parse common truthy environment values without surprising bool casts."""
    fallback = "true" if default else "false"
    return os.getenv(name, fallback).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class TierLimits:
    """Rate/usage limits for a subscription tier."""
    quotes_batch_max: int
    signal_log_max: int


@dataclass(frozen=True)
class Settings:
    """Central application settings sourced from environment variables."""

    # --- Kite Connect ---
    KITE_API_KEY: str = os.getenv("KITE_API_KEY", "")
    KITE_API_SECRET: str = os.getenv("KITE_API_SECRET", "")

    # --- Arrow Trade API ---
    MARKET_DATA_PROVIDER: str = os.getenv("MARKET_DATA_PROVIDER", "kite").lower()
    ARROW_BASE_URL: str = os.getenv("ARROW_BASE_URL", "https://edge.arrow.trade")
    ARROW_LOGIN_URL: str = os.getenv("ARROW_LOGIN_URL", "https://app.arrow.trade/app/login")
    ARROW_APP_ID: str = os.getenv("ARROW_APP_ID", "")
    ARROW_APP_SECRET: str = os.getenv("ARROW_APP_SECRET", "")
    ARROW_ACCESS_TOKEN: str = os.getenv("ARROW_ACCESS_TOKEN", "")
    ARROW_AUTO_LOGIN_ENABLED: bool = _env_bool("ARROW_AUTO_LOGIN_ENABLED")
    ARROW_USER_ID: str = os.getenv("ARROW_USER_ID", "")
    ARROW_PASSWORD: str = os.getenv("ARROW_PASSWORD", "")
    ARROW_TOTP_SECRET: str = os.getenv("ARROW_TOTP_SECRET", "")
    ARROW_AUTO_LOGIN_HOUR: int = int(os.getenv("ARROW_AUTO_LOGIN_HOUR", "8"))
    ARROW_AUTO_LOGIN_MINUTE: int = int(os.getenv("ARROW_AUTO_LOGIN_MINUTE", "30"))
    ARROW_PRICE_SCALE: float = float(os.getenv("ARROW_PRICE_SCALE", "100"))

    # --- Supabase ---
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_SERVICE_ROLE_KEY: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    SUPABASE_ANON_KEY: str = os.getenv("SUPABASE_ANON_KEY", "")

    # --- Durable OI history (Alpha Radar Supabase only) ---
    # Writes stay off unless both the feature flag and the expected Alpha Radar
    # project ref are configured. This prevents a reused service-role key from
    # sending Alpha Radar market history to another product's database.
    ALPHA_RADAR_SUPABASE_PROJECT_REF: str = os.getenv("ALPHA_RADAR_SUPABASE_PROJECT_REF", "")
    OI_HISTORY_ENABLED: bool = _env_bool("OI_HISTORY_ENABLED")
    OI_HISTORY_INTERVAL_MINUTES: int = int(os.getenv("OI_HISTORY_INTERVAL_MINUTES", "5"))
    OI_HISTORY_SHARED_CHAIN_SECONDS: int = int(os.getenv("OI_HISTORY_SHARED_CHAIN_SECONDS", "360"))
    OI_HISTORY_REDIS_SNAPSHOTS: int = int(os.getenv("OI_HISTORY_REDIS_SNAPSHOTS", "96"))
    OI_HISTORY_RETENTION_DAYS: int = int(os.getenv("OI_HISTORY_RETENTION_DAYS", "30"))
    OI_HISTORY_INDICES: tuple[str, ...] = tuple(
        item.strip().lower()
        for item in os.getenv(
            "OI_HISTORY_INDICES",
            "nifty,banknifty,finnifty,midcpnifty,sensex",
        ).split(",")
        if item.strip()
    )

    # --- Razorpay ---
    RAZORPAY_KEY_ID: str = os.getenv("RAZORPAY_KEY_ID", "")
    RAZORPAY_KEY_SECRET: str = os.getenv("RAZORPAY_KEY_SECRET", "")
    RAZORPAY_PLAN_ID: str = os.getenv("RAZORPAY_PLAN_ID", "")
    RAZORPAY_WEBHOOK_SECRET: str = os.getenv("RAZORPAY_WEBHOOK_SECRET", "")

    # --- Transactional email (Resend) ---
    RESEND_API_KEY: str = os.getenv("RESEND_API_KEY", "")
    PAYMENT_EMAIL_FROM: str = os.getenv("PAYMENT_EMAIL_FROM", "")

    # --- Domain ---
    DOMAIN: str = os.getenv("DOMAIN", "localhost")

    # --- Telegram ---
    TELEGRAM_TOKEN: str = os.getenv("TELEGRAM_TOKEN", "")
    TELEGRAM_CHAT_ID: str = os.getenv("TELEGRAM_CHAT_ID", "")

    # --- Admin ---
    ADMIN_SECRET: str = os.getenv("ADMIN_SECRET", "")
    ADMIN_EMAILS: tuple[str, ...] = tuple(
        email.strip().lower()
        for email in os.getenv("ADMIN_EMAILS", "charan@trezofin.ai,balaji.kdutta@gmail.com").split(",")
        if email.strip()
    )

    # --- Server ---
    PORT: int = int(os.getenv("PORT", "8000"))
    CORS_ORIGINS: list[str] = field(default_factory=lambda: [
        o.strip()
        for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
        if o.strip()
    ])
    AUTH_REDIRECT_URL: str = os.getenv("AUTH_REDIRECT_URL", "http://localhost:3000")

    # --- Storage ---
    DATA_DIR: Path = Path(os.getenv("DATA_DIR", "./data"))

    # --- Shared cache / market refresh ---
    # Redis is intentionally local in phase one. The application degrades to
    # in-process state if it is temporarily unavailable, but production should
    # keep this pointed at localhost so locks survive API request concurrency.
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    REDIS_CONNECT_TIMEOUT_SECONDS: float = float(os.getenv("REDIS_CONNECT_TIMEOUT_SECONDS", "1.5"))
    REDIS_RECONNECT_SECONDS: float = float(os.getenv("REDIS_RECONNECT_SECONDS", "30"))
    MARKET_ACTIVE_TTL_SECONDS: int = int(os.getenv("MARKET_ACTIVE_TTL_SECONDS", "90"))
    MARKET_CORE_REFRESH_SECONDS: int = int(os.getenv("MARKET_CORE_REFRESH_SECONDS", "30"))
    MARKET_BROAD_REFRESH_SECONDS: int = int(os.getenv("MARKET_BROAD_REFRESH_SECONDS", "60"))
    MARKET_MANUAL_RESCAN_COOLDOWN_SECONDS: int = int(os.getenv("MARKET_MANUAL_RESCAN_COOLDOWN_SECONDS", "60"))
    MARKET_SNAPSHOT_RETENTION_SECONDS: int = int(os.getenv("MARKET_SNAPSHOT_RETENTION_SECONDS", "900"))

    # Conservative operation budgets. Individual Arrow quote batches also pass
    # through this gateway, so these stay below the upstream documented caps.
    ARROW_PROVIDER_REQUESTS_PER_MINUTE: int = int(os.getenv("ARROW_PROVIDER_REQUESTS_PER_MINUTE", "90"))
    KITE_PROVIDER_REQUESTS_PER_MINUTE: int = int(os.getenv("KITE_PROVIDER_REQUESTS_PER_MINUTE", "120"))
    ARROW_PROVIDER_CONCURRENCY: int = int(os.getenv("ARROW_PROVIDER_CONCURRENCY", "1"))
    KITE_PROVIDER_CONCURRENCY: int = int(os.getenv("KITE_PROVIDER_CONCURRENCY", "1"))
    ARROW_PROVIDER_MIN_INTERVAL_SECONDS: float = float(os.getenv("ARROW_PROVIDER_MIN_INTERVAL_SECONDS", "0.7"))
    KITE_PROVIDER_MIN_INTERVAL_SECONDS: float = float(os.getenv("KITE_PROVIDER_MIN_INTERVAL_SECONDS", "0.5"))
    PROVIDER_MAX_RETRIES: int = int(os.getenv("PROVIDER_MAX_RETRIES", "2"))
    PROVIDER_RETRY_BASE_SECONDS: float = float(os.getenv("PROVIDER_RETRY_BASE_SECONDS", "0.6"))

    # Identity-aware API guard. Feed reads are intentionally not in the small
    # refresh bucket; only explicit warming/rescan endpoints are throttled.
    API_RATE_LIMIT_WINDOW_SECONDS: int = int(os.getenv("API_RATE_LIMIT_WINDOW_SECONDS", "60"))
    API_RATE_LIMIT_MAX_REQUESTS: int = int(os.getenv("API_RATE_LIMIT_MAX_REQUESTS", "600"))
    API_REFRESH_RATE_LIMIT_MAX_REQUESTS: int = int(os.getenv("API_REFRESH_RATE_LIMIT_MAX_REQUESTS", "8"))

    # --- Market hours (IST) ---
    TIMEZONE: ZoneInfo = field(default_factory=lambda: ZoneInfo("Asia/Kolkata"))
    MARKET_OPEN: time = time(9, 15)
    MARKET_CLOSE: time = time(15, 30)
    MARKET_HOLIDAYS: tuple[str, ...] = tuple(
        item.strip()
        for item in os.getenv("MARKET_HOLIDAYS", "").split(",")
        if item.strip()
    )

    # --- Runner / Momentum Ignition foundation (fully disable-able) ---
    RUNNER_ENGINE_ENABLED: bool = _env_bool("RUNNER_ENGINE_ENABLED", True)
    RUNNER_UNIVERSE: str = os.getenv("RUNNER_UNIVERSE", "broad").lower()
    RUNNER_FEATURE_VERSION: str = os.getenv("RUNNER_FEATURE_VERSION", "runner-v1")
    RUNNER_BASELINE_VERSION: str = os.getenv("RUNNER_BASELINE_VERSION", "runner-baseline-v1")
    RUNNER_BROAD_REFRESH_SECONDS: int = int(os.getenv("RUNNER_BROAD_REFRESH_SECONDS", "10"))
    RUNNER_PERSIST_MINUTE_FEATURES: bool = _env_bool("RUNNER_PERSIST_MINUTE_FEATURES", True)
    RUNNER_BASELINE_SHORT_SESSIONS: int = int(os.getenv("RUNNER_BASELINE_SHORT_SESSIONS", "20"))
    RUNNER_BASELINE_LONG_SESSIONS: int = int(os.getenv("RUNNER_BASELINE_LONG_SESSIONS", "60"))
    RUNNER_PRIMARY_PROVIDER: str = os.getenv("RUNNER_PRIMARY_PROVIDER", os.getenv("MARKET_DATA_PROVIDER", "kite")).lower()
    RUNNER_PROVIDER_CROSSCHECK_ENABLED: bool = _env_bool("RUNNER_PROVIDER_CROSSCHECK_ENABLED", False)
    RUNNER_PROVIDER_CROSSCHECK_SAMPLE_SIZE: int = int(os.getenv("RUNNER_PROVIDER_CROSSCHECK_SAMPLE_SIZE", "10"))
    RUNNER_STALE_AFTER_SECONDS: int = int(os.getenv("RUNNER_STALE_AFTER_SECONDS", "30"))
    RUNNER_PROVIDER_LTP_TOLERANCE_BPS: float = float(os.getenv("RUNNER_PROVIDER_LTP_TOLERANCE_BPS", "20"))
    RUNNER_QUALITY_EVENT_COOLDOWN_SECONDS: int = int(os.getenv("RUNNER_QUALITY_EVENT_COOLDOWN_SECONDS", "60"))
    RUNNER_BASELINE_AUTO_UPDATE: bool = _env_bool("RUNNER_BASELINE_AUTO_UPDATE", True)
    RUNNER_BASELINE_LOAD_RETRY_SECONDS: int = int(os.getenv("RUNNER_BASELINE_LOAD_RETRY_SECONDS", "60"))
    RUNNER_DAILY_CONTEXT_ENABLED: bool = _env_bool("RUNNER_DAILY_CONTEXT_ENABLED", True)
    RUNNER_HISTORY_REQUEST_DELAY_SECONDS: float = float(os.getenv("RUNNER_HISTORY_REQUEST_DELAY_SECONDS", "0.35"))
    RUNNER_MARKET_CONTEXT_MIN_SYMBOLS: int = int(os.getenv("RUNNER_MARKET_CONTEXT_MIN_SYMBOLS", "20"))
    RUNNER_PROVIDER_LIVENESS_SECONDS: int = int(os.getenv("RUNNER_PROVIDER_LIVENESS_SECONDS", "45"))
    RUNNER_RUN_HEARTBEAT_SECONDS: int = int(os.getenv("RUNNER_RUN_HEARTBEAT_SECONDS", "300"))
    RUNNER_BASELINE_BOOTSTRAP_ENABLED: bool = _env_bool("RUNNER_BASELINE_BOOTSTRAP_ENABLED", True)
    RUNNER_SHORTLIST_LIMIT: int = int(os.getenv("RUNNER_SHORTLIST_LIMIT", "5"))
    RUNNER_SHORTLIST_MIN_RVOL_TOD: float = float(os.getenv("RUNNER_SHORTLIST_MIN_RVOL_TOD", "1.5"))
    RUNNER_SHORTLIST_MIN_RVOL_5M: float = float(os.getenv("RUNNER_SHORTLIST_MIN_RVOL_5M", "1.5"))
    RUNNER_SHORTLIST_MIN_ACCELERATION: float = float(os.getenv("RUNNER_SHORTLIST_MIN_ACCELERATION", "1.05"))
    RUNNER_SHORTLIST_MIN_TURNOVER_CRORE: float = float(os.getenv("RUNNER_SHORTLIST_MIN_TURNOVER_CRORE", "5"))
    RUNNER_SCORE_VERSION: str = os.getenv("RUNNER_SCORE_VERSION", "runner-score-v1")
    RUNNER_RANKING_LIMIT: int = int(os.getenv("RUNNER_RANKING_LIMIT", "10"))
    RUNNER_SCORE_UNUSUAL_MIN: float = float(os.getenv("RUNNER_SCORE_UNUSUAL_MIN", "55"))
    RUNNER_SCORE_CANDIDATE_MIN: float = float(os.getenv("RUNNER_SCORE_CANDIDATE_MIN", "70"))
    RUNNER_SCORE_HIGH_QUALITY_MIN: float = float(os.getenv("RUNNER_SCORE_HIGH_QUALITY_MIN", "82"))
    RUNNER_SCORE_CANDIDATE_PERCENTILE: float = float(os.getenv("RUNNER_SCORE_CANDIDATE_PERCENTILE", "80"))
    RUNNER_SCORE_HIGH_QUALITY_PERCENTILE: float = float(os.getenv("RUNNER_SCORE_HIGH_QUALITY_PERCENTILE", "95"))

    # --- Premium intraday retracement breakouts ---
    # The detector consumes the existing Runner stream. Historical calls are
    # bounded and round-robin across the full eligible Intraday universe,
    # paced through the shared provider gateway.
    INTRADAY_BREAKOUT_REFRESH_SECONDS: int = int(os.getenv("INTRADAY_BREAKOUT_REFRESH_SECONDS", "30"))
    INTRADAY_BREAKOUT_HISTORY_FETCHES_PER_CYCLE: int = int(os.getenv("INTRADAY_BREAKOUT_HISTORY_FETCHES_PER_CYCLE", "8"))

    # --- Tier limits ---
    FREE_TIER_LIMITS: TierLimits = TierLimits(quotes_batch_max=15, signal_log_max=5)
    PREMIUM_TIER_LIMITS: TierLimits = TierLimits(quotes_batch_max=500, signal_log_max=999)

    def tier_limits(self, is_premium: bool) -> TierLimits:
        """Return the appropriate tier limits."""
        return self.PREMIUM_TIER_LIMITS if is_premium else self.FREE_TIER_LIMITS


# Singleton used throughout the application
settings = Settings()
