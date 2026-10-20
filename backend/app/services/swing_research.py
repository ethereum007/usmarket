"""Completed-session research using existing detectors, with explicit coverage."""
from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta

import pandas as pd

from app.config import settings
from app.caches.sector_map import SECTOR_MAP
from app.engines.cpr.swing_detector import scan_swing_spectrum, swing_signal_to_dict
from app.services import swing_repository as repo

VERSION = "swing-eod-v1"
BENCHMARK = "NIFTY 500"


def completed_bars(bars: list[dict], now: datetime | None = None) -> list[dict]:
    now = (now or datetime.now(settings.TIMEZONE)).astimezone(settings.TIMEZONE)
    by_session = {}
    for bar in bars:
        try:
            session = str(bar["date"])[:10]
            day = datetime.strptime(session, "%Y-%m-%d").date()
            values = {key: float(bar[key]) for key in ("open", "high", "low", "close", "volume")}
            if day > now.date() or (day == now.date() and (now.hour, now.minute) < (16, 30)):
                continue
            if day.weekday() >= 5 or session in settings.MARKET_HOLIDAYS:
                continue
            if not all(math.isfinite(v) for v in values.values()) or min(values[k] for k in ("open", "high", "low", "close")) <= 0 or values["volume"] < 0:
                continue
            if values["high"] < max(values["open"], values["close"], values["low"]) or values["low"] > min(values["open"], values["close"]):
                continue
            by_session[session] = {"date": session, **values}
        except (ValueError, KeyError, TypeError):
            continue
    return [by_session[day] for day in sorted(by_session)]


def features(bars: list[dict], benchmark: list[dict], session: str) -> dict:
    rows = [bar for bar in bars if bar["date"] <= session]
    calendar = [bar["date"] for bar in benchmark if bar["date"] <= session]
    if not rows or rows[-1]["date"] != session:
        return {"available": False, "reason": "No completed bar for selected session"}
    close = pd.Series([bar["close"] for bar in rows], dtype=float)
    dates = [bar["date"] for bar in rows]
    def complete(window: int) -> bool:
        return len(rows) >= window and len(calendar) >= window and dates[-window:] == calendar[-window:]
    result = {"available": True, "close": float(close.iloc[-1]), "sessions": len(rows), "session": session}
    for period in (10, 20, 50, 200):
        result[f"ema{period}"] = float(close.ewm(span=period, adjust=False).mean().iloc[-1]) if complete(period) else None
    for period in (1, 5, 20, 60):
        result[f"return{period}"] = (float(close.iloc[-1] / close.iloc[-period - 1]) - 1) * 100 if complete(period + 1) else None
        bench = [bar for bar in benchmark if bar["date"] <= session]
        result[f"rs{period}"] = result[f"return{period}"] - (bench[-1]["close"] / bench[-period - 1]["close"] - 1) * 100 if result[f"return{period}"] is not None else None
    result["high252"] = max(bar["high"] for bar in rows[-252:]) if complete(252) else None
    result["low252"] = min(bar["low"] for bar in rows[-252:]) if complete(252) else None
    avg_volume = sum(bar["volume"] for bar in rows[-21:-1]) / 20 if complete(21) else None
    result["rvol20"] = rows[-1]["volume"] / avg_volume if avg_volume and avg_volume > 0 else None
    result["turnover20"] = sum(bar["close"] * bar["volume"] for bar in rows[-20:]) / 20 if complete(20) else None
    return result


