"""US completed-session research. Run: python -m app.services.us_research --help."""
from __future__ import annotations
import argparse
import asyncio
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import httpx
from dotenv import load_dotenv
from app.services.swing_research import build_package
from app.services.swing_repository import identity
from app.services.us_instruments import load_instruments, bind_instruments
from app.services.us_sessions import completed_calendar, missing_sessions, VERSION as SESSION_VERSION, FINALIZATION_MINUTES

NY = ZoneInfo('America/New_York')
PROVIDER_DEADLINE_SECONDS = 180


def completed_sessions(calendar: list[dict], now: datetime) -> list[str]:
    return [row['date'] for row in completed_calendar(calendar, now)]


def normalize_bars(raw: list[dict], sessions: list[str]) -> list[dict]:
    accepted = set(sessions)
    rows = {}
    for bar in raw:
        try:
            stamp = datetime.fromisoformat(bar['t'].replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                continue
            day = stamp.astimezone(NY).date().isoformat()
            # Only JSON numbers are evidence: do not coerce strings, booleans,
            # nulls or containers into provider prices/volume.
            if any(type(bar.get(source)) not in (int, float) for source in ('o','h','l','c','v')):
                continue
            values = {key: float(bar[source]) for key, source in
                      [('open','o'), ('high','h'), ('low','l'), ('close','c'), ('volume','v')]}
            if day not in accepted or not all(math.isfinite(v) for v in values.values()):
                continue
            o,h,l,c,v = (values[k] for k in ('open','high','low','close','volume'))
            if min(o,h,l,c) <= 0 or v < 0 or h < max(o,l,c) or l > min(o,c):
                continue
            if day in rows and rows[day] != {'date': day, **values}:
                raise ValueError('Conflicting daily bars for ' + day)
            rows[day] = {'date': day, **values}
        except (KeyError, TypeError, OverflowError):
            continue
    return [rows[day] for day in sorted(rows)]


class AlpacaHistory:
    def __init__(self, client: httpx.AsyncClient, feed: str = 'sip'):
        if feed not in {'sip', 'iex'}:
            raise ValueError('Supported feeds: sip, iex')
        self.client, self.feed = client, feed

    async def get(self, url, params):
        # Idempotent GET only. Bounded attempts never change the selected feed.
        for attempt in range(3):
            try:
                response = await self.client.get(url, params=params)
            except httpx.TransportError:
                if attempt == 2:
                    raise RuntimeError('Historical provider transport unavailable; research was not published') from None
                await asyncio.sleep(0.25 * (2 ** attempt))
                continue
            if response.status_code == 200:
                return response.json()
            if response.status_code not in {429, 502, 503, 504} or attempt == 2:
                raise RuntimeError(f'Alpaca HTTP {response.status_code}; research was not published')
            delay = 0.25 * (2 ** attempt)
            retry_after = response.headers.get('retry-after')
            if retry_after is not None:
                try:
                    requested_delay = float(retry_after)
                except ValueError:
                    raise RuntimeError('Historical provider cooldown requires a later retry; research was not published') from None
                if not math.isfinite(requested_delay) or not 0 <= requested_delay <= 5:
                    raise RuntimeError('Historical provider cooldown requires a later retry; research was not published')
                delay = max(delay, requested_delay)
            await asyncio.sleep(delay)

    async def load(self, symbols: list[str], start: str, end: str):
        calendar = await self.get('https://paper-api.alpaca.markets/v2/calendar', {'start':start, 'end':end})
        sessions = completed_sessions(calendar, datetime.now(timezone.utc))
        if not sessions:
            raise ValueError('No completed provider sessions in requested interval')
        request_end = min(
            datetime.fromisoformat(sessions[-1] + 'T23:59:59').replace(tzinfo=NY),
            datetime.now(timezone.utc) - timedelta(minutes=16),
        ).isoformat()
        result = {symbol: [] for symbol in symbols}
        params = dict(symbols=','.join(symbols), timeframe='1Day', start=start,
                      end=request_end, adjustment='split', feed=self.feed, limit=10000, sort='asc', asof=end)
        seen = set()
        total_rows = 0
        maximum_rows = max(10000, len(symbols) * len(sessions) * 2)
        for _ in range(1000):
            payload = await self.get('https://data.alpaca.markets/v2/stocks/bars', params)
            if not isinstance(payload, dict) or not isinstance(payload.get('bars'), dict):
                raise ValueError('Invalid provider history page')
            page_rows = 0
            for rows in payload['bars'].values():
                if not isinstance(rows, list):
                    raise ValueError('Invalid provider history rows')
                page_rows += len(rows)
            if page_rows > 10000 or total_rows + page_rows > maximum_rows:
                raise ValueError('Provider history exceeds bounded row limit')
            if any(not isinstance(row, dict) for rows in payload['bars'].values() for row in rows):
                raise ValueError('Invalid provider history row')
            token = payload.get('next_page_token')
            if token is not None and (not isinstance(token, str) or len(token) > 4096):
                raise ValueError('Invalid provider pagination token')
            if token and token in seen:
                raise ValueError('Repeated provider pagination token')
            for symbol, rows in payload['bars'].items():
                if symbol in result:
                    result[symbol].extend(rows)
            total_rows += page_rows
            if token is None or token == '':
                return calendar, result
            seen.add(token)
            params['page_token'] = token
        raise ValueError('History pagination exceeded bounded limit')


def research_package(symbols, raw, calendar, now, feed='sip', benchmark='SPY'):
    calendar_evidence = completed_calendar(calendar, now)
    sessions = [row['date'] for row in calendar_evidence]
    if not sessions:
        raise ValueError('No completed provider sessions')
    histories = {s: normalize_bars(raw.get(s, []), sessions) for s in [benchmark, *symbols]}
    bench = histories.pop(benchmark)
    if not bench or bench[-1]['date'] != sessions[-1]:
        raise ValueError('Benchmark missing latest completed session')
    if [bar["date"] for bar in bench] != sessions:
        raise ValueError('Benchmark history has missing provider sessions; research was not published')
    history_gaps = {symbol: gaps for symbol, bars in histories.items()
                    if (gaps := missing_sessions(bars, sessions))}
    package = build_package('us-custom-' + identity(sorted(symbols))[:12], symbols, histories, bench,
                            market='US', benchmark_name=benchmark, sector_map={},
                            setup_exclusions={symbol: 'History has missing provider sessions' for symbol in history_gaps})
    package.update(currency='USD', timezone='America/New_York', provider='alpaca', feed=feed,
                   adjustment_basis='split', version='us-swing-eod-v2', earnings_status='unavailable',
                   calendar_basis='Alpaca market calendar; close plus 30 minute finalization buffer',
                   membership_basis='Explicit current custom list; not historical index membership',
                   research_only=True, expected_session=sessions[-1])
    session_record = {'version': SESSION_VERSION, 'timezone': 'America/New_York',
                      'finalization_buffer_minutes': FINALIZATION_MINUTES, 'sessions': calendar_evidence}
    package['session_calendar'] = {**session_record, 'id': identity(session_record)}
    package['history_gaps'] = history_gaps
    if history_gaps:
        package['state'] = 'partial'
    package['source_manifest_id'] = identity({'market':'US','feed':feed,'adjustment':'split',
                                             'calendar':package['session_calendar']['id'], 'snapshot':package['source_snapshot_id']})
    for setup in package['setups']:
        setup['setup_version'] = identity([setup['setup_version'], package['source_manifest_id']])
    package['warnings'] = ['US detector thresholds are not calibrated', 'Earnings events and industry classification unavailable',
                           'Daily provider aggregates: regular-session-only volume is not certified']
    if feed == 'iex':
        package['warnings'].append('Single-exchange IEX coverage; volume is not consolidated US volume')
    if history_gaps:
        package['warnings'].append('Missing provider sessions in stock history; affected setups withheld and publication is partial')
    package['universe'] += '-' + benchmark.lower() + '-' + feed
    package['id'] = identity({k:v for k,v in package.items() if k != 'computed_at'})
    return package


def save_package(package: dict, folder: Path):
    from app.services.us_publication import publish
    return publish(package, folder)


async def run(args):
    load_dotenv(Path(__file__).resolve().parents[2] / '.env.us.local', override=False)
    symbols = sorted(set(s.strip().upper() for s in args.symbols.split(',') if s.strip()))
    if not symbols or len(symbols) > 500 or any(not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', s) for s in symbols):
        raise ValueError('Provide 1–500 valid US ticker symbols')
    if args.benchmark in symbols:
        raise ValueError('Benchmark must be separate from the research universe')
    key, secret = os.getenv('ALPACA_API_KEY'), os.getenv('ALPACA_SECRET_KEY')
    if not key or not secret:
        raise ValueError('Set ALPACA_API_KEY and ALPACA_SECRET_KEY locally; no data generated')
    now = datetime.now(timezone.utc)
    end = now.astimezone(NY).date().isoformat()
    start = (now - timedelta(days=800)).date().isoformat()
    try:
        async with asyncio.timeout(PROVIDER_DEADLINE_SECONDS):
            async with httpx.AsyncClient(headers={'APCA-API-KEY-ID':key, 'APCA-API-SECRET-KEY':secret}, timeout=30) as client:
                instruments = await load_instruments(client, [args.benchmark, *symbols])
                if instruments["records"][args.benchmark]["resolution"] != "resolved":
                    raise ValueError("Benchmark current asset identity could not be resolved; research was not published")
                eligible = [symbol for symbol in symbols if instruments["records"][symbol]["resolution"] == "resolved"]
                calendar, raw = await AlpacaHistory(client, args.feed).load([args.benchmark, *eligible], start, end)
    except TimeoutError:
        raise RuntimeError('US provider retrieval deadline exceeded; research was not published') from None
    package = research_package(symbols, raw, calendar, now, args.feed, args.benchmark)
    package = bind_instruments(package, instruments)
    # Remote API callers own publication/acknowledgement. Do not make remote
    # durability depend on a second ephemeral filesystem publication.
    if getattr(args, 'publish_local', True):
        target, package = save_package(package, Path(args.output))
        print(json.dumps({'path':str(target.resolve()), 'state':package['state'], 'session':package['session'],
                          'available':package['breadth']['available'], 'requested':len(symbols), 'setups':len(package['setups'])}))
    return package


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--symbols', required=True, help='Explicit comma-separated research universe')
    parser.add_argument('--benchmark', choices=['SPY','QQQ'], default='SPY')
    parser.add_argument('--feed', choices=['sip','iex'], default='sip')
    parser.add_argument('--output', default='data/us-research')
    try:
        asyncio.run(run(parser.parse_args()))
    except (ValueError, RuntimeError, httpx.HTTPError) as exc:
        parser.exit(1, str(exc) + '\n')
