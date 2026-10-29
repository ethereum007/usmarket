"""Read-only US quote diagnostics; never changes completed-session research."""
from __future__ import annotations
import asyncio
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
import httpx
from dotenv import load_dotenv

_CACHE: dict[tuple, tuple[float, dict]] = {}
_INFLIGHT: dict[tuple, asyncio.Task] = {}
_MAX_INFLIGHT = 8
OBSERVATION_DEADLINE_SECONDS = 20


def number(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def event_age(stamp, now):
    try:
        parsed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        age = (now - parsed).total_seconds()
        return round(age, 3) if age >= -5 else None
    except (ValueError, TypeError, AttributeError):
        return None


def quote_diagnostic(symbol, quote, trade, now):
    quote = quote if isinstance(quote, dict) else {}
    trade = trade if isinstance(trade, dict) else {}
    bid, ask = number(quote.get('bp')), number(quote.get('ap'))
    age = event_age(quote.get('t'), now)
    valid = bid is not None and ask is not None and ask >= bid
    spread = ask - bid if valid else None
    spread_bps = spread / (bid / 2 + ask / 2) * 10000 if valid else None
    status = 'invalid' if not valid or age is None else 'fresh' if age <= 30 else 'stale'
    price = number(trade.get('p'))
    trade_age = event_age(trade.get('t'), now)
    return {'symbol':symbol, 'bid':bid, 'ask':ask, 'quote_timestamp':quote.get('t') if age is not None else None,
            'quote_age_seconds':age, 'quote_status':status, 'spread':spread,
            'spread_bps':spread_bps, 'wide_spread':spread_bps is not None and spread_bps > 100,
            'last_trade':price, 'trade_timestamp':trade.get('t') if trade_age is not None else None, 'trade_age_seconds':trade_age,
            'trade_status':'invalid' if price is None or trade_age is None else 'fresh' if trade_age <= 30 else 'stale'}


async def snapshot(symbols: list[str], feed: str = 'iex', client=None):
    # Network-operation timeouts alone permit an indefinitely slow response.
    async with asyncio.timeout(OBSERVATION_DEADLINE_SECONDS):
        return await _snapshot(symbols, feed, client)


async def _snapshot(symbols: list[str], feed: str = 'iex', client=None):
    load_dotenv(Path(__file__).resolve().parents[2] / '.env.us.local', override=False)
    key, secret = os.getenv('ALPACA_API_KEY'), os.getenv('ALPACA_SECRET_KEY')
    if client is None:
        if not key or not secret:
            return {'state':'unavailable','feed':feed,'error':'Local Alpaca data credentials are missing'}
        async with httpx.AsyncClient(headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret},timeout=15) as owned:
            return await _snapshot(symbols, feed, owned)
    requests = [
        ('clock', 'https://paper-api.alpaca.markets/v2/clock', {}),
        ('quotes', 'https://data.alpaca.markets/v2/stocks/quotes/latest', {'symbols':','.join(symbols),'feed':feed}),
        ('trades', 'https://data.alpaca.markets/v2/stocks/trades/latest', {'symbols':','.join(symbols),'feed':feed}),
    ]
    results = await asyncio.gather(*(client.get(url,params=params) for _,url,params in requests),return_exceptions=True)
    payloads, errors, codes = {}, {}, {}
    for (name, _, _), result in zip(requests, results):
        if isinstance(result, Exception):
            errors[name] = 'Provider request unavailable'
        else:
            codes[name] = result.status_code
            if result.status_code == 200:
                try:
                    payload = result.json()
                    if not isinstance(payload, dict):
                        raise ValueError()
                    if name in {'quotes', 'trades'} and not isinstance(payload.get(name), dict):
                        raise ValueError()
                    payloads[name] = payload
                except ValueError:
                    errors[name] = 'Invalid provider response'
            else:
                errors[name] = 'Feed permission denied' if result.status_code in {401,403} else f'Provider HTTP {result.status_code}'
    now = datetime.now(timezone.utc)
    clock = payloads.get('clock', {})
    clock_age = event_age(clock.get('timestamp'), now)
    if clock_age is None or clock_age > 60 or not isinstance(clock.get('is_open'), bool):
        errors.setdefault('clock', 'Market clock unavailable or invalid')
        clock = {}
    else:
        clock = {**clock}
        for field in ('next_open', 'next_close'):
            stamp = clock.get(field)
            if stamp is not None:
                try:
                    parsed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                    if parsed.utcoffset() is None:
                        raise ValueError()
                except (ValueError, TypeError, AttributeError):
                    clock[field] = None
                    errors.setdefault('clock', 'Market clock schedule is invalid')
    denied = any(codes.get(name) in {401,403} for name in ('quotes','trades'))
    rows = [quote_diagnostic(s, (payloads.get('quotes',{}).get('quotes') or {}).get(s),
                            (payloads.get('trades',{}).get('trades') or {}).get(s), now) for s in symbols]
    if any(row['quote_status'] == 'invalid' for row in rows):
        errors.setdefault('quotes', 'Some requested quotes are unavailable or invalid')
    if any(row['trade_status'] == 'invalid' for row in rows):
        errors.setdefault('trades', 'Some requested trades are unavailable or invalid')
    return {'state':'denied' if denied else 'degraded' if errors else 'connected',
            'feed':feed, 'coverage':'Single-exchange IEX' if feed == 'iex' else 'Consolidated SIP',
            'received_at':now.isoformat(), 'market':{k:clock.get(k) for k in ('timestamp','is_open','next_open','next_close')},
            'errors':errors, 'rows':rows, 'transport':'REST snapshots polled every 5 seconds; not browser streaming',
            'research_only':True, 'freshness_threshold_seconds':30}


async def cached_snapshot(symbols, feed):
    key = (tuple(sorted(set(symbols))),feed)
    entry = _CACHE.get(key)
    if entry and time.monotonic() - entry[0] < 3:
        return entry[1]
    task = _INFLIGHT.get(key)
    if task is None:
        if len(_INFLIGHT) >= _MAX_INFLIGHT:
            return {'state':'unavailable','feed':feed,'error':'Live diagnostics are busy; retry shortly', 'research_only':True}
        async def produce():
            try:
                try:
                    data = await snapshot(list(key[0]),feed)
                except Exception:
                    data = {'state':'unavailable','feed':feed,'error':'Live provider observation unavailable', 'research_only':True}
                if len(_CACHE) >= 64:
                    _CACHE.pop(next(iter(_CACHE)))
                _CACHE[key] = (time.monotonic(), data)
                return data
            finally:
                if _INFLIGHT.get(key) is asyncio.current_task():
                    _INFLIGHT.pop(key, None)
        task = asyncio.create_task(produce())
        _INFLIGHT[key] = task
    # A disconnected requester must not cancel the shared observation for others.
    return await asyncio.shield(task)
