"""
Relative Rotation Graph (RRG) compute engine.

Plots each sector vs a benchmark on two axes:
  - X = JdK RS-Ratio       (smoothed relative strength,  100 ± stdev)
  - Y = JdK RS-Momentum    (rate of change of RS-Ratio,  100 ± stdev)

Quadrants:
  Leading    : ratio ≥ 100, momentum ≥ 100     -> hold / add
  Weakening  : ratio ≥ 100, momentum  < 100    -> trim / tighten stops
  Lagging    : ratio  < 100, momentum  < 100   -> avoid
  Improving  : ratio  < 100, momentum ≥ 100    -> best new-entry zone

Construction (default daily window=20, weekly window=14):
    RS_t           = 100 * Close_sector_t / Close_benchmark_t
    RS_Ratio_t     = 100 + (RS_t - SMA(RS, n)_t) / stdev(RS, n)_t
    dRS_Ratio_t    = RS_Ratio_t - RS_Ratio_{t-1}
    RS_Momentum_t  = 100 + (dRS_Ratio_t - SMA(dRS_Ratio, n)_t) / stdev(dRS_Ratio, n)_t

"JdK" is Julius de Kempenaer's trademark; the construction above is the
public-domain equivalent used across open-source RRG implementations.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class RrgParams:
    window: int = 20
    momentum_lookback: int = 1
    timeframe: str = "daily"


# Tuned to match strike.money's behaviour on Nifty sector indices:
#   - daily window=20  -> matches strike's call on IT (Improving), Banks (Lagging)
#   - weekly window=14 -> standard JdK
DEFAULT_PARAMS: dict[str, RrgParams] = {
    "daily": RrgParams(window=20, momentum_lookback=1, timeframe="daily"),
    "weekly": RrgParams(window=14, momentum_lookback=1, timeframe="weekly"),
}


def _zscore_100(series: pd.Series, window: int) -> pd.Series:
    """Rolling z-score centred on 100 — returns 100 + (x - mean) / std."""
    mean = series.rolling(window).mean()
    std = series.rolling(window).std(ddof=0)
    z = (series - mean) / std.replace(0, np.nan)
    return 100 + z


def _quadrant(row: pd.Series) -> str:
    r, m = row["rs_ratio"], row["rs_momentum"]
    if r >= 100 and m >= 100:
        return "leading"
    if r >= 100 and m < 100:
        return "weakening"
    if r < 100 and m < 100:
        return "lagging"
    return "improving"


def resample_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """Resample daily OHLCV bars to Friday-anchored weekly bars."""
    if daily.empty:
        return daily
    df = daily.copy()
    df["date"] = pd.to_datetime(df["date"])
    df["week_as_of"] = df["date"]
    df = df.set_index("date").sort_index()
    weekly = df.resample("W-FRI").agg(
        {
            "week_as_of": "last",
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
        }
    ).dropna(subset=["close"])
    weekly = weekly.reset_index()
    weekly["date"] = weekly["week_as_of"].dt.date
    weekly = weekly.drop(columns=["week_as_of"])
    return weekly


def compute_pair(
    sector_close: pd.Series,
    benchmark_close: pd.Series,
    params: RrgParams = RrgParams(),
) -> pd.DataFrame:
    """Compute RRG values for one (sector, benchmark) pair across a price history."""
    aligned = pd.concat(
        {"sector": sector_close, "benchmark": benchmark_close}, axis=1
    ).dropna()

    rs = 100 * aligned["sector"] / aligned["benchmark"]
    rs_ratio = _zscore_100(rs, params.window)

    # Momentum = z-score of the N-period change in RS_Ratio. Using >1 lookback
    # damps day-to-day noise that would otherwise flip strong-trend sectors
    # in and out of Weakening on every minor pullback. Default is 1 because
    # diff(3) was empirically worse on Nifty data (flipped IT to Lagging).
    rs_ratio_change = rs_ratio.diff(params.momentum_lookback)
    rs_momentum = _zscore_100(rs_ratio_change, params.window)

    out = pd.DataFrame(
        {"rs": rs, "rs_ratio": rs_ratio, "rs_momentum": rs_momentum}
    ).dropna()
    out["quadrant"] = out.apply(_quadrant, axis=1)
    return out


def _close_series(frame: pd.DataFrame) -> pd.Series:
    return frame.set_index("date")["close"]


def compute_universe(
    price_frames: dict[str, pd.DataFrame],
    benchmark_symbol: str,
    sector_symbols: list[str],
    params: RrgParams = RrgParams(),
) -> pd.DataFrame:
    """Compute RRG for every sector vs the benchmark on a single timeframe.

    Missing symbols (not in price_frames) are skipped silently — keeps the
    job robust to symbols Kite doesn't expose for a given account.
    """
    if benchmark_symbol not in price_frames:
        return pd.DataFrame()
    bench = _close_series(price_frames[benchmark_symbol])

    rows: list[pd.DataFrame] = []
    for sym in sector_symbols:
        if sym == benchmark_symbol or sym not in price_frames:
            continue
        sector = _close_series(price_frames[sym])
        rrg = compute_pair(sector, bench, params).reset_index()
        rrg["symbol"] = sym
        rrg["benchmark"] = benchmark_symbol
        rrg["timeframe"] = params.timeframe
        rrg = rrg.rename(columns={"date": "as_of_date"})
        rows.append(
            rrg[
                [
                    "as_of_date",
                    "symbol",
                    "benchmark",
                    "timeframe",
                    "rs_ratio",
                    "rs_momentum",
                    "quadrant",
                ]
            ]
        )
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def compute_grid(
    daily_frames: dict[str, pd.DataFrame],
    benchmarks: list[str],
    sectors: list[str],
) -> pd.DataFrame:
    """Full grid: every (benchmark, timeframe, sector, date) snapshot."""
    weekly_frames = {sym: resample_weekly(df) for sym, df in daily_frames.items()}

    parts: list[pd.DataFrame] = []
    for benchmark in benchmarks:
        parts.append(
            compute_universe(daily_frames, benchmark, sectors, DEFAULT_PARAMS["daily"])
        )
        parts.append(
            compute_universe(weekly_frames, benchmark, sectors, DEFAULT_PARAMS["weekly"])
        )
    non_empty = [p for p in parts if not p.empty]
    return pd.concat(non_empty, ignore_index=True) if non_empty else pd.DataFrame()


def detect_crossings(rrg: pd.DataFrame) -> pd.DataFrame:
    """Find rows where a tuple's quadrant changes from the previous bar."""
    if rrg.empty:
        return pd.DataFrame(
            columns=[
                "as_of_date",
                "symbol",
                "benchmark",
                "timeframe",
                "from_quadrant",
                "to_quadrant",
            ]
        )

    df = rrg.sort_values(["symbol", "benchmark", "timeframe", "as_of_date"]).copy()
    df["prev_quadrant"] = df.groupby(
        ["symbol", "benchmark", "timeframe"]
    )["quadrant"].shift(1)

    crossed = df[
        df["prev_quadrant"].notna() & (df["prev_quadrant"] != df["quadrant"])
    ].copy()
    crossed = crossed.rename(
        columns={"quadrant": "to_quadrant", "prev_quadrant": "from_quadrant"}
    )
    return crossed[
        [
            "as_of_date",
            "symbol",
            "benchmark",
            "timeframe",
            "from_quadrant",
            "to_quadrant",
        ]
    ]