def breadth(stock_features: dict[str, dict], requested: int) -> dict:
    available = [f for f in stock_features.values() if f.get("available")]
    gauges = []
    for period in (10, 20, 50, 200):
        eligible = [f for f in available if f.get(f"ema{period}") is not None]
        above = sum(f["close"] > f[f"ema{period}"] for f in eligible)
        gauges.append({"label": f"{period} EMA", "eligible": len(eligible), "above": above,
                       "value": round(above / len(eligible) * 100, 2) if eligible else None})
    day = [f for f in available if f.get("return1") is not None]
    advances = sum(f["return1"] > 0 for f in day)
    declines = sum(f["return1"] < 0 for f in day)
    five = [f for f in available if f.get("return5") is not None]
    highs = [f for f in available if f.get("high252") is not None]
    volume = [f for f in available if f.get("rvol20") is not None and f.get("return1") is not None]
    return {"requested": requested, "available": len(available), "daily_eligible": len(day),
            "advances": advances, "declines": declines, "unchanged": len(day) - advances - declines,
            "advance_pct": round(advances / len(day) * 100, 2) if day else None,
            "gauges": gauges, "five_day_eligible": len(five),
            "up20_in5": sum(f["return5"] >= 20 for f in five) if five else None,
            "up30_in5": sum(f["return5"] >= 30 for f in five) if five else None,
            "extremes_eligible": len(highs),
            "new_highs": sum(f["close"] >= f["high252"] for f in highs) if highs else None,
            "new_lows": sum(f["close"] <= f["low252"] for f in highs) if highs else None,
            "volume_eligible": len(volume),
            "up4_on_volume": sum(f["return1"] >= 4 and f["rvol20"] >= 1.5 for f in volume) if volume else None,
            "down4_on_volume": sum(f["return1"] <= -4 and f["rvol20"] >= 1.5 for f in volume) if volume else None}


def build_package(universe: str, symbols: list[str], histories: dict[str, list[dict]], benchmark: list[dict], failures: dict | None = None, *, market: str = "NSE", benchmark_name: str = BENCHMARK, sector_map: dict | None = None, setup_exclusions: dict[str, str] | None = None) -> dict:
    sector_map = SECTOR_MAP if sector_map is None else sector_map
    if not benchmark:
        raise ValueError(f"Completed {benchmark_name} history is required; no package published")
    session = benchmark[-1]["date"]
    histories = {symbol: [bar for bar in histories.get(symbol, []) if bar["date"] <= session] for symbol in symbols}
    stock_features = {symbol: features(histories.get(symbol, []), benchmark, session) for symbol in symbols}
    missing = [symbol for symbol, f in stock_features.items() if not f["available"]]
    # Dates and actual source bars are part of package identity. Corrections create a new package.
    source_id = repo.identity({"bars": histories, "benchmark": benchmark, "universe": symbols, "market": market, "benchmark_name": benchmark_name})
    setups = []
    benchmark_df = pd.DataFrame(benchmark)
    for symbol, f in stock_features.items():
        if not f["available"] or f["sessions"] < 35 or symbol in (setup_exclusions or {}):
            continue
        rows = [bar for bar in histories[symbol] if bar["date"] <= session]
        for signal in scan_swing_spectrum(pd.DataFrame(rows), symbol, benchmark_df=benchmark_df):
            data = swing_signal_to_dict(signal)
            data["benchmark_rs_20"] = f.get("rs20")
            data["benchmark_rs_60"] = f.get("rs60")
            # Detector explanations historically hardcoded Nifty even with an explicit benchmark.
            # Render benchmark evidence from the same aligned features exposed by this package.
            data["reasons"] = [reason for reason in data.get("reasons", []) if not reason.startswith("Nifty 500 RS ")]
            for period in (20, 60):
                value = f.get(f"rs{period}")
                data["reasons"].append(f"{benchmark_name} RS {period}D {value:+.1f} pp" if value is not None else f"{benchmark_name} RS {period}D unavailable")

            data["research_warnings"] = ["Engine score is uncalibrated; policy objective is not measured structural room"]
            if f.get("rs60") is None:
                data["research_warnings"].append("60-session relative strength unavailable; do not infer leadership")
            data.update({"setup_id": repo.identity([market, symbol, signal.strategy, signal.signal, signal.trigger_date]),
                         "setup_version": repo.identity([VERSION, source_id, data]),
                         "source_snapshot_id": source_id, "session": session,
                         "target_policy": "Engine policy objective; structural room unverified",
                         "structural_room_r": None, "execution_readiness": "PLANNING_ONLY"})
            setups.append(data)
    groups = []
    for name in sorted({sector_map[s] for s in symbols if s in sector_map}):
        members = [s for s in symbols if sector_map.get(s) == name]
        group_features = {s: stock_features[s] for s in members}
        measured = [f["rs20"] for f in group_features.values() if f.get("rs20") is not None]
        groups.append({"name": name, "classification": "sector", "members": members,
                       "breadth": breadth(group_features, len(members)), "rs20_eligible": len(measured),
                       "mean_excess_return20": sum(measured) / len(measured) if measured else None,
                       "setup_symbols": sorted({s["symbol"] for s in setups if s["symbol"] in members})})
    return {"version": VERSION, "market": market, "universe": universe, "membership_version": repo.identity(symbols),
            "membership_basis": "Current configured membership; historical membership unverified",
            "session": session, "state": "partial" if missing else "final",
            "computed_at": repo.now_iso(), "source_snapshot_id": source_id,
            "symbols": symbols, "missing_symbols": missing, "refresh_failures": failures or {},
            "breadth": breadth(stock_features, len(symbols)), "features": stock_features,
            "groups": groups, "industry_taxonomy": "unavailable", "unclassified_symbols": [s for s in symbols if s not in sector_map],
            "setups": setups, "benchmark": benchmark_name, "setup_exclusions": setup_exclusions or {},
            "source_bars": histories, "benchmark_bars": benchmark,
            "methodology": {"ema": "Recursive EMA seeded by first available close; minimum period bars; calendar gaps excluded",
                            "relative_strength": f"Stock session return minus {benchmark_name} return in percentage points; not a percentile",
                            "volume": "Current volume / prior 20 completed sessions; high volume >=1.5x",
                            "extremes": "Close at trailing 252-session high/low; short histories unknown"}}


