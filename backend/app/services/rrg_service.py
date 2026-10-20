"""
RRG end-of-day orchestration: pull daily candles from Kite, compute the full
RRG grid for every (benchmark x timeframe x sector), detect quadrant
crossings, and persist everything to Supabase.

Designed to run unattended on a daily schedule (~16:15 IST Mon-Fri) via
APScheduler. Idempotent: re-running upserts the latest bars and recomputes
the rolling window.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from typing import Iterable

import pandas as pd
from kiteconnect import KiteConnect

from app.config import settings
from app.core.kite_client import kite_state
from app.core.supabase_client import get_supabase_client
from app.engines.rrg import compute_grid, detect_crossings

logger = logging.getLogger("alpha_radar.rrg")


# ----------------------------------------------------------------------------
# Universe
# ----------------------------------------------------------------------------
PRIMARY_BENCHMARK = "NIFTY 50"

BENCHMARKS: list[str] = [
    "NIFTY 50",
    "NIFTY 500",
    "NIFTY MIDCAP 100",
    "NIFTY BANK",
]

CLASSIC_SECTORS: list[str] = [
    "NIFTY AUTO",
    "NIFTY BANK",
    "NIFTY FMCG",
    "NIFTY IT",
    "NIFTY MEDIA",
    "NIFTY METAL",
    "NIFTY PHARMA",
    "NIFTY PSU BANK",
    "NIFTY REALTY",
    "NIFTY ENERGY",
    "NIFTY FIN SERVICE",
]

THEMATIC_SECTORS: list[str] = [
    "NIFTY HEALTHCARE",
    "NIFTY PVT BANK",
    "NIFTY OIL AND GAS",
    "NIFTY CONSR DURBL",
    "NIFTY COMMODITIES",
    "NIFTY INFRA",
    "NIFTY MNC",
    "NIFTY PSE",
    "NIFTY CPSE",
    "NIFTY SERV SECTOR",
    "NIFTY INDIA CONSUMPTION",
    "NIFTY INDIA DIGITAL",
    "NIFTY INDIA DEFENCE",
    "NIFTY INDIA MFG",
    "NIFTY FIN SRV 25 50",
    "NIFTY HOUSING",
    "NIFTY ALPHA 50",
]

SIZE_SECTORS: list[str] = [
    "NIFTY 100",
    "NIFTY 200",
    "NIFTY NEXT 50",
    "NIFTY MIDCAP 50",
    "NIFTY MIDCAP 150",
    "NIFTY LARGEMID250",
    "NIFTY SMLCAP 50",
    "NIFTY SMLCAP 100",
    "NIFTY SMLCAP 250",
    "NIFTY MICROCAP250",
]

SECTORS: list[str] = [*CLASSIC_SECTORS, *THEMATIC_SECTORS, *SIZE_SECTORS]

# Deduped union of everything we need to pull from Kite.
ALL_SYMBOLS: list[str] = list(dict.fromkeys([*BENCHMARKS, *SECTORS]))


# Kite uses inconsistent tradingsymbol names for some indices — these aliases
# map our canonical name to Kite's actual name. Discovered empirically via
# `instruments("NSE")` dump. Run the helper in routes/rrg.py to list any
# new ones that fail to resolve in future.
ALIASES: dict[str, list[str]] = {
    "NIFTY HEALTHCARE": ["NIFTY HEALTHCARE INDEX", "NIFTY HEALTH"],
    "NIFTY PVT BANK": ["NIFTY PRIVATE BANK", "NIFTY PVTBANK"],
    "NIFTY OIL AND GAS": ["NIFTY OIL & GAS", "NIFTY OIL GAS"],
    "NIFTY CONSR DURBL": ["NIFTY CONSUMER DURABLES", "NIFTY CONS DURBL"],
    "NIFTY INFRA": ["NIFTY INFRASTRUCTURE"],
    "NIFTY SERV SECTOR": ["NIFTY SERVICES SECTOR", "NIFTY SERVICE SECTOR"],
    "NIFTY INDIA MFG": ["NIFTY INDIA MANUFACTURING"],
    "NIFTY FIN SRV 25 50": [
        "NIFTY FINSRV25 50",
        "NIFTY FIN SERV 25 50",
        "NIFTY FINANCIAL SERVICES 25 50",
    ],
    "NIFTY FIN SERVICE": ["NIFTY FINANCIAL SERVICES", "NIFTY FIN SERV"],
    "NIFTY INDIA CONSUMPTION": ["NIFTY CONSUMPTION"],
    "NIFTY INDIA DIGITAL": ["NIFTY IND DIGITAL"],
    "NIFTY INDIA DEFENCE": ["NIFTY IND DEFENCE"],
    "NIFTY SMLCAP 50": ["NIFTY SMALLCAP 50"],
    "NIFTY SMLCAP 100": ["NIFTY SMALLCAP 100"],
    "NIFTY SMLCAP 250": ["NIFTY SMALLCAP 250"],
    "NIFTY MICROCAP250": ["NIFTY MICROCAP 250"],
    "NIFTY LARGEMID250": ["NIFTY LARGEMIDCAP 250", "NIFTY LARGEMID 250"],
}


# ----------------------------------------------------------------------------
# Kite fetch
# ----------------------------------------------------------------------------
def _index_table(kite: KiteConnect) -> pd.DataFrame:
    rows = kite.instruments("NSE")
    df = pd.DataFrame(rows)
    indices = df[df["segment"] == "INDICES"].copy()
    indices["tradingsymbol_upper"] = indices["tradingsymbol"].str.upper().str.strip()
    return indices


def resolve_tokens(kite: KiteConnect, symbols: list[str]) -> dict[str, int]:
    """Map NSE index tradingsymbols to Kite instrument tokens.

    Unresolvable symbols are logged at WARN and skipped — the returned dict only
    contains successful mappings. Callers iterate over the dict, not the input list.
    """
    indices = _index_table(kite)
    name_to_token = dict(
        zip(indices["tradingsymbol_upper"], indices["instrument_token"])
    )

    resolved: dict[str, int] = {}
    missing: list[str] = []

    for sym in symbols:
        upper = sym.upper().strip()
        candidates = [upper, *ALIASES.get(upper, [])]
        for cand in candidates:
            if cand in name_to_token:
                resolved[sym] = int(name_to_token[cand])
                break
        else:
            missing.append(sym)

    if missing:
        logger.warning(
            "RRG: %d symbol(s) could not be resolved on Kite — skipping: %s",
            len(missing),
            ", ".join(missing),
        )

    return resolved


def fetch_daily(
    kite: KiteConnect,
    token: int,
    from_date: date,
    to_date: date,
) -> pd.DataFrame:
    raw = kite.historical_data(
        instrument_token=token,
        from_date=from_date,
        to_date=to_date,
        interval="day",
    )
    df = pd.DataFrame(raw)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df[["date", "open", "high", "low", "close", "volume"]]


def fetch_universe(
    kite: KiteConnect,
    lookback_days: int = 400,
) -> dict[str, pd.DataFrame]:
    """Fetch daily candles for every resolvable symbol in the universe."""
    tokens = resolve_tokens(kite, ALL_SYMBOLS)
    to_date = datetime.now(settings.TIMEZONE).date()
    from_date = to_date - timedelta(days=lookback_days)

    out: dict[str, pd.DataFrame] = {}
    for sym, tok in tokens.items():
        try:
            out[sym] = fetch_daily(kite, tok, from_date, to_date)
        except Exception as exc:
            logger.warning("RRG: failed to fetch %s (token=%s): %s", sym, tok, exc)
            continue
        # Kite historical rate limit is 3 req/sec — sleep is cheap insurance.
        time.sleep(0.4)
    return out


# ----------------------------------------------------------------------------
# Persistence
# ----------------------------------------------------------------------------
def _chunks(rows: list[dict], size: int) -> Iterable[list[dict]]:
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def upsert_prices(price_frames: dict[str, pd.DataFrame]) -> int:
    sb = get_supabase_client()
    rows: list[dict] = []
    for sym, df in price_frames.items():
        if df.empty:
            continue
        for _, r in df.iterrows():
            rows.append(
                {
                    "symbol": sym,
                    "date": r["date"].isoformat(),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume": int(r["volume"]),
                }
            )
    written = 0
    for chunk in _chunks(rows, 1000):
        sb.table("prices").upsert(chunk, on_conflict="symbol,date").execute()
        written += len(chunk)
    return written


def upsert_rrg_snapshots(rrg: pd.DataFrame) -> int:
    if rrg.empty:
        return 0
    sb = get_supabase_client()
    rrg = rrg.copy()
    rrg["as_of_date"] = rrg["as_of_date"].astype(str)
    rrg["rs_ratio"] = rrg["rs_ratio"].astype(float)
    rrg["rs_momentum"] = rrg["rs_momentum"].astype(float)
    rows = rrg.to_dict(orient="records")
    written = 0
    for chunk in _chunks(rows, 1000):
        sb.table("rrg_snapshots").upsert(
            chunk,
            on_conflict="as_of_date,symbol,benchmark,timeframe",
        ).execute()
        written += len(chunk)
    return written


def upsert_alerts(crossings: pd.DataFrame) -> int:
    if crossings.empty:
        return 0
    sb = get_supabase_client()
    df = crossings.copy()
    df["as_of_date"] = df["as_of_date"].astype(str)
    rows = df.to_dict(orient="records")
    written = 0
    for chunk in _chunks(rows, 500):
        sb.table("alerts").upsert(
            chunk,
            on_conflict="as_of_date,symbol,benchmark,timeframe",
            ignore_duplicates=True,
        ).execute()
        written += len(chunk)
    return written


# ----------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------
def run_eod(lookback_days: int = 400) -> dict:
    """Full end-of-day pipeline. Returns a summary dict for logging/admin UI."""
    if not kite_state.is_connected:
        logger.warning("RRG: Kite is not connected, aborting EOD run")
        return {"status": "skipped", "reason": "kite_not_connected"}

    started = datetime.utcnow()
    logger.info("RRG: starting EOD run (lookback=%dd)", lookback_days)

    daily = fetch_universe(kite_state.kite, lookback_days=lookback_days)
    total_bars = sum(len(df) for df in daily.values())
    logger.info("RRG: fetched %d bars across %d symbols", total_bars, len(daily))

    rrg = compute_grid(daily, BENCHMARKS, SECTORS)
    crossings = detect_crossings(rrg)
    logger.info(
        "RRG: computed %d snapshot rows, detected %d crossings",
        len(rrg),
        len(crossings),
    )

    n_prices = upsert_prices(daily)
    n_rrg = upsert_rrg_snapshots(rrg)
    n_alerts = upsert_alerts(crossings)

    elapsed = (datetime.utcnow() - started).total_seconds()
    summary = {
        "status": "ok",
        "started_at": started.isoformat() + "Z",
        "elapsed_seconds": round(elapsed, 1),
        "symbols_fetched": len(daily),
        "bars_fetched": total_bars,
        "snapshots_written": n_rrg,
        "alerts_written": n_alerts,
        "prices_written": n_prices,
    }
    logger.info(
        "RRG: EOD run complete in %ss — %d snapshots, %d alerts",
        summary["elapsed_seconds"],
        n_rrg,
        n_alerts,
    )
    return summary
