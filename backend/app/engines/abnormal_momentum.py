"""Abnormal momentum surveillance scoring.

This module is a screening engine, not a manipulation detector. It ranks stocks
by unusual price, volume, delivery, breakout, liquidity, and cleanliness signals
so traders can decide what deserves investigation.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from typing import Any, Iterable


RISK_CLEAN = "Clean Momentum"
RISK_WATCH = "Watch Carefully"
RISK_LIQUIDITY = "Liquidity Trap"
RISK_CIRCUIT = "Circuit Risk"
RISK_NEWS = "News-Only Move"
RISK_AVOID = "Avoid: Surveillance/Low Liquidity"


@dataclass
class AbnormalStockRow:
    symbol: str
    last_price: float
    prev_close: float
    volume: float
    avg_volume20: float
    delivery_pct: float | None = None
    pdh: float | None = None
    high20: float | None = None
    high50: float | None = None
    sector: str = "Others"
    sector_change_pct: float = 0
    market_cap_bucket: str = "unknown"
    turnover_lakh: float = 0
    asm_gsm: bool = False
    trade_to_trade: bool = False
    circuit_hit: bool = False
    news_tag: str | None = None
    bulk_deal: bool = False
    block_deal: bool = False


@dataclass
class ScoreBreakdown:
    volume_expansion: float = 0
    delivery_strength: float = 0
    breakout: float = 0
    sector_support: float = 0
    institutional_footprint: float = 0
    liquidity_quality: float = 0
    governance_cleanliness: float = 0

    @property
    def total(self) -> float:
        return round(
            self.volume_expansion
            + self.delivery_strength
            + self.breakout
            + self.sector_support
            + self.institutional_footprint
            + self.liquidity_quality
            + self.governance_cleanliness,
            2,
        )


@dataclass
class AbnormalScoreResult:
    symbol: str
    last_price: float
    change_pct: float
    volume_vs_avg: float
    delivery_pct: float | None
    breakout_status: str
    circuit_status: str
    liquidity_score: float
    risk_flag: str
    alpha_score: float
    score_breakdown: ScoreBreakdown
    reasons: list[str] = field(default_factory=list)
    invalidation_level: float | None = None
    market_cap_bucket: str = "unknown"
    sector: str = "Others"
    turnover_lakh: float = 0
    tags: list[str] = field(default_factory=list)


SAMPLE_ROWS: list[dict[str, Any]] = [
    {
        "symbol": "NETWEB",
        "last_price": 4533,
        "prev_close": 4195,
        "volume": 3100000,
        "avg_volume20": 900000,
        "delivery_pct": 54,
        "high20": 4310,
        "high50": 4475,
        "sector": "IT",
        "sector_change_pct": 1.7,
        "market_cap_bucket": "mid",
        "turnover_lakh": 140523,
        "bulk_deal": False,
    },
    {
        "symbol": "BSE",
        "last_price": 2920,
        "prev_close": 2785,
        "volume": 1800000,
        "avg_volume20": 750000,
        "delivery_pct": 47,
        "high20": 2880,
        "high50": 2965,
        "sector": "Finance",
        "sector_change_pct": 0.9,
        "market_cap_bucket": "mid",
        "turnover_lakh": 52560,
    },
    {
        "symbol": "XYZLOW",
        "last_price": 18.4,
        "prev_close": 16.8,
        "volume": 420000,
        "avg_volume20": 70000,
        "delivery_pct": 23,
        "high20": 18.2,
        "high50": 21,
        "sector": "Others",
        "market_cap_bucket": "micro",
        "turnover_lakh": 77,
        "trade_to_trade": True,
    },
    {
        "symbol": "CIRCUITCO",
        "last_price": 126,
        "prev_close": 105,
        "volume": 120000,
        "avg_volume20": 45000,
        "delivery_pct": 71,
        "high20": 126,
        "high50": 126,
        "sector": "Industrials",
        "market_cap_bucket": "small",
        "turnover_lakh": 151,
        "circuit_hit": True,
    },
    {
        "symbol": "RELIANCE",
        "last_price": 2940,
        "prev_close": 2895,
        "volume": 7600000,
        "avg_volume20": 5200000,
        "delivery_pct": 41,
        "high20": 2960,
        "high50": 3015,
        "sector": "Energy",
        "sector_change_pct": 0.4,
        "market_cap_bucket": "large",
        "turnover_lakh": 223440,
        "news_tag": "result",
    },
]


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "hit", "asm", "gsm", "t2t"}


def to_float(value: Any, default: float = 0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def normalize_row(row: dict[str, Any]) -> AbnormalStockRow:
    aliases = {
        "last_price": ["last_price", "ltp", "close", "last", "LAST_PRICE"],
        "prev_close": ["prev_close", "previous_close", "prevClose", "PREV_CLOSE"],
        "avg_volume20": ["avg_volume20", "avgVolume20", "avg_volume", "20d_avg_volume"],
        "delivery_pct": ["delivery_pct", "delivery", "deliv_per", "DELIV_PER"],
        "pdh": ["pdh", "previous_day_high", "prev_day_high", "PDH"],
        "high20": ["high20", "20d_high", "high_20"],
        "high50": ["high50", "50d_high", "high_50"],
    }

    def pick(name: str, fallback: Any = None) -> Any:
        for key in aliases.get(name, [name]):
            if key in row:
                return row.get(key)
        return row.get(name, fallback)

    symbol = str(row.get("symbol") or row.get("SYMBOL") or row.get("tradingsymbol") or "").strip().upper()
    last_price = to_float(pick("last_price"))
    prev_close = to_float(pick("prev_close"), last_price)
    volume = to_float(row.get("volume") or row.get("VOLUME") or row.get("ttl_trd_qnty"))
    avg_volume20 = to_float(pick("avg_volume20"), volume)
    turnover_lakh = to_float(row.get("turnover_lakh") or row.get("turnover") or row.get("TURNOVER_LAKH"))
    if turnover_lakh == 0 and last_price > 0:
        turnover_lakh = (volume * last_price) / 100000

    return AbnormalStockRow(
        symbol=symbol,
        last_price=last_price,
        prev_close=prev_close,
        volume=volume,
        avg_volume20=avg_volume20,
        delivery_pct=to_float(pick("delivery_pct"), -1) if pick("delivery_pct") not in (None, "") else None,
        pdh=to_float(pick("pdh"), 0) or None,
        high20=to_float(pick("high20"), 0) or None,
        high50=to_float(pick("high50"), 0) or None,
        sector=str(row.get("sector") or row.get("SECTOR") or "Others"),
        sector_change_pct=to_float(row.get("sector_change_pct") or row.get("sectorChangePct")),
        market_cap_bucket=str(row.get("market_cap_bucket") or row.get("bucket") or "unknown").lower(),
        turnover_lakh=turnover_lakh,
        asm_gsm=parse_bool(row.get("asm_gsm") or row.get("ASM_GSM")),
        trade_to_trade=parse_bool(row.get("trade_to_trade") or row.get("T2T")),
        circuit_hit=parse_bool(row.get("circuit_hit") or row.get("circuit")),
        news_tag=str(row.get("news_tag") or row.get("news") or "").strip() or None,
        bulk_deal=parse_bool(row.get("bulk_deal") or row.get("bulk")),
        block_deal=parse_bool(row.get("block_deal") or row.get("block")),
    )


def parse_csv_rows(content: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(content))
    return [dict(row) for row in reader]


def score_row(row: AbnormalStockRow) -> AbnormalScoreResult:
    change_pct = ((row.last_price - row.prev_close) / row.prev_close * 100) if row.prev_close else 0
    volume_vs_avg = row.volume / row.avg_volume20 if row.avg_volume20 else 1
    breakdown = ScoreBreakdown()
    reasons: list[str] = []
    tags: list[str] = []

    if volume_vs_avg >= 5:
        breakdown.volume_expansion = 2
    elif volume_vs_avg >= 3:
        breakdown.volume_expansion = 1.5
    elif volume_vs_avg >= 2:
        breakdown.volume_expansion = 1
    elif volume_vs_avg >= 1.5:
        breakdown.volume_expansion = 0.5
    if breakdown.volume_expansion:
        reasons.append(f"Volume is {volume_vs_avg:.1f}x the 20D average.")

    delivery = row.delivery_pct
    if delivery is not None:
        if delivery >= 60 and volume_vs_avg >= 1.5:
            breakdown.delivery_strength = 2
        elif delivery >= 50:
            breakdown.delivery_strength = 1.5
        elif delivery >= 40:
            breakdown.delivery_strength = 1
        elif delivery >= 30:
            breakdown.delivery_strength = 0.5
        if breakdown.delivery_strength:
            reasons.append(f"Delivery participation is {delivery:.0f}%.")

    breakout_status = "None"
    if row.high50 and row.last_price > row.high50:
        breakdown.breakout = 2
        breakout_status = "50D Breakout"
        reasons.append(f"Price cleared 50D range high {row.high50:.2f}.")
    elif row.high20 and row.last_price > row.high20:
        breakdown.breakout = 1.5
        breakout_status = "20D Breakout"
        reasons.append(f"Price cleared 20D range high {row.high20:.2f}.")
    elif row.high20 and row.last_price >= row.high20 * 0.99:
        breakdown.breakout = 0.75
        breakout_status = "Near 20D Breakout"
        reasons.append("Price is within 1% of the 20D breakout level.")
    elif row.pdh and row.last_price > row.pdh:
        breakdown.breakout = 1
        breakout_status = "PDH Breakout"
        reasons.append(f"Price cleared previous-day high {row.pdh:.2f}.")

    if row.sector_change_pct >= 1.5:
        breakdown.sector_support = 1
        reasons.append(f"{row.sector} theme is strong at +{row.sector_change_pct:.1f}%.")
    elif row.sector_change_pct >= 0.75:
        breakdown.sector_support = 0.5

    if row.bulk_deal or row.block_deal:
        breakdown.institutional_footprint = 1
        reasons.append("Bulk/block deal footprint present.")
        tags.append("Institutional footprint")

    if row.turnover_lakh >= 1000 and row.last_price >= 50:
        breakdown.liquidity_quality = 1
    elif row.turnover_lakh >= 300:
        breakdown.liquidity_quality = 0.5

    clean = not row.asm_gsm and not row.trade_to_trade and not row.circuit_hit and row.turnover_lakh >= 300
    if clean:
        breakdown.governance_cleanliness = 1
    else:
        if row.asm_gsm:
            tags.append("ASM/GSM")
        if row.trade_to_trade:
            tags.append("T2T")
        if row.circuit_hit:
            tags.append("Circuit")

    liquidity_score = round(min(10, (breakdown.liquidity_quality + breakdown.governance_cleanliness) * 5), 1)
    circuit_status = "Hit" if row.circuit_hit else "Clear"
    risk_flag = classify_risk(row, change_pct, volume_vs_avg, breakout_status)
    invalidation = row.high20 if breakout_status in {"20D Breakout", "50D Breakout"} and row.high20 else None

    return AbnormalScoreResult(
        symbol=row.symbol,
        last_price=round(row.last_price, 2),
        change_pct=round(change_pct, 2),
        volume_vs_avg=round(volume_vs_avg, 2),
        delivery_pct=round(delivery, 2) if delivery is not None else None,
        breakout_status=breakout_status,
        circuit_status=circuit_status,
        liquidity_score=liquidity_score,
        risk_flag=risk_flag,
        alpha_score=breakdown.total,
        score_breakdown=breakdown,
        reasons=reasons,
        invalidation_level=round(invalidation, 2) if invalidation else None,
        market_cap_bucket=row.market_cap_bucket,
        sector=row.sector,
        turnover_lakh=round(row.turnover_lakh, 2),
        tags=tags,
    )


def classify_risk(row: AbnormalStockRow, change_pct: float, volume_vs_avg: float, breakout_status: str) -> str:
    if row.asm_gsm or row.trade_to_trade or row.turnover_lakh < 100:
        return RISK_AVOID
    if row.circuit_hit:
        return RISK_CIRCUIT
    if volume_vs_avg >= 4 and abs(change_pct) >= 6 and row.turnover_lakh < 300:
        return RISK_LIQUIDITY
    if row.news_tag and volume_vs_avg < 1.5 and breakout_status == "None":
        return RISK_NEWS
    if volume_vs_avg >= 2 and change_pct >= 3 and "Breakout" in breakout_status and row.turnover_lakh >= 500:
        return RISK_CLEAN
    return RISK_WATCH


def score_rows(rows: Iterable[dict[str, Any] | AbnormalStockRow]) -> list[AbnormalScoreResult]:
    normalized = [row if isinstance(row, AbnormalStockRow) else normalize_row(row) for row in rows]
    scored = [score_row(row) for row in normalized if row.symbol and row.last_price > 0]
    return sorted(scored, key=lambda item: (item.alpha_score, item.volume_vs_avg, abs(item.change_pct)), reverse=True)


def apply_filters(results: list[AbnormalScoreResult], filters: dict[str, Any]) -> list[AbnormalScoreResult]:
    min_volume = to_float(filters.get("minVolumeSpike"), 1)
    min_change = to_float(filters.get("minPriceChange"), 0)
    bucket = str(filters.get("marketCapBucket") or "all").lower()
    avoid_surveillance = bool(filters.get("avoidSurveillance", True))
    only_breakout = bool(filters.get("onlyBreakout", False))

    out: list[AbnormalScoreResult] = []
    for item in results:
        if item.volume_vs_avg < min_volume:
            continue
        if abs(item.change_pct) < min_change:
            continue
        if bucket != "all" and item.market_cap_bucket != bucket:
            continue
        if avoid_surveillance and item.risk_flag == RISK_AVOID:
            continue
        if only_breakout and "Breakout" not in item.breakout_status:
            continue
        out.append(item)
    return out