async def refresh(job: dict, kite, symbols: list[str]) -> None:
    from app.services.scanner_service import _resolve_tokens, _fetch_historical
    job.update(state="running", completed=0, total=len(symbols) + 1, failures={})
    repo.save_job(job)
    try:
        tokens = await asyncio.to_thread(_resolve_tokens, [BENCHMARK, *symbols], kite)
        now = datetime.now(settings.TIMEZONE)
        for symbol in [BENCHMARK, *symbols]:
            try:
                if symbol not in tokens:
                    raise ValueError("Instrument token unavailable")
                raw = await _fetch_historical(kite, tokens[symbol], "day", (now - timedelta(days=600)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d"))
                rows = completed_bars(raw, now)
                if not rows:
                    raise ValueError("No valid completed bars returned")
                repo.save_bars(symbol, rows)
            except Exception as exc:
                job["failures"][symbol] = type(exc).__name__ + ": historical data unavailable"
            job["completed"] += 1
            repo.save_job(job)
            await asyncio.sleep(0.4)
        benchmark = repo.load_bars(BENCHMARK)
        # Never call an old cached session a successful fresh final publication.
        histories = {symbol: repo.load_bars(symbol) for symbol in symbols}
        package = build_package(job["universe"], symbols, histories, benchmark, job["failures"])
        package["source_manifest"] = repo.source_manifest([BENCHMARK, *symbols])
        package["provider"] = "kite historical_data"
        package["adjustment_basis"] = "Provider-supplied; corporate-action adjustment not independently verified"
        if job["failures"]:
            package["state"] = "partial"
        saved = repo.publish(package)
        job.update(state="completed", package_id=saved["id"], package_state=saved["state"])
    except Exception as exc:
        job.update(state="failed", error=str(exc) if isinstance(exc, ValueError) else "Refresh failed; last final research preserved")
    repo.save_job(job)
