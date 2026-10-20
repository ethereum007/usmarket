"""Runner constants. Runtime cadence and lookbacks live in app.config."""

from datetime import time

MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)
SESSION_MINUTES = 375
ROLLING_WINDOWS = (1, 3, 5, 10, 15, 30)
MAX_ROLLING_BARS = 90
DEFAULT_FEATURE_VERSION = "runner-v1"
DEFAULT_BASELINE_VERSION = "runner-baseline-v1"
BASELINE_METRICS = (
    "cumulative_volume",
    "volume_1m",
    "volume_3m",
    "volume_5m",
    "volume_10m",
    "volume_15m",
    "cumulative_turnover",
    "intraday_range",
    "abs_move_prev_close",
    "abs_move_open",
    "ret_1m",
    "ret_5m",
    "ret_15m",
)
