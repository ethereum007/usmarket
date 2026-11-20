"""Read-only local IEX liveness sample; never emits provider payloads."""
import asyncio
import json
from datetime import datetime, timezone

from app.services import us_live


async def report():
    result = {
        'state': 'unavailable', 'feed': 'iex', 'market_open': None,
        'quote_status': 'unknown', 'trade_status': 'unknown', 'passed': False,
        'scope': 'Local SPY IEX REST sample only; hosted acceptance, recovery, load and consolidated coverage unverified',
    }
    try:
        observation = await us_live.snapshot(['SPY'], 'iex')
        if isinstance(observation, dict) and observation.get('feed') == 'iex':
            state = observation.get('state')
            if state in ('connected', 'degraded', 'denied', 'unavailable'):
                result['state'] = state
            market = observation.get('market')
            if isinstance(market, dict) and type(market.get('is_open')) is bool:
                result['market_open'] = market['is_open']
            rows = observation.get('rows')
            if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) and rows[0].get('symbol') == 'SPY':
                for key in ('quote_status', 'trade_status'):
                    if rows[0].get(key) in ('fresh', 'stale', 'invalid'):
                        result[key] = rows[0][key]
            result['passed'] = (result['state'] == 'connected' and result['market_open'] is True
                                and result['quote_status'] == result['trade_status'] == 'fresh')
    except Exception:
        # Exception text can contain provider response fragments or credentials.
        pass
    result['observed_at'] = datetime.now(timezone.utc).isoformat()
    return result


def main():
    result = asyncio.run(report())
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
