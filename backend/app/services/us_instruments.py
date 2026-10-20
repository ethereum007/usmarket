"""Provider-scoped current asset identity; never invent historical symbol mappings."""
import asyncio
from datetime import datetime, timezone
import re
from uuid import UUID

import httpx

from app.services.swing_repository import identity

VERSION = "us-alpaca-assets-v1"


def instrument_snapshot(symbols: list[str], raw: dict, observed_at: datetime) -> dict:
    if observed_at.tzinfo is None or observed_at.utcoffset() is None:
        raise ValueError("Timezone-aware instrument observation required")
    records = {}
    ids = {}
    for symbol in sorted(set(symbols)):
        if not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,14}", symbol):
            raise ValueError("Invalid instrument lookup symbol")
        row = raw.get(symbol)
        record = {"requested_symbol": symbol, "resolution": "unavailable",
                  "reason": "Provider asset identity unavailable"}
        if isinstance(row, dict):
            try:
                asset_id = str(UUID(row["id"]))
                if row.get("symbol") != symbol:
                    raise ValueError()
                if row.get("class") != "us_equity":
                    raise ValueError()
                if row.get("status") not in {"active", "inactive"}:
                    raise ValueError()
                exchange = row.get("exchange")
                if not isinstance(exchange, str) or not re.fullmatch(r"[A-Z0-9_]{1,20}", exchange):
                    raise ValueError()
                if asset_id in ids and ids[asset_id] != symbol:
                    raise ValueError("Asset identity collision")
            except (KeyError, ValueError, TypeError, AttributeError):
                record["reason"] = "Provider asset response invalid or ambiguous"
            else:
                ids[asset_id] = symbol
                record.update(provider_asset_id=asset_id, symbol=symbol, asset_class="us_equity",
                              exchange=exchange, status=row["status"],
                              resolution="resolved" if row["status"] == "active" else "excluded",
                              reason=None if row["status"] == "active" else "Provider asset is currently inactive",
                              listing_date=None, delisting_date=None, security_type="unclassified")
        records[symbol] = record
    # A duplicated provider ID makes every competing symbol ambiguous, not just the last one.
    seen = {}
    for symbol, row in raw.items():
        if symbol in records and isinstance(row, dict) and isinstance(row.get("id"), str):
            try:
                key = str(UUID(row["id"]))
            except ValueError:
                continue
            seen.setdefault(key, []).append(symbol)
    for aliases in seen.values():
        if len(aliases) > 1:
            for symbol in aliases:
                records[symbol] = {"requested_symbol": symbol, "resolution": "unavailable",
                                   "reason": "Ambiguous provider asset identity across requested symbols"}
    content = {"version": VERSION, "provider": "alpaca", "records": records,
               "basis": "Current provider observation; historical aliases, security subtype and listing dates unverified"}
    return {**content, "id": identity(content), "observed_at": observed_at.astimezone(timezone.utc).isoformat()}


async def load_instruments(client: httpx.AsyncClient, symbols: list[str]) -> dict:
    members = sorted(set(symbols))
    if not 1 <= len(members) <= 501 or any(not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,14}", symbol) for symbol in members):
        raise ValueError("Use 1-501 valid instrument symbols")
    semaphore = asyncio.Semaphore(5)
    async def load(symbol):
        async with semaphore:
            try:
                result = await client.get("https://paper-api.alpaca.markets/v2/assets/" + symbol)
                if result.status_code in {401, 403}:
                    raise RuntimeError("US instrument provider access denied; research was not published")
                if result.status_code != 200:
                    return symbol, None
                return symbol, result.json()
            except (httpx.HTTPError, ValueError):
                return symbol, None
    rows = await asyncio.gather(*(load(symbol) for symbol in members))
    return instrument_snapshot(members, dict(rows), datetime.now(timezone.utc))


def bind_instruments(package: dict, snapshot: dict) -> dict:
    """Create new content, preserving older packages and explicit requested coverage."""
    records = snapshot["records"]
    benchmark = records.get(package["benchmark"], {})
    if benchmark.get("resolution") != "resolved":
        raise ValueError("Benchmark current asset identity could not be resolved; research was not published")
    result = {**package, "instrument_snapshot": snapshot, "version": "us-swing-eod-v3"}
    exclusions = {symbol: records.get(symbol, {}).get("reason") or "Provider asset identity unavailable"
                  for symbol in package["symbols"] if records.get(symbol, {}).get("resolution") != "resolved"}
    result["instrument_exclusions"] = exclusions
    result["setup_exclusions"] = {**package.get("setup_exclusions", {}), **exclusions}
    result["source_snapshot_id"] = identity([package["source_snapshot_id"], snapshot["id"]])
    result["source_manifest_id"] = identity([package["source_manifest_id"], snapshot["id"]])
    result["setups"] = []
    for setup in package["setups"]:
        if setup["symbol"] in exclusions:
            continue
        asset_id = records[setup["symbol"]]["provider_asset_id"]
        setup_id = identity([setup["setup_id"], "alpaca", asset_id])
        result["setups"].append({**setup, "setup_id": setup_id,
                                 "provider_asset_id": asset_id,
                                 "setup_version": identity([setup["setup_version"], setup_id, result["source_manifest_id"]]),
                                 "source_snapshot_id": result["source_snapshot_id"]})
    result["warnings"] = [*package["warnings"], "Asset identities are current provider observations; historical mappings and corporate actions unverified"]
    if exclusions:
        result["state"] = "partial"
        result["warnings"].append("Unresolved or inactive instruments; affected setups withheld and publication is partial")
    content = {key: value for key, value in result.items() if key not in {"id", "computed_at"}}
    content["instrument_snapshot"] = {key: value for key, value in snapshot.items() if key != "observed_at"}
    result["id"] = identity(content)
    return result
