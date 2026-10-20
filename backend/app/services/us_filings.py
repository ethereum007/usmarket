"""Read-only current SEC issuer mapping and filing evidence, never an earnings calendar."""
import asyncio
from datetime import date, datetime, timezone
import os
import re
import time

import httpx


class FilingUnavailable(ValueError):
    pass


def issuer_for(symbol, mapping):
    if not isinstance(mapping, dict):
        raise FilingUnavailable("SEC issuer mapping is invalid")
    matches = set()
    for row in mapping.values():
        if isinstance(row, dict) and row.get("ticker") == symbol:
            cik = str(row.get("cik_str", ""))
            if re.fullmatch(r"[0-9]{1,10}", cik) and int(cik) > 0:
                matches.add(str(int(cik)))
            else:
                raise FilingUnavailable("SEC ticker association is malformed")
    if len(matches) != 1:
        raise FilingUnavailable("Current SEC ticker association is missing or ambiguous")
    return matches.pop()


def filing_evidence(symbol, cik, payload, observed_at):
    if observed_at.utcoffset() is None:
        raise FilingUnavailable("An aware SEC observation time is required")
    if not isinstance(payload, dict) or str(payload.get("cik", "")).lstrip("0") != cik:
        raise FilingUnavailable("SEC issuer evidence does not match requested CIK")
    filing_data = payload.get("filings")
    if not isinstance(filing_data, dict):
        raise FilingUnavailable("SEC recent-filing schema is unavailable")
    recent = filing_data.get("recent", {})
    columns = ("accessionNumber", "form", "filingDate", "acceptanceDateTime", "primaryDocument")
    if not isinstance(recent, dict) or any(not isinstance(recent.get(key), list) for key in columns):
        raise FilingUnavailable("SEC recent-filing schema is unavailable")
    size = len(recent["accessionNumber"])
    if size > 10000 or any(len(recent[key]) != size for key in columns):
        raise FilingUnavailable("SEC recent-filing columns are inconsistent")
    for key in ("items", "reportDate"):
        if key in recent and (not isinstance(recent[key], list) or len(recent[key]) != size):
            raise FilingUnavailable("SEC recent-filing columns are inconsistent")
    reports = recent.get("reportDate", [""] * size)
    item_values = recent.get("items", [""] * size)
    rows, omitted, seen = [], 0, set()
    accepted_forms = {"8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A", "6-K", "6-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}
    for index in range(size):
        if not isinstance(recent["form"][index], str):
            omitted += 1
            continue
        if recent["form"][index] not in accepted_forms:
            continue
        try:
            accession = recent["accessionNumber"][index]
            document = recent["primaryDocument"][index]
            if not re.fullmatch(r"[0-9]{10}-[0-9]{2}-[0-9]{6}", accession) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,200}", document) or ".." in document:
                raise ValueError()
            stamp = datetime.fromisoformat(recent["acceptanceDateTime"][index].replace("Z", "+00:00"))
            filing_date = date.fromisoformat(recent["filingDate"][index])
            if stamp.utcoffset() is None or stamp > observed_at or filing_date.isoformat() != recent["filingDate"][index]:
                raise ValueError()
            report_date = reports[index]
            if report_date:
                report_date = date.fromisoformat(report_date).isoformat()
            items = item_values[index]
            if not isinstance(items, str):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            omitted += 1
            continue
        if accession in seen:
            omitted += 1
            continue
        seen.add(accession)
        form = recent["form"][index]
        rows.append({"id": f"sec:{cik}:{accession}", "symbol": symbol, "cik": cik, "form": form,
                     "accepted_at": stamp.astimezone(timezone.utc).isoformat(), "filing_date": filing_date.isoformat(),
                     "report_date": report_date or None, "items": items, "amendment": form.endswith("/A"),
                     "source_url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{document}",
                     "results_item_reported": form.startswith("8-K") and "2.02" in {item.strip() for item in items.split(",")},
                     "earnings_date": None, "earnings_timing": "unknown", "fiscal_period": None})
    rows.sort(key=lambda row: (row["accepted_at"], row["id"]), reverse=True)
    return {"state": "partial" if omitted else "available", "symbol": symbol, "cik": cik,
            "observed_at": observed_at.astimezone(timezone.utc).isoformat(), "filings": rows[:20],
            "omitted_records": omitted, "scope": "Current SEC ticker association; issuer-level recent filings only",
            "earnings_status": "unknown", "coverage": "Recent submissions only; older history and forthcoming earnings are not searched"}


class SecGateway:
    def __init__(self, interval=0.5):
        self.lock = asyncio.Lock()
        self.interval = interval
        self.last = 0.0
        self.cache = {}

    async def get(self, client, url, ttl):
        async with self.lock:
            cached = self.cache.get(url)
            if cached and time.monotonic() - cached[0] < ttl:
                return cached[1]
            await asyncio.sleep(max(0, self.interval - (time.monotonic() - self.last)))
            self.last = time.monotonic()
            try:
                response = await client.get(url)
                if response.status_code != 200 or len(response.content) > 10_000_000:
                    raise FilingUnavailable("SEC evidence is temporarily unavailable")
                data = response.json()
            except (httpx.HTTPError, ValueError):
                raise FilingUnavailable("SEC evidence is temporarily unavailable") from None
            if len(self.cache) >= 64:
                self.cache.pop(next(iter(self.cache)))
            observed = (data, datetime.now(timezone.utc))
            self.cache[url] = (time.monotonic(), observed)
            return observed

    async def load(self, symbol, client=None):
        if not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,14}", symbol):
            raise FilingUnavailable("Invalid US filing symbol")
        if client is None:
            agent = os.getenv("SEC_USER_AGENT", "")
            if not agent or "@" not in agent or "\n" in agent or "\r" in agent:
                raise FilingUnavailable("SEC access is not configured for this service")
            async with httpx.AsyncClient(headers={"User-Agent": agent}, timeout=10, follow_redirects=False) as owned:
                return await self.load(symbol, owned)
        mapping, mapping_at = await self.get(client, "https://www.sec.gov/files/company_tickers.json", 3600)
        cik = issuer_for(symbol, mapping)
        payload, observed_at = await self.get(client, f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", 120)
        evidence = filing_evidence(symbol, cik, payload, observed_at)
        evidence["mapping_observed_at"] = mapping_at.isoformat()
        evidence["mapping_source_url"] = "https://www.sec.gov/files/company_tickers.json"
        evidence["submissions_source_url"] = f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json"
        return evidence


gateway = SecGateway()
