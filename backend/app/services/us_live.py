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


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else None
    except (ValueError, TypeError):
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
    quote, trade = quote or {}, trade or {}
    bid, ask = number(quote.get('bp')), number(quote.get('ap'))
    age = event_age(quote.get('t'), now)
    valid = bid is not None and ask is not None and ask >= bid
    spread = ask - bid if valid else None
    spread_bps = spread / ((bid + ask) / 2) * 10000 if valid else None
    status = 'invalid' if not valid or age is None else 'fresh' if age <= 30 else 'stale'
    price = number(trade.get('p'))
    trade_age = event_age(trade.get('t'), now)
    return {'symbol':symbol, 'bid':bid, 'ask':ask, 'quote_timestamp':quote.get('t'),
            'quote_age_seconds':age, 'quote_status':status, 'spread':spread,
            'spread_bps':spread_bps, 'wide_spread':spread_bps is not None and spread_bps > 100,
            'last_trade':price, 'trade_timestamp':trade.get('t'), 'trade_age_seconds':trade_age,
            'trade_status':'invalid' if price is None or trade_age is None else 'fresh' if trade_age <= 30 else 'stale'}


async def snapshot(symbols: list[str], feed: str = 'iex', client=None):
    load_dotenv(Path(__file__).resolve().parents[2] / '.env.us.local', override=False)
    key, secret = os.getenv('ALPACA_API_KEY'), os.getenv('ALPACA_SECRET_KEY')
    if client is None:
        if not key or not secret:
            return {'state':'unavailable','feed':feed,'error':'Local Alpaca data credentials are missing'}
        async with httpx.AsyncClient(headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret},timeout=15) as owned:
            return await snapshot(symbols, feed, owned)
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
                try: payloads[name] = result.json()
                except ValueError: errors[name] = 'Invalid provider response'
            else:
                errors[name] = 'Feed permission denied' if result.status_code in {401,403} else f'Provider HTTP {result.status_code}'
    now = datetime.now(timezone.utc)
    clock = payloads.get('clock', {})
    denied = any(codes.get(name) in {401,403} for name in ('quotes','trades'))
    rows = [quote_diagnostic(s, (payloads.get('quotes',{}).get('quotes') or {}).get(s),
                            (payloads.get('trades',{}).get('trades') or {}).get(s), now) for s in symbols]
    return {'state':'denied' if denied else 'degraded' if errors else 'connected',
            'feed':feed, 'coverage':'Single-exchange IEX' if feed == 'iex' else 'Consolidated SIP',
            'received_at':now.isoformat(), 'market':{k:clock.get(k) for k in ('timestamp','is_open','next_open','next_close')},
            'errors':errors, 'rows':rows, 'transport':'REST snapshots polled every 5 seconds; not browser streaming',
            'research_only':True, 'freshness_threshold_seconds':30}


async def cached_snapshot(symbols, feed):
    key = (tuple(symbols),feed)
    entry = _CACHE.get(key)
    if entry and time.monotonic() - entry[0] < 3:
        return entry[1]
    data = await snapshot(symbols,feed)
    if len(_CACHE) >= 64:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (time.monotonic(), data)
    return data
